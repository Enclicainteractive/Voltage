const cluster = require('cluster')
const os = require('os')

class LoadBalancerService {
  constructor() {
    this.workers = new Map()
    this.currentWorker = 0
    this.maxWorkers = process.env.MAX_WORKERS || os.cpus().length
    this.minWorkers = process.env.MIN_WORKERS || 2
    this.restartingWorkers = new Set()
    this.stats = {
      totalRequests: 0,
      totalConnections: 0,
      restarts: 0
    }
  }

  async initialize() {
    if (cluster.isMaster) {
      console.log(`[LoadBalancer] Master ${process.pid} starting...`)
      this.setupMaster()
      await this.startWorkers()
      this.setupMonitoring()
      return true
    }
    return false
  }

  setupMaster() {
    cluster.setupMaster({
      exec: process.argv[1],
      args: process.argv.slice(2),
      silent: false
    })

    cluster.on('exit', (worker, code, signal) => {
      this.handleWorkerExit(worker, code, signal)
    })

    cluster.on('fork', (worker) => {
      this.handleWorkerFork(worker)
    })

    cluster.on('online', (worker) => {
      this.handleWorkerOnline(worker)
    })

    cluster.on('listening', (worker, address) => {
      this.handleWorkerListening(worker, address)
    })

    cluster.on('disconnect', (worker) => {
      this.handleWorkerDisconnect(worker)
    })

    // Graceful shutdown
    process.on('SIGTERM', () => this.gracefulShutdown())
    process.on('SIGINT', () => this.gracefulShutdown())
  }

  async startWorkers() {
    const initialWorkers = Math.min(this.maxWorkers, this.minWorkers)
    
    for (let i = 0; i < initialWorkers; i++) {
      await this.forkWorker()
    }

    console.log(`[LoadBalancer] Started ${initialWorkers} workers`)
  }

  async forkWorker() {
    return new Promise((resolve, reject) => {
      const worker = cluster.fork({
        WORKER_ID: this.workers.size,
        CLUSTER_WORKER: 'true'
      })

      const timeout = setTimeout(() => {
        reject(new Error('Worker startup timeout'))
      }, 30000)

      worker.once('listening', () => {
        clearTimeout(timeout)
        this.workers.set(worker.id, {
          worker,
          pid: worker.process.pid,
          connections: 0,
          requests: 0,
          memory: 0,
          cpu: 0,
          startTime: Date.now(),
          lastHealthCheck: Date.now(),
          status: 'running'
        })
        resolve(worker)
      })

      worker.once('exit', () => {
        clearTimeout(timeout)
        reject(new Error('Worker exited during startup'))
      })
    })
  }

  handleWorkerFork(worker) {
    console.log(`[LoadBalancer] Worker ${worker.id} (PID: ${worker.process.pid}) forked`)
  }

  handleWorkerOnline(worker) {
    console.log(`[LoadBalancer] Worker ${worker.id} (PID: ${worker.process.pid}) online`)
  }

  handleWorkerListening(worker, address) {
    console.log(`[LoadBalancer] Worker ${worker.id} (PID: ${worker.process.pid}) listening on ${address.address}:${address.port}`)
  }

  handleWorkerDisconnect(worker) {
    console.log(`[LoadBalancer] Worker ${worker.id} (PID: ${worker.process.pid}) disconnected`)
    this.workers.delete(worker.id)
  }

  handleWorkerExit(worker, code, signal) {
    console.log(`[LoadBalancer] Worker ${worker.id} (PID: ${worker.process.pid}) died with code ${code} and signal ${signal}`)
    
    this.workers.delete(worker.id)
    this.restartingWorkers.delete(worker.id)
    this.stats.restarts++

    // Restart worker if not intentional shutdown
    if (!worker.exitedAfterDisconnect) {
      console.log(`[LoadBalancer] Restarting worker ${worker.id}`)
      setTimeout(() => {
        this.forkWorker().catch(err => {
          console.error('[LoadBalancer] Failed to restart worker:', err)
        })
      }, 1000)
    }
  }

