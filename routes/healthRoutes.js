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

const router = express.Router()

/**
 * Basic health check endpoint
 * Returns simple status for load balancers
 */
router.get('/health', async (req, res) => {
  try {
    const start = Date.now()
    const health = await healthService.getHealthStatus()
    const duration = Date.now() - start
    
    healthService.recordRequest(true)
    
    const statusCode = health.status === 'healthy' ? 200 :
                      health.status === 'warning' ? 200 :
                      health.status === 'degraded' ? 503 : 503
    
    res.status(statusCode).json({
      status: health.status,
      timestamp: health.timestamp,
      uptime: health.uptime,
      duration,
      version: process.env.npm_package_version || '1.0.0'
    })
  } catch (error) {
    healthService.recordRequest(false)
    res.status(503).json({
      status: 'error',
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Detailed health status endpoint
 * Returns comprehensive health information
 */
router.get('/health/detailed', async (req, res) => {
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
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Prometheus metrics endpoint
 * Returns metrics in Prometheus format
 */
router.get('/metrics', (req, res) => {
  try {
    const metrics = healthService.getPrometheusMetrics()
    healthService.recordRequest(true)
    
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(metrics)
  } catch (error) {
    healthService.recordRequest(false)
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Circuit breaker status endpoint
 */
router.get('/health/circuit-breakers', (req, res) => {
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
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Reset circuit breaker endpoint (admin only)
 */
router.post('/health/circuit-breakers/:name/reset', (req, res) => {
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
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Liveness probe for Kubernetes
 */
router.get('/health/live', (req, res) => {
  res.status(200).json({
    status: 'alive',
    timestamp: Date.now(),
    pid: process.pid
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
      health: health.status,
      timestamp: Date.now(),
      checks: Object.keys(health.checks).length
    })
  } catch (error) {
    res.status(503).json({
      status: 'not-ready',
      error: error.message,
      timestamp: Date.now()
    })
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
    status: isStarted ? 'started' : 'starting',
    uptime,
    timestamp: Date.now()
  })
})

/**
 * Message batching metrics endpoint
 */
router.get('/health/message-batching', (req, res) => {
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
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Force flush all pending message batches (admin endpoint)
 */
router.post('/health/message-batching/flush', async (req, res) => {
  try {
    await messageBatchService.flushAll()
    
    res.json({
      message: 'All message batches flushed successfully',
      timestamp: Date.now()
    })
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Validation metrics endpoint
 */
router.get('/health/validation', (req, res) => {
  try {
    // Import validation middleware to access internal state
    const { validationFailures } = require('../middleware/builtinValidationMiddleware.js')
    
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
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Error statistics endpoint
 */
router.get('/health/errors', (req, res) => {
  try {
    const stats = errorLogService.getErrorStats()
    
    healthService.recordRequest(true)
    
    res.json({
      ...stats,
      timestamp: Date.now()
    })
  } catch (error) {
    healthService.recordRequest(false)
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    })
  }
})

/**
 * Test error logging endpoint (for development/testing)
 */
router.post('/health/test-error', (req, res) => {
  try {
    const { type = 'test', severity = 'info' } = req.body
    
    // Create test error
    const testError = new Error(`Test error of type: ${type}`)
    testError.name = 'TestError'
    
    const errorId = errorLogService.logError(testError, {
      endpoint: req.path,
      method: req.method,
      ip: req.ip,
      testType: type
    }, severity)
    
    res.json({
      message: 'Test error logged successfully',
      errorId,
      type,
      severity,
      timestamp: Date.now()
    })
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    })
  }
})

export default router