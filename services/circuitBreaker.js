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
      lastFailureTime: this.lastFailureTime
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

  getAllStatus() {
    const status = {}
    for (const [name, breaker] of this.breakers) {
      status[name] = breaker.getStatus()
    }
    return status
  }

  reset(name) {
    const breaker = this.breakers.get(name)
    if (breaker) breaker.reset()
  }

  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.reset()
    }
  }
}

const circuitBreakerManager = new CircuitBreakerManager()
export default circuitBreakerManager
export { CircuitBreaker, CircuitBreakerManager }
