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

    log('\n')
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

  config [type]             Generate config
    Types: default, mainline, production

Examples:
  volt scale setup production mydomain.com
  volt scale setup development localhost
  volt scale status
  volt scale config production

Volt - Decentralized Chat Platform
      `, 'cyan')
  }
}

main().catch(console.error)
