#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import crypto from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.join(__dirname, '..')

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
}

function log(msg, color = 'reset') {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`)
}

function generateJwtSecret() {
  return crypto.randomBytes(64).toString('hex')
}

function generateApiKey() {
  return `vlt_${crypto.randomBytes(24).toString('hex')}`
}

class VoltageScaler {
  constructor() {
    this.envFile = path.join(PROJECT_ROOT, '.env')
  }

  async setup(options = {}) {
    const { mode = 'development', domain = 'localhost', ssl = false } = options
    
    log('\n⚡ Volt Scaling Helper', 'cyan')
    log('====================\n', 'cyan')

    log('Generating secure keys...', 'blue')
    const jwtSecret = generateJwtSecret()
    const apiKey = generateApiKey()

    const envContent = [
      `# Volt Configuration - Generated ${new Date().toISOString()}`,
      `# Mode: ${mode}`,
      '',
      `NODE_ENV=${mode}`,
      `PORT=5000`,
      `SERVER_URL=${ssl ? 'https' : 'http'}://${domain}`,
      `SERVER_NAME=Volt`,
      `VOLTAGE_MODE=${mode === 'production' ? 'mainline' : 'self-volt'}`,
      '',
      '# Security',
      `JWT_SECRET=${jwtSecret}`,
      '',
      '# Storage (json/sqlite)',
      'STORAGE_TYPE=json',
      '',
      '# Auth',
      'ALLOW_LOCAL_AUTH=true',
      'ALLOW_REGISTRATION=true',
      '',
      '# Features',
      'ENABLE_DISCOVERY=true',
      'ENABLE_SELF_VOLT=true',
      '',
      '# CDN (leave empty to use local)',
      '# CDN_PROVIDER=s3',
      '# CDN_BUCKET=',
      '# CDN_REGION=us-east-1',
      '',
      '# Redis (optional)',
      '# REDIS_HOST=localhost',
      '# REDIS_PORT=6379',
      '',
      '# API Key (for admin/self-volt sync)',
      `VOLT_API_KEY=${apiKey}`,
      '',
      '# Logging',
      'LOG_LEVEL=info'
    ].join('\n')

    fs.writeFileSync(this.envFile, envContent)
    log(`✓ Created .env file`, 'green')

    if (mode === 'production') {
      log('\n📦 Production Setup', 'blue')
      log('-------------------\n', 'blue')
      
      const nginxConfig = this.generateNginxConfig(domain, ssl)
      fs.writeFileSync(path.join(PROJECT_ROOT, 'nginx.conf'), nginxConfig)
      log(`✓ Created nginx.conf`, 'green')

      const dockerCompose = this.generateDockerCompose()
      fs.writeFileSync(path.join(PROJECT_ROOT, 'docker-compose.yml'), dockerCompose)
      log(`✓ Created docker-compose.yml`, 'green')

      const systemdService = this.generateSystemdService()
      fs.writeFileSync(path.join(PROJECT_ROOT, 'voltage.service'), systemdService)
      log(`✓ Created voltage.service`, 'green')
    }

    log('\n🚀 Next Steps:', 'yellow')
    log('------------', 'yellow')
    log(`1. Edit .env with your settings`, 'reset')
    log(`2. Run: npm install`, 'reset')
    log(`3. Run: npm run migrate -- backup`, 'reset')
    log(`4. Run: npm start`, 'reset')
    log('\n')
  }

  generateNginxConfig(domain, ssl) {
    const sslConfig = ssl ? `
  ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;` : ''

    return `
upstream voltage_backend {
  server 127.0.0.1:5000;
}

server {
  listen 80;
  server_name ${domain};
  
  ${ssl ? '' : `return 301 https://$server_name$request_uri;`}
}

server {
  listen 443 ssl http2;
  server_name ${domain};${sslConfig}

  client_max_body_size 10M;

  location / {
    proxy_pass http://voltage_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
  }

  location /socket.io {
    proxy_pass http://voltage_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400;
  }

  location /uploads {
    alias ${PROJECT_ROOT}/uploads;
    expires 30d;
    add_header Cache-Control "public, immutable";
  }
}
`
  }

  generateDockerCompose() {
    return `version: '3.8'

