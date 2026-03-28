/**
 * VoltChat Health Check & Metrics Service
 * 
 * Provides comprehensive health monitoring for all system components
 */

import storageService from './storageService.js'
import circuitBreakerManager from './circuitBreaker.js'
import lockService from './lockService.js'
import config from '../config/config.js'

class HealthService {
  constructor() {
    this.metrics = {
      uptime: Date.now(),
      requests: {
        total: 0,
        success: 0,
        failed: 0,
        lastMinute: []
      },
      memory: {
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        rss: 0
      },
      database: {
        connections: 0,
        queries: 0,
        slowQueries: 0,
        errors: 0,
        lastQueryTime: null
      },
      socket: {
        connections: 0,
        rooms: 0,
        messages: 0
      }
    }
    
    this.healthChecks = new Map()
    this.monitoringInterval = null
    this.isRunning = false
    
    this.registerDefaultHealthChecks()
  }

  /**
   * Start health monitoring
   */
  start() {
    if (this.isRunning) return
    
    this.isRunning = true
    console.log('[Health] Health monitoring started')
    
    // Update metrics every 30 seconds
    this.monitoringInterval = setInterval(() => {
      this.updateMetrics()
      this.cleanupOldData()
    }, 30000)
    
    // Initial metrics update
    this.updateMetrics()
  }

