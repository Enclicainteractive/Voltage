#!/usr/bin/env node

/**
 * VoltChat Cluster Startup Script
 * 
 * This script handles the initialization of VoltChat in cluster mode.
 * It can automatically detect the environment and start the appropriate
 * number of workers, or run in single-process mode for development.
 */

import path from 'path'
import fs from 'fs'
import { config } from 'dotenv'
import { cpus } from 'os'

// Load environment variables
config()

// Check if we should run in cluster mode
const isClusterMode = process.env.CLUSTER_MODE !== 'false'
const isDevelopment = process.env.NODE_ENV === 'development'
const isProduction = process.env.NODE_ENV === 'production'

// Configure environment
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'development'
}

console.log('🚀 VoltChat Starting...')
console.log(`📍 Environment: ${process.env.NODE_ENV}`)
console.log(`🔧 Cluster Mode: ${isClusterMode ? 'Enabled' : 'Disabled'}`)
console.log(`📡 Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`)

// Validate required environment variables
const requiredEnvVars = ['DATABASE_URL']
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName])

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:')
  missingEnvVars.forEach(varName => console.error(`   - ${varName}`))
  console.error('\nPlease set these variables in your .env file or environment.')
  process.exit(1)
}

// Check if Redis is configured for cluster mode
if (isClusterMode && !process.env.REDIS_HOST) {
  console.warn('⚠️  Cluster mode enabled but REDIS_HOST not configured.')
  console.warn('   Clustering features will be disabled.')
  console.warn('   Set REDIS_HOST to enable full clustering support.')
}

// Set default worker count based on environment
if (isClusterMode && !process.env.MIN_WORKERS) {
  if (isDevelopment) {
    process.env.MIN_WORKERS = '1'
    process.env.MAX_WORKERS = '2'
  } else {
    process.env.MIN_WORKERS = '2'
    process.env.MAX_WORKERS = cpus().length.toString()
  }
}

console.log(`👥 Workers: ${process.env.MIN_WORKERS || 'N/A'} - ${process.env.MAX_WORKERS || 'N/A'}`)

// Health check configuration
if (!process.env.HEALTH_PORT) {
  process.env.HEALTH_PORT = '3001'
}

// Start the appropriate server
if (isClusterMode && !isDevelopment) {
  console.log('🔄 Starting cluster server...')
  import('./cluster-server.js').catch(error => {
    console.error('❌ Failed to start cluster server:', error)
    process.exit(1)
  })
} else {
  console.log('📱 Starting single-process server...')
  
  // Import the ES module server
  import('./server.js').catch(error => {
    console.error('❌ Failed to start server:', error)
    process.exit(1)
  })
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully...')
  process.exit(0)
})

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason)
  process.exit(1)
})