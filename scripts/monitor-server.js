import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import axios from 'axios'

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

const SERVICE_PORTS = {
  api: 5000,
  websocket: 5001,
  federation: 5002,
  cdn: 5003,
  worker: 5004
}

const services = {
  api: { status: 'unknown', stats: {}, history: [] },
  websocket: { status: 'unknown', stats: {}, history: [] },
  federation: { status: 'unknown', stats: {}, history: [] },
  cdn: { status: 'unknown', stats: {}, history: [] },
  worker: { status: 'unknown', stats: {}, history: [] }
}

let globalStats = {
  totalConnections: 0,
  totalUsers: 0,
  uptime: Date.now(),
  messagesPerSecond: 0,
  requestsPerSecond: 0,
  startTime: Date.now()
}

let messageCount = 0
let requestCount = 0

setInterval(() => {
  globalStats.messagesPerSecond = messageCount
  globalStats.requestsPerSecond = requestCount
  messageCount = 0
  requestCount = 0
}, 1000)

async function checkService(name, port) {
  try {
    const response = await axios.get(`http://localhost:${port}/api/health`, {
      timeout: 5000
    })
    services[name].status = 'healthy'
    services[name].stats = response.data
    services[name].lastCheck = Date.now()
    
    if (response.data.websocket) {
      globalStats.totalConnections = response.data.websocket.connections || 0
      globalStats.totalUsers = response.data.websocket.uniqueUsers || 0
    }
    
    return true
  } catch (err) {
    services[name].status = 'unhealthy'
    return false
  }
}

async function updateAllServices() {
  for (const [name, port] of Object.entries(SERVICE_PORTS)) {
    await checkService(name, port)
    
    services[name].history.push({
      timestamp: Date.now(),
      connections: services[name].stats?.websocket?.connections || 0,
      users: services[name].stats?.websocket?.uniqueUsers || 0
    })
    
    if (services[name].history.length > 60) {
      services[name].history.shift()
    }
  }
}

setInterval(updateAllServices, 5000)
updateAllServices()

app.get('/api/monitor/stats', (req, res) => {
  requestCount++
  res.json({
    global: {
      ...globalStats,
      uptimeMs: Date.now() - globalStats.startTime,
      uptime: Math.floor((Date.now() - globalStats.startTime) / 1000)
    },
    services,
    timestamp: Date.now()
  })
})

app.get('/api/monitor/services', (req, res) => {
  requestCount++
  res.json(services)
})

app.get('/api/monitor/history/:service', (req, res) => {
  requestCount++
  const { service } = req.params
  if (services[service]) {
    res.json(services[service].history)
  } else {
    res.status(404).json({ error: 'Service not found' })
  }
})

io.on('connection', (socket) => {
  console.log('[Monitor] Client connected')

  const emitStats = () => {
    socket.emit('stats', {
      global: {
        ...globalStats,
        uptimeMs: Date.now() - globalStats.startTime,
        uptime: Math.floor((Date.now() - globalStats.startTime) / 1000)
      },
      services
    })
  }

  emitStats()
  const interval = setInterval(emitStats, 2000)

  socket.on('disconnect', () => {
    clearInterval(interval)
  })
})

const MONITOR_PORT = process.env.MONITOR_PORT || 5050

httpServer.listen(MONITOR_PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║     Voltage Monitoring Dashboard                   ║
║     Running on http://localhost:${MONITOR_PORT}              ║
╚════════════════════════════════════════════════════╝

Endpoints:
  - GET /api/monitor/stats    - Global statistics
  - GET /api/monitor/services - Service status
  - GET /api/monitor/history/:service - Service history
  - WS  /                    - Real-time updates

  `)
})

process.on('SIGTERM', () => {
  console.log('[Monitor] Shutting down...')
  httpServer.close()
  process.exit(0)
})
