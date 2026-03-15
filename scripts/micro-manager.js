#!/usr/bin/env node

import { spawn, execSync } from 'child_process'
import { createServer } from 'http'
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

const SERVICES = {
  api: {
    name: 'api',
    port: 5000,
    description: 'Main API Server',
    env: { VOLT_SERVICE: 'api' },
    healthEndpoint: '/api/health',
    critical: true
  },
  websocket: {
    name: 'websocket',
    port: 5001,
    description: 'WebSocket Server',
    env: { VOLT_SERVICE: 'websocket' },
    healthEndpoint: '/api/health',
    critical: true
  },
  federation: {
    name: 'federation',
    port: 5002,
    description: 'Federation Server',
    env: { VOLT_SERVICE: 'federation' },
    healthEndpoint: '/api/health',
    critical: false
  },
  cdn: {
    name: 'cdn',
    port: 5003,
    description: 'CDN/Uploads Server',
    env: { VOLT_SERVICE: 'cdn' },
    healthEndpoint: '/api/health',
    critical: false
  },
  worker: {
    name: 'worker',
    port: 5004,
    description: 'Background Worker',
    env: { VOLT_SERVICE: 'worker' },
    healthEndpoint: '/api/health',
    critical: false,
    instances: 2
  }
}

const CONFIG = {
  managerPort: 5005,
  checkInterval: 30000,
  maxRestarts: 10,
  restartDelay: 5000
}

class MicroserviceManager {
  constructor() {
    this.processes = new Map()
    this.status = new Map()
    this.restartCounts = new Map()
    this.startTime = Date.now()
    this.managementApi = null
  }

  async startAll(services = Object.keys(SERVICES)) {
    log('\n⚡ Starting Voltage Microservices', 'cyan')
    log('====================================\n', 'cyan')

    for (const serviceName of services) {
      if (SERVICES[serviceName]) {
        await this.startService(serviceName)
      }
    }

    this.startHealthChecker()
    this.startManagementApi()
    this.printStatus()

    log('\n✓ All services started', 'green')
    log(`\n📊 Management UI: http://localhost:${CONFIG.managerPort}`, 'blue')
    log('🔧 Management API: http://localhost:${CONFIG.managerPort}/api/manager\n', 'blue')
  }

  async startService(serviceName) {
    const service = SERVICES[serviceName]
    if (!service) {
      log(`Unknown service: ${serviceName}`, 'red')
      return false
    }

    log(`Starting ${serviceName}...`, 'yellow')

    const env = {
      ...process.env,
      ...service.env,
      PORT: service.port,
      NODE_ENV: 'production'
    }

    const child = spawn('node', ['server.js'], {
      env,
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n')
      lines.forEach(line => {
        if (line.trim()) {
          console.log(`[${serviceName}] ${line}`)
        }
      })
    })

    child.stderr.on('data', (data) => {
      console.error(`[${serviceName} ERROR] ${data.toString().trim()}`)
    })

    child.on('exit', (code) => {
      log(`[${serviceName}] Process exited with code ${code}`, 'red')
      this.handleCrash(serviceName, code)
    })

    child.on('error', (err) => {
      log(`[${serviceName}] Error: ${err.message}`, 'red')
    })

    this.processes.set(serviceName, child)
    this.status.set(serviceName, { running: true, pid: child.pid, port: service.port })
    this.restartCounts.set(serviceName, 0)

    return true
  }

  async handleCrash(serviceName, exitCode) {
    const service = SERVICES[serviceName]
    const restarts = this.restartCounts.get(serviceName) || 0

    if (restarts >= CONFIG.maxRestarts) {
      log(`[${serviceName}] Max restarts reached, giving up`, 'red')
      this.status.set(serviceName, { running: false, restarts, error: 'Max restarts reached' })
      return
    }

    if (service.critical || restarts < 3) {
      log(`[${serviceName}] Restarting in ${CONFIG.restartDelay}ms...`, 'yellow')
      this.restartCounts.set(serviceName, restarts + 1)
      
      setTimeout(() => {
        this.startService(serviceName)
      }, CONFIG.restartDelay)
    }
  }

  stopService(serviceName) {
    const child = this.processes.get(serviceName)
    if (child) {
      child.kill('SIGTERM')
      this.processes.delete(serviceName)
      this.status.set(serviceName, { running: false, stopped: true })
      log(`[${serviceName}] Stopped`, 'yellow')
      return true
    }
    return false
  }

  async restartService(serviceName) {
    this.stopService(serviceName)
    await new Promise(r => setTimeout(r, 1000))
    return this.startService(serviceName)
  }

  startHealthChecker() {
    setInterval(async () => {
      for (const [name, service] of Object.entries(SERVICES)) {
        const status = this.status.get(name)
        if (status && status.running) {
          try {
            const response = await fetch(`http://localhost:${service.port}${service.healthEndpoint}`, {
              method: 'GET',
              signal: AbortSignal.timeout(5000)
            })
            status.healthy = response.ok
            status.lastCheck = Date.now()
          } catch (err) {
            status.healthy = false
            status.lastError = err.message
          }
        }
      }
    }, CONFIG.checkInterval)
  }

