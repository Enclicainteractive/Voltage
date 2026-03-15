import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

const SECURITY_DIR = path.join(DATA_DIR, 'security')
if (!fs.existsSync(SECURITY_DIR)) {
  fs.mkdirSync(SECURITY_DIR, { recursive: true })
}

class SecurityManager {
  constructor() {
    this.ipBlacklist = new Set()
    this.ipWhitelist = new Set()
    this.failedAttempts = new Map()
    this.suspiciousIPs = new Set()
    this.rateLimitStore = new Map()
    this.loadBlacklist()
    this.loadWhitelist()
  }

  loadBlacklist() {
    try {
      const file = path.join(SECURITY_DIR, 'blacklist.json')
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        this.ipBlacklist = new Set(data.ips || [])
        console.log(`[Security] Loaded ${this.ipBlacklist.size} blacklisted IPs`)
      }
    } catch (err) {
      console.error('[Security] Failed to load blacklist:', err.message)
    }
  }

  saveBlacklist() {
    try {
      const file = path.join(SECURITY_DIR, 'blacklist.json')
      const data = JSON.stringify({ ips: Array.from(this.ipBlacklist) }, null, 2)
      fs.writeFile(file, data, (err) => {
        if (err) console.error('[Security] Failed to save blacklist:', err.message)
      })
    } catch (err) {
      console.error('[Security] Failed to save blacklist:', err.message)
    }
  }

  loadWhitelist() {
    try {
      const file = path.join(SECURITY_DIR, 'whitelist.json')
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        this.ipWhitelist = new Set(data.ips || [])
        console.log(`[Security] Loaded ${this.ipWhitelist.size} whitelisted IPs`)
      }
    } catch (err) {
      console.error('[Security] Failed to load whitelist:', err.message)
    }
  }

  isBlacklisted(ip) {
    return this.ipBlacklist.has(ip)
  }

  isWhitelisted(ip) {
    return this.ipWhitelist.has(ip)
  }

  addToBlacklist(ip) {
    this.ipBlacklist.add(ip)
    this.saveBlacklist()
  }

  removeFromBlacklist(ip) {
    this.ipBlacklist.delete(ip)
    this.saveBlacklist()
  }

  addToWhitelist(ip) {
    this.ipWhitelist.add(ip)
  }

  removeFromWhitelist(ip) {
    this.ipWhitelist.delete(ip)
  }

  recordFailedAttempt(ip, endpoint) {
    const key = `${ip}:${endpoint}`
    const attempts = this.failedAttempts.get(key) || { count: 0, firstAttempt: Date.now(), endpoints: new Set() }
    attempts.count++
    attempts.endpoints.add(endpoint)
    attempts.lastAttempt = Date.now()
    this.failedAttempts.set(key, attempts)

    if (attempts.count >= 10) {
      this.suspiciousIPs.add(ip)
      this.addToBlacklist(ip)
      console.log(`[Security] IP ${ip} blacklisted due to repeated failed attempts`)
    }
  }

  getFailedAttempts(ip) {
    let total = 0
    for (const [key, data] of this.failedAttempts) {
      if (key.startsWith(ip)) {
        total += data.count
      }
    }
    return total
  }

  clearOldAttempts() {
    const now = Date.now()
    const timeout = 15 * 60 * 1000
    for (const [key, data] of this.failedAttempts) {
      if (now - data.lastAttempt > timeout) {
        this.failedAttempts.delete(key)
      }
    }
  }
}

const securityManager = new SecurityManager()
setInterval(() => securityManager.clearOldAttempts(), 5 * 60 * 1000)

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'", "wss:", "https:"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permissionsPolicy: {
    features: {
      camera: ['() => false'],
      microphone: ['() => false'],
      geolocation: ['() => false'],
      payment: ['() => false'],
    },
  },
  crossOriginEmbedderPolicy: false,
})

export const ipFilter = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'

  if (securityManager.isWhitelisted(ip)) {
    return next()
  }

  if (securityManager.isBlacklisted(ip)) {
    console.log(`[Security] Blocked blacklisted IP: ${ip}`)
    return res.status(403).json({ error: 'Access denied' })
  }

  next()
}

export const strictRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress
  },
  skip: (req) => {
    return securityManager.isWhitelisted(req.ip)
  },
})

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later' },
  keyGenerator: (req) => {
    return `${req.ip}:auth`
  },
})

export const loginRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Account locked due to too many failed login attempts' },
  keyGenerator: (req) => {
    return `${req.ip}:login`
  },
})

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'API rate limit exceeded' },
})

export const websocketRateLimit = new Map()

export const wsRateLimiter = (socket, next) => {
  const ip = socket.handshake.address || 'unknown'
  const now = Date.now()
  const windowMs = 60000
  const maxMessages = 120

  if (securityManager.isBlacklisted(ip)) {
    return next(new Error('Access denied'))
  }

  const key = `${ip}:ws`
  const record = websocketRateLimit.get(key) || { count: 0, resetTime: now + windowMs }

  if (now > record.resetTime) {
    record.count = 0
    record.resetTime = now + windowMs
  }

  record.count++

  if (record.count > maxMessages) {
    console.log(`[Security] WebSocket rate limit exceeded for ${ip}`)
    return next(new Error('Rate limit exceeded'))
  }

  websocketRateLimit.set(key, record)
  next()
}

export const sanitizeInput = (req, res, next) => {
  const sanitize = (obj) => {
    if (typeof obj !== 'object' || obj === null) return obj

    for (const key of Object.keys(obj)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        delete obj[key]
        continue
      }

      if (typeof obj[key] === 'string') {
        obj[key] = obj[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/javascript:/gi, '')
          .replace(/on\w+\s*=/gi, '')
          .trim()
      } else if (typeof obj[key] === 'object') {
        sanitize(obj[key])
      }
    }
    return obj
  }

  if (req.body) sanitize(req.body)
  if (req.query) sanitize(req.query)
  if (req.params) sanitize(req.params)

  next()
}

export const validateContentType = (req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const contentType = req.headers['content-type']
    
    if (!contentType) {
      return res.status(415).json({ error: 'Content-Type header required' })
    }

    const allowedTypes = [
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data'
    ]

    const isAllowed = allowedTypes.some(type => contentType.startsWith(type))
    
    if (!isAllowed) {
      return res.status(415).json({ error: 'Unsupported Content-Type' })
    }
  }
  next()
}

export const preventClickjacking = (req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  next()
}

export const requestSizeLimit = (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10)
  const maxSize = 100000 * 1024 * 1024

  if (contentLength > maxSize) {
    return res.status(413).json({ error: 'Payload too large' })
  }

  next()
}

export const timeoutMiddleware = (timeout = 30000) => {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      res.status(503).json({ error: 'Request timeout' })
      req.destroy()
    }, timeout)

    res.on('finish', () => clearTimeout(timer))
    res.on('close', () => clearTimeout(timer))
    next()
  }
}

export { securityManager }
