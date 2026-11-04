// pm2 config for the HPZ Material Out app.
//
// .cjs, not .js, because package.json sets "type": "module" and pm2 reads this
// file as CommonJS.
//
// fork mode with instances: 1 is not a default worth changing. Two copies of
// this app mean two clients talking to Tally's gateway at once, and overlapping
// requests wedge Tally at several GB until it is killed.

module.exports = {
  apps: [{
    name: 'hpz-materialout',
    script: 'server.mjs',
    cwd: __dirname,

    exec_mode: 'fork',
    instances: 1,

    autorestart: true,
    watch: false,
    // A month of Unicommerce orders (20,000) is held ~415 MB; 400M restarted the app and lost the list (2026-10-24).
    // Fetching and checking a month or two of them peaks well above that: pm2 killed the app at 1.26 GB on 2026-11-04, twice,
    // before the fetch finished (it does not survive a restart: the list is lost). 4G leaves this 16 GB PC room for Tally (~2 GB);
    // Node's own heap cap is set just above so it does not die before pm2's limit.
    max_memory_restart: '4G',
    node_args: '--max-old-space-size=5120',
    time: true,

    // No env block on purpose: every setting (PORT, HPZ_TALLY_URL, HPZ_FEED_URL, RMS_API_URL,
    // RMS_AGENT_SECRET) lives in .env, loaded by lib/env.mjs. Values set here would silently
    // override .env, so moving the app to a PC whose Tally is elsewhere would keep using
    // localhost:9000 even after .env was edited.
  }],
};
