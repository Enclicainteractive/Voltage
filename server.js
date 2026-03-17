/**
 * VoltChat Server
 *
 * Main entry point for the VoltChat backend API server.
 * This file initializes Express, Socket.IO, and all middleware.
 *
 * @author VoltChat Team
 * @license MIT
 * @version 1.0.0
 *
 * ---------------------------------------------------------------------
 * IMPORTANT DEVELOPER NOTES:
 * ---------------------------------------------------------------------
 * This file has been through some shit. A lot of shit.
 * We're talking a metric shit-ton of shit.
 * If you touch it without knowing what you're doing, I will find you.
 * And I will make you fix it. personally. with my hands. violently.
 * - Bluet (probably)
 * ---------------------------------------------------------------------
 */

import cluster from 'cluster'
import os from 'os'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// JSON compatibility layer - handles differences in JSON handling across Node versions
//
// Honestly, this is the most annoying thing about Node sometimes.
// Just pick ONE way to handle JSON and STICK WITH IT.
// But no, that would be too EASY.
//
// Whoever decided JSON.stringify(undefined) should return undefined
// can fight me. Literally. I'll be outside.
import { installJsonCompat } from './services/jsonCompatService.js'

// Redis service - handles session management and pub/sub messaging
//
// If Redis dies, everything dies.
// We tried memcached once. Never again. Never.
// Redis is... fine. I guess. It's fine. Everything is fine.
import redisService from './services/redisService.js'

// Session manager - tracks active user sessions and WebSocket connections
//
// If you ever need to debug why users are getting disconnected,
// check here first. Probably here. Almost definitely here.
import sessionManager from './services/sessionManager.js'

// Rate limiter - prevents abuse and ensures fair usage
//
// Because people are ASSHOLES.
// And by "people" I mean "bots" but also some people honestly.
import rateLimiter from './services/rateLimiter.js'

// Health check endpoints - used by load balancers and orchestration
//
// Kubernetes wants them. Docker wants them. AWS wants them.
// Everyone wants health checks. It's like being in high school all over again.
import healthCheck from './services/healthCheck.js'

// WebSocket manager - handles all Socket.IO connections and events
//
// If this breaks, NOBODY can connect.
// Pressure test this thing. Please. I BEG you.
import wsManager from './services/wsManager.js'

// Message bus - pub/sub system for inter-service communication
//
// Very useful. Very annoying when it breaks.
import messageBus from './services/messageBus.js'

// Security event logging - records security-relevant events for auditing
//
// We log EVERYTHING. Because when something goes wrong, we need to know what.
import securityLogger from './services/securityLogger.js'

// Bot detection middleware - identifies and blocks automated clients
//
// This is an endless arms race.
// Bots get smarter, we get smarter, they get smarter, we...
import botDetector from './middleware/botDetection.js'

// Admin authorization middleware - protects admin-only routes
//
// If you add a new admin route, you NEED to use this.
import { requireAdmin, requireSuperAdmin } from './middleware/adminAuth.js'

// Security middleware stack - comprehensive request filtering
//
// If you're adding a new route, YOU NEED TO USE THESE.
import {
  securityHeaders,
  ipFilter,
  authRateLimit,
  loginRateLimit,
  apiRateLimit,
  sanitizeInput,
  validateContentType,
  preventClickjacking,
  requestSizeLimit,
  timeoutMiddleware,
  securityManager
} from './middleware/securityMiddleware.js'

// Input validation - ensures request data meets expected schemas
//
// Because trusting user input is a MISTAKE.
// ALWAYS VALIDATE YOUR INPUTS. I MEAN IT.
import inputValidator from './middleware/inputValidation.js'

/**
 * Global shutdown flag
 *
 * If this is true, we're in the process of dying.
 * // Don't start new connections, don't accept new requests, just die gracefully.
 *
 * We tried just calling process.exit() directly once.
 * // It didn't go well. Customers were... upset.
 */
let isShuttingDown = false

/**
 * Global exception handlers
 *
 * THIS IS THE END OF THE WORLD when these run.
 * We log EVERYTHING because we need to know what happened.
 */
process.on('uncaughtException', (err) => {
  console.error('\n[CRASH] Uncaught Exception:', err.message)
  console.error(err.stack)
  securityLogger.logSecurityEvent('CRASH', { type: 'uncaught', error: err.message, stack: err.stack })
  if (!isShuttingDown) {
    setTimeout(() => process.exit(1), 1000)
  }
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n[CRASH] Unhandled Rejection at:', promise, 'reason:', reason)
  securityLogger.logSecurityEvent('CRASH', { type: 'unhandled', reason: String(reason) })
  healthCheck.recordCheck('runtime.unhandledRejection', false, String(reason))
})

