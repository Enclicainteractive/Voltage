/**
 * VoltChat Enhanced Error Logging & Monitoring Service
 * 
 * Provides comprehensive error tracking, logging, and alerting capabilities
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

class ErrorLogService {
  constructor() {
    this.logDirectory = path.join(__dirname, '../logs')
    this.logFiles = {
      errors: path.join(this.logDirectory, 'errors.log'),
      security: path.join(this.logDirectory, 'security.log'),
      performance: path.join(this.logDirectory, 'performance.log'),
      database: path.join(this.logDirectory, 'database.log'),
      validation: path.join(this.logDirectory, 'validation.log')
    }
    
    this.errorCounts = new Map()
    this.alertThresholds = {
      errorRate: 50, // errors per minute
      criticalErrors: 10, // critical errors per minute
      databaseErrors: 20, // database errors per minute
      validationFailures: 100 // validation failures per minute
    }
    
    this.errorPatterns = new Map()
    this.alertCooldowns = new Map()
    this.isInitialized = false
    
    this.init()
  }

  /**
   * Initialize logging service
   */
  init() {
    if (this.isInitialized) return
    
    try {
      // Create logs directory if it doesn't exist
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true })
      }
      
      // Initialize log files
      for (const [type, filePath] of Object.entries(this.logFiles)) {
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, '', 'utf8')
        }
      }
      
      this.isInitialized = true
      console.log('[ErrorLog] Error logging service initialized')
      
      // Start cleanup task
      this.startCleanupTask()
      
    } catch (error) {
      console.error('[ErrorLog] Failed to initialize logging service:', error.message)
    }
  }

  /**
   * Log an error with context and metadata
   */
  logError(error, context = {}, severity = 'error') {
    try {
      const timestamp = new Date().toISOString()
      const errorId = this.generateErrorId()
      
      const logEntry = {
        id: errorId,
        timestamp,
        severity,
        message: error?.message || String(error),
        stack: error?.stack || null,
        context: {
          ...context,
          userAgent: context.userAgent || null,
          ip: context.ip || null,
          userId: context.userId || null,
          endpoint: context.endpoint || null,
          method: context.method || null,
          statusCode: context.statusCode || null
        },
        process: {
          pid: process.pid,
          memory: process.memoryUsage(),
          uptime: process.uptime()
        }
      }
      
      // Write to appropriate log file
      const logType = this.categorizeError(error, context)
      this.writeToFile(logType, logEntry)
      
      // Track error patterns
      this.trackErrorPattern(error, context)
      
      // Check for alerting conditions
      this.checkAlertConditions(logEntry)
      
      // Log to console if in development
      if (config.config?.environment === 'development') {
        console.error(`[${severity.toUpperCase()}] ${errorId}:`, error?.message || error)
        if (error?.stack) {
          console.error(error.stack)
        }
      }
      
      return errorId
      
    } catch (logError) {
      console.error('[ErrorLog] Failed to log error:', logError.message)
      return null
    }
  }

  /**
   * Log security-related events
   */
  logSecurity(event, details = {}, severity = 'warning') {
    const timestamp = new Date().toISOString()
    const eventId = this.generateErrorId()
    
    const logEntry = {
      id: eventId,
      timestamp,
      severity,
      event,
      details: {
        ...details,
        ip: details.ip || null,
        userAgent: details.userAgent || null,
        userId: details.userId || null
      },
      process: {
        pid: process.pid
      }
    }
    
    this.writeToFile('security', logEntry)
    
    // Security events might need immediate attention
    if (severity === 'critical') {
      this.triggerSecurityAlert(logEntry)
    }
    
    return eventId
  }

  /**
   * Log performance issues
   */
  logPerformance(metric, value, context = {}) {
    const timestamp = new Date().toISOString()
    const entryId = this.generateErrorId()
    
    const logEntry = {
      id: entryId,
      timestamp,
      metric,
      value,
      context: {
        ...context,
        endpoint: context.endpoint || null,
        userId: context.userId || null
      },
      process: {
        pid: process.pid,
        memory: process.memoryUsage()
      }
    }
    
    this.writeToFile('performance', logEntry)
    
    // Check for performance thresholds
    if (this.isPerformanceIssue(metric, value)) {
      this.logError(
        new Error(`Performance issue: ${metric} = ${value}`),
        { ...context, performanceMetric: metric },
        'warning'
      )
    }
    
    return entryId
  }

  /**
   * Log database-related errors
   */
  logDatabase(error, query = null, context = {}) {
    const timestamp = new Date().toISOString()
    const errorId = this.generateErrorId()
    
    const logEntry = {
      id: errorId,
      timestamp,
      error: {
        message: error?.message || String(error),
        code: error?.code || null,
        errno: error?.errno || null,
        sqlState: error?.sqlState || null
      },
      query: query ? {
        sql: this.sanitizeQuery(query),
        length: query.length
      } : null,
      context: {
        ...context,
        userId: context.userId || null,
        table: context.table || null,
        operation: context.operation || null
      },
      process: {
        pid: process.pid
      }
    }
    
    this.writeToFile('database', logEntry)
    
    // Also log to main error log
    this.logError(error, { ...context, category: 'database' }, 'error')
    
    return errorId
  }

  /**
   * Log validation failures
   */
  logValidation(errors, context = {}) {
    const timestamp = new Date().toISOString()
    const entryId = this.generateErrorId()
    
    const logEntry = {
      id: entryId,
      timestamp,
      validationErrors: errors,
      context: {
        ...context,
        ip: context.ip || null,
        userAgent: context.userAgent || null,
        endpoint: context.endpoint || null,
        method: context.method || null
      },
      process: {
        pid: process.pid
      }
    }
    
    this.writeToFile('validation', logEntry)
    
    return entryId
  }

  /**
   * Generate unique error ID
   */
  generateErrorId() {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substr(2, 9)
    return `err_${timestamp}_${random}`
  }

  /**
   * Categorize error for appropriate logging
   */
  categorizeError(error, context = {}) {
    if (context.category) return context.category
    
    const message = error?.message?.toLowerCase() || ''
    const stack = error?.stack?.toLowerCase() || ''
    
    // Database errors
    if (message.includes('connection') && (message.includes('refused') || message.includes('timeout'))) return 'database'
    if (message.includes('sql') || message.includes('mysql') || message.includes('postgres')) return 'database'
    if (error?.code && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) return 'database'
    
    // Security-related errors
    if (message.includes('unauthorized') || message.includes('forbidden')) return 'security'
    if (message.includes('token') || message.includes('auth')) return 'security'
    
    // Validation errors
    if (message.includes('validation') || message.includes('invalid')) return 'validation'
    
    return 'errors'
  }

  /**
   * Write log entry to file
   */
  writeToFile(logType, logEntry) {
    try {
      const filePath = this.logFiles[logType] || this.logFiles.errors
      const logLine = JSON.stringify(logEntry) + '\n'
      
      fs.appendFileSync(filePath, logLine, 'utf8')
      
    } catch (writeError) {
      console.error(`[ErrorLog] Failed to write to ${logType} log:`, writeError.message)
    }
  }

  /**
   * Track error patterns for alerting
   */
  trackErrorPattern(error, context) {
    const pattern = this.extractErrorPattern(error, context)
    const now = Date.now()
    const minute = Math.floor(now / 60000)
    
    if (!this.errorPatterns.has(pattern)) {
      this.errorPatterns.set(pattern, new Map())
    }
    
    const patternCounts = this.errorPatterns.get(pattern)
    patternCounts.set(minute, (patternCounts.get(minute) || 0) + 1)
    
    // Clean up old data (keep last 60 minutes)
    for (const [timeKey] of patternCounts) {
      if (timeKey < minute - 60) {
        patternCounts.delete(timeKey)
      }
    }
  }

  /**
   * Extract error pattern for tracking
   */
  extractErrorPattern(error, context) {
    const message = error?.message || String(error)
    const endpoint = context.endpoint || 'unknown'
    const type = error?.constructor?.name || 'Error'
    
    // Create a pattern key that groups similar errors
    const normalizedMessage = message
      .replace(/\d+/g, 'N') // Replace numbers with N
      .replace(/['"]/g, '') // Remove quotes
      .replace(/\s+/g, ' ') // Normalize whitespace
      .slice(0, 100) // Limit length
    
    return `${type}:${endpoint}:${normalizedMessage}`
  }

  /**
   * Check if current error rates exceed alert thresholds
   */
  checkAlertConditions(logEntry) {
    const now = Date.now()
    const minute = Math.floor(now / 60000)
    
    // Count errors in the last minute
    const counts = {
      total: 0,
      critical: 0,
      database: 0,
      validation: 0
    }
    
    for (const patternCounts of this.errorPatterns.values()) {
      const recentCount = patternCounts.get(minute) || 0
      counts.total += recentCount
      
      // Categorize based on log entry
      if (logEntry.severity === 'critical') counts.critical += recentCount
      if (logEntry.context?.category === 'database') counts.database += recentCount
      if (logEntry.context?.category === 'validation') counts.validation += recentCount
    }
    
    // Check thresholds and trigger alerts
    if (counts.total > this.alertThresholds.errorRate) {
      this.triggerAlert('high_error_rate', { errorRate: counts.total, threshold: this.alertThresholds.errorRate })
    }
    
    if (counts.critical > this.alertThresholds.criticalErrors) {
      this.triggerAlert('critical_errors', { criticalErrors: counts.critical, threshold: this.alertThresholds.criticalErrors })
    }
    
    if (counts.database > this.alertThresholds.databaseErrors) {
      this.triggerAlert('database_errors', { databaseErrors: counts.database, threshold: this.alertThresholds.databaseErrors })
    }
  }

  /**
   * Trigger alert (with cooldown to prevent spam)
   */
  triggerAlert(alertType, details) {
    const now = Date.now()
    const cooldownKey = alertType
    const lastAlert = this.alertCooldowns.get(cooldownKey) || 0
    const cooldownPeriod = 5 * 60 * 1000 // 5 minutes
    
    if (now - lastAlert < cooldownPeriod) {
      return // Still in cooldown
    }
    
    this.alertCooldowns.set(cooldownKey, now)
    
    console.error(`[ALERT] ${alertType.toUpperCase()}:`, details)
    
    // Log the alert
    this.logSecurity('system_alert', {
      alertType,
      details,
      timestamp: new Date().toISOString()
    }, 'critical')
  }

  /**
   * Trigger security alert
   */
  triggerSecurityAlert(logEntry) {
    console.error('[SECURITY ALERT]', logEntry.event, logEntry.details)
    
    // In a production system, this might send to external monitoring
    // For now, just ensure it's prominently logged
  }

  /**
   * Check if performance metric indicates an issue
   */
  isPerformanceIssue(metric, value) {
    const thresholds = {
      response_time: 5000, // 5 seconds
      memory_usage: 1024 * 1024 * 1024, // 1GB
      event_loop_lag: 100, // 100ms
      database_query_time: 10000 // 10 seconds
    }
    
    return value > (thresholds[metric] || Infinity)
  }

  /**
   * Sanitize SQL query for logging (remove sensitive data)
   */
  sanitizeQuery(query) {
    if (typeof query !== 'string') return String(query).slice(0, 1000)
    
    return query
      .replace(/password\s*=\s*['"'][^'"]*['"]/gi, "password='***'")
      .replace(/email\s*=\s*['"'][^'"]*['"]/gi, "email='***'")
      .slice(0, 1000) // Limit length
  }

  /**
   * Get error statistics
   */
  getErrorStats() {
    const now = Date.now()
    const minute = Math.floor(now / 60000)
    
    const stats = {
      lastHour: 0,
      lastMinute: 0,
      patterns: {},
      topErrors: []
    }
    
    const patternStats = []
    
    for (const [pattern, patternCounts] of this.errorPatterns) {
      let hourCount = 0
      let minuteCount = 0
      
      for (const [timeKey, count] of patternCounts) {
        if (timeKey >= minute - 60) hourCount += count
        if (timeKey === minute) minuteCount += count
      }
      
      stats.lastHour += hourCount
      stats.lastMinute += minuteCount
      
      if (hourCount > 0) {
        patternStats.push({ pattern, count: hourCount })
      }
    }
    
    // Sort patterns by frequency
    stats.topErrors = patternStats
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(({ pattern, count }) => ({ pattern, count }))
    
    return stats
  }

  /**
   * Clean up old log files
   */
  startCleanupTask() {
    const cleanupInterval = 24 * 60 * 60 * 1000 // 24 hours
    
    setInterval(() => {
      this.cleanupOldLogs()
    }, cleanupInterval)
  }

  /**
   * Clean up logs older than retention period
   */
  cleanupOldLogs() {
    const retentionDays = 30
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000)
    
    for (const [type, filePath] of Object.entries(this.logFiles)) {
      try {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath)
          if (stats.size > 100 * 1024 * 1024) { // 100MB
            this.rotateLogFile(filePath)
          }
        }
      } catch (error) {
        console.error(`[ErrorLog] Failed to check log file ${type}:`, error.message)
      }
    }
  }

  /**
   * Rotate large log files
   */
  rotateLogFile(filePath) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const rotatedPath = `${filePath}.${timestamp}`
      
      fs.renameSync(filePath, rotatedPath)
      fs.writeFileSync(filePath, '', 'utf8')
      
      console.log(`[ErrorLog] Rotated log file: ${filePath}`)
      
    } catch (error) {
      console.error(`[ErrorLog] Failed to rotate log file ${filePath}:`, error.message)
    }
  }
}

// Export singleton instance
export default new ErrorLogService()