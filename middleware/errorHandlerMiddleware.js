/**
 * VoltChat Enhanced Error Handler Middleware
 * 
 * Provides comprehensive error handling with detailed logging and monitoring
 */

import errorLogService from '../services/errorLogService.js'
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

const isPrivateOrLoopbackIp = (ip) => {
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

const getClientIp = (req) => {
  const remoteIp = normalizeIpAddress(
    req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      req.ip ||
      ''
  )
  const forwardedFor = req.headers?.['x-forwarded-for']

  if (typeof forwardedFor === 'string' && isPrivateOrLoopbackIp(remoteIp)) {
    const clientIp = forwardedFor
      .split(',')
      .map((candidate) => normalizeIpAddress(candidate))
      .filter(Boolean)[0]

    if (clientIp) return clientIp
  }

  return remoteIp || 'unknown'
}

const sanitizeStatusCode = (value) => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 400 || parsed > 599) {
    return 500
  }
  return parsed
}

/**
 * Extract request context for error logging
 */
const extractRequestContext = (req) => {
  return {
    endpoint: req.path || req.url,
    method: req.method,
    ip: getClientIp(req),
    userAgent: req.get('User-Agent'),
    userId: req.user?.id || null,
    query: req.query || {},
    params: req.params || {},
    headers: {
      'content-type': req.get('Content-Type'),
      'authorization': req.get('Authorization') ? '[REDACTED]' : null,
      'referer': req.get('Referer'),
      'origin': req.get('Origin')
    }
  }
}

/**
 * Determine error severity based on error type and status code
 */
const determineSeverity = (error, statusCode) => {
  // Critical errors that need immediate attention
  if (statusCode >= 500) return 'critical'
  if (error?.name === 'DatabaseError') return 'critical'
  if (error?.code && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) return 'critical'
  
  // Warning-level errors
  if (statusCode >= 400 && statusCode < 500) return 'warning'
  if (error?.name === 'ValidationError') return 'warning'
  if (error?.name === 'AuthenticationError') return 'warning'
  
  // Default to error level
  return 'error'
}

/**
 * Determine appropriate status code from error
 */
const determineStatusCode = (error) => {
  let statusCode

  // Explicit status codes
  if (error?.statusCode) statusCode = error.statusCode
  else if (error?.status) statusCode = error.status
  
  // Error-type based status codes
  else if (error?.name === 'ValidationError') statusCode = 400
  else if (error?.name === 'AuthenticationError') statusCode = 401
  else if (error?.name === 'AuthorizationError') statusCode = 403
  else if (error?.name === 'NotFoundError') statusCode = 404
  else if (error?.name === 'ConflictError') statusCode = 409
  else if (error?.name === 'RateLimitError') statusCode = 429
  
  // Database-specific errors
  else if (error?.code === 'ER_DUP_ENTRY') statusCode = 409
  else if (error?.code === 'ER_NO_SUCH_TABLE') statusCode = 500
  else if (error?.code && error.code.startsWith('ER_')) statusCode = 500
  
  // Network errors
  else if (error?.code === 'ECONNREFUSED') statusCode = 503
  else if (error?.code === 'ETIMEDOUT') statusCode = 504
  else if (error?.code === 'ENOTFOUND') statusCode = 502
  
  // Default server error
  else statusCode = 500

  return sanitizeStatusCode(statusCode)
}

/**
 * Create user-friendly error message
 *
 * `exposeDetails` MUST only be true when both NODE_ENV === 'development' AND
 * an explicit opt-in env flag is set. We never leak stack traces by default
 * even in development (server logs still get the full info).
 */
const createUserMessage = (error, statusCode, exposeDetails = false) => {
  // Only when explicitly opted-in and never for server-side errors.
  if (exposeDetails && statusCode < 500) {
    return {
      error: error?.message || 'An error occurred',
      type: error?.name || 'Error'
    }
  }

  // Production / safe default user-friendly messages
  const userMessages = {
    400: 'The request was invalid. Please check your input.',
    401: 'Authentication is required to access this resource.',
    403: 'You do not have permission to access this resource.',
    404: 'The requested resource was not found.',
    409: 'There was a conflict with your request. The resource may already exist.',
    429: 'Too many requests. Please try again later.',
    500: 'An internal server error occurred. Our team has been notified.',
    502: 'Bad gateway. The server received an invalid response.',
    503: 'Service temporarily unavailable. Please try again later.',
    504: 'Gateway timeout. The request took too long to process.'
  }
  
  return {
    error: userMessages[statusCode] || 'An unexpected error occurred.',
    code: statusCode
  }
}

/**
 * Check if error should be logged (to avoid spam)
 */
const shouldLogError = (error, statusCode) => {
  // Always log server errors
  if (statusCode >= 500) return true
  
  // Log security-related errors
  if (statusCode === 401 || statusCode === 403) return true
  
  // Skip common client errors that don't need logging
  if (statusCode === 404) return false
  if (statusCode === 400 && error?.name === 'ValidationError') return false
  
  return true
}

/**
 * Main error handler middleware
 */