services:
  voltage:
    image: voltage:latest
    container_name: volt
    restart: unless-stopped
    ports:
      - "5000:5000"
    environment:
      - NODE_ENV=production
      - SERVER_URL=\${SERVER_URL}
      - JWT_SECRET=\${JWT_SECRET}
      - STORAGE_TYPE=sqlite
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:5000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Optional: Redis for caching
  # redis:
  #   image: redis:7-alpine
  #   restart: unless-stopped
  #   volumes:
  #     - redis_data:/data

volumes:
  redis_data:
`
  }

  generateSystemdService() {
    return `[Unit]
Description=Volt - Decentralized Chat Platform
After=network.target

[Service]
Type=simple
User=volt
WorkingDirectory=${PROJECT_ROOT}
ExecStart=/usr/bin/node ${PROJECT_ROOT}/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`
  }

  async status() {
    log('\n⚡ Volt Status', 'cyan')
    log('=============\n', 'cyan')

    try {
      const response = await fetch('http://localhost:5000/api/health')
      const data = await response.json()
      log('Server:    ✓ Running', 'green')
      log(`Version:   ${data.version}`, 'reset')
      log(`Mode:      ${data.mode}`, 'reset')
      log(`URL:       ${data.url}`, 'reset')
    } catch (e) {
      log('Server:    ✗ Not running', 'red')
    }

    const configPath = path.join(PROJECT_ROOT, 'config.json')
    const envPath = path.join(PROJECT_ROOT, '.env')
    
    log(`\nConfig:    ${fs.existsSync(configPath) ? '✓ Found' : '✗ Not found'}`, 
        fs.existsSync(configPath) ? 'green' : 'yellow')
    log(`Env File:  ${fs.existsSync(envPath) ? '✓ Found' : '✗ Not found'}`,
        fs.existsSync(envPath) ? 'green' : 'yellow')

    log('\n')
  }

  async scale() {
    log('\n⚡ Volt Scaling Guide', 'cyan')
    log('====================\n', 'cyan')

    log('Horizontal Scaling Options:', 'blue')
    log('--------------------------\n', 'blue')

    log('1. Load Balancer (Recommended)', 'yellow')
    log('   - Use nginx, HAProxy, or cloud LB', 'reset')
    log('   - Sticky sessions for WebSocket', 'reset')
    log('   - SSL termination at LB', 'reset')

    log('\n2. Redis for Scaling', 'yellow')
    log('   - Enable Redis in config.json', 'reset')
    log('   - Shared session storage', 'reset')
    log('   - Pub/sub for real-time', 'reset')

    log('\n3. Database Scaling', 'yellow')
    log('   - Use SQLite for single server', 'reset')
    log('   - PostgreSQL for multi-server', 'reset')
    log('   - Read replicas for heavy load', 'reset')

    log('\n4. CDN Configuration', 'yellow')
    log('   - Set cdn.enabled=true in config', 'reset')
    log('   - Choose: s3, cloudflare, or local', 'reset')
    log('   - Configure in config.json', 'reset')

    log('\n5. Self-Volt Federation', 'yellow')
    log('   - Run multiple instances', 'reset')
    log('   - Sync via API keys', 'reset')
    log('   - Enable federation in config', 'reset')

    log('\n6. Multi-Process Architecture (NEW)', 'yellow')
    log('   - Split services into separate apps', 'reset')
    log('   - If one service crashes, others stay up', 'reset')
    log('   - Run: npm run scale:split to generate configs', 'reset')

    log('\n')
  }

  async split() {
    log('\n⚡ Volt Multi-Process Setup', 'cyan')
    log('===========================\n', 'cyan')

    const services = [
      { name: 'api', port: 5000, desc: 'Main API Server', routes: ['user', 'server', 'channel', 'message', 'dm', 'upload', 'invite', 'discovery', 'admin', 'auth', 'push', 'migration', 'bots', 'system', 'automod', 'notifications', 'safety', 'activities', 'theme', 'gif'] },
      { name: 'websocket', port: 5001, desc: 'WebSocket Server', routes: [] },
      { name: 'federation', port: 5002, desc: 'Federation Server', routes: ['federation'] },
      { name: 'cdn', port: 5003, desc: 'CDN/Uploads Server', routes: ['upload'] },
      { name: 'worker', port: 5004, desc: 'Background Worker', routes: [] }
    ]

    log('Creating separate service configurations...\n', 'blue')

    const projectRoot = PROJECT_ROOT

    const nginxConfig = this.generateMultiServiceNginxConfig(services)
    fs.writeFileSync(path.join(projectRoot, 'nginx-multi.conf'), nginxConfig)
    log('✓ Created nginx-multi.conf', 'green')

    const systemdServices = this.generateMultiServiceSystemd(services)
    for (const [name, content] of Object.entries(systemdServices)) {
      fs.writeFileSync(path.join(projectRoot, name), content)
      log(`✓ Created ${name}`, 'green')
    }

    const pm2Config = this.generatePm2Config(services)
    fs.writeFileSync(path.join(projectRoot, 'ecosystem.config.js'), pm2Config)
    log('✓ Created ecosystem.config.js (for PM2)', 'green')

    const dockerCompose = this.generateMultiServiceDockerCompose(services)
    fs.writeFileSync(path.join(projectRoot, 'docker-compose.multi.yml'), dockerCompose)
    log('✓ Created docker-compose.multi.yml', 'green')

    const serviceEntrypoints = this.generateServiceEntrypoints(services)
    const microservicesDir = path.join(projectRoot, 'microservices')
    if (!fs.existsSync(microservicesDir)) {
      fs.mkdirSync(microservicesDir, { recursive: true })
    }
    for (const [name, content] of Object.entries(serviceEntrypoints)) {
      fs.writeFileSync(path.join(microservicesDir, `${name}.js`), content)
      log(`✓ Created microservices/${name}.js`, 'green')
    }

    log('\n📋 Service Architecture:', 'yellow')
    log('------------------------\n', 'yellow')
    for (const svc of services) {
      log(`  ${svc.name.padEnd(12)} :${svc.port}  - ${svc.desc}`, 'reset')
    }

    log('\n🚀 Quick Start Options:', 'yellow')
    log('-----------------------\n', 'yellow')
    log('1. Using PM2 (recommended for single server):', 'reset')
    log('   npm install -g pm2', 'dim')
    log('   pm2 start ecosystem.config.js', 'dim')
    log('   pm2 logs', 'dim')

    log('\n2. Using systemd (recommended for production):', 'reset')
    log('   sudo cp *.service /etc/systemd/system/', 'dim')
    log('   sudo systemctl daemon-reload', 'dim')
    log('   sudo systemctl start voltage-api', 'dim')
    log('   sudo systemctl enable voltage-api voltage-websocket voltage-federation', 'dim')

    log('\n3. Using Docker:', 'reset')
    log('   docker-compose -f docker-compose.multi.yml up -d', 'dim')

    log('\n4. Using nginx:', 'reset')
    log('   nginx -c $(pwd)/nginx-multi.conf', 'dim')
    log('   (or include nginx-multi.conf in your nginx.conf)', 'dim')

    log('\n⚠️  Notes:', 'yellow')
    log('----------\n', 'yellow')
    log('- All services share the same database and Redis', 'reset')
    log('- API and WebSocket require sticky sessions', 'reset')
    log('- Federation needs its own API key in .env', 'reset')
    log('- Worker handles background jobs (notifications, etc.)', 'reset')

    log('\n')
  }

  generateMultiServiceNginxConfig(services) {
    let upstreamBlock = ''
    let locationBlock = ''

    for (const svc of services) {
      upstreamBlock += `
