/**
 * VoltChat Enhanced Error Handler Middleware
 * 
 * Provides comprehensive error handling with detailed logging and monitoring
 */

import errorLogService from '../services/errorLogService.js'

/**
 * Extract request context for error logging
 */
const extractRequestContext = (req) => {
  return {
    endpoint: req.path || req.url,
    method: req.method,
    ip: req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress,
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
  // Explicit status codes
  if (error?.statusCode) return error.statusCode
  if (error?.status) return error.status
  
  // Error-type based status codes
  if (error?.name === 'ValidationError') return 400
  if (error?.name === 'AuthenticationError') return 401
  if (error?.name === 'AuthorizationError') return 403
  if (error?.name === 'NotFoundError') return 404
  if (error?.name === 'ConflictError') return 409
  if (error?.name === 'RateLimitError') return 429
  
  // Database-specific errors
  if (error?.code === 'ER_DUP_ENTRY') return 409
  if (error?.code === 'ER_NO_SUCH_TABLE') return 500
  if (error?.code && error.code.startsWith('ER_')) return 500
  
  // Network errors
  if (error?.code === 'ECONNREFUSED') return 503
  if (error?.code === 'ETIMEDOUT') return 504
  if (error?.code === 'ENOTFOUND') return 502
  
  // Default server error
  return 500
}

/**
 * Create user-friendly error message
 */
const createUserMessage = (error, statusCode, isDevelopment = false) => {
  // In development, show detailed errors
  if (isDevelopment) {
    return {
      error: error?.message || 'An error occurred',
      type: error?.name || 'Error',
      stack: error?.stack || null
    }
  }
  
  // Production user-friendly messages
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
  
  // Log the error if it should be logged
  if (shouldLogError(error, statusCode)) {
    const errorId = errorLogService.logError(error, {
      ...context,
      statusCode
    }, severity)
    
    // Add error ID to context for tracking
    context.errorId = errorId
  }
  
  // Log to console in development
  if (isDevelopment) {
    console.error(`[${severity.toUpperCase()}] ${error?.message || 'Unknown error'}`)
    if (error?.stack) {
      console.error(error.stack)
    }
  }
  
  // Create response
  const userMessage = createUserMessage(error, statusCode, isDevelopment)
  
  const response = {
    ...userMessage,
    timestamp: Date.now(),
    requestId: context.errorId || null
  }
  
  // Add additional debug info in development
  if (isDevelopment && error) {
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