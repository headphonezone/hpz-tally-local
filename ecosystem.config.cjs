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
    // A month of Unicommerce orders (20,000) is held ~415 MB PER PERSON; 400M restarted the app and lost the list (2026-10-24).
    // Shared by up to 5 people (~2 GB at the very most), and a restart in the middle of a posting is the worst case, so the limit is 6G —
    // run the server on a PC with at least 16 GB (the HPZ server PC has 32). Node's own heap cap is lifted to 8 GB so it
    // does not die before pm2's limit. Lists idle for 3 hours are freed on their own (lib/userstate.mjs).
    max_memory_restart: '6G',
    node_args: '--max-old-space-size=8192',
    time: true,

    // No env block on purpose: every setting (PORT, HPZ_TALLY_URL, HPZ_FEED_URL, RMS_API_URL,
    // RMS_AGENT_SECRET) lives in .env, loaded by lib/env.mjs. Values set here would silently
    // override .env, so moving the app to a PC whose Tally is elsewhere would keep using
    // localhost:9000 even after .env was edited.
  }],
};