const errorHandler = (error, req, res, next) => {
  const context = extractRequestContext(req)
  const statusCode = determineStatusCode(error)
  const severity = determineSeverity(error, statusCode)
  const isDevelopment = process.env.NODE_ENV === 'development'
  // Stack traces / error internals are only sent to the client when BOTH
  // NODE_ENV === 'development' AND EXPOSE_ERRORS=true. The default — even in
  // dev — is to NOT leak stack traces. Server logs still receive everything.
  const exposeDetails =
    isDevelopment &&
    process.env.EXPOSE_ERRORS === 'true' &&
    isPrivateOrLoopbackIp(getClientIp(req))

  // Log the error if it should be logged
  if (shouldLogError(error, statusCode)) {
    const errorId = errorLogService.logError(error, {
      ...context,
      statusCode
    }, severity)

    // Add error ID to context for tracking
    context.errorId = errorId
  }

  // Log to console in development (server-side only — never sent to client)
  if (isDevelopment) {
    console.error(`[${severity.toUpperCase()}] ${error?.message || 'Unknown error'}`)
    if (error?.stack) {
      console.error(error.stack)
    }
  }

  // Create response (stack only included if exposeDetails is true)
  const userMessage = createUserMessage(error, statusCode, exposeDetails)

  const response = {
    ...userMessage,
    timestamp: Date.now(),
    requestId: context.errorId || null
  }

  // Only attach debug info to the response when explicitly opted-in.
  if (exposeDetails && error && statusCode < 500) {
    response.debug = {
      originalError: error.message,
      stack: error.stack?.split('\n').slice(0, 5) // First 5 lines of stack
    }
  }

  res.status(statusCode).json(response)
}

/**
 * Async error wrapper for route handlers
 */
const asyncErrorHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/**
 * 404 handler for unknown routes
 */
const notFoundHandler = (req, res, next) => {
  const error = new Error(`Not found: ${req.method} ${req.path}`)
  error.name = 'NotFoundError'
  error.statusCode = 404
  
  // Log 404s for API routes (might indicate broken links)
  if (req.path.startsWith('/api/')) {
    const context = extractRequestContext(req)
    errorLogService.logError(error, {
      ...context,
      statusCode: 404,
      category: 'routing'
    }, 'info')
  }
  
  next(error)
}

/**
 * Database error handler
 */
const databaseErrorHandler = (error, context = {}) => {
  const dbContext = {
    ...context,
    category: 'database',
    errorCode: error?.code,
    errno: error?.errno,
    sqlState: error?.sqlState
  }
  
  return errorLogService.logDatabase(error, context.query, dbContext)
}

/**
 * Validation error handler
 */
const validationErrorHandler = (errors, context = {}) => {
  const validationContext = {
    ...context,
    category: 'validation',
    errorCount: Array.isArray(errors) ? errors.length : 1
  }
  
  return errorLogService.logValidation(errors, validationContext)
}

/**
 * Security event handler
 */
const securityEventHandler = (event, details = {}, severity = 'warning') => {
  return errorLogService.logSecurity(event, details, severity)
}

/**
 * Performance issue handler
 */
const performanceIssueHandler = (metric, value, context = {}) => {
  return errorLogService.logPerformance(metric, value, context)
}

/**
 * Unhandled promise rejection handler
 */
const setupGlobalErrorHandlers = () => {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
    
    const error = reason instanceof Error ? reason : new Error(String(reason))
    error.name = 'UnhandledRejection'
    
    errorLogService.logError(error, {
      category: 'runtime',
      type: 'unhandledRejection'
    }, 'critical')
  })
  
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error)
    
    errorLogService.logError(error, {
      category: 'runtime',
      type: 'uncaughtException'
    }, 'critical')
    
    // In production, you might want to gracefully shutdown
    // process.exit(1)
  })
}

/**
 * Error recovery utilities
 */
const errorRecovery = {
  /**
   * Retry operation with exponential backoff
   */
  retry: async (operation, maxRetries = 3, baseDelay = 1000) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error) {
        if (attempt === maxRetries) {
          throw error
        }
        
        const delay = baseDelay * Math.pow(2, attempt - 1)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  },

  /**
   * Circuit breaker for failed operations
   */
  circuitBreaker: (operation, failureThreshold = 5, resetTimeout = 60000) => {
    let failureCount = 0
    let lastFailureTime = 0
    let isOpen = false
    
    return async (...args) => {
      if (isOpen) {
        if (Date.now() - lastFailureTime > resetTimeout) {
          isOpen = false
          failureCount = 0
        } else {
          throw new Error('Circuit breaker is open')
        }
      }
      
      try {
        const result = await operation(...args)
        failureCount = 0
        return result
      } catch (error) {
        failureCount++
        lastFailureTime = Date.now()
        
        if (failureCount >= failureThreshold) {
          isOpen = true
        }
        
        throw error
      }
    }
  }
}

export {
  errorHandler,
  asyncErrorHandler,
  notFoundHandler,
  databaseErrorHandler,
  validationErrorHandler,
  securityEventHandler,
  performanceIssueHandler,
  setupGlobalErrorHandlers,
  errorRecovery,
  extractRequestContext,
  determineSeverity,
  determineStatusCode
}
