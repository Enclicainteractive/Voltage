class CircuitBreaker {
  constructor(options = {}) {
    this.failures = 0
    this.successes = 0
    this.lastFailureTime = null
    this.state = 'CLOSED'
    
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      successThreshold: options.successThreshold || 2,
      timeout: options.timeout || 60000,
      resetTimeout: options.resetTimeout || 30000,
      ...options
    }
    
    this.callbacks = {
      onOpen: options.onOpen || (() => {}),
      onClose: options.onClose || (() => {}),
      onHalfOpen: options.onHalfOpen || (() => {})
    }
  }

  getState() {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.options.resetTimeout) {
        this.state = 'HALF_OPEN'
        this.callbacks.onHalfOpen()
      }
    }
    return this.state
  }

  async execute(fn) {
    const state = this.getState()
    
    if (state === 'OPEN') {
      throw new Error('Circuit breaker is OPEN')
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  onSuccess() {
    this.successes++
    this.lastFailureTime = null

    if (this.state === 'HALF_OPEN') {
      if (this.successes >= this.options.successThreshold) {
        this.state = 'CLOSED'
        this.failures = 0
        this.successes = 0
        this.callbacks.onClose()
      }
    }
  }

  onFailure() {
    this.failures++
    this.lastFailureTime = Date.now()
    this.successes = 0

    if (this.state === 'CLOSED') {
      if (this.failures >= this.options.failureThreshold) {
        this.state = 'OPEN'
        this.callbacks.onOpen()
      }
    } else if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN'
      this.callbacks.onOpen()
    }
  }

  reset() {
    this.state = 'CLOSED'
    this.failures = 0
    this.successes = 0
    this.lastFailureTime = null
  }

  getStatus() {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.state === 'OPEN' 
        ? this.lastFailureTime + this.options.resetTimeout
        : null,
      failureRate: this.failures + this.successes > 0 
        ? this.failures / (this.failures + this.successes)
        : 0,
      uptime: this.state === 'CLOSED' ? 100 : 0
    }
  }

  /**
   * Execute with fallback function if circuit is open
   */
  async executeWithFallback(fn, fallbackFn) {
    const state = this.getState()
    
    if (state === 'OPEN') {
      console.warn(`[CircuitBreaker] Circuit is OPEN, executing fallback`)
      if (fallbackFn) {
        return fallbackFn()
      }
      throw new Error('Circuit breaker is OPEN and no fallback provided')
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      this.onFailure()
      if (fallbackFn && this.getState() === 'OPEN') {
        console.warn(`[CircuitBreaker] Circuit opened, executing fallback`)
        return fallbackFn()
      }
      throw err
    }
  }
}

class CircuitBreakerManager {
  constructor() {
    this.breakers = new Map()
  }

  getBreaker(name, options) {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker(options))
    }
    return this.breakers.get(name)
  }

  async execute(name, fn, options = {}) {
    const breaker = this.getBreaker(name, options)
    return breaker.execute(fn)
  }

  async executeWithFallback(name, fn, fallbackFn, options = {}) {
    const breaker = this.getBreaker(name, options)
    return breaker.executeWithFallback(fn, fallbackFn)
  }

  getAllStatus() {
    const status = {}
    const summary = {
      totalBreakers: this.breakers.size,
      openBreakers: 0,
      halfOpenBreakers: 0,
      closedBreakers: 0,
      totalFailures: 0,
      totalSuccesses: 0
    }

    for (const [name, breaker] of this.breakers) {
      const breakerStatus = breaker.getStatus()
      status[name] = breakerStatus
      
      // Aggregate summary stats
      summary.totalFailures += breakerStatus.failures
      summary.totalSuccesses += breakerStatus.successes
      
      switch (breakerStatus.state) {
        case 'OPEN':
          summary.openBreakers++
          break
        case 'HALF_OPEN':
          summary.halfOpenBreakers++
          break
        case 'CLOSED':
          summary.closedBreakers++
          break
      }
    }

    return { breakers: status, summary }
  }

  getHealthScore() {
    const status = this.getAllStatus()
    const { summary } = status
    
    if (summary.totalBreakers === 0) return 100
    
    const healthyBreakers = summary.closedBreakers + summary.halfOpenBreakers
    const baseScore = (healthyBreakers / summary.totalBreakers) * 100
    
    // Penalize for failures
    const totalOperations = summary.totalFailures + summary.totalSuccesses
    if (totalOperations > 0) {
      const failureRate = summary.totalFailures / totalOperations
      return Math.max(0, baseScore - (failureRate * 50))
    }
    
    return baseScore
  }

  reset(name) {
    const breaker = this.breakers.get(name)
    if (breaker) {
      breaker.reset()
      console.log(`[CircuitBreaker] Reset breaker: ${name}`)
    }
  }

  resetAll() {
    for (const [name, breaker] of this.breakers) {
      breaker.reset()
      console.log(`[CircuitBreaker] Reset breaker: ${name}`)
    }
  }

  /**
   * Get breakers that need attention (open or high failure rate)
   */
  getProblematicBreakers() {
    const problematic = []
    
    for (const [name, breaker] of this.breakers) {
      const status = breaker.getStatus()
      
      if (status.state === 'OPEN' || status.failureRate > 0.5) {
        problematic.push({
          name,
          state: status.state,
          failureRate: status.failureRate,
          failures: status.failures,
          lastFailureTime: status.lastFailureTime
        })
      }
    }
    
    return problematic.sort((a, b) => b.failureRate - a.failureRate)
  }
}

const circuitBreakerManager = new CircuitBreakerManager()
export default circuitBreakerManager
export { CircuitBreaker, CircuitBreakerManager }
