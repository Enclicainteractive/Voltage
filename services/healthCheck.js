import redisService from './redisService.js'
import wsManager from './wsManager.js'
import sessionManager from './sessionManager.js'

class HealthCheck {
  constructor() {
    this.startTime = Date.now()
    this.checks = new Map()
    this.lastCheck = null
    this.registerDefaultChecks()
  }

  registerDefaultChecks() {
    this.registerCheck('redis', async () => {
      if (!redisService.isReady()) {
        return { status: 'unavailable', message: 'Redis not connected' }
      }
      try {
        await redisService.client.ping()
        return { status: 'healthy', message: 'Redis connected' }
      } catch {
        return { status: 'unhealthy', message: 'Redis ping failed' }
      }
    })

    this.registerCheck('memory', () => {
      const used = process.memoryUsage()
      const heapUsedPercent = (used.heapUsed / used.heapTotal) * 100
      
      let status = 'healthy'
      if (heapUsedPercent > 90) status = 'unhealthy'
      else if (heapUsedPercent > 75) status = 'degraded'

      return {
        status,
        message: `Heap: ${Math.round(heapUsedPercent)}%`,
        data: {
          rss: Math.round(used.rss / 1024 / 1024) + 'MB',
          heapTotal: Math.round(used.heapTotal / 1024 / 1024) + 'MB',
          heapUsed: Math.round(used.heapUsed / 1024 / 1024) + 'MB',
          external: Math.round(used.external / 1024 / 1024) + 'MB'
        }
      }
    })

    this.registerCheck('uptime', () => {
      const uptime = Date.now() - this.startTime
      return {
        status: 'healthy',
        message: `Uptime: ${Math.round(uptime / 1000 / 60)} minutes`,
        data: {
          uptimeMs: uptime,
          uptimeSeconds: Math.round(uptime / 1000),
          startedAt: new Date(this.startTime).toISOString()
        }
      }
    })

    this.registerCheck('connections', () => {
      const connections = wsManager.getConnectionCount()
      const users = wsManager.getUserCount()

      let status = 'healthy'
      if (connections > 10000) status = 'degraded'
      if (connections > 20000) status = 'unhealthy'

      return {
        status,
        message: `${connections} connections, ${users} users`,
        data: {
          connections,
          uniqueUsers: users
        }
      }
    })

    this.registerCheck('sessions', async () => {
      const sessionCount = await sessionManager.getOnlineCount()
      return {
        status: 'healthy',
        message: `${sessionCount} active sessions`,
        data: { sessionCount }
      }
    })
  }

  registerCheck(name, fn) {
    this.checks.set(name, fn)
  }

  recordCheck(name, ok, message = '', data = null) {
    const status = ok ? 'healthy' : 'degraded'
    this.lastCheck = this.lastCheck || {
      status: 'healthy',
      results: {},
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime
    }
    this.lastCheck.results[name] = {
      name,
      status,
      message,
      data,
      timestamp: Date.now()
    }
    if (!ok && this.lastCheck.status === 'healthy') {
      this.lastCheck.status = 'degraded'
    }
    this.lastCheck.timestamp = Date.now()
  }

  async runCheck(name) {
    const check = this.checks.get(name)
    if (!check) {
      return { status: 'unknown', message: `Check ${name} not found` }
    }

    try {
      const result = await check()
      return { ...result, name, timestamp: Date.now() }
    } catch (err) {
      return { status: 'error', message: err.message, name, timestamp: Date.now() }
    }
  }

  async runAllChecks() {
    const results = {}
    let overallStatus = 'healthy'

    for (const [name] of this.checks) {
      const result = await this.runCheck(name)
      results[name] = result

      if (result.status === 'unhealthy' || result.status === 'error') {
        overallStatus = 'unhealthy'
      } else if (result.status === 'degraded' && overallStatus === 'healthy') {
        overallStatus = 'degraded'
      }
    }

    this.lastCheck = {
      status: overallStatus,
      results,
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime
    }

    return this.lastCheck
  }

  async getStatus() {
    if (!this.lastCheck || Date.now() - this.lastCheck.timestamp > 30000) {
      return await this.runAllChecks()
    }
    return this.lastCheck
  }

  getReadiness() {
    const checks = ['redis', 'memory']
    let ready = true

    for (const checkName of checks) {
      const result = this.lastCheck?.results?.[checkName]
      if (result?.status === 'unhealthy' || result?.status === 'error') {
        ready = false
        break
      }
    }

    return ready
  }

  getLiveness() {
    return !wsManager.draining
  }

  resetUptime() {
    this.startTime = Date.now()
  }
}

const healthCheck = new HealthCheck()
export default healthCheck
