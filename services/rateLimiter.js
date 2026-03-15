import redisService from './redisService.js'

class RateLimiter {
  constructor() {
    this.useRedis = false
    this.localCounts = new Map()
    this.localWindows = new Map()
  }

  init() {
    this.useRedis = redisService.isReady()
    if (this.useRedis) {
      console.log('[RateLimit] Using Redis-backed rate limiting')
    } else {
      console.log('[RateLimit] Using in-memory rate limiting (fallback)')
    }
  }

  async checkRateLimit(key, limit, windowSeconds, byUser = true) {
    const now = Date.now()
    const windowMs = windowSeconds * 1000
    
    if (this.useRedis) {
      const redisKey = `ratelimit:${byUser ? 'user' : 'ip'}:${key}`
      const current = await redisService.incr(redisKey)
      
      if (current === 1) {
        await redisService.expire(redisKey, windowSeconds)
      }
      
      const ttl = await redisService.client?.ttl(redisKey) || windowSeconds
      
      return {
        allowed: current <= limit,
        remaining: Math.max(0, limit - current),
        resetIn: ttl,
        retryAfter: current > limit ? ttl : 0
      }
    } else {
      const localKey = `${key}:${byUser ? 'user' : 'ip'}`
      let window = this.localWindows.get(localKey)
      
      if (!window || now - window.start > windowMs) {
        window = { start: now, count: 0 }
        this.localWindows.set(localKey, window)
      }
      
      window.count++
      
      const ttl = Math.ceil((window.start + windowMs - now) / 1000)
      
      return {
        allowed: window.count <= limit,
        remaining: Math.max(0, limit - window.count),
        resetIn: ttl,
        retryAfter: window.count > limit ? ttl : 0
      }
    }
  }

  async checkUserRateLimit(userId, limit, windowSeconds = 60) {
    return this.checkRateLimit(userId, limit, windowSeconds, true)
  }

  async checkIPRateLimit(ip, limit, windowSeconds = 60) {
    return this.checkRateLimit(ip, limit, windowSeconds, false)
  }

  async checkMessageRateLimit(userId) {
    return this.checkUserRateLimit(userId, 20, 10)
  }

  async checkHighFrequencyLimit(userId) {
    return this.checkUserRateLimit(`hf:${userId}`, 5, 1)
  }

  async checkConnectionRateLimit(ip) {
    return this.checkRateLimit(`conn:${ip}`, 30, 60, false)
  }

  async checkApiRateLimit(key, limit = 100, windowSeconds = 60) {
    return this.checkRateLimit(`api:${key}`, limit, windowSeconds, false)
  }

  async checkCanvasRateLimit(userId) {
    return this.checkUserRateLimit(`canvas:${userId}`, 3, 10)
  }

  middleware(options = {}) {
    const {
      limit = 100,
      windowSeconds = 60,
      byUser = false,
      keyGenerator = (req) => byUser ? req.user?.id : req.ip,
      skipSuccessfulRequests = false,
      skipFailedRequests = false,
      handler = (req, res) => {
        res.status(429).json({
          error: 'Too many requests',
          retryAfter: res.getHeader('Retry-After')
        })
      }
    } = options

    return async (req, res, next) => {
      const key = keyGenerator(req)
      if (!key) return next()

      const result = await this.checkRateLimit(key, limit, windowSeconds, byUser)
      
      res.setHeader('X-RateLimit-Limit', limit)
      res.setHeader('X-RateLimit-Remaining', result.remaining)
      res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + result.resetIn))
      
      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter)
        return handler(req, res)
      }
      
      next()
    }
  }

  async resetRateLimit(key, byUser = true) {
    if (this.useRedis) {
      const redisKey = `ratelimit:${byUser ? 'user' : 'ip'}:${key}`
      await redisService.del(redisKey)
    } else {
      const localKey = `${key}:${byUser ? 'user' : 'ip'}`
      this.localWindows.delete(localKey)
    }
  }

  async getRateLimitStatus(key, limit, windowSeconds, byUser = true) {
    return this.checkRateLimit(key, limit, windowSeconds, byUser)
  }
}

const rateLimiter = new RateLimiter()
export default rateLimiter
