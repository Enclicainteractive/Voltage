/**
 * rateLimitMiddleware.js - Redis-based rate limiting
 */
import { rateLimitCheck } from '../services/redisService.js'

const DEFAULTS = {
  windowMs: 60000, // 1 minute
  max: 100, // max requests per window
  message: 'Too many requests, please try again later',
  statusCode: 429,
  skipFailedRequests: false,
  keyGenerator: (req) => req.ip || req.connection.remoteAddress
}

export const createRateLimiter = (options = {}) => {
  const config = { ...DEFAULTS, ...options }
  const windowSeconds = Math.floor(config.windowMs / 1000)

  return async (req, res, next) => {
    const key = typeof config.keyGenerator === 'function' 
      ? config.keyGenerator(req) 
      : req.ip

    const result = await rateLimitCheck(`ip:${key}`, config.max, windowSeconds)

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', config.max)
    res.setHeader('X-RateLimit-Remaining', result.remaining ?? 0)
    if (result.resetIn != null) {
      res.setHeader('X-RateLimit-Reset', result.resetIn)
    }

    if (!result.allowed) {
      res.setHeader('Retry-After', result.resetIn ?? 60)
      return res.status(config.statusCode).json({
        error: config.message,
        retryAfter: result.resetIn
      })
    }

    next()
  }
}

export const createUserRateLimiter = (options = {}) => {
  const config = { ...DEFAULTS, ...options }
  const windowSeconds = Math.floor(config.windowMs / 1000)

  return async (req, res, next) => {
    if (!req.user) return next()

    const key = `user:${req.user.id}`
    const result = await rateLimitCheck(key, config.max, windowSeconds)

    res.setHeader('X-RateLimit-Limit', config.max)
    res.setHeader('X-RateLimit-Remaining', result.remaining ?? 0)
    if (result.resetIn != null) {
      res.setHeader('X-RateLimit-Reset', result.resetIn)
    }

    if (!result.allowed) {
      res.setHeader('Retry-After', result.resetIn ?? 60)
      return res.status(config.statusCode).json({
        error: config.message,
        retryAfter: result.resetIn
      })
    }

    next()
  }
}

// Specific rate limiters
export const apiLimiter = createRateLimiter({
  windowMs: 60000,
  max: 200
})

export const authLimiter = createRateLimiter({
  windowMs: 900000, // 15 minutes
  max: 10,
  message: 'Too many authentication attempts, please try again later'
})

export const messageLimiter = createUserRateLimiter({
  windowMs: 1000,
  max: 5,
  message: 'You are sending messages too quickly'
})

export const uploadLimiter = createUserRateLimiter({
  windowMs: 60000,
  max: 20,
  message: 'Too many file uploads, please slow down'
})

export default {
  createRateLimiter,
  createUserRateLimiter,
  apiLimiter,
  authLimiter,
  messageLimiter,
  uploadLimiter
}
