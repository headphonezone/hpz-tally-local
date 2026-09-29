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
    max_memory_restart: '400M',
    time: true,

    env: {
      PORT: 7654,
      HPZ_TALLY_URL: 'http://localhost:9000',
      // HPZ_FEED_URL: 'https://script.google.com/macros/s/.../exec',
    },
  }],
};
