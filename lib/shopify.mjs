// Shopify Admin API (GraphQL), read only: the orders of a date range with their payment transactions.
//
// Payment Gateway tab: the gateway report (Razorpay / Cashfree) says "this payment was settled"; Shopify says which
// order and customer it belongs to. The old tool took a Shopify order EXPORT for that, matched on its "Payment id"
// column. The API gives the same thing as OrderTransaction.paymentId, so the match key is unchanged.
//
// Needs in .env:  SHOPIFY_STORE=<name>.myshopify.com   SHOPIFY_ADMIN_TOKEN=<Admin API access token, scope read_orders>
// (read_all_orders as well when the range reaches back more than 60 days). Optional: SHOPIFY_API_VERSION.

const API_VERSION = () => process.env.SHOPIFY_API_VERSION || '2025-01';
const PAGE = 50;

export const storeHost = () => {
  const s = String(process.env.SHOPIFY_STORE || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return s && !s.includes('.') ? `${s}.myshopify.com` : s;
};
const token = () => String(process.env.SHOPIFY_ADMIN_TOKEN || '').trim();
export const configured = () => Boolean(storeHost() && token());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One GraphQL call. Shopify throttles by query cost: a THROTTLED error or HTTP 429 means wait and repeat.
async function gql(query, variables, tries = 6) {
  for (let attempt = 1; ; attempt++) {
    let res, body;
    try {
      res = await fetch(`${process.env.SHOPIFY_BASE_URL || `https://${storeHost()}`}/admin/api/${API_VERSION()}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token() },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60000),
      });
      body = await res.json().catch(() => ({}));
    } catch (err) {
      if (attempt < tries) { await sleep(2000 * attempt); continue; }
      throw new Error(`Shopify could not be reached: ${err.message}`);
    }
    const throttled = res.status === 429 || body.errors?.some?.((e) => e?.extensions?.code === 'THROTTLED');
    if (throttled && attempt < tries) { await sleep(Number(res.headers.get('retry-after')) * 1000 || 2000 * attempt); continue; }
    if (res.status === 401 || res.status === 403) throw new Error('Shopify refused the access token — check SHOPIFY_ADMIN_TOKEN and its read_orders scope');
    if (res.status === 404) throw new Error(`Shopify store "${storeHost()}" not found — check SHOPIFY_STORE`);
    if (res.status >= 500 && attempt < tries) { await sleep(2000 * attempt); continue; }
    if (!res.ok) throw new Error(`Shopify answered HTTP ${res.status}`);
    if (body.errors?.length) throw new Error(`Shopify: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data;
  }
}

const QUERY = `query ($first: Int!, $after: String, $q: String) {
  orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt email
      currentTotalPriceSet { shopMoney { amount } }
      transactions { id kind status gateway paymentId processedAt amountSet { shopMoney { amount } } }
    }
  }
}`;

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

// "#1234" -> "1234": the order number as the accounts book it. (To confirm against a real Tally bill reference.)
export const orderNumberOf = (name) => String(name || '').replace(/^#/, '').trim();

export function normaliseOrder(n) {
  return {
    id: n.id,
    name: n.name,
    orderNumber: orderNumberOf(n.name),
    createdAt: n.createdAt,
    email: String(n.email || '').trim(),
    total: num(n.currentTotalPriceSet?.shopMoney?.amount),
    transactions: (n.transactions || []).map((t) => ({
      id: t.id, kind: String(t.kind || '').toUpperCase(), status: String(t.status || '').toUpperCase(),
      gateway: t.gateway || '', paymentId: t.paymentId || '', processedAt: t.processedAt || null,
      amount: num(t.amountSet?.shopMoney?.amount),
    })),
  };
}

// Every order created from `fromIso` through `toIso` (yyyy-mm-dd, India dates).
export async function fetchOrders(fromIso, toIso, { onProgress } = {}) {
  if (!configured()) throw new Error('Shopify is not connected — SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN go in the app\'s .env, then restart the app');
  const q = `created_at:>='${fromIso}T00:00:00+05:30' created_at:<='${toIso}T23:59:59+05:30'`;
  const orders = [];
  let after = null;
  for (;;) {
    const data = await gql(QUERY, { first: PAGE, after, q });
    for (const n of data.orders.nodes) orders.push(normaliseOrder(n));
    onProgress?.(`Shopify: ${orders.length} orders read…`);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return orders;
}

// Lookups the match uses. paymentId -> { order, txn } for the gateway's own reference; email -> [orders].
export function indexOrders(orders) {
  const byPayment = new Map(), byEmail = new Map(), byNumber = new Map();
  for (const o of orders) {
    byNumber.set(o.orderNumber, o);
    if (o.email) { const k = o.email.toLowerCase(); (byEmail.get(k) || byEmail.set(k, []).get(k)).push(o); }
    for (const t of o.transactions) if (t.paymentId && !byPayment.has(t.paymentId)) byPayment.set(t.paymentId, { order: o, txn: t });
  }
  return { byPayment, byEmail, byNumber };
}