process.on('exit', (code) => {
  securityLogger.logSecurityEvent('PROCESS_EXIT', { code })
})

/**
 * Graceful shutdown handler
 *
 * THIS IS IMPORTANT. If we don't do graceful shutdown,
 * active connections get DROPPED and users get VERY confused.
 *
 * @param {string} signal - The signal that triggered shutdown
 */
const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return // don't shutdown twice you idiot
    isShuttingDown = true

    console.log(`\n[SIGNAL] Received ${signal}, initiating graceful shutdown...`)

    // If we're already draining, just force close.
    if (wsManager.draining) {
      console.log('[Shutdown] Already draining, forcing close')
      wsManager.forceCloseAll()
      await redisService.disconnect()
      process.exit(0)
      return
    }

    // Mark this scale node as offline before connections drain
    await scaleService.shutdown()

    // start draining - tell websockets to close
    // 30 seconds is plenty of time
    // if it takes longer, we force close anyway
    wsManager.startDrain(30000)

    console.log('[Shutdown] Waiting for connections to drain (30s)...')

    // wait for connections or timeout
    setTimeout(async () => {
      console.log('[Shutdown] Closing HTTP server...')
      httpServer.close(async () => {
        console.log('[Shutdown] HTTP server closed')
        await redisService.disconnect()
        console.log('[Shutdown] Redis disconnected')
        process.exit(0)
      })
    }, 25000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

//reminder to self make this not look assssssssss.
import userRoutes from './routes/userRoutes.js'
import serverRoutes from './routes/serverRoutes.js'
import channelRoutes from './routes/channelRoutes.js'
import messageRoutes from './routes/messageRoutes.js'
import dmRoutes from './routes/dmRoutes.js'
import authProxyRoutes from './routes/authProxyRoutes.js'
import uploadRoutes from './routes/uploadRoutes.js'
import voiceMessageRoutes from './routes/voiceMessageRoutes.js'
import imageRoutes from './routes/imageRoutes.js'
import mediaProxyRoutes from './routes/mediaProxyRoutes.js'
import inviteRoutes from './routes/inviteRoutes.js'
import discoveryRoutes from './routes/discoveryRoutes.js'
import adminRoutes from './routes/adminRoutes.js'
import e2eRoutes from './routes/e2eRoutes.js'
import selfVoltRoutes from './routes/selfVoltRoutes.js'
import authRoutes from './routes/authRoutes.js'
import pushRoutes from './routes/pushRoutes.js'
import adminConfigRoutes from './routes/adminConfigRoutes.js'
import migrationRoutes from './routes/migrationRoutes.js'
import importRoutes from './routes/importRoutes.js'
import federationRoutes, { buildFederationDiscoveryDocument, setupFederationRoutes } from './routes/federationRoutes.js'
import botRoutes from './routes/botRoutes.js'
import serverEventRoutes from './routes/serverEventRoutes.js'
import e2eTrueRoutes from './routes/e2eTrueRoutes.js'
import systemRoutes from './routes/systemRoutes.js'
import themeRoutes from './routes/themeRoutes.js'
import safetyRoutes from './routes/safetyRoutes.js'
import notificationSettingsRoutes from './routes/notificationSettingsRoutes.js'
import activityRoutes from './routes/activityRoutes.js'
import gifRoutes from './routes/gifRoutes.js'
import scaleRoutes from './routes/scaleRoutes.js'
import automodRoutes from './routes/automodRoutes.js'


import { authenticateSocket } from './middleware/authMiddleware.js'
import scaleService from './services/scaleService.js'
import { setupSocketHandlers } from './services/socketService.js'
import { startSystemScheduler } from './services/systemMessageScheduler.js'
import config from './config/config.js'
import { initStorageAndDistribute } from './services/storageService.js'
import dataService, { FILES, serverService } from './services/dataService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config()
config.load()

const numCPUs = os.cpus().length
const CLUSTER_MODE = process.env.VOLT_CLUSTER_MODE !== 'false' && !process.env.VOLT_SERVICE
const VOLT_WORKERS = parseInt(process.env.VOLT_WORKERS || '0', 10)
const MAX_WORKERS = VOLT_WORKERS > 0 ? VOLT_WORKERS : Math.max(2, Math.min(numCPUs, 8))

const isMaster = cluster.isMaster && CLUSTER_MODE
const isWorker = cluster.isWorker

if (isMaster) {
  console.log(`\n[Cluster] Master process starting with ${MAX_WORKERS} max workers`)

  const workerStats = new Map()
  
  // Optimize: Use execArgv to enable lazy loading and improve startup
  const workerOptions = {
    execArgv: ['--lazy', '--optimize-for-size', '--gc-interval=100']
  }

  cluster.on('online', (worker) => {
    console.log(`[Cluster] Worker ${worker.process.pid} is online`)
    workerStats.set(worker.id, {
      pid: worker.process.pid,
      connections: 0,
      cpu: 0,
      memory: 0,
      lastUpdate: Date.now()
    })
  })

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[Cluster] Worker ${worker.process.pid} died (${signal || code}). Restarting...`)
    workerStats.delete(worker.id)

    if (!isShuttingDown) {
      // Optimize: Faster restart with exponential backoff, but faster initial restart
      setTimeout(() => {
        cluster.fork(workerOptions)
      }, 500)
    }
  })

  cluster.on('message', (worker, msg) => {
    if (msg.type === 'stats') {
      const stats = workerStats.get(worker.id)
      if (stats) {
        stats.connections = msg.connections || 0
        stats.cpu = msg.cpu || 0
        stats.memory = msg.memory || 0
        stats.lastUpdate = Date.now()
      }
    }
  })

  let lastScaleCheck = Date.now()
  // Optimize: More frequent checks for faster response
  const SCALE_CHECK_INTERVAL = 15000
  const CPU_SCALE_THRESHOLD = 75
  const MEMORY_SCALE_THRESHOLD = 85

  const scaleWorkers = () => {
    if (isShuttingDown) return

    const now = Date.now()
    if (now - lastScaleCheck < SCALE_CHECK_INTERVAL) return
    lastScaleCheck = now

    let totalCpu = 0
    let totalMemory = 0
    let activeWorkers = 0

    for (const [id, stats] of workerStats) {
      if (now - stats.lastUpdate < 60000) {
        totalCpu += stats.cpu
        totalMemory += stats.memory
        activeWorkers++
      }
    }

    if (activeWorkers === 0) return

    const avgCpu = totalCpu / activeWorkers
    const avgMemory = totalMemory / activeWorkers

    console.log(`[Cluster] Avg CPU: ${avgCpu.toFixed(1)}%, Avg Memory: ${avgMemory.toFixed(1)}%, Workers: ${activeWorkers}`)

    if (avgCpu > CPU_SCALE_THRESHOLD || avgMemory > MEMORY_SCALE_THRESHOLD) {
      if (activeWorkers < MAX_WORKERS) {
        console.log(`[Cluster] Scaling up: adding worker`)
        cluster.fork(workerOptions)
      }
    } else if (avgCpu < 20 && avgMemory < 40 && activeWorkers > 2) {
      const workerIds = Array.from(workerStats.keys())
      if (workerIds.length > 0) {
        const oldestWorker = cluster.workers[workerIds[0]]
        if (oldestWorker) {
          console.log(`[Cluster] Scaling down: removing worker ${oldestWorker.process.pid}`)
          oldestWorker.kill()
        }
      }
    }
  }

  setInterval(scaleWorkers, SCALE_CHECK_INTERVAL)

  // Optimize: Start workers in parallel but staggered for faster startup
  for (let i = 0; i < Math.min(2, MAX_WORKERS); i++) {
    cluster.fork(workerOptions)
  }

  setTimeout(() => {
    scaleWorkers()
  }, 5000)

  process.on('SIGUSR2', () => {
    console.log('[Cluster] Received SIGUSR2, restarting all workers...')
    for (const id in cluster.workers) {
      cluster.workers[id].kill('SIGUSR2')
    }
  })
}

if (isWorker) {
  console.log(`[Cluster] Worker ${process.pid} starting...`)

  // Workers also need to initialize storage
  await initStorageAndDistribute()
  await dataService.initStorage()
  await dataService.initActivityTables()

  setInterval(() => {
    const memUsage = process.memoryUsage()
    const cpuUsage = process.cpuUsage()
    const totalCpu = (cpuUsage.user + cpuUsage.system) / 1000000
    
    if (cluster.worker) {
      cluster.worker.send({
        type: 'stats',
        connections: 0,
        cpu: totalCpu,
        memory: Math.round(memUsage.heapUsed / memUsage.heapLimit * 100)
      })
    }
  }, 5000)
}

await initStorageAndDistribute()
await redisService.connect()
await dataService.initStorage()
await dataService.initActivityTables()
await sessionManager.init()
rateLimiter.init()
messageBus.init()
wsManager.init()
healthCheck.resetUptime()
// Scale service: init after storage is ready, no-ops if scaling.enabled=false
await scaleService.init()

const app = express()
const httpServer = createServer(app)
app.set('trust proxy', 1)

const serverUrl = config.getServerUrl()
const corsOrigin = process.env.NODE_ENV === 'production'
? serverUrl
: ['http://localhost:3000', 'http://127.0.0.1:3000']

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    credentials: true
  },
  maxHttpBufferSize: 20 * 1024 * 1024 // 20MB — needed for drawing/activity payloads
})

// ── Redis Adapter for Socket.IO ────────────────────────────────────────────────
// When scaling is enabled (or when Redis is available), attach the Redis adapter
// so Socket.IO rooms/events work across all nodes behind the load balancer.
// Without this, a message emitted on node-1 won't reach sockets on node-2.
if (redisService.isReady()) {
  try {
    const { createAdapter } = await import('@socket.io/redis-adapter')
    const { pubClient, subClient } = redisService.getAdapterClients()
    io.adapter(createAdapter(pubClient, subClient))
    console.log('[Socket.IO] Redis adapter attached — cross-node socket events enabled')
  } catch (err) {
    console.warn('[Socket.IO] Could not attach Redis adapter:', err.message, '— running in single-node socket mode')
  }
}

// ─── Multi-Service Support ────────────────────────────────────────────────────────
// Support running services independently via VOLT_SERVICE or VOLT_*_ENABLED env vars
const voltService = process.env.VOLT_SERVICE

// Determine which services to enable based on VOLT_SERVICE or explicit flags
let apiEnabled = process.env.VOLT_API_ENABLED === 'true'
let wsEnabled = process.env.VOLT_WEBSOCKET_ENABLED === 'true'
let fedEnabled = process.env.VOLT_FEDERATION_ENABLED === 'true'
let workerEnabled = process.env.VOLT_WORKER_ENABLED === 'true'

// If VOLT_SERVICE is set, enable only that service by default
if (voltService) {
  apiEnabled = voltService === 'api' || voltService === 'cdn'
  wsEnabled = voltService === 'websocket'
  fedEnabled = voltService === 'federation'
  workerEnabled = voltService === 'worker'
} else if (!apiEnabled && !wsEnabled && !fedEnabled && !workerEnabled) {
  // If no specific service is set, enable all (default mode)
  apiEnabled = true
  wsEnabled = true
  fedEnabled = true
  workerEnabled = true
}

const serviceName = voltService || (apiEnabled ? 'api' : '') +
(wsEnabled ? '-websocket' : '') +
(fedEnabled ? '-federation' : '') +
(workerEnabled ? '-worker' : '') || 'all'

if (voltService || process.env.VOLT_API_ENABLED || process.env.VOLT_WEBSOCKET_ENABLED || process.env.VOLT_FEDERATION_ENABLED || process.env.VOLT_WORKER_ENABLED) {
  console.log(`\n>>> Running in service mode: ${serviceName}`)
  console.log(`>>> API: ${apiEnabled}, WebSocket: ${wsEnabled}, Federation: ${fedEnabled}, Worker: ${workerEnabled}\n`)
}

// Default ports for multi-service mode
const servicePorts = {
  api: 5000,
  websocket: 5001,
  federation: 5002,
  cdn: 5003,
  worker: 5004
}

const defaultPort = voltService ? (servicePorts[voltService] || 5000) : (config.config.server.port || 5000)

// Security middleware
app.use(securityHeaders)
app.use(preventClickjacking)
app.use(ipFilter)
app.use(requestSizeLimit)
app.use(timeoutMiddleware(30000))
app.use(sanitizeInput)
app.use(validateContentType)

// Global request logging
app.use((req, res, next) => {
  const start = Date.now()
  const ip = req.ip || req.socket.remoteAddress

  securityLogger.logApiAccess(ip, req.path, req.method, req.user?.id)

  const suspicious = securityLogger.analyzeRequest(req)
  if (suspicious.length > 0) {
    console.log(`[Security] Suspicious request from ${ip}:`, suspicious)
  }

  // Bot detection
  if (!req.path.startsWith('/api/health') && !req.path.startsWith('/api/monitor')) {
    const botAnalysis = botDetector.analyze(req)
    if (botDetector.shouldBlock(botAnalysis)) {
      securityLogger.logSecurityEvent('BOT_DETECTED', { ip, score: botAnalysis.score, reasons: botAnalysis.reasons })
      return res.status(403).json({ error: 'Access denied' })
    }
  }

  res.on('finish', () => {
    const duration = Date.now() - start
    if (res.statusCode >= 400 || duration > 5000) {
      console.log(`[Request] ${req.method} ${req.path} ${res.statusCode} ${duration}ms from ${ip}`)
    }
  })

  next()
})

// CORS configuration
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 86400,
}))

// Rate limiting
app.use('/api/auth', authRateLimit)
app.use('/api/auth/login', loginRateLimit)
app.use('/api', apiRateLimit)

app.use(express.json({ limit: '2gb' }))
app.use(express.urlencoded({ extended: true, limit: '2gb' }))

app.get('/.well-known/voltchat', (req, res) => {
  res.json(buildFederationDiscoveryDocument())
})

app.get('/.well-known/voltchat/mainnet', (req, res) => {
  res.json(buildFederationDiscoveryDocument())
})

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// Additional CORS headers for file serving
app.use('/api/upload/file', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET')
  res.header('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
})

app.use('/api/images', imageRoutes)
app.use('/api/media', mediaProxyRoutes)

app.use('/api/auth/proxy', authProxyRoutes)
// Alias routes for OAuth compatibility
app.use('/api/oauth', authProxyRoutes)

app.use('/api/auth', authRoutes)
app.use('/api/user', userRoutes)
app.use('/api/users', userRoutes) // Alias for backward compatibility
app.use('/api/servers', serverRoutes)
app.use('/api/channels', channelRoutes)
app.use('/api/messages', messageRoutes)
app.use('/api/dms', dmRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/voice-message', voiceMessageRoutes)
app.use('/api/invites', inviteRoutes)
app.use('/api/discovery', discoveryRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/admin/config', adminConfigRoutes)
app.use('/api/e2e', e2eRoutes)
app.use('/api/self-volt', selfVoltRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/migration', migrationRoutes)
app.use('/api/import', importRoutes)
app.use('/api/federation', federationRoutes)
app.use('/api/bots', botRoutes)
app.use('/api', serverEventRoutes)
app.use('/api/e2e-true', e2eTrueRoutes)
app.use('/api/system', systemRoutes)
app.use('/api/themes', themeRoutes)
app.use('/api/safety', safetyRoutes)
app.use('/api/notifications', notificationSettingsRoutes)
app.use('/api/activities', activityRoutes)
app.use('/api/gif', gifRoutes)
app.use('/api/gifs', gifRoutes)
app.use('/api/scale', scaleRoutes)
app.use('/api', automodRoutes)

// Global error handler - catches any unhandled errors from routes
app.use((err, req, res, next) => {
  console.error('[Error] Unhandled error in route:', err.message)
  console.error(err.stack)
  securityLogger.logSecurityEvent('ROUTE_ERROR', {
    path: req.path,
    method: req.method,
    error: err.message,
    stack: err.stack
  })
  res.status(500).json({ error: 'Internal server error' })
})

// Category routes at /api/categories
// Optimize: Only save categories that have actually changed
const getAllCategories = () => serverService.getAllCategoriesGrouped()
const setAllCategories = async (categories) => {
  if (!categories || typeof categories !== 'object') return
  
  for (const serverCategories of Object.values(categories)) {
    if (!Array.isArray(serverCategories)) continue
    for (const category of serverCategories) {
      if (category?.id) {
        // Get existing category to check if it changed
        const existing = await serverService.getCategory?.(category.id) 
        if (!existing || JSON.stringify(existing) !== JSON.stringify(category)) {
          await serverService.updateCategory(category.id, category)
        }
      }
    }
  }
}

app.put('/api/categories/:categoryId', async (req, res) => {
  const allCategories = getAllCategories()
  let foundCategory = null
  let serverId = null

  for (const [sid, categories] of Object.entries(allCategories)) {
    if (!Array.isArray(categories)) continue
      const idx = categories.findIndex(c => c.id === req.params.categoryId)
      if (idx !== -1) {
        foundCategory = categories[idx]
        serverId = sid
        break
      }
  }

  if (!foundCategory) {
    return res.status(404).json({ error: 'Category not found' })
  }

  for (const categories of Object.values(allCategories)) {
    if (!Array.isArray(categories)) continue
      const idx = categories.findIndex(c => c.id === req.params.categoryId)
      if (idx !== -1) {
        categories[idx] = { ...categories[idx], ...req.body, updatedAt: new Date().toISOString() }
        await setAllCategories(allCategories)

        io.to(`server:${serverId}`).emit('category:updated', categories[idx])
        console.log(`[API] Updated category ${req.params.categoryId}`)
        return res.json(categories[idx])
      }
  }
})

app.delete('/api/categories/:categoryId', async (req, res) => {
  if (req.params.categoryId === 'uncategorized') {
    return res.status(400).json({ error: 'Cannot delete uncategorized pseudo-category' })
  }

  const allCategories = getAllCategories()
  let serverId = null

  for (const [sid, categories] of Object.entries(allCategories)) {
    if (!Array.isArray(categories)) continue
      const idx = categories.findIndex(c => c.id === req.params.categoryId)
      if (idx !== -1) {
        serverId = sid
        break
      }
  }

  if (!serverId) {
    return res.status(404).json({ error: 'Category not found' })
  }

  allCategories[serverId] = toGroupedItems(allCategories[serverId]).filter(c => c.id !== req.params.categoryId)
  await setAllCategories(allCategories)

  io.to(`server:${serverId}`).emit('category:deleted', { categoryId: req.params.categoryId, serverId })

  console.log(`[API] Deleted category ${req.params.categoryId}`)
  res.json({ success: true })
})

app.get('/api/health', async (req, res) => {
  const healthStatus = await healthCheck.getStatus()
  const wsStats = wsManager.getStats()

  const clusterInfo = isMaster ? { mode: 'master' } : {
    mode: 'worker',
    pid: process.pid,
    workers: Object.keys(cluster.workers || {}).length
  }

  res.json({
    status: healthStatus.status,
    timestamp: new Date().toISOString(),
           server: config.config.server.name,
           version: config.config.server.version,
           mode: config.config.server.mode,
           url: config.getServerUrl(),
           service: serviceName,
           port: PORT,
           uptime: healthStatus.uptime,
           checks: healthStatus.results,
           cluster: CLUSTER_MODE ? clusterInfo : { mode: 'single' },
           websocket: {
             connections: wsStats.connections,
             uniqueUsers: wsStats.uniqueUsers,
             isDraining: wsStats.isDraining
           },
           redis: redisService.isReady(),
           features: {
             federation: config.config.federation?.enabled || false,
             bots: config.config.features?.bots || false,
             e2eTrueEncryption: config.config.features?.e2eTrueEncryption || false,
             e2eEncryption: config.config.features?.e2eEncryption || false
           },
           scaling: config.isScalingEnabled() ? {
             enabled: true,
             nodeId: config.getNodeId(),
             ...scaleService.getClusterStatus().summary
           } : { enabled: false }
  })
})

app.get('/api/health/ready', async (req, res) => {
  const ready = healthCheck.getReadiness()
  res.status(ready ? 200 : 503).json({ ready })
})

app.get('/api/health/live', async (req, res) => {
  const alive = healthCheck.getLiveness()
  res.status(alive ? 200 : 503).json({ alive })
})

app.get('/api/monitoring/stats', requireAdmin, (req, res) => {
  const wsStats = wsManager.getStats()
  res.json({
    uptime: process.uptime(),
           memory: process.memoryUsage(),
           cpu: process.cpuUsage(),
           connections: wsStats.connections,
           uniqueUsers: wsStats.uniqueUsers,
           serverRooms: wsStats.serverRooms,
           channelRooms: wsStats.channelRooms,
           messagesSent: wsStats.messagesSent,
           messagesReceived: wsStats.messagesReceived,
           isDraining: wsStats.isDraining,
           pid: process.pid,
           nodeVersion: process.version
  })
})

// Security admin endpoints - require admin auth
app.get('/api/admin/security/stats', requireAdmin, (req, res) => {
  const stats = securityLogger.getSecurityStats(7)
  const blacklistSize = securityManager.ipBlacklist.size
  const whitelistSize = securityManager.ipWhitelist.size

  res.json({
    security: stats,
    blacklist: blacklistSize,
    whitelist: whitelistSize,
    timestamp: Date.now()
  })
})

app.get('/api/admin/security/events', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10)
  const events = securityLogger.getRecentEvents(limit)
  res.json({ events })
})

app.post('/api/admin/security/blacklist', requireAdmin, (req, res) => {
  const { ip, action } = req.body

  if (!ip) {
    return res.status(400).json({ error: 'IP address required' })
  }

  if (action === 'add') {
    securityManager.addToBlacklist(ip)
    securityLogger.logBlockedIP(ip, 'manual_admin')
    res.json({ success: true, message: `IP ${ip} added to blacklist` })
  } else if (action === 'remove') {
    securityManager.removeFromBlacklist(ip)
    res.json({ success: true, message: `IP ${ip} removed from blacklist` })
  } else {
    res.status(400).json({ error: 'Invalid action' })
  }
})

app.get('/api/admin/security/blacklist', requireAdmin, (req, res) => {
  res.json({
    ips: Array.from(securityManager.ipBlacklist)
  })
})

app.get('/api/admin/security/bot-stats', requireAdmin, (req, res) => {
  res.json(botDetector.getStats())
})

io.use(authenticateSocket)

if (wsEnabled || (!apiEnabled && !fedEnabled && !workerEnabled)) {
  setupSocketHandlers(io)
}

if (fedEnabled || (!apiEnabled && !wsEnabled && !workerEnabled)) {
  setupFederationRoutes(io)
}

if (workerEnabled || (!apiEnabled && !wsEnabled && !fedEnabled)) {
  startSystemScheduler(io)
}

export { io }

const PORT = process.env.PORT || defaultPort

// Only start the HTTP server if we're not in cluster mode, or if we're the primary process
// In cluster mode, workers should NOT listen on the port - they handle requests forwarded from the master
const shouldStartServer = !CLUSTER_MODE || (isMaster && !isWorker) || (isWorker && cluster.worker?.id === 1)

// ─── ANSI color/style helpers ───────────────────────────────────────────────
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',

  // foreground
  white:   '\x1b[97m',
  gray:    '\x1b[90m',
  cyan:    '\x1b[96m',
  yellow:  '\x1b[93m',
  green:   '\x1b[92m',
  red:     '\x1b[91m',
  magenta: '\x1b[95m',
  blue:    '\x1b[94m',

  // background
  bgBlack: '\x1b[40m',
}

const enabled = (v) => v
? `${c.bold}${c.green}yes${c.reset}`
: `${c.dim}${c.gray}no${c.reset}`

const label = (text) => `${c.dim}${c.gray}${text.padEnd(15)}${c.reset}`
const val   = (text) => `${c.white}${text}${c.reset}`
const section = (text) => `${c.bold}${c.cyan}  ${text}${c.reset}`
const line  = (lbl, v) => `  ${label(lbl)} ${v}`

function printBanner(serverName, version, mode, storage, PORT) {

  //i hope this works >~< please render correctly.........
  const LOGO = `
  ${c.bold}${c.cyan}
  ___      ___  ________  ___   _________  ________  ________  _______
  |\\  \\    /  /|/\\   __  \\|\\  \\ |\\___   ___\\\\   __  \\|\\   ____\\|\\  ___ \\
  \\ \\  \\  /  / /\\ \\  \\|\\  \\ \\  \\\\|___ \\  \\_\\ \\  \\|\\  \\ \\  \\___|\\ \\   __/|
  \\ \\  \\/  / /  \\ \\  \\\\\\  \\ \\  \\    \\ \\  \\ \\ \\   __  \\ \\  \\  __\\ \\  \\_|/__
  \\ \\    / /    \\ \\  \\\\\\  \\ \\  \\____\\ \\  \\ \\ \\  \\ \\  \\ \\  \\|\\  \\ \\  \\_|\\ \\
  \\ \\__/ /      \\ \\_______\\ \\_______\\ \\__\\ \\ \\__\\ \\__\\ \\_______\\ \\_______\\
  \\|__|/        \\|_______|\\|_______|\\|__|  \\|__|\\|__|\\|_______|\\|_______|
  ${c.reset}`

  const DIVIDER   = `${c.dim}${c.gray}  ${'─'.repeat(60)}${c.reset}`
  const DIVIDER_S = `${c.dim}${c.gray}  ${'─'.repeat(60)}${c.reset}`

  console.log(LOGO)
  console.log(`  ${c.bold}${c.white}${serverName}${c.reset}  ${c.dim}${c.gray}v${version}${c.reset}   ${c.yellow}${mode}${c.reset}`)
  console.log()
  console.log(DIVIDER)
  console.log()

  // Server
  console.log(section('Server'))
  console.log(line('Host',    val(config.getHost())))
  console.log(line('URL',     `${c.cyan}${config.getServerUrl()}${c.reset}`))
  console.log(line('Port',    val(PORT)))
  console.log()

  // Storage
  console.log(section('Storage'))
  console.log(line('Type', val(storage.type)))


  /*
   *
   *
   * UWU IF ELSE CHAINS
   *
   *
   */
  if (storage.type === 'json') {
    console.log(line('Data dir', val(storage.json?.dataDir || './data')))
  } else if (storage.type === 'sqlite') {
    console.log(line('DB path', val(storage.sqlite?.dbPath || './data/voltage.db')))
  } else if (['mysql', 'mariadb'].includes(storage.type)) {
    const s = storage[storage.type]
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || 3306}`)))
    console.log(line('Database', val(s?.database || 'voltchat')))
  } else if (['postgres', 'cockroachdb'].includes(storage.type)) {
    const s = storage[storage.type]
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || (storage.type === 'postgres' ? 5432 : 26257)}`)))
    console.log(line('Database', val(s?.database || 'voltchat')))
  } else if (storage.type === 'mssql') {
    const s = storage.mssql
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || 1433}`)))
    console.log(line('Database', val(s?.database || 'voltchat')))
  } else if (storage.type === 'mongodb') {
    const s = storage.mongodb
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || 27017}`)))
    console.log(line('Database', val(s?.database || 'voltchat')))
  } else if (storage.type === 'redis') {
    const s = storage.redis
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || 6379}`)))
    console.log(line('DB', val(s?.db ?? 0)))
  } //MESSY CODE NEED TO CLEANUP LATER
  console.log()

  // Auth lots of auth
  console.log(section('Auth'))
  console.log(line('Local',        enabled(config.isLocalAuthEnabled())))
  console.log(line('Registration', enabled(config.config.auth?.local?.allowRegistration)))
  console.log(line('OAuth',        enabled(config.isOAuthEnabled())))
  if (config.isOAuthEnabled()) {
    console.log(line('Provider', val(config.config.auth?.oauth?.provider || 'enclica')))
  }
  console.log()

  // CDN
  console.log(section('CDN'))
  console.log(line('Enabled', enabled(config.isCdnEnabled())))
  if (config.isCdnEnabled()) {
    console.log(line('Provider', val(config.config.cdn?.provider || 'local')))
  }
  console.log()

  // Federation
  console.log(section('Federation'))
  console.log(line('Enabled', enabled(config.config.federation?.enabled)))
  if (config.config.federation?.enabled) {
    console.log(line('Server name', val(config.config.federation.serverName || 'N/A')))
  }
  console.log()

  // Scaling
  const scaleCfg = config.getScalingConfig()
  console.log(section('Scaling'))
  console.log(line('Enabled', enabled(scaleCfg.enabled)))
  if (scaleCfg.enabled) {
    console.log(line('Node ID',    val(scaleCfg.nodeId || '(not set)')))
    console.log(line('Node URL',   val(scaleCfg.nodeUrl || config.getServerUrl())))
    console.log(line('Peers',      val(String((scaleCfg.nodes || []).length - 1 > 0 ? (scaleCfg.nodes.length - 1) : scaleCfg.nodes.length) + ' configured')))
    console.log(line('File mode',  val(scaleCfg.fileResolutionMode || 'proxy')))
  }
  console.log()

  // Features
  console.log(section('Features'))
  console.log(line('Bots',     enabled(config.config.features?.bots)))
  console.log(line('True E2EE',enabled(config.config.features?.e2eTrueEncryption)))
  console.log(line('E2EE',     enabled(config.config.features?.e2eEncryption)))
  console.log()

  console.log(DIVIDER_S)
  console.log()
  console.log(`  ${c.dim}${c.gray}Ready.  Listening on port ${c.reset}${c.bold}${c.white}${PORT}${c.reset}`)
  console.log()
}

if (shouldStartServer) {
  httpServer.listen(PORT, () => {
    const serverName = config.config.server.name || 'Volt'
    const version    = config.config.server.version || '1.0.0'
    const mode       = config.config.server.mode || 'mainline'
    const storage    = config.config.storage

    printBanner(serverName, version, mode, storage, PORT)
  })
} else {
  // In cluster mode, workers don't directly listen on the port
  // The printBanner won't be shown, but the worker is ready
  console.log(`[Worker] Worker ${process.pid} ready, handling requests`)
}