  /**
   * Stop health monitoring
   */
  stop() {
    if (!this.isRunning) return
    
    this.isRunning = false
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval)
      this.monitoringInterval = null
    }
    console.log('[Health] Health monitoring stopped')
  }

  /**
   * Register a health check function
   */
  registerHealthCheck(name, checkFn, options = {}) {
    this.healthChecks.set(name, {
      name,
      checkFn,
      timeout: options.timeout || 5000,
      critical: options.critical || false,
      lastCheck: null,
      lastResult: null,
      consecutive_failures: 0
    })
  }

  /**
   * Register default health checks
   */
  registerDefaultHealthChecks() {
    // Database health check
    this.registerHealthCheck('database', async () => {
      const start = Date.now()
      try {
        const testData = { test: Date.now() }
        await storageService.save('health_check', testData)
        const loaded = await storageService.load('health_check', {})
        
        const latency = Date.now() - start
        return {
          status: 'healthy',
          latency,
          connection: storageService.getType(),
          details: 'Database read/write successful'
        }
      } catch (error) {
        return {
          status: 'unhealthy',
          error: error.message,
          latency: Date.now() - start
        }
      }
    }, { critical: true, timeout: 10000 })

    // Memory health check
    this.registerHealthCheck('memory', async () => {
      const memUsage = process.memoryUsage()
      const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100
      
      let status = 'healthy'
      if (heapUsedPercent > 90) status = 'critical'
      else if (heapUsedPercent > 80) status = 'warning'
      
      return {
        status,
        heapUsedPercent: Math.round(heapUsedPercent),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memUsage.rss / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024)
      }
    })

    // Circuit breaker health check
    this.registerHealthCheck('circuit-breakers', async () => {
      const status = circuitBreakerManager.getAllStatus()
      const healthScore = circuitBreakerManager.getHealthScore()
      const problematic = circuitBreakerManager.getProblematicBreakers()
      
      let overallStatus = 'healthy'
      if (healthScore < 50) overallStatus = 'critical'
      else if (healthScore < 80) overallStatus = 'warning'
      
      return {
        status: overallStatus,
        healthScore: Math.round(healthScore),
        totalBreakers: status.summary.totalBreakers,
        openBreakers: status.summary.openBreakers,
        problematicBreakers: problematic.length,
        details: problematic
      }
    })

    // Lock service health check
    this.registerHealthCheck('locks', async () => {
      const stats = lockService.getStats()
      const testLockKey = `health_check_${Date.now()}`
      
      try {
        const lockToken = await lockService.acquireLock(testLockKey, 1000, 2000)
        if (lockToken) {
          await lockService.releaseLock(testLockKey, lockToken)
        }
        
        return {
          status: 'healthy',
          backend: stats.backend,
          localLocks: stats.localLocks,
          pendingTimeouts: stats.pendingTimeouts,
          lockTest: lockToken ? 'success' : 'timeout'
        }
      } catch (error) {
        return {
          status: 'unhealthy',
          error: error.message,
          backend: stats.backend
        }
      }
    })

    // Event loop lag check
    this.registerHealthCheck('event-loop', async () => {
      return new Promise((resolve) => {
        const start = process.hrtime()
        setImmediate(() => {
          const delta = process.hrtime(start)
          const nanosec = delta[0] * 1e9 + delta[1]
          const millisec = nanosec / 1e6
          
          let status = 'healthy'
          if (millisec > 100) status = 'critical'
          else if (millisec > 50) status = 'warning'
          
          resolve({
            status,
            lag: Math.round(millisec),
            threshold: { warning: 50, critical: 100 }
          })
        })
      })
    })

    // Message batching health check
    this.registerHealthCheck('message-batching', async () => {
      try {
        const { default: messageBatchService } = await import('./messageBatchService.js')
        const metrics = messageBatchService.getMetrics()
        
        let status = 'healthy'
        if (metrics.pendingMessages > 1000) status = 'critical'
        else if (metrics.pendingMessages > 500) status = 'warning'
        else if (metrics.successRate < 90) status = 'critical'
        else if (metrics.successRate < 95) status = 'warning'
        
        return {
          status,
          pendingMessages: metrics.pendingMessages,
          pendingBatches: metrics.pendingBatches,
          messagesProcessed: metrics.messagesProcessed,
          successRate: metrics.successRate,
          averageBatchSize: metrics.averageBatchSize,
          processingErrors: metrics.processingErrors
        }
      } catch (error) {
        return {
          status: 'error',
          error: error.message
        }
      }
    })

    // Data validation health check
    this.registerHealthCheck('data-validation', async () => {
      try {
        // This is a basic check - in a real scenario you might track validation metrics
        const testInput = {
          username: 'testuser123',
          displayName: 'Test User',
          email: 'test@example.com'
        }
        
        const { validators } = await import('../middleware/builtinValidationMiddleware.js')
        
        // Test basic validators are working
        const usernameValid = validators.matches(testInput.username, /^[a-zA-Z0-9_.]{2,32}$/)
        const emailValid = validators.isEmail(testInput.email)
        
        let status = 'healthy'
        if (!usernameValid || !emailValid) {
          status = 'critical'
        }
        
        return {
          status,
          validatorsWorking: usernameValid && emailValid,
          testsPassed: {
            username: usernameValid,
            email: emailValid
          }
        }
      } catch (error) {
        return {
          status: 'error',
          error: error.message
        }
      }
    })

    // Error monitoring health check
    this.registerHealthCheck('error-monitoring', async () => {
      try {
        const { default: errorLogService } = await import('./errorLogService.js')
        const stats = errorLogService.getErrorStats()
        
        let status = 'healthy'
        if (stats.lastMinute > 50) status = 'critical'
        else if (stats.lastMinute > 20) status = 'warning'
        else if (stats.lastHour > 500) status = 'warning'
        
        return {
          status,
          errorsLastMinute: stats.lastMinute,
          errorsLastHour: stats.lastHour,
          topErrorPatterns: stats.topErrors.slice(0, 3),
          loggingEnabled: true
        }
      } catch (error) {
        return {
          status: 'error',
          error: error.message
        }
      }
    })
  }

  /**
   * Run all health checks
   */
  async runHealthChecks() {
    const results = {}
    const promises = []
    
    for (const [name, check] of this.healthChecks) {
      const promise = this.runSingleHealthCheck(name, check)
      promises.push(promise.then(result => ({ name, result })))
    }
    
    const completed = await Promise.allSettled(promises)
    
    for (const settled of completed) {
      if (settled.status === 'fulfilled') {
        const { name, result } = settled.value
        results[name] = result
      } else {
        const name = settled.reason?.name || 'unknown'
        results[name] = {
          status: 'error',
          error: settled.reason?.message || 'Unknown error'
        }
      }
    }
    
    return results
  }

  /**
   * Run a single health check with timeout
   */
  async runSingleHealthCheck(name, check) {
    const start = Date.now()
    
    try {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Health check timeout')), check.timeout)
      )
      
      const checkPromise = check.checkFn()
      const result = await Promise.race([checkPromise, timeoutPromise])
      
      const duration = Date.now() - start
      check.lastCheck = Date.now()
      check.lastResult = result
      
      if (result.status === 'healthy') {
        check.consecutive_failures = 0
      } else {
        check.consecutive_failures++
      }
      
      return {
        ...result,
        duration,
        lastCheck: check.lastCheck,
        consecutive_failures: check.consecutive_failures
      }
      
    } catch (error) {
      check.consecutive_failures++
      return {
        status: 'error',
        error: error.message,
        duration: Date.now() - start,
        consecutive_failures: check.consecutive_failures
      }
    }
  }

  /**
   * Update system metrics
   */
  updateMetrics() {
    // Update memory metrics
    const memUsage = process.memoryUsage()
    this.metrics.memory = {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024)
    }
  }

  /**
   * Clean up old metrics data
   */
  cleanupOldData() {
    const now = Date.now()
    const oneMinuteAgo = now - 60000
    
    // Clean up request metrics older than 1 minute
    this.metrics.requests.lastMinute = this.metrics.requests.lastMinute
      .filter(timestamp => timestamp > oneMinuteAgo)
  }

  /**
   * Record request metrics
   */
  recordRequest(success = true) {
    const now = Date.now()
    this.metrics.requests.total++
    this.metrics.requests.lastMinute.push(now)
    
    if (success) {
      this.metrics.requests.success++
    } else {
      this.metrics.requests.failed++
    }
  }

  /**
   * Record database metrics
   */
  recordDatabaseQuery(duration, success = true) {
    this.metrics.database.queries++
    this.metrics.database.lastQueryTime = Date.now()
    
    if (duration > 1000) { // Slow query threshold: 1 second
      this.metrics.database.slowQueries++
    }
    
    if (!success) {
      this.metrics.database.errors++
    }
  }

  /**
   * Record socket metrics
   */
  updateSocketMetrics(connections, rooms, messages) {
    this.metrics.socket.connections = connections
    this.metrics.socket.rooms = rooms
    this.metrics.socket.messages = messages
  }

  /**
   * Get comprehensive health status
   */
  async getHealthStatus() {
    const healthChecks = await this.runHealthChecks()
    const uptime = Math.floor((Date.now() - this.metrics.uptime) / 1000)
    
    // Calculate overall health
    let overallStatus = 'healthy'
    let criticalIssues = 0
    let warnings = 0
    
    for (const [name, result] of Object.entries(healthChecks)) {
      if (result.status === 'critical' || result.status === 'error') {
        criticalIssues++
        const check = this.healthChecks.get(name)
        if (check?.critical) {
          overallStatus = 'critical'
        } else if (overallStatus !== 'critical') {
          overallStatus = 'degraded'
        }
      } else if (result.status === 'warning') {
        warnings++
        if (overallStatus === 'healthy') {
          overallStatus = 'warning'
        }
      }
    }
    
    const requestsLastMinute = this.metrics.requests.lastMinute.length
    const errorRate = this.metrics.requests.total > 0 
      ? (this.metrics.requests.failed / this.metrics.requests.total) * 100 
      : 0
    
    return {
      status: overallStatus,
      timestamp: Date.now(),
      uptime,
      summary: {
        criticalIssues,
        warnings,
        checksTotal: this.healthChecks.size,
        requestsPerMinute: requestsLastMinute,
        errorRate: Math.round(errorRate * 100) / 100
      },
      system: {
        uptime,
        memory: this.metrics.memory,
        requests: {
          total: this.metrics.requests.total,
          success: this.metrics.requests.success,
          failed: this.metrics.requests.failed,
          lastMinute: requestsLastMinute,
          errorRate: Math.round(errorRate * 100) / 100
        },
        database: this.metrics.database,
        socket: this.metrics.socket
      },
      checks: healthChecks
    }
  }

  /**
   * Get metrics in Prometheus format
   */
  getPrometheusMetrics() {
    const uptime = Math.floor((Date.now() - this.metrics.uptime) / 1000)
    const errorRate = this.metrics.requests.total > 0 
      ? (this.metrics.requests.failed / this.metrics.requests.total) * 100 
      : 0
    
    return `# HELP voltchat_uptime_seconds Time since service started
# TYPE voltchat_uptime_seconds counter
voltchat_uptime_seconds ${uptime}

# HELP voltchat_requests_total Total number of requests
# TYPE voltchat_requests_total counter
voltchat_requests_total ${this.metrics.requests.total}

# HELP voltchat_requests_failed_total Total number of failed requests
# TYPE voltchat_requests_failed_total counter
voltchat_requests_failed_total ${this.metrics.requests.failed}

# HELP voltchat_error_rate Percentage of failed requests
# TYPE voltchat_error_rate gauge
voltchat_error_rate ${errorRate}

# HELP voltchat_memory_heap_used_mb Memory heap used in MB
# TYPE voltchat_memory_heap_used_mb gauge
voltchat_memory_heap_used_mb ${this.metrics.memory.heapUsed}

# HELP voltchat_memory_heap_total_mb Memory heap total in MB
# TYPE voltchat_memory_heap_total_mb gauge
voltchat_memory_heap_total_mb ${this.metrics.memory.heapTotal}

# HELP voltchat_database_queries_total Total database queries
# TYPE voltchat_database_queries_total counter
voltchat_database_queries_total ${this.metrics.database.queries}

# HELP voltchat_database_slow_queries_total Total slow database queries
# TYPE voltchat_database_slow_queries_total counter
voltchat_database_slow_queries_total ${this.metrics.database.slowQueries}

# HELP voltchat_socket_connections Current socket connections
# TYPE voltchat_socket_connections gauge
voltchat_socket_connections ${this.metrics.socket.connections}

# HELP voltchat_socket_rooms Current socket rooms
# TYPE voltchat_socket_rooms gauge
voltchat_socket_rooms ${this.metrics.socket.rooms}
`
  }
}

// Export singleton instance
export default new HealthService()