  startManagementApi() {
    const app = express()
    app.use(cors())
    app.use(express.json())

    app.get('/api/manager/health', (req, res) => {
      res.json({ status: 'ok', uptime: Date.now() - this.startTime })
    })

    app.get('/api/manager/services', (req, res) => {
      const services = {}
      for (const [name, service] of Object.entries(SERVICES)) {
        services[name] = {
          ...service,
          status: this.status.get(name) || { running: false }
        }
      }
      res.json(services)
    })

    app.get('/api/manager/service/:name', (req, res) => {
      const { name } = req.params
      const service = SERVICES[name]
      if (!service) {
        return res.status(404).json({ error: 'Service not found' })
      }
      res.json({
        ...service,
        status: this.status.get(name) || { running: false }
      })
    })

    app.post('/api/manager/service/:name/start', async (req, res) => {
      const { name } = req.params
      const result = await this.startService(name)
      res.json({ success: result, name })
    })

    app.post('/api/manager/service/:name/stop', (req, res) => {
      const { name } = req.params
      const result = this.stopService(name)
      res.json({ success: result, name })
    })

    app.post('/api/manager/service/:name/restart', async (req, res) => {
      const { name } = req.params
      const result = await this.restartService(name)
      res.json({ success: result, name })
    })

    app.post('/api/manager/restart-all', async (req, res) => {
      for (const name of Object.keys(SERVICES)) {
        this.stopService(name)
      }
      await new Promise(r => setTimeout(r, 2000))
      for (const name of Object.keys(SERVICES)) {
        await this.startService(name)
      }
      res.json({ success: true })
    })

    app.post('/api/manager/stop-all', (req, res) => {
      for (const name of Object.keys(SERVICES)) {
        this.stopService(name)
      }
      res.json({ success: true })
    })

    app.get('/api/manager/logs/:name', (req, res) => {
      const { name } = req.params
      const logsPath = path.join(__dirname, 'logs', `${name}.log`)
      try {
        if (fs.existsSync(logsPath)) {
          const logs = fs.readFileSync(logsPath, 'utf8').split('\n').slice(-100)
          res.json({ logs: logs.join('\n') })
        } else {
          res.json({ logs: '' })
        }
      } catch (err) {
        res.status(500).json({ error: err.message })
      }
    })

    app.get('/api/manager/stats', (req, res) => {
      const stats = {
        uptime: Date.now() - this.startTime,
        services: {},
        total: {
          running: 0,
          stopped: 0,
          healthy: 0
        }
      }

      for (const [name, service] of Object.entries(SERVICES)) {
        const status = this.status.get(name) || { running: false }
        stats.services[name] = status
        if (status.running) stats.total.running++
        else stats.total.stopped++
        if (status.healthy) stats.total.healthy++
      }

      res.json(stats)
    })

    app.get('/api/manager/config', (req, res) => {
      res.json(CONFIG)
    })

    app.listen(CONFIG.managerPort, () => {
      log(`✓ Management API running on port ${CONFIG.managerPort}`, 'green')
    })
  }

  printStatus() {
    log('\n📋 Service Status:', 'cyan')
    log('------------------\n', 'cyan')
    
    for (const [name, service] of Object.entries(SERVICES)) {
      const status = this.status.get(name)
      const running = status?.running ? '✓' : '✗'
      const color = status?.running ? 'green' : 'red'
      log(`  ${running} ${name.padEnd(12)} :${service.port}  ${service.description}`, color)
    }

    log('\n')
  }

  stopAll() {
    log('\n⚠ Stopping all services...', 'yellow')
    for (const name of Object.keys(SERVICES)) {
      this.stopService(name)
    }
    log('✓ All services stopped', 'green')
  }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  const manager = new MicroserviceManager()

  process.on('SIGINT', () => {
    log('\n⚠ Shutting down...', 'yellow')
    manager.stopAll()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    manager.stopAll()
    process.exit(0)
  })

  switch (command) {
    case 'start':
      const services = args[1] ? args[1].split(',') : Object.keys(SERVICES)
      await manager.startAll(services)
      break

    case 'stop':
      manager.stopAll()
      break

    case 'restart':
      await manager.startAll()
      break

    case 'status':
      log('\n📋 Service Status:', 'cyan')
      for (const [name, service] of Object.entries(SERVICES)) {
        log(`  ${name.padEnd(12)} :${service.port}`, 'reset')
      }
      break

    case 'help':
    default:
      log(`
⚡ Voltage Microservice Manager
==============================

Usage:
  npm run micro <command>

Commands:
  start [services]    Start services (comma-separated, or all)
  stop                Stop all services
  restart             Restart all services
  status              Show service status

Examples:
  npm run micro start           # Start all services
  npm run micro start api       # Start only API
  npm run micro start api,ws    # Start API and WebSocket
  npm run micro stop           # Stop all services
  npm run micro restart        # Restart all services

Management:
  Web UI:      http://localhost:${CONFIG.managerPort}
  API:         http://localhost:${CONFIG.managerPort}/api/manager

Service Ports:
  API:         5000
  WebSocket:   5001
  Federation:  5002
  CDN:         5003
  Worker:      5004
  Manager:    ${CONFIG.managerPort}
`, 'cyan')
  }
}

main().catch(console.error)
