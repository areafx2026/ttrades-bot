module.exports = {
  apps: [
    {
      name: 'ttrades-bot',
      script: './dist/index.js',
      cwd: '/var/www/ttrades-bot',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/www/ttrades-bot/logs/error.log',
      out_file:   '/var/www/ttrades-bot/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
