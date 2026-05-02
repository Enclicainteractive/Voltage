import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { fileURLToPath } from 'url'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

const SECURITY_DIR = path.join(DATA_DIR, 'security')
if (!fs.existsSync(SECURITY_DIR)) {
  fs.mkdirSync(SECURITY_DIR, { recursive: true })
}

const getRawHeaderCount = (req, name) => {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : []
  let count = 0
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === name) {
      count++
    }
  }
  return count
}

const normalizeIpAddress = (rawIp) => {
  if (!rawIp || typeof rawIp !== 'string') return null

  let ip = rawIp.trim()
  if (!ip) return null

  // Handle bracketed IPv6 addresses such as [::1]:443.
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'))
  }

  // Remove zone index from IPv6 addresses (e.g. fe80::1%lo0).
  if (ip.includes('%')) {
    ip = ip.split('%')[0]
  }

  // Normalize IPv4-mapped IPv6 notation.
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7)
    if (net.isIP(mapped) === 4) {
      ip = mapped
    }
  }

  if (net.isIP(ip)) {
    return ip
  }

  // Strip "ip:port" for plain IPv4 socket format.
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
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // Unique local addresses.
  if (lower.startsWith('fe80:')) return true // Link-local.

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

const getForwardedClientIp = (req) => {
  const remoteIp = getSocketRemoteIp(req)
  if (!isTrustedProxyIp(remoteIp)) return null

  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor !== 'string') return null

  const chain = forwardedFor
    .split(',')
    .map((candidate) => normalizeIpAddress(candidate))
    .filter(Boolean)

  return chain[0] || null
}

const hasSuspiciousRequestFraming = (req) => {
  const contentLength = req.headers['content-length']
  const transferEncoding = req.headers['transfer-encoding']

  // Duplicate framing headers are a classic request smuggling primitive.
  if (getRawHeaderCount(req, 'content-length') > 1) return true
  if (getRawHeaderCount(req, 'transfer-encoding') > 1) return true

  if (contentLength !== undefined && transferEncoding !== undefined) {
    return true
  }

  if (contentLength !== undefined) {
    const rawValue = Array.isArray(contentLength)
      ? contentLength.join(',')
      : String(contentLength)
    const normalized = rawValue.trim()
    if (!/^\d+$/.test(normalized)) return true
    const parsed = Number(normalized)
    if (!Number.isSafeInteger(parsed)) return true
  }

  if (transferEncoding !== undefined) {
    const rawValue = Array.isArray(transferEncoding)
      ? transferEncoding.join(',')
      : String(transferEncoding)

    const encodings = rawValue
      .split(',')
      .map((encoding) => encoding.trim().toLowerCase())
      .filter(Boolean)

    if (encodings.length !== 1 || encodings[0] !== 'chunked') {
      return true
    }
  }

  return false
}

const rejectSuspiciousRequestFraming = (req, res) => {
  if (!hasSuspiciousRequestFraming(req)) return false
  const clientIp = getClientIp(req)
  console.warn(`[Security] Rejected malformed request framing from ${clientIp}`)
  res.status(400).json({ error: 'Malformed request framing' })
  return true
}

export const getClientIp = (req) => {
  return getForwardedClientIp(req) || getSocketRemoteIp(req) || 'unknown'
}

const getSocketClientIp = (socket) => {
  const remoteIp = normalizeIpAddress(
    socket.request?.socket?.remoteAddress ||
      socket.handshake?.address ||
      socket.conn?.remoteAddress ||
      ''
  )

  const forwardedFor = socket.handshake?.headers?.['x-forwarded-for']
  if (typeof forwardedFor === 'string' && isTrustedProxyIp(remoteIp)) {
    const firstForwardedIp = forwardedFor
      .split(',')
      .map((candidate) => normalizeIpAddress(candidate))
      .filter(Boolean)[0]

    if (firstForwardedIp) return firstForwardedIp
  }

  return remoteIp || 'unknown'
}