upstream voltage_${svc.name} {
  server 127.0.0.1:${svc.port};
}
`
      if (svc.name === 'api') {
        locationBlock += `
  location / {
    proxy_pass http://voltage_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
  }

  location /api {
    proxy_pass http://voltage_api;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /uploads {
    proxy_pass http://voltage_cdn;
    proxy_set_header Host $host;
  }
`
      }

      if (svc.name === 'websocket') {
        locationBlock += `
  location /socket.io {
    proxy_pass http://voltage_websocket;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400;
  }
`
      }

      if (svc.name === 'federation') {
        locationBlock += `
  location /federation {
    proxy_pass http://voltage_federation;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
`
      }
    }

    return `worker_processes auto;
error_log /var/log/nginx/error.log warn;

events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;

  log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                  '$status $body_bytes_sent "$http_referer" '
                  '"$http_user_agent" "$http_x_forwarded_for"';

  access_log /var/log/nginx/access.log main;

  sendfile on;
  tcp_nopush on;
  tcp_nodelay on;
  keepalive_timeout 65;
  types_hash_max_size 2048;

${upstreamBlock}
  server {
    listen 80;
    server_name localhost;

${locationBlock}
  }
}
`
  }

  generateMultiServiceSystemd(servicesList) {
    const systemdServices = {}

    for (const svc of servicesList) {
      systemdServices[`voltage-${svc.name}.service`] = `[Unit]
