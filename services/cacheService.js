import cluster from 'cluster'
import os from 'os'

class CoalescingCache {
  constructor(options = {}) {
    this.ttl = options.ttl || 30000
    this.maxAge = options.maxAge || 60000
    this.cache = new Map()
    this.loadingPromises = new Map()
    this.loadingTimers = new Map()
  }

  get(key) {
    const entry = this.cache.get(key)
    if (!entry) return { hit: false, value: undefined }

    const now = Date.now()
    if (now - entry.timestamp > this.maxAge) {
      this.cache.delete(key)
      return { hit: false, value: undefined }
    }

    if (now - entry.timestamp > this.ttl) {
      return { hit: true, value: entry.value, stale: true }
    }

    return { hit: true, value: entry.value, stale: false }
  }

  set(key, value) {
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    })
  }

  async getOrLoad(key, loader) {
    const entry = this.get(key)
    if (entry.hit && !entry.stale) {
      return entry.value
    }

    let promise = this.loadingPromises.get(key)
    if (promise) {
      return promise
    }

    const loadTimeout = setTimeout(() => {
      this.loadingPromises.delete(key)
      this.loadingTimers.delete(key)
    }, 30000)

    promise = (async () => {
      try {
        const value = await loader()
        this.set(key, value)
        return value
      } finally {
        clearTimeout(loadTimeout)
        this.loadingPromises.delete(key)
        this.loadingTimers.delete(key)
      }
    })()

    this.loadingPromises.set(key, promise)
    this.loadingTimers.set(key, loadTimeout)
    return promise
  }

  invalidate(key) {
    this.cache.delete(key)
    const timer = this.loadingTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.loadingTimers.delete(key)
    }
    this.loadingPromises.delete(key)
  }

  clear() {
    for (const timer of this.loadingTimers.values()) {
      clearTimeout(timer)
    }
    this.cache.clear()
    this.loadingPromises.clear()
    this.loadingTimers.clear()
  }
}

class RequestCoalescer {
  constructor() {
    this.pending = new Map()
  }

  async coalesce(key, fn) {
    if (this.pending.has(key)) {
      return this.pending.get(key)
    }

    const promise = fn().finally(() => {
      this.pending.delete(key)
    })

    this.pending.set(key, promise)
    return promise
  }

  clear() {
    this.pending.clear()
  }
}

class RateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests || 100
    this.windowMs = options.windowMs || 1000
    this.requests = new Map()
  }

  isAllowed(key) {
    const now = Date.now()
    const timestamps = this.requests.get(key) || []
    const validTimestamps = timestamps.filter(t => now - t < this.windowMs)
    
    if (validTimestamps.length >= this.maxRequests) {
      this.requests.set(key, validTimestamps)
      return false
    }

    validTimestamps.push(now)
    this.requests.set(key, validTimestamps)
    return true
  }

  clear() {
    this.requests.clear()
  }
}

const globalCoalescer = new RequestCoalescer()
const globalRateLimiter = new RateLimiter({ maxRequests: 200, windowMs: 1000 })

const botCache = new CoalescingCache({ ttl: 15000, maxAge: 60000 })
const messageCache = new CoalescingCache({ ttl: 5000, maxAge: 15000 })

const userCache = new CoalescingCache({ ttl: 10000, maxAge: 30000 })
const serverCache = new CoalescingCache({ ttl: 15000, maxAge: 60000 })
const channelCache = new CoalescingCache({ ttl: 10000, maxAge: 30000 })

export { 
  CoalescingCache, 
  RequestCoalescer, 
  RateLimiter,
  globalCoalescer, 
  globalRateLimiter,
  botCache, 
  messageCache,
  userCache,
  serverCache,
  channelCache
}