class SecurityManager {
  constructor() {
    this.ipBlacklist = new Set()
    this.ipWhitelist = new Set()
    this.failedAttempts = new Map()
    this.suspiciousIPs = new Set()
    this.rateLimitStore = new Map()
    // Optimize: Cache for IP lookups to avoid repeated Set lookups
    this.blacklistCache = new Map()
    this.whitelistCache = new Map()
    this.cacheTTL = 5000 // 5 seconds cache
    this.loadBlacklist()
    this.loadWhitelist()
  }

  // Optimized: Cache blacklist check results
  isBlacklisted(ip) {
    const cached = this.blacklistCache.get(ip)
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.result
    }
    const result = this.ipBlacklist.has(ip)
    this.blacklistCache.set(ip, { result, timestamp: Date.now() })
    return result
  }

  // Optimized: Cache whitelist check results
  isWhitelisted(ip) {
    const cached = this.whitelistCache.get(ip)
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.result
    }
    const result = this.ipWhitelist.has(ip)
    this.whitelistCache.set(ip, { result, timestamp: Date.now() })
    return result
  }

  invalidateCache(ip) {
    this.blacklistCache.delete(ip)
    this.whitelistCache.delete(ip)
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

  addToBlacklist(ip) {
    this.ipBlacklist.add(ip)
    this.invalidateCache(ip)
    this.saveBlacklist()
  }

  removeFromBlacklist(ip) {
    this.ipBlacklist.delete(ip)
    this.invalidateCache(ip)
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
      // Removed 'unsafe-eval' (enables eval/Function-like execution from any
      // injected script) and 'blob:' (allows fetched/created blobs to execute
      // as scripts). Kept 'unsafe-inline' for now because Vite-built apps
      // emit inline bootstrap snippets; removing it requires a nonce-based
      // CSP wired through the HTML response.
      // TODO: migrate to a nonce-based CSP and drop 'unsafe-inline' from
      // scriptSrc and styleSrc.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'"],
      // TODO: federation requires arbitrary cross-origin wss/https, so this
      // stays broad for now. Tighten once we have an allow-list of federated
      // peers we can pin.
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
  // TODO: enabling COEP ('require-corp') would give us cross-origin isolation
  // (and access to high-resolution timers / SharedArrayBuffer), but it tends
  // to break embedded media, third-party iframes, and federation assets.
  // Re-evaluate once all media sources serve appropriate CORP/COEP headers.
  crossOriginEmbedderPolicy: false,
})

export const ipFilter = (req, res, next) => {
  const ip = getClientIp(req)

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
    return getClientIp(req)
  },
  skip: (req) => {
    return securityManager.isWhitelisted(getClientIp(req))
  },
})

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later' },
  keyGenerator: (req) => {
    return `${getClientIp(req)}:auth`
  },
})

export const loginRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Account locked due to too many failed login attempts' },
  keyGenerator: (req) => {
    return `${getClientIp(req)}:login`
  },
})

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'API rate limit exceeded' },
  keyGenerator: (req) => {
    return `${getClientIp(req)}:api`
  },
})

export const websocketRateLimit = new Map()

export const wsRateLimiter = (socket, next) => {
  const ip = getSocketClientIp(socket)
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
  if (rejectSuspiciousRequestFraming(req, res)) {
    return
  }

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
  if (rejectSuspiciousRequestFraming(req, res)) {
    return
  }

  const rawContentLength = req.headers['content-length']
  // Read from config; default to 10MB. Was previously 100GB which made this
  // middleware effectively a no-op. Genuinely large uploads should go through
  // a multipart upload route with its own (multer-managed) larger limit.
  const maxSize = config.config.limits?.maxRequestSize || (10 * 1024 * 1024)

  if (rawContentLength === undefined) {
    return next()
  }

  const contentLength = Number(String(rawContentLength).trim())
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return res.status(400).json({ error: 'Invalid Content-Length' })
  }

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