Description=Volt ${svc.desc}
After=network.target

[Service]
Type=simple
User=volt
WorkingDirectory=${PROJECT_ROOT}
ExecStart=/usr/bin/node ${PROJECT_ROOT}/microservices/${svc.name}.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=VOLT_SERVICE=${svc.name}

[Install]
WantedBy=multi-user.target
`
    }

    return systemdServices
  }

  generatePm2Config(services) {
    const apps = services.map(svc => ({
      name: `voltage-${svc.name}`,
      script: `./microservices/${svc.name}.js`,
      instances: svc.name === 'worker' ? 2 : 1,
      exec_mode: 'cluster' in svc && svc.cluster ? 'cluster' : 'fork',
      env: {
        NODE_ENV: 'production',
        VOLT_SERVICE: svc.name
      },
      error_file: `./logs/${svc.name}-error.log`,
      out_file: `./logs/${svc.name}-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: svc.name === 'api' ? '1G' : '512M',
      listen_timeout: 8000,
      kill_timeout: 5000
    }))

    return `module.exports = {
  apps: ${JSON.stringify(apps, null, 2)}
}
`
  }

  generateMultiServiceDockerCompose(services) {
    const svcList = services.map(svc => `  voltage-${svc.name}:
    image: voltage:latest
    container_name: volt-${svc.name}
    restart: unless-stopped
    ports:
      - "${svc.port}:${svc.port}"
    environment:
      - NODE_ENV=production
      - VOLT_SERVICE=${svc.name}
      - SERVER_URL=\${SERVER_URL}
      - JWT_SECRET=\${JWT_SECRET}
      - STORAGE_TYPE=sqlite
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
    depends_on:
      - redis
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:${svc.port}/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
`).join('\n')

    return `version: '3.8'

services:
${svcList}

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data

volumes:
  redis_data:
`
  }

  generateServiceEntrypoints(services) {
    const entrypoints = {}

    for (const svc of services) {
      if (svc.name === 'api') {
        entrypoints['api'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'api'
process.env.VOLT_API_ENABLED = 'true'
process.env.VOLT_WEBSOCKET_ENABLED = 'false'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[API Service] Starting API-only server on port ${svc.port}')
await import('../server.js')
`

        entrypoints['websocket'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'websocket'
process.env.VOLT_API_ENABLED = 'false'
process.env.VOLT_WEBSOCKET_ENABLED = 'true'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[WebSocket Service] Starting WebSocket-only server on port ${svc.port}')
await import('../server.js')
`

        entrypoints['federation'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'federation'
process.env.VOLT_API_ENABLED = 'false'
process.env.VOLT_WEBSOCKET_ENABLED = 'false'
process.env.VOLT_FEDERATION_ENABLED = 'true'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[Federation Service] Starting Federation-only server on port ${svc.port}')
await import('../server.js')
`

        entrypoints['cdn'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'cdn'
process.env.VOLT_API_ENABLED = 'true'
process.env.VOLT_WEBSOCKET_ENABLED = 'false'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[CDN Service] Starting CDN-only server on port ${svc.port}')
await import('../server.js')
`

        entrypoints['worker'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'worker'
process.env.VOLT_API_ENABLED = 'false'
process.env.VOLT_WEBSOCKET_ENABLED = 'false'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'true'
console.log('[Worker Service] Starting Background Worker')
await import('../server.js')
`
      } else if (svc.name === 'websocket') {
        entrypoints['websocket'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'websocket'
process.env.VOLT_API_ENABLED = 'false'
process.env.VOLT_WEBSOCKET_ENABLED = 'true'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[WebSocket Service] Starting WebSocket-only server on port ${svc.port}')
await import('../server.js')
`

        entrypoints['federation'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'federation'
process.env.VOLT_API_ENABLED = 'false'
process.env.VOLT_WEBSOCKET_ENABLED = 'false'
process.env.VOLT_FEDERATION_ENABLED = 'true'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[Federation Service] Starting Federation-only server on port ${svc.port}')
await import('../server.js')
`

        entrypoints['cdn'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'cdn'
process.env.VOLT_API_ENABLED = 'true'
process.env.VOLT_WEBSOCKET_ENABLED = 'false'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[CDN Service] Starting CDN-only server on port ${svc.port}')
await import('../server.js')
`

        entrypoints['worker'] = `import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'worker'
process.env.VOLT_API_ENABLED = 'false'
process.env.VOLT_WEBSOCKET_ENABLED = 'false'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'true'
console.log('[Worker Service] Starting Background Worker')
await import('../server.js')
`
      } else if (svc.name === 'federation') {
        entrypoints['federation'] = `import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()

process.env.VOLT_SERVICE = 'federation'

const app = express()
const config = require('../config/config.js')

app.use(cors())
app.use(express.json())

const federationRoutes = require('../routes/federationRoutes.js')
app.use('/federation', federationRoutes)

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'federation', timestamp: new Date().toISOString() })
})

const PORT = process.env.PORT || ${svc.port}

app.listen(PORT, () => {
  console.log('[Federation Server] Running on port ' + PORT)
})
`
      } else if (svc.name === 'cdn') {
        entrypoints['cdn'] = `import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config()

process.env.VOLT_SERVICE = 'cdn'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()

app.use(cors())
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'cdn', timestamp: new Date().toISOString() })
})

const PORT = process.env.PORT || ${svc.port}

app.listen(PORT, () => {
  console.log('[CDN Server] Running on port ' + PORT)
})
`
      } else if (svc.name === 'worker') {
        entrypoints['worker'] = `import dotenv from 'dotenv'

dotenv.config()

process.env.VOLT_SERVICE = 'worker'

const { startSystemScheduler } = require('../services/systemMessageScheduler.js')

console.log('[Worker Server] Starting background workers...')

startSystemScheduler(null)

console.log('[Worker Server] Workers running')

setInterval(() => {
  // Keep worker alive
}, 60000)
`
      }
    }

    return entrypoints
  }

  async generateConfig(type = 'default') {
    const configs = {
      default: {
        server: { name: 'Volt', mode: 'self-volt', url: 'http://localhost:5000' },
        storage: { type: 'json' },
        auth: { local: { enabled: true, allowRegistration: true } },
        features: { discovery: false, selfVolt: true }
      },
      mainline: {
        server: { name: 'Volt', mode: 'mainline', url: 'https://volt.chat' },
        storage: { type: 'sqlite' },
        auth: { local: { enabled: true, allowRegistration: true }, oauth: { enabled: true } },
        features: { discovery: true, selfVolt: true }
      },
      production: {
        server: { name: 'Volt', mode: 'mainline', url: 'https://your-domain.com' },
        storage: { type: 'sqlite' },
        cdn: { enabled: true, provider: 's3' },
        cache: { enabled: true, provider: 'redis' },
        auth: { local: { enabled: true, allowRegistration: true } },
        features: { discovery: true, selfVolt: true },
        monitoring: { enabled: true }
      }
    }

    const config = configs[type]
    if (!config) {
      log(`Unknown config type: ${type}`, 'red')
      log('Available: default, mainline, production', 'reset')
      return
    }

    const configPath = path.join(PROJECT_ROOT, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    log(`✓ Created ${type} config.json`, 'green')
  }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const scaler = new VoltageScaler()

  switch (command) {
    case 'setup':
      await scaler.setup({
        mode: args[1] || 'development',
        domain: args[2] || 'localhost',
        ssl: args.includes('--ssl')
      })
      break

    case 'status':
      await scaler.status()
      break

    case 'scale':
      await scaler.scale()
      break

    case 'split':
      await scaler.split()
      break

    case 'config':
      await scaler.generateConfig(args[1] || 'default')
      break

    default:
      log(`
⚡ Volt Scaling Helper
======================

Usage:
  volt scale <command> [options]

Commands:
  setup [mode] [domain]    Setup new instance
    Modes: development, production
    Options: --ssl

  status                    Show server status

  scale                     Show scaling options

  split                     Generate multi-service configs (microservices)

  config [type]             Generate config
    Types: default, mainline, production

Examples:
  volt scale setup production mydomain.com
  volt scale setup development localhost
  volt scale status
  volt scale split
  volt scale config production

Volt - Decentralized Chat Platform
      `, 'cyan')
  }
}

main().catch(console.error)
