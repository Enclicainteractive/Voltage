/**
 * rateLimitMiddleware.js - Redis-based rate limiting
 */
import { rateLimitCheck } from '../services/redisService.js'
import net from 'net'

const normalizeIpAddress = (rawIp) => {
  if (!rawIp || typeof rawIp !== 'string') return null

  let ip = rawIp.trim()
  if (!ip) return null

  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'))
  }

  if (ip.includes('%')) {
    ip = ip.split('%')[0]
  }

  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7)
    if (net.isIP(mapped) === 4) {
      ip = mapped
    }
  }

  if (net.isIP(ip)) return ip

  const ipv4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (ipv4WithPort && net.isIP(ipv4WithPort[1]) === 4) {
    return ipv4WithPort[1]
  }

  return null
}

const configuredTrustedProxies = new Set(
  String(process.env.TRUSTED_PROXY_IPS || '')
    .split(',')
    .map((ip) => normalizeIpAddress(ip))
    .filter(Boolean)
)

const isTrustedProxyIp = (ip) => {
  if (!ip) return false
  if (configuredTrustedProxies.has(ip)) return true

  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map((part) => Number.parseInt(part, 10))
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    return false
  }

  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('fe80:')) return true

  return false
}

const getSocketRemoteIp = (req) => {
  return normalizeIpAddress(
    req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      req.ip ||
      ''
  )
}

const getClientIp = (req) => {
  const remoteIp = getSocketRemoteIp(req)
  const forwardedFor = req.headers?.['x-forwarded-for']

  if (typeof forwardedFor === 'string' && isTrustedProxyIp(remoteIp)) {
    const clientIp = forwardedFor
      .split(',')
      .map((candidate) => normalizeIpAddress(candidate))
      .filter(Boolean)[0]

    if (clientIp) return clientIp
  }

  return remoteIp || 'unknown'
}

const normalizeRateLimitKey = (key, req) => {
  if (key === null || key === undefined) {
    return getClientIp(req)
  }

  const normalized = String(key).trim()
  if (!normalized) return getClientIp(req)
  return normalized.slice(0, 256)
}

const DEFAULTS = {
  windowMs: 60000, // 1 minute
  max: 100, // max requests per window
  message: 'Too many requests, please try again later',
  statusCode: 429,
  skipFailedRequests: false,
  keyGenerator: (req) => getClientIp(req)
}

export const createRateLimiter = (options = {}) => {
  const config = { ...DEFAULTS, ...options }
  const windowSeconds = Math.max(1, Math.ceil(config.windowMs / 1000))
  const maxRequests = Number.isInteger(config.max) && config.max > 0
    ? config.max
    : DEFAULTS.max

  return async (req, res, next) => {
    const key = normalizeRateLimitKey(
      typeof config.keyGenerator === 'function'
        ? config.keyGenerator(req)
        : getClientIp(req),
      req
    )

    let result
    try {
      result = await rateLimitCheck(`ip:${key}`, maxRequests, windowSeconds)
    } catch (error) {
      console.error('[RateLimit] Backend check failed:', error?.message || error)
      return res.status(503).json({
        error: 'Rate limiting temporarily unavailable'
      })
    }

    if (!result || typeof result.allowed !== 'boolean') {
      return res.status(503).json({
        error: 'Rate limiting temporarily unavailable'
      })
    }

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests)
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
  const windowSeconds = Math.max(1, Math.ceil(config.windowMs / 1000))
  const maxRequests = Number.isInteger(config.max) && config.max > 0
    ? config.max
    : DEFAULTS.max

  return async (req, res, next) => {
    if (!req.user) return next()

    const userId = req.user?.id ? String(req.user.id).trim() : ''
    if (!userId) return next()

    let result
    try {
      result = await rateLimitCheck(`user:${userId.slice(0, 128)}`, maxRequests, windowSeconds)
    } catch (error) {
      console.error('[RateLimit] User backend check failed:', error?.message || error)
      return res.status(503).json({
        error: 'Rate limiting temporarily unavailable'
      })
    }

    if (!result || typeof result.allowed !== 'boolean') {
      return res.status(503).json({
        error: 'Rate limiting temporarily unavailable'
      })
    }

    res.setHeader('X-RateLimit-Limit', maxRequests)
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
