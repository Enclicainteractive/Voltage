#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import vm from 'vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.join(__dirname, '..')

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
}

function log(msg, color = 'reset') {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`)
}

class VoltageBuilder {
  constructor() {
    this.outputDir = path.join(PROJECT_ROOT, 'dist')
    this.buildInfo = {
      version: '1.0.0',
      buildTime: new Date().toISOString(),
      commit: ''
    }
  }

  async build(options = {}) {
    const { minify = true } = options

    log('\n⚡ Voltage Builder', 'cyan')
    log('=================\n', 'cyan')

    try {
      this.buildInfo.commit = execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT }).toString().trim().slice(0, 7)
    } catch (e) {
      this.buildInfo.commit = 'unknown'
    }

    log('Version: ' + this.buildInfo.version, 'blue')
    log('Commit:  ' + this.buildInfo.commit, 'blue')
    log('Minify:  ' + (minify ? 'yes' : 'no') + '\n', 'blue')

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true })
    }

    log('📦 Building main bundle...', 'yellow')
    await this.buildMainBundle({ minify })

    log('📦 Building microservices...', 'yellow')
    await this.buildMicroservices({ minify })

    log('📦 Creating launcher scripts...', 'yellow')
    this.createLauncherScripts()

    log('📦 Creating production config...', 'yellow')
    this.createProductionConfig()

    this.createBuildManifest()

    log('\n✓ Build complete!', 'green')
    log('\nOutput: ' + this.outputDir, 'blue')
    log('\nUsage:', 'yellow')
    log('  node dist/voltage.js                    # Run all-in-one', 'reset')
    log('  node dist/voltage-micro.js               # Run microservices', 'reset')
    log('  pm2 start dist/ecosystem.config.js     # Run with PM2\n', 'reset')
  }

  checkSyntax(code, filename) {
    try {
      vm.compileFunction(code)
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err }
    }
  }

  async buildMainBundle(options) {
    const entryPoint = path.join(PROJECT_ROOT, 'server.js')
    const outputFile = path.join(this.outputDir, 'voltage.js')

    let code = fs.readFileSync(entryPoint, 'utf8')
    
    log('🔍 Checking for syntax errors...', 'yellow')
    const syntaxResult = this.checkSyntax(code, 'server.js')
    if (!syntaxResult.valid) {
      const err = syntaxResult.error
      const lineMatch = err.message.match(/line (\d+)/)
      const line = lineMatch ? lineMatch[1] : 'unknown'
      log(`✗ Syntax error in server.js:${line}: ${err.message}`, 'red')
      process.exit(1)
    }
    log('✓ No syntax errors found', 'green')

    const bundled = await this.bundleCode(code, options)

    fs.writeFileSync(outputFile, bundled)
    log('✓ Created voltage.js', 'green')
  }

  async buildMicroservices(options) {
    const microservicesDir = path.join(this.outputDir, 'microservices')
    if (!fs.existsSync(microservicesDir)) {
      fs.mkdirSync(microservicesDir, { recursive: true })
    }

    const services = ['api', 'websocket', 'federation', 'cdn', 'worker']
    
    for (const service of services) {
      const code = "import dotenv from 'dotenv'\ndotenv.config()\nprocess.env.VOLT_SERVICE = '" + service + "'\nprocess.env['VOLT_' + service.toUpperCase() + '_ENABLED'] = 'true'\nconsole.log('[" + service + "] Starting " + service + " service...')\nawait import('../server.js')\n"
      fs.writeFileSync(path.join(microservicesDir, service + '.js'), code)
      log('✓ Created microservices/' + service + '.js', 'green')
    }
  }

  async bundleCode(code, options) {
    let bundled = code

    if (options.minify) {
      bundled = bundled.replace(/\/\*[\s\S]*?\*\//g, '')
      bundled = bundled.replace(/\/\/.*/g, '')
      bundled = bundled.replace(/\n\s*\n/g, '\n')
    }

    bundled = '// Voltage v' + this.buildInfo.version + ' - Built ' + this.buildInfo.buildTime + '\n' + bundled

    return bundled
  }

  createLauncherScripts() {
    const launcher = '#!/bin/bash\n' +
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
      'cd "$SCRIPT_DIR"\n\n' +
      'MODE="${1:-all}"\n\n' +
      'case "$MODE" in\n' +
      '  all)\n' +
      '    echo "Starting Voltage in all-in-one mode..."\n' +
      '    node voltage.js\n' +
      '    ;;\n' +
      '  micro)\n' +
      '    echo "Starting Voltage in microservices mode..."\n' +
      '    node voltage-micro.js\n' +
      '    ;;\n' +
      '  api)\n' +
      '    echo "Starting Voltage API..."\n' +
      '    VOLT_SERVICE=api node microservices/api.js\n' +
      '    ;;\n' +
      '  ws|websocket)\n' +
      '    echo "Starting Voltage WebSocket..."\n' +
      '    VOLT_SERVICE=websocket node microservices/websocket.js\n' +
      '    ;;\n' +
      '  fed|federation)\n' +
      '    echo "Starting Voltage Federation..."\n' +
      '    VOLT_SERVICE=federation node microservices/federation.js\n' +
      '    ;;\n' +
      '  cdn)\n' +
      '    echo "Starting Voltage CDN..."\n' +
      '    VOLT_SERVICE=cdn node microservices/cdn.js\n' +
      '    ;;\n' +
      '  worker)\n' +
      '    echo "Starting Voltage Worker..."\n' +
      '    VOLT_SERVICE=worker node microservices/worker.js\n' +
      '    ;;\n' +
      '  *)\n' +
      '    echo "Usage: $0 [all|micro|api|ws|fed|cdn|worker]"\n' +
      '    exit 1\n' +
      '    ;;\n' +
      'esac\n'

    fs.writeFileSync(path.join(this.outputDir, 'voltage.sh'), launcher)
    fs.chmodSync(path.join(this.outputDir, 'voltage.sh'), '755')

    const winLauncher = `@echo off
set SCRIPT_DIR=%~dp0
cd /d %SCRIPT_DIR%

set MODE=%1
if "%MODE%"=="" set MODE=all

if "%MODE%"=="all" (
  echo Starting Voltage in all-in-one mode...
  node voltage.js
) else if "%MODE%"=="micro" (
  echo Starting Voltage in microservices mode...
  node voltage-micro.js
) else if "%MODE%"=="api" (
  echo Starting Voltage API...
  set VOLT_SERVICE=api
  node microservices/api.js
) else if "%MODE%"=="ws" (
  echo Starting Voltage WebSocket...
  set VOLT_SERVICE=websocket
  node microservices/websocket.js
) else if "%MODE%"=="fed" (
  echo Starting Voltage Federation...
  set VOLT_SERVICE=federation
  node microservices/federation.js
) else if "%MODE%"=="cdn" (
  echo Starting Voltage CDN...
  set VOLT_SERVICE=cdn
  node microservices/cdn.js
) else if "%MODE%"=="worker" (
  echo Starting Voltage Worker...
  set VOLT_SERVICE=worker
  node microservices/worker.js
) else (
  echo Usage: voltage.bat [all^|micro^|api^|ws^|fed^|cdn^|worker]
  exit /b 1
)
`

    fs.writeFileSync(path.join(this.outputDir, 'voltage.bat'), winLauncher)

    const microLauncher = `import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const services = {
  api: { port: 5000, file: 'microservices/api.js' },
  websocket: { port: 5001, file: 'microservices/websocket.js' },
  federation: { port: 5002, file: 'microservices/federation.js' },
  cdn: { port: 5003, file: 'microservices/cdn.js' },
  worker: { port: 5004, file: 'microservices/worker.js', instances: 2 }
}

const processes = new Map()

function startService(name, config) {
  console.log(\`[\${name}] Starting on port \${config.port}...\`)
  
  const child = spawn('node', [config.file], {
    env: { ...process.env, VOLT_SERVICE: name, PORT: config.port },
    cwd: __dirname,
    stdio: 'inherit'
  })

  processes.set(name, child)
  
  child.on('exit', (code) => {
    console.log(\`[\${name}] Exited with code \${code}\`)
    if (code !== 0) {
      setTimeout(() => startService(name, config), 3000)
    }
  })
}

console.log('Starting Voltage Microservices...\\n')

for (const [name, config] of Object.entries(services)) {
  startService(name, config)
}

process.on('SIGINT', () => {
  console.log('\\nShutting down...')
  for (const [name, child] of processes) {
    child.kill('SIGTERM')
  }
  process.exit(0)
})
`

    fs.writeFileSync(path.join(this.outputDir, 'voltage-micro.js'), microLauncher)

    log('✓ Created launcher scripts', 'green')
  }

  createProductionConfig() {
    const config = {
      server: {
        name: 'Volt',
        version: this.buildInfo.version,
        mode: 'production',
        port: 5000
      },
      storage: {
        type: 'sqlite',
        sqlite: {
          dbPath: './data/voltage.db'
        }
      },
      auth: {
        local: { enabled: true, allowRegistration: true }
      },
      features: {
        bots: true,
        e2eTrueEncryption: true,
        e2eEncryption: true
      },
      cache: {
        enabled: true,
        provider: 'redis'
      },
      cdn: {
        enabled: false,
        provider: 'local'
      },
      federation: {
        enabled: false
      },
      monitoring: {
        enabled: true,
        port: 5005
      }
    }

    fs.writeFileSync(path.join(this.outputDir, 'config.json'), JSON.stringify(config, null, 2))
    log('✓ Created production config.json', 'green')
  }

  createBuildManifest() {
    const manifest = {
      name: 'Voltage',
      version: this.buildInfo.version,
      buildTime: this.buildInfo.buildTime,
      commit: this.buildInfo.commit,
      files: [
        'voltage.js',
        'voltage-micro.js',
        'voltage.sh',
        'voltage.bat',
        'config.json',
        'ecosystem.config.js',
        'microservices/'
      ],
      services: {
        api: { port: 5000, description: 'Main API Server' },
        websocket: { port: 5001, description: 'WebSocket Server' },
        federation: { port: 5002, description: 'Federation Server' },
        cdn: { port: 5003, description: 'CDN/Uploads Server' },
        worker: { port: 5004, description: 'Background Worker' },
        manager: { port: 5005, description: 'Management API' }
      }
    }

    fs.writeFileSync(path.join(this.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    
    const pm2Config = `module.exports = {
  apps: [
    {
      name: 'voltage-api',
      script: 'microservices/api.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', VOLT_SERVICE: 'api', PORT: 5000 },
      error_file: 'logs/api-error.log',
      out_file: 'logs/api-out.log',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'voltage-websocket',
      script: 'microservices/websocket.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', VOLT_SERVICE: 'websocket', PORT: 5001 },
      error_file: 'logs/ws-error.log',
      out_file: 'logs/ws-out.log',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'voltage-federation',
      script: 'microservices/federation.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', VOLT_SERVICE: 'federation', PORT: 5002 },
      error_file: 'logs/fed-error.log',
      out_file: 'logs/fed-out.log',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'voltage-cdn',
      script: 'microservices/cdn.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', VOLT_SERVICE: 'cdn', PORT: 5003 },
      error_file: 'logs/cdn-error.log',
      out_file: 'logs/cdn-out.log',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'voltage-worker',
      script: 'microservices/worker.js',
      instances: 2,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', VOLT_SERVICE: 'worker', PORT: 5004 },
      error_file: 'logs/worker-error.log',
      out_file: 'logs/worker-out.log',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
}
`
    fs.writeFileSync(path.join(this.outputDir, 'ecosystem.config.js'), pm2Config)
    log('✓ Created PM2 ecosystem.config.js', 'green')
  }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const options = {
    minify: !args.includes('--no-minify'),
    sourceMaps: args.includes('--sourcemaps'),
    target: (args.find(a => a.startsWith('--target=')) || 'node18').split('=')[1] || 'node18'
  }

  const builder = new VoltageBuilder()

  switch (command) {
    case 'build':
      await builder.build(options)
      break

    case 'clean':
      log('\nCleaning build directory...', 'yellow')
      if (fs.existsSync(builder.outputDir)) {
        fs.rmSync(builder.outputDir, { recursive: true })
      }
      log('✓ Cleaned\n', 'green')
      break

    case 'help':
    default:
      log('\n⚡ Voltage Builder\n=================\n\nUsage:\n  npm run build [options]\n\nOptions:\n  --no-minify     Don\'t minify the output\n  --sourcemaps    Generate source maps\n  --target=node  Target Node.js version\n\nCommands:\n  build            Build the project\n  clean            Clean build directory\n\nExamples:\n  npm run build\n  npm run build --no-minify\n  npm run build --target=node20\n', 'cyan')
  }
}

main().catch(console.error)
