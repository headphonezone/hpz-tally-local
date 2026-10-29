import { activeCompany, importVouchers, materialOutVoucher, vouchersOfType } from './tally.mjs';

const BATCH_SIZE = 50;

// A clean import_result proves nothing — Tally has reported "created: 1,
// errors: 0" for a voucher whose entries landed on the wrong side. Existence is
// re-read from Tally afterwards and that read, not the response, decides.
export async function createMaterialOut(rows, { report, onProgress = () => {} }) {
  const nowActive = await activeCompany();
  if (report.company && nowActive !== report.company) {
    throw new Error(
      `Tally's open company changed since this report was built ` +
      `("${report.company}" -> "${nowActive}"). Rebuild the report before creating.`,
    );
  }

  const eligible = rows.filter((r) => r.status === 'ready' && r.mi && r.tallyDate);
  const attempted = [];

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    // A replaced WCID goes out as the unit actually sent (`out`, lib/replacements.mjs); every other
    // one as the Material In's own item. The party is always the Material In's.
    const payload = batch.map((r) => {
      const out = r.out || r.mi;
      return materialOutVoucher({
        wcid: r.wcid,
        date: r.tallyDate,
        party: r.mi.party,
        narration: out.narration,
        stockItem: out.stockItem,
        qty: out.qty,
        godown: out.godown,
        batchName: out.batchName,
      });
    });

    let response;
    try {
      response = await importVouchers(payload);
    } catch (err) {
      response = { status: '0', error_list: [err.message] };
    }
    attempted.push(...batch.map((r) => ({ row: r, response })));
    onProgress({
      done: Math.min(i + BATCH_SIZE, eligible.length),
      total: eligible.length,
      company: nowActive,
    });
  }

  const afterOut = new Set((await vouchersOfType('Material Out')).map((v) => v.voucherNumber));
  const results = attempted.map(({ row, response }) => {
    const exists = afterOut.has(row.moNumber);
    return {
      wcid: row.wcid,
      moNumber: row.moNumber,
      created: exists,
      error: exists ? '' : describeFailure(response),
    };
  });

  return {
    company: nowActive,
    requested: rows.length,
    eligible: eligible.length,
    created: results.filter((r) => r.created).length,
    failed: results.filter((r) => !r.created).length,
    results,
  };
}

function describeFailure(response) {
  if (!response) return 'no response from Tally';
  if (Array.isArray(response.error_list) && response.error_list.length) {
    return response.error_list.join('; ');
  }
  const data = response.data || {};
  const errors = data.import_result?.errors ?? data.errors;
  if (errors) return `Tally reported ${errors} error(s)`;
  return 'voucher not present in Tally after import';
}
