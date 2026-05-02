const cluster = require('cluster')
const os = require('os')

// Cluster configuration
const clusterConfig = {
  // Worker process settings
  workers: {
    min: parseInt(process.env.MIN_WORKERS) || 2,
    max: parseInt(process.env.MAX_WORKERS) || os.cpus().length,
    auto: process.env.AUTO_SCALE !== 'false', // Auto-scaling enabled by default
    restartDelay: parseInt(process.env.WORKER_RESTART_DELAY) || 1000,
    gracefulTimeout: parseInt(process.env.GRACEFUL_TIMEOUT) || 30000
  },

  // Redis cluster settings
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB) || 0,
    keyPrefix: process.env.REDIS_PREFIX || 'voltchat:',
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableAutoPipelining: true
  },

  // Load balancing settings
  loadBalancing: {
    algorithm: process.env.LB_ALGORITHM || 'round-robin', // round-robin, least-connections, random
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 30000,
    unhealthyThreshold: parseInt(process.env.UNHEALTHY_THRESHOLD) || 3,
    loadThreshold: parseFloat(process.env.LOAD_THRESHOLD) || 0.8,
    memoryThreshold: parseFloat(process.env.MEMORY_THRESHOLD) || 0.85
  },

  // Cluster communication
  cluster: {
    heartbeatInterval: parseInt(process.env.CLUSTER_HEARTBEAT) || 5000,
    nodeTimeout: parseInt(process.env.CLUSTER_NODE_TIMEOUT) || 15000,
    leaderTimeout: parseInt(process.env.CLUSTER_LEADER_TIMEOUT) || 20000,
    broadcastTimeout: parseInt(process.env.CLUSTER_BROADCAST_TIMEOUT) || 5000
  },

  // WebSocket settings for clustering
  websocket: {
    transports: ['websocket', 'polling'],
    pingTimeout: parseInt(process.env.WS_PING_TIMEOUT) || 60000,
    pingInterval: parseInt(process.env.WS_PING_INTERVAL) || 25000,
    upgradeTimeout: parseInt(process.env.WS_UPGRADE_TIMEOUT) || 10000,
    maxHttpBufferSize: parseInt(process.env.WS_MAX_BUFFER) || 1e6,
    allowEIO3: true,
    cors: {
      origin: process.env.CORS_ORIGIN || "*",
      credentials: true
    }
  },

  // Scaling policies
  scaling: {
    enabled: process.env.AUTO_SCALE !== 'false',
    scaleUpThreshold: parseFloat(process.env.SCALE_UP_THRESHOLD) || 0.7,
    scaleDownThreshold: parseFloat(process.env.SCALE_DOWN_THRESHOLD) || 0.3,
    cooldownPeriod: parseInt(process.env.SCALE_COOLDOWN) || 300000, // 5 minutes
    maxScaleUp: parseInt(process.env.MAX_SCALE_UP) || 2,
    maxScaleDown: parseInt(process.env.MAX_SCALE_DOWN) || 1
  },

  // Monitoring and metrics
  monitoring: {
    enabled: process.env.MONITORING !== 'false',
    metricsInterval: parseInt(process.env.METRICS_INTERVAL) || 30000,
    retentionPeriod: parseInt(process.env.METRICS_RETENTION) || 3600000, // 1 hour
    alertThresholds: {
      cpu: parseFloat(process.env.CPU_ALERT_THRESHOLD) || 0.8,
      memory: parseFloat(process.env.MEMORY_ALERT_THRESHOLD) || 0.85,
      errorRate: parseFloat(process.env.ERROR_RATE_THRESHOLD) || 0.05,
      responseTime: parseInt(process.env.RESPONSE_TIME_THRESHOLD) || 1000
    }
  },

  // Service discovery
  discovery: {
    enabled: process.env.SERVICE_DISCOVERY !== 'false',
    announceInterval: parseInt(process.env.ANNOUNCE_INTERVAL) || 10000,
    ttl: parseInt(process.env.SERVICE_TTL) || 30000,
    tags: (process.env.SERVICE_TAGS || 'voltchat,websocket').split(',')
  }
}

// Environment-specific overrides
if (process.env.NODE_ENV === 'production') {
  // Production optimizations
  clusterConfig.workers.min = Math.max(2, clusterConfig.workers.min)
  clusterConfig.loadBalancing.healthCheckInterval = 15000
  clusterConfig.monitoring.enabled = true
  
} else if (process.env.NODE_ENV === 'development') {
  // Development settings
  clusterConfig.workers.min = 1
  clusterConfig.workers.max = 2
  clusterConfig.loadBalancing.healthCheckInterval = 60000
  clusterConfig.monitoring.enabled = false
}

// Validation
function validateConfig() {
  const errors = []

  // Validate worker counts
  if (clusterConfig.workers.min > clusterConfig.workers.max) {
    errors.push('MIN_WORKERS cannot be greater than MAX_WORKERS')
  }

  if (clusterConfig.workers.min < 1) {
    errors.push('MIN_WORKERS must be at least 1')
  }

  // Validate thresholds
  if (clusterConfig.scaling.scaleUpThreshold <= clusterConfig.scaling.scaleDownThreshold) {
    errors.push('Scale up threshold must be greater than scale down threshold')
  }

  // Validate Redis config
  if (!clusterConfig.redis.host) {
    errors.push('Redis host is required')
  }

  if (clusterConfig.redis.port < 1 || clusterConfig.redis.port > 65535) {
    errors.push('Redis port must be between 1 and 65535')
  }

  return errors
}

// Get configuration for specific environment
function getConfig(environment = process.env.NODE_ENV) {
  const config = { ...clusterConfig }
  
  // Apply environment-specific settings
  if (environment === 'test') {
    config.workers.min = 1
    config.workers.max = 1
    config.workers.auto = false
    config.monitoring.enabled = false
  }

  return config
}

// Export functions
module.exports = {
  clusterConfig,
  validateConfig,
  getConfig,
  
  // Helper functions
  isClusterMode: () => process.env.CLUSTER_MODE !== 'false' && !cluster.isWorker,
  isMaster: () => cluster.isMaster,
  isWorker: () => cluster.isWorker,
  getWorkerId: () => process.env.WORKER_ID || cluster.worker?.id || 0,
  getNodeId: () => process.env.NODE_ID || `${os.hostname()}-${process.pid}`,
  
  // Environment checks
  isDevelopment: () => process.env.NODE_ENV === 'development',
  isProduction: () => process.env.NODE_ENV === 'production',
  isTesting: () => process.env.NODE_ENV === 'test'
}