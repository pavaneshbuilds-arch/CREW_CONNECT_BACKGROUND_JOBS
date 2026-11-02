// NODE_ENV, DATABASE_URL, and the FCM keys come from .env, not from here.
module.exports = {
  apps: [
    {
      name: 'crew-connect-jobs',
      script: 'src/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 10000,
    },
  ],
};