  setupMonitoring() {
    // Health check interval
    setInterval(() => {
      this.performHealthChecks()
    }, 30000) // Every 30 seconds

    // Load balancing check
    setInterval(() => {
      this.performLoadBalancing()
    }, 60000) // Every minute

    // Stats collection
    setInterval(() => {
      this.collectStats()
    }, 10000) // Every 10 seconds
  }

  async performHealthChecks() {
    const now = Date.now()
    const unhealthyWorkers = []

    for (const [workerId, workerInfo] of this.workers) {
      try {
        // Check if worker is responsive
        const healthCheck = await this.pingWorker(workerInfo.worker)
        
        if (!healthCheck.success || now - workerInfo.lastHealthCheck > 60000) {
          unhealthyWorkers.push(workerId)
        } else {
          workerInfo.lastHealthCheck = now
          workerInfo.memory = healthCheck.memory || 0
          workerInfo.cpu = healthCheck.cpu || 0
        }
      } catch (error) {
        console.error(`[LoadBalancer] Health check failed for worker ${workerId}:`, error)
        unhealthyWorkers.push(workerId)
      }
    }

    // Restart unhealthy workers
    for (const workerId of unhealthyWorkers) {
      await this.restartWorker(workerId)
    }
  }

  async pingWorker(worker) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false })
      }, 5000)

      worker.send({ type: 'health-check', timestamp: Date.now() })

      const responseHandler = (message) => {
        if (message.type === 'health-response') {
          clearTimeout(timeout)
          worker.off('message', responseHandler)
          resolve({
            success: true,
            memory: message.memory,
            cpu: message.cpu,
            connections: message.connections
          })
        }
      }

      worker.on('message', responseHandler)
    })
  }

  async restartWorker(workerId) {
    if (this.restartingWorkers.has(workerId)) return
    
    this.restartingWorkers.add(workerId)
    const workerInfo = this.workers.get(workerId)
    
    if (!workerInfo) return

    try {
      console.log(`[LoadBalancer] Restarting worker ${workerId}`)
      
      // Graceful disconnect
      workerInfo.worker.disconnect()
      
      // Wait for graceful shutdown or force kill after timeout
      setTimeout(() => {
        if (!workerInfo.worker.isDead()) {
          workerInfo.worker.kill('SIGKILL')
        }
      }, 10000)

      // Fork new worker
      await this.forkWorker()
      
    } catch (error) {
      console.error(`[LoadBalancer] Failed to restart worker ${workerId}:`, error)
    } finally {
      this.restartingWorkers.delete(workerId)
    }
  }

  performLoadBalancing() {
    const workers = Array.from(this.workers.values())
    if (workers.length === 0) return

    // Calculate average load
    const totalLoad = workers.reduce((sum, w) => sum + w.connections + (w.cpu * 0.1), 0)
    const avgLoad = totalLoad / workers.length

    // Check if we need to scale up or down
    const maxLoad = Math.max(...workers.map(w => w.connections + (w.cpu * 0.1)))
    const minLoad = Math.min(...workers.map(w => w.connections + (w.cpu * 0.1)))

    if (maxLoad > avgLoad * 1.5 && workers.length < this.maxWorkers) {
      // Scale up
      this.scaleUp()
    } else if (maxLoad < avgLoad * 0.5 && workers.length > this.minWorkers) {
      // Scale down
      this.scaleDown()
    }
  }

  async scaleUp() {
    if (this.workers.size >= this.maxWorkers) return

    try {
      console.log('[LoadBalancer] Scaling up - adding worker')
      await this.forkWorker()
    } catch (error) {
      console.error('[LoadBalancer] Failed to scale up:', error)
    }
  }

  async scaleDown() {
    if (this.workers.size <= this.minWorkers) return

    // Find worker with least connections
    const workers = Array.from(this.workers.values())
    const leastBusyWorker = workers.reduce((min, worker) => 
      worker.connections < min.connections ? worker : min
    )

    try {
      console.log(`[LoadBalancer] Scaling down - removing worker ${leastBusyWorker.worker.id}`)
      leastBusyWorker.worker.disconnect()
    } catch (error) {
      console.error('[LoadBalancer] Failed to scale down:', error)
    }
  }

  collectStats() {
    const workers = Array.from(this.workers.values())
    
    this.stats.totalConnections = workers.reduce((sum, w) => sum + w.connections, 0)
    this.stats.averageMemory = workers.reduce((sum, w) => sum + w.memory, 0) / workers.length
    this.stats.averageCpu = workers.reduce((sum, w) => sum + w.cpu, 0) / workers.length
    this.stats.activeWorkers = workers.length
    this.stats.timestamp = Date.now()

    // Log stats periodically
    if (Date.now() % 300000 < 10000) { // Every 5 minutes
      console.log('[LoadBalancer] Stats:', this.stats)
    }
  }

  getNextWorker() {
    const workers = Array.from(this.workers.values()).filter(w => w.status === 'running')
    if (workers.length === 0) return null

    // Round-robin with least connections fallback
    const sortedWorkers = workers.sort((a, b) => a.connections - b.connections)
    return sortedWorkers[0].worker
  }

  getWorkerStats() {
    return {
      master: {
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage()
      },
      workers: Array.from(this.workers.values()).map(w => ({
        id: w.worker.id,
        pid: w.pid,
        connections: w.connections,
        requests: w.requests,
        memory: w.memory,
        cpu: w.cpu,
        uptime: Date.now() - w.startTime,
        status: w.status
      })),
      stats: this.stats
    }
  }

  async gracefulShutdown() {
    console.log('[LoadBalancer] Starting graceful shutdown...')
    
    // Stop accepting new connections
    for (const [workerId, workerInfo] of this.workers) {
      try {
        workerInfo.worker.send({ type: 'shutdown' })
        workerInfo.worker.disconnect()
      } catch (error) {
        console.error(`[LoadBalancer] Error disconnecting worker ${workerId}:`, error)
      }
    }

    // Wait for workers to finish
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const aliveWorkers = Array.from(this.workers.values())
          .filter(w => !w.worker.isDead())

        if (aliveWorkers.length === 0) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 100)

      // Force exit after timeout
      setTimeout(() => {
        clearInterval(checkInterval)
        resolve()
      }, 30000)
    })

    console.log('[LoadBalancer] Graceful shutdown complete')
    process.exit(0)
  }

  // Worker-side methods
  static setupWorker(server, io) {
    if (!cluster.isWorker) return

    // Handle messages from master
    process.on('message', (message) => {
      switch (message.type) {
        case 'health-check':
          LoadBalancerService.sendHealthResponse()
          break
        case 'shutdown':
          LoadBalancerService.gracefulWorkerShutdown(server, io)
          break
      }
    })

    console.log(`[Worker ${cluster.worker.id}] Initialized`)
  }

  static sendHealthResponse() {
    const usage = process.memoryUsage()
    
    process.send({
      type: 'health-response',
      timestamp: Date.now(),
      memory: usage.heapUsed,
      cpu: process.cpuUsage(),
      connections: global.socketConnections || 0
    })
  }

  static gracefulWorkerShutdown(server, io) {
    console.log(`[Worker ${cluster.worker.id}] Starting graceful shutdown...`)
    
    // Stop accepting new connections
    server.close(() => {
      console.log(`[Worker ${cluster.worker.id}] HTTP server closed`)
    })

    // Close all socket connections
    if (io) {
      io.close(() => {
        console.log(`[Worker ${cluster.worker.id}] Socket.IO server closed`)
        process.exit(0)
      })
    } else {
      process.exit(0)
    }

    // Force exit after timeout
    setTimeout(() => {
      console.log(`[Worker ${cluster.worker.id}] Force exit`)
      process.exit(1)
    }, 10000)
  }
}

module.exports = LoadBalancerService