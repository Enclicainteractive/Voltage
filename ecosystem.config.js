module.exports = {
  apps: [
    {
      name: 'voltage-api',
      script: './server.js',
      instances: process.env.VOLT_API_INSTANCES || 2,
      exec_mode: 'cluster',
      interpreter: 'none',
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        VOLT_SERVICE: 'api',
        PORT: 5000
      },
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 1000,
      listen_timeout: 8000,
      kill_timeout: 5000,
      wait_ready: true,
      instance_var: 'INSTANCE_INDEX',
      pmx: true,
      source_map_support: true
    },
    {
      name: 'voltage-websocket',
      script: './server.js',
      instances: process.env.VOLT_WS_INSTANCES || 2,
      exec_mode: 'cluster',
      interpreter: 'none',
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        VOLT_SERVICE: 'websocket',
        PORT: 5001
      },
      error_file: './logs/ws-error.log',
      out_file: './logs/ws-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 1000,
      listen_timeout: 8000,
      kill_timeout: 5000,
      wait_ready: true,
      instance_var: 'INSTANCE_INDEX',
      pmx: true,
      source_map_support: true
    },
    {
      name: 'voltage-worker',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      interpreter: 'none',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        VOLT_SERVICE: 'worker',
        PORT: 5004
      },
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 1000,
      listen_timeout: 8000,
      kill_timeout: 5000,
      wait_ready: true,
      pmx: true,
      source_map_support: true,
      cron_restart: '0 4 * * *'
    },
    {
      name: 'voltage-federation',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      interpreter: 'none',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        VOLT_SERVICE: 'federation',
        PORT: 5002
      },
      error_file: './logs/federation-error.log',
      out_file: './logs/federation-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 2000,
      listen_timeout: 10000,
      kill_timeout: 5000,
      wait_ready: true,
      pmx: true,
      source_map_support: true
    },
    {
      name: 'voltage-cdn',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      interpreter: 'none',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        VOLT_SERVICE: 'cdn',
        PORT: 5003
      },
      error_file: './logs/cdn-error.log',
      out_file: './logs/cdn-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 1000,
      listen_timeout: 8000,
      kill_timeout: 5000,
      wait_ready: true,
      pmx: true,
      source_map_support: true
    }
  ],
  
  deploy: {
    production: {
      user: 'volt',
      host: 'production.example.com',
      ref: 'origin/main',
      repo: 'git@github.com:voltchat/voltage.git',
      path: '/var/www/voltage',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'apt-get update && apt-get install -y python3 build-essential'
    },
    staging: {
      user: 'volt',
      host: 'staging.example.com',
      ref: 'origin/develop',
      repo: 'git@github.com:voltchat/voltage.git',
      path: '/var/www/voltage',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env staging'
    }
  }
}
