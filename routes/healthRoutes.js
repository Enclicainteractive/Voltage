/**
 * VoltChat Health Check Routes
 * 
 * Provides health check endpoints for monitoring and observability
 */

import express from 'express'
import healthService from '../services/healthService.js'
import circuitBreakerManager from '../services/circuitBreaker.js'
import messageBatchService from '../services/messageBatchService.js'
import errorLogService from '../services/errorLogService.js'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { requireAdmin, requireSuperAdmin } from '../middleware/adminAuth.js'

const router = express.Router()
const sendOperationalError = (res, statusCode = 500) => (
  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal server error' : 'Request failed',
    timestamp: Date.now()
  })
)
const isDebugHealthRouteEnabled = () => (
  process.env.NODE_ENV !== 'production' ||
  process.env.ENABLE_HEALTH_DEBUG_ROUTES === 'true'
)
const requireDebugHealthRoute = (_req, res, next) => {
  if (!isDebugHealthRouteEnabled()) {
    return res.status(404).json({ error: 'Not found' })
  }
  return next()
}

/**
 * Basic health check endpoint
 * Returns simple status for load balancers
 */
router.get('/health', async (req, res) => {
  try {
    healthService.recordRequest(true)
    res.status(200).json({ status: 'ok' })
  } catch (error) {
    healthService.recordRequest(false)
    res.status(503).json({ status: 'error' })
  }
})

/**
 * Detailed health status endpoint
 * Returns comprehensive health information
 */
router.get('/health/detailed', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const start = Date.now()
    const health = await healthService.getHealthStatus()
    const duration = Date.now() - start
    
    healthService.recordRequest(true)
    
    res.json({
      ...health,
      checkDuration: duration
    })
  } catch (error) {
    healthService.recordRequest(false)
    sendOperationalError(res, 500)
  }
})

/**
 * Prometheus metrics endpoint
 * Returns metrics in Prometheus format
 */
router.get('/metrics', authenticateToken, requireAdmin, (req, res) => {
  try {
    const metrics = healthService.getPrometheusMetrics()
    healthService.recordRequest(true)
    
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(metrics)
  } catch (error) {
    healthService.recordRequest(false)
    sendOperationalError(res, 500)
  }
})

/**
 * Circuit breaker status endpoint
 */
router.get('/health/circuit-breakers', authenticateToken, requireAdmin, (req, res) => {
  try {
    const status = circuitBreakerManager.getAllStatus()
    const healthScore = circuitBreakerManager.getHealthScore()
    const problematic = circuitBreakerManager.getProblematicBreakers()
    
    healthService.recordRequest(true)
    
    res.json({
      healthScore,
      summary: status.summary,
      breakers: status.breakers,
      problematic,
      timestamp: Date.now()
    })
  } catch (error) {
    healthService.recordRequest(false)
    sendOperationalError(res, 500)
  }
})

/**
 * Reset circuit breaker endpoint (admin only)
 */
router.post('/health/circuit-breakers/:name/reset', authenticateToken, requireSuperAdmin, (req, res) => {
  try {
    const { name } = req.params
    
    if (name === 'all') {
      circuitBreakerManager.resetAll()
      res.json({ message: 'All circuit breakers reset', timestamp: Date.now() })
    } else {
      circuitBreakerManager.reset(name)
      res.json({ message: `Circuit breaker '${name}' reset`, timestamp: Date.now() })
    }
    
    healthService.recordRequest(true)
  } catch (error) {
    healthService.recordRequest(false)
    sendOperationalError(res, 500)
  }
})

/**
 * Liveness probe for Kubernetes
 */
router.get('/health/live', (req, res) => {
  res.status(200).json({
    status: 'alive'
  })
})

/**
 * Readiness probe for Kubernetes
 */
router.get('/health/ready', async (req, res) => {
  try {
    // Check critical dependencies
    const health = await healthService.getHealthStatus()
    const ready = health.status !== 'critical'
    
    const statusCode = ready ? 200 : 503
    
    res.status(statusCode).json({
      status: ready ? 'ready' : 'not-ready',
      ready
    })
  } catch (error) {
    res.status(503).json({ status: 'not-ready', ready: false })
  }
})

