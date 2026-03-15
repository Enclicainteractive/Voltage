#!/usr/bin/env node

import { spawn } from 'child_process'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import axios from 'axios'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SERVICES = [
  { name: 'API', port: 5000, healthPath: '/api/health' },
  { name: 'WebSocket', port: 5001, healthPath: '/api/health' },
  { name: 'Federation', port: 5002, healthPath: '/api/health' },
  { name: 'CDN', port: 5003, healthPath: '/api/health' },
  { name: 'Worker', port: 5004, healthPath: '/api/health' }
]

const LOGS_DIR = path.join(__dirname, 'logs')
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true })
}

class ServiceManager {
  constructor() {
    this.processes = new Map()
    this.running = false
    this.servicePorts = {}
  }

  log(service, message, type = 'info') {
    const timestamp = new Date().toISOString()
    const colors = {
      info: '\x1b[36m',
      success: '\x1b[32m',
      error: '\x1b[31m',
      warn: '\x1b[33m'
    }
    const color = colors[type] || colors.info
    console.log(`${color}[${service}]${'\x1b[0m'} ${message}`)
    
    const logFile = path.join(LOGS_DIR, `${service.toLowerCase()}-manager.log`)
    fs.appendFileSync(logFile, `[${timestamp}] [${type.toUpperCase()}] ${message}\n`)
  }

  async checkHealth(port, path) {
    try {
      const response = await axios.get(`http://localhost:${port}${path}`, {
        timeout: 5000,
        validateStatus: () => true
      })
      return response.status === 200
    } catch {
      return false
    }
  }

  async waitForService(service, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      const healthy = await this.checkHealth(service.port, service.healthPath)
      if (healthy) {
        this.log(service.name, `Ready after ${i + 1} attempts`, 'success')
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    this.log(service.name, `Failed to start after ${maxAttempts} attempts`, 'error')
    return false
  }

  async startService(service) {
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'production',
        VOLT_SERVICE: service.name.toLowerCase(),
        PORT: service.port,
        VOLT_API_ENABLED: service.name === 'API' ? 'true' : 'false',
        VOLT_WEBSOCKET_ENABLED: service.name === 'WebSocket' ? 'true' : 'false',
        VOLT_FEDERATION_ENABLED: service.name === 'Federation' ? 'true' : 'false',
        VOLT_WORKER_ENABLED: service.name === 'Worker' ? 'true' : 'false'
      }

      const proc = spawn('node', ['server.js'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      })

      const outLog = fs.openSync(path.join(LOGS_DIR, `${service.name.toLowerCase()}-out.log`), 'a')
      const errLog = fs.openSync(path.join(LOGS_DIR, `${service.name.toLowerCase()}-error.log`), 'a')

      proc.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n')
        for (const line of lines) {
          if (line) console.log(line)
        }
        fs.writeSync(outLog, data)
      })

      proc.stderr.on('data', (data) => {
        const lines = data.toString().trim().split('\n')
        for (const line of lines) {
          if (line) console.error(`\x1b[31m${line}\x1b[0m`)
        }
        fs.writeSync(errLog, data)
      })

      proc.on('exit', (code) => {
        this.log(service.name, `Process exited with code ${code}`, 'error')
        this.processes.delete(service.name)
        
        if (this.running && code !== 0) {
          this.log(service.name, 'Restarting service...', 'warn')
          setTimeout(() => this.startService(service), 2000)
        }
      })

      this.processes.set(service.name, proc)
      this.log(service.name, `Starting on port ${service.port}...`)
      
      resolve()
    })
  }

  async startAll() {
    console.log('\n\x1b[36m╔════════════════════════════════════════╗\x1b[0m')
    console.log('\x1b[36m║    Voltage Service Manager v1.0        ║\x1b[0m')
    console.log('\x1b[36m╚════════════════════════════════════════╝\x1b[0m\n')

    this.running = true
    this.log('Manager', 'Starting all services...', 'info')

    const enabledServices = process.env.SERVICES 
      ? process.env.SERVICES.split(',').map(s => s.trim())
      : SERVICES.map(s => s.name)

    const startPromises = SERVICES
      .filter(s => enabledServices.includes(s.name))
      .map(service => this.startService(service))

    await Promise.all(startPromises)

    this.log('Manager', 'Waiting for services to be ready...', 'info')

    const healthPromises = SERVICES
      .filter(s => enabledServices.includes(s.name))
      .map(service => this.waitForService(service))

    const results = await Promise.all(healthPromises)

    console.log('\n')
    if (results.every(r => r)) {
      this.log('Manager', 'All services started successfully!', 'success')
      console.log('\n\x1b[32m✓ All services are running\x1b[0m\n')
      console.log('Service endpoints:')
      for (const service of SERVICES.filter(s => enabledServices.includes(s.name))) {
        console.log(`  \x1b[36m${service.name}:\x1b[0m http://localhost:${service.port}`)
      }
      console.log('\nUse \x1b[33mnpm run start:stop\x1b[0m to stop all services\n')
    } else {
      this.log('Manager', 'Some services failed to start', 'error')
    }
  }

  async stopAll() {
    this.running = false
    this.log('Manager', 'Stopping all services...', 'warn')

    const stopPromises = Array.from(this.processes.entries()).map(async ([name, proc]) => {
      try {
        proc.kill('SIGTERM')
        this.log(name, 'Sent SIGTERM')
        
        await new Promise((resolve) => {
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGKILL')
            }
            resolve()
          }, 5000)
        })
      } catch (err) {
        this.log(name, `Error stopping: ${err.message}`, 'error')
      }
    })

    await Promise.all(stopPromises)
    this.processes.clear()
    this.log('Manager', 'All services stopped', 'success')
  }

  async restartService(serviceName) {
    const service = SERVICES.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
    if (!service) {
      this.log('Manager', `Service ${serviceName} not found`, 'error')
      return
    }

    const proc = this.processes.get(service.name)
    if (proc) {
      proc.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    await this.startService(service)
    await this.waitForService(service)
    this.log('Manager', `Service ${serviceName} restarted`, 'success')
  }

  async status() {
    console.log('\n\x1b[36m╔════════════════════════════════════════╗\x1b[0m')
    console.log('\x1b[36m║    Voltage Service Status              ║\x1b[0m')
    console.log('\x1b[36m╚════════════════════════════════════════╝\x1b[0m\n')

    for (const service of SERVICES) {
      const healthy = await this.checkHealth(service.port, service.healthPath)
      const status = healthy ? '\x1b[32mRunning\x1b[0m' : '\x1b[31mStopped\x1b[0m'
      console.log(`  ${service.name.padEnd(15)} ${status.padEnd(10)} :${service.port}`)
    }
    console.log('')
  }
}

const manager = new ServiceManager()

const command = process.argv[2]

switch (command) {
  case 'start':
    manager.startAll()
    break
  case 'stop':
    manager.stopAll()
    break
  case 'restart':
    if (process.argv[3]) {
      manager.restartService(process.argv[3])
    } else {
      manager.stopAll().then(() => manager.startAll())
    }
    break
  case 'status':
    manager.status()
    break
  default:
    console.log(`
Usage: npm run start:all [command]

Commands:
  start           Start all services
  stop            Stop all services
  restart [name]  Restart all or specific service
  status          Show service status

Examples:
  npm run start:all start
  npm run start:all status
  npm run start:all restart websocket
`)
    break
}

process.on('SIGINT', async () => {
  console.log('\n\n\x1b[33mReceived SIGINT, shutting down...\x1b[0m')
  await manager.stopAll()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await manager.stopAll()
  process.exit(0)
})
