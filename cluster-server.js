#!/usr/bin/env node

const cluster = require('cluster')
const { clusterConfig, validateConfig, isClusterMode } = require('./config/cluster')
const ClusterService = require('./services/clusterService')
const LoadBalancerService = require('./services/loadBalancerService')

// Validate configuration
const configErrors = validateConfig()
if (configErrors.length > 0) {
  console.error('[ClusterServer] Configuration errors:')
  configErrors.forEach(error => console.error(`  - ${error}`))
  process.exit(1)
}

// Global cluster state
let clusterService = null
let loadBalancerService = null

async function startMaster() {
  console.log(`[ClusterServer] Starting master process (PID: ${process.pid})`)
  console.log(`[ClusterServer] CPU cores: ${require('os').cpus().length}`)
  console.log(`[ClusterServer] Workers: ${clusterConfig.workers.min} - ${clusterConfig.workers.max}`)
  
  try {
    // Initialize cluster service for multi-server coordination
    clusterService = new ClusterService()
    const clusterInitialized = await clusterService.initialize(clusterConfig.redis)
    
    if (!clusterInitialized) {
      console.warn('[ClusterServer] Failed to initialize cluster service, running in standalone mode')
    }

    // Initialize load balancer for multi-process scaling
    loadBalancerService = new LoadBalancerService()
    await loadBalancerService.initialize()

    // Set up master process monitoring
    setupMasterMonitoring()

    console.log('[ClusterServer] Master process started successfully')
    
  } catch (error) {
    console.error('[ClusterServer] Failed to start master process:', error)
    process.exit(1)
  }
}

async function startWorker() {
  console.log(`[ClusterServer] Starting worker ${cluster.worker.id} (PID: ${process.pid})`)
  
  try {
    // Import and start the main server
    const server = require('./server')
    
    // Initialize cluster service for this worker
    if (clusterConfig.redis.host) {
      const workerClusterService = new ClusterService()
      const initialized = await workerClusterService.initialize(clusterConfig.redis)
      
      if (initialized) {
        console.log(`[ClusterServer] Worker ${cluster.worker.id} connected to cluster`)
      }
    }

    console.log(`[ClusterServer] Worker ${cluster.worker.id} started successfully`)
    
  } catch (error) {
    console.error(`[ClusterServer] Worker ${cluster.worker.id} failed to start:`, error)
    process.exit(1)
  }
}

function setupMasterMonitoring() {
  // Monitor cluster health
  setInterval(async () => {
    try {
      if (clusterService) {
        const nodes = await clusterService.getAllNodes()
        const stats = loadBalancerService.getWorkerStats()
        
        console.log(`[ClusterServer] Cluster: ${nodes.length} nodes, ${stats.workers.length} workers, ${stats.stats.totalConnections} connections`)
        
        // Check for unhealthy conditions
        const avgLoad = stats.stats.averageCpu || 0
        const totalMemory = stats.stats.averageMemory || 0
        
        if (avgLoad > clusterConfig.monitoring.alertThresholds.cpu) {
          console.warn(`[ClusterServer] High CPU usage: ${avgLoad.toFixed(2)}`)
        }
        
        if (totalMemory > clusterConfig.monitoring.alertThresholds.memory * 1024 * 1024 * 1024) {
          console.warn(`[ClusterServer] High memory usage: ${(totalMemory / 1024 / 1024).toFixed(2)}MB`)
        }
      }
    } catch (error) {
      console.error('[ClusterServer] Monitoring error:', error)
    }
  }, clusterConfig.monitoring.metricsInterval)

  // Graceful shutdown handling
  const gracefulShutdown = async (signal) => {
    console.log(`[ClusterServer] Received ${signal}, starting graceful shutdown...`)
    
    try {
      if (loadBalancerService) {
        await loadBalancerService.gracefulShutdown()
      }
      
      if (clusterService) {
        await clusterService.shutdown()
      }
      
      console.log('[ClusterServer] Master shutdown complete')
      process.exit(0)
    } catch (error) {
      console.error('[ClusterServer] Error during shutdown:', error)
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('[ClusterServer] Uncaught exception in master:', error)
    gracefulShutdown('uncaughtException')
  })
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[ClusterServer] Unhandled rejection in master:', reason, 'at', promise)
  })
}

// Health check endpoint for load balancers
function setupHealthCheck() {
  const http = require('http')
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const stats = loadBalancerService ? loadBalancerService.getWorkerStats() : null
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        process: {
          pid: process.pid,
          uptime: process.uptime(),
          memory: process.memoryUsage()
        },
        cluster: stats || { message: 'Load balancer not initialized' }
      }))
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  })

  const healthPort = process.env.HEALTH_PORT || 3001
  healthServer.listen(healthPort, () => {
    console.log(`[ClusterServer] Health check server listening on port ${healthPort}`)
  })
}

// Main entry point
async function main() {
  console.log(`[ClusterServer] Node.js ${process.version} starting...`)
  console.log(`[ClusterServer] Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`[ClusterServer] Cluster mode: ${isClusterMode() ? 'enabled' : 'disabled'}`)

  // Start health check server
  if (cluster.isMaster || !isClusterMode()) {
    setupHealthCheck()
  }

  if (isClusterMode()) {
    if (cluster.isMaster) {
      await startMaster()
    } else {
      await startWorker()
    }
  } else {
    // Single process mode
    console.log('[ClusterServer] Running in single process mode')
    require('./server')
  }
}

// Handle startup errors
process.on('uncaughtException', (error) => {
  console.error('[ClusterServer] Uncaught exception during startup:', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ClusterServer] Unhandled rejection during startup:', reason, 'at', promise)
  process.exit(1)
})

// Start the application
main().catch((error) => {
  console.error('[ClusterServer] Failed to start:', error)
  process.exit(1)
})