/**
 * Startup probe for Kubernetes
 */
router.get('/health/startup', (req, res) => {
  const uptime = process.uptime()
  const isStarted = uptime > 5 // Consider started after 5 seconds
  
  const statusCode = isStarted ? 200 : 503
  
  res.status(statusCode).json({
    status: isStarted ? 'started' : 'starting'
  })
})

/**
 * Message batching metrics endpoint
 */
router.get('/health/message-batching', authenticateToken, requireAdmin, (req, res) => {
  try {
    const metrics = messageBatchService.getMetrics()
    const status = messageBatchService.getBatchStatus()
    
    healthService.recordRequest(true)
    
    res.json({
      ...metrics,
      batches: status,
      timestamp: Date.now()
    })
  } catch (error) {
    healthService.recordRequest(false)
    sendOperationalError(res, 500)
  }
})

/**
 * Force flush all pending message batches (admin endpoint)
 */
router.post('/health/message-batching/flush', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    await messageBatchService.flushAll()
    
    res.json({
      message: 'All message batches flushed successfully',
      timestamp: Date.now()
    })
  } catch (error) {
    sendOperationalError(res, 500)
  }
})

/**
 * Validation metrics endpoint
 */
router.get('/health/validation', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const validationModule = await import('../middleware/builtinValidationMiddleware.js')
    const validationFailures = validationModule?.validationFailures
    
    const now = Date.now()
    const windowMs = 5 * 60 * 1000 // 5 minutes
    let totalFailures = 0
    let activeIPs = 0
    
    // Calculate metrics from validation failures map
    if (validationFailures && typeof validationFailures.size === 'number') {
      activeIPs = validationFailures.size
      
      for (const failures of validationFailures.values()) {
        if (Array.isArray(failures)) {
          totalFailures += failures.filter(timestamp => now - timestamp < windowMs).length
        }
      }
    }
    
    healthService.recordRequest(true)
    
    res.json({
      totalValidationFailures: totalFailures,
      activeIPsWithFailures: activeIPs,
      windowMinutes: windowMs / (60 * 1000),
      validationEnabled: true,
      sanitizationEnabled: true,
      rateLimitEnabled: true,
      timestamp: now
    })
  } catch (error) {
    healthService.recordRequest(false)
    sendOperationalError(res, 500)
  }
})

/**
 * Error statistics endpoint
 */
router.get('/health/errors', authenticateToken, requireAdmin, (req, res) => {
  try {
    const stats = errorLogService.getErrorStats()
    
    healthService.recordRequest(true)
    
    res.json({
      ...stats,
      timestamp: Date.now()
    })
  } catch (error) {
    healthService.recordRequest(false)
    sendOperationalError(res, 500)
  }
})

/**
 * Test error logging endpoint (for development/testing)
 */
router.post('/health/test-error', requireDebugHealthRoute, authenticateToken, requireSuperAdmin, (req, res) => {
  try {
    const safeType = typeof req.body?.type === 'string' ? req.body.type.trim().slice(0, 64) : 'test'
    const requestedSeverity = typeof req.body?.severity === 'string' ? req.body.severity.trim().toLowerCase() : 'info'
    const allowedSeverities = new Set(['debug', 'info', 'warn', 'error', 'critical'])
    const safeSeverity = allowedSeverities.has(requestedSeverity) ? requestedSeverity : 'info'
    
    // Create test error
    const testError = new Error(`Test error of type: ${safeType || 'test'}`)
    testError.name = 'TestError'
    
    const errorId = errorLogService.logError(testError, {
      endpoint: req.path,
      method: req.method,
      ip: req.ip,
      testType: safeType || 'test'
    }, safeSeverity)
    
    res.json({
      message: 'Test error logged successfully',
      errorId,
      type: safeType || 'test',
      severity: safeSeverity,
      timestamp: Date.now()
    })
  } catch (error) {
    sendOperationalError(res, 500)
  }
})

export default router
