import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { authenticateToken, requireOwner } from '../middleware/authMiddleware.js'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const router = express.Router()

// Get full config (with sensitive data filtered)
router.get('/', authenticateToken, requireOwner, (req, res) => {
  const cfg = config.config
  
  const safeConfig = {
    server: {
      name: cfg.server?.name,
      version: cfg.server?.version,
      mode: cfg.server?.mode,
      url: cfg.server?.url,
      imageServerUrl: cfg.server?.imageServerUrl,
      port: cfg.server?.port,
      description: cfg.server?.description,
      host: cfg.server?.host
    },
    branding: cfg.branding,
    storage: {
      type: cfg.storage?.type,
      json: cfg.storage?.json ? { dataDir: cfg.storage.json.dataDir } : undefined,
      sqlite: cfg.storage?.sqlite ? { dbPath: cfg.storage.sqlite.dbPath } : undefined,
      postgres: cfg.storage?.postgres ? { 
        host: cfg.storage.postgres.host,
        port: cfg.storage.postgres.port,
        database: cfg.storage.postgres.database
      } : undefined
    },
    auth: {
      type: cfg.auth?.type,
      local: cfg.auth?.local ? { 
        enabled: cfg.auth.local.enabled,
        allowRegistration: cfg.auth.local.allowRegistration,
        minPasswordLength: cfg.auth.local.minPasswordLength
      } : undefined,
      oauth: cfg.auth?.oauth ? {
        enabled: cfg.auth.oauth.enabled,
        provider: cfg.auth.oauth.provider,
        enclica: cfg.auth.oauth.enclica ? {
          clientId: cfg.auth.oauth.enclica.clientId ? '(set)' : null,
          authUrl: cfg.auth.oauth.enclica.authUrl,
          tokenUrl: cfg.auth.oauth.enclica.tokenUrl,
          userInfoUrl: cfg.auth.oauth.enclica.userInfoUrl,
          revokeUrl: cfg.auth.oauth.enclica.revokeUrl
        } : undefined,
        discord: cfg.auth.oauth.discord ? {
          clientId: cfg.auth.oauth.discord.clientId ? '(set)' : null
        } : undefined,
        google: cfg.auth.oauth.google ? {
          clientId: cfg.auth.oauth.google.clientId ? '(set)' : null
        } : undefined
      } : undefined
    },
    security: {
      jwtExpiry: cfg.security?.jwtExpiry,
      bcryptRounds: cfg.security?.bcryptRounds,
      rateLimit: cfg.security?.rateLimit,
      adminUsers: cfg.security?.adminUsers || []
    },
    features: cfg.features,
    limits: cfg.limits,
    cdn: cfg.cdn ? {
      enabled: cfg.cdn.enabled,
      provider: cfg.cdn.provider,
      local: cfg.cdn.local ? {
        uploadDir: cfg.cdn.local.uploadDir,
        baseUrl: cfg.cdn.local.baseUrl
      } : undefined,
      s3: cfg.cdn.s3 ? {
        bucket: cfg.cdn.s3.bucket,
        region: cfg.cdn.s3.region,
        endpoint: cfg.cdn.s3.endpoint,
        publicUrl: cfg.cdn.s3.publicUrl
      } : undefined
    } : undefined,
    cache: cfg.cache ? {
      enabled: cfg.cache.enabled,
      provider: cfg.cache.provider,
      redis: cfg.cache.redis ? {
        host: cfg.cache.redis.host,
        port: cfg.cache.redis.port
      } : undefined
    } : undefined,
    queue: cfg.queue ? {
      enabled: cfg.queue.enabled,
      provider: cfg.queue.provider,
      redis: cfg.queue.redis ? {
        host: cfg.queue.redis.host,
        port: cfg.queue.redis.port
      } : undefined
    } : undefined,
    monitoring: cfg.monitoring,
    federation: cfg.federation
  }
  
  res.json(safeConfig)
})

// Get raw config (JSON mode)
router.get('/raw', authenticateToken, requireOwner, (req, res) => {
  const configPath = path.join(__dirname, '..', 'config.json')
  if (fs.existsSync(configPath)) {
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    // Mask sensitive values
    const masked = JSON.parse(JSON.stringify(configData))
    if (masked.security?.jwtSecret) masked.security.jwtSecret = '(hidden)'
    if (masked.storage?.postgres?.password) masked.storage.postgres.password = '(hidden)'
    if (masked.cdn?.s3?.secretAccessKey) masked.cdn.s3.secretAccessKey = '(hidden)'
    if (masked.cache?.redis?.password) masked.cache.redis.password = '(hidden)'
    if (masked.queue?.redis?.password) masked.queue.redis.password = '(hidden)'
    res.json(masked)
  } else {
    res.json(config.config)
  }
})

// Update config via JSON (raw mode)
router.put('/raw', authenticateToken, requireOwner, (req, res) => {
  const newConfig = req.body
  
  try {
    // Validate basic structure
    if (!newConfig.server || !newConfig.storage || !newConfig.auth) {
      return res.status(400).json({ error: 'Invalid config structure' })
    }
    
    // Merge with current config
    const merged = config.mergeDeep(config.config, newConfig)
    
    // Save to file
    const configPath = path.join(__dirname, '..', 'config.json')
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2))
    
    // Update runtime config
    config.config = merged
    
    res.json({ success: true, message: 'Config updated from JSON. Restart server for full effect.' })
  } catch (error) {
    console.error('[Admin/Config] Raw update error:', error)
    res.status(500).json({ error: 'Failed to update config: ' + error.message })
  }
})

// Update config (GUI mode)
router.put('/', authenticateToken, requireOwner, (req, res) => {
  const updates = req.body
  
  try {
    // Server settings
    if (updates.server) {
      Object.keys(updates.server).forEach(key => {
        if (updates.server[key] !== undefined) {
          config.config.server[key] = updates.server[key]
        }
      })
    }
    
    // Branding
    if (updates.branding) {
      config.config.branding = { ...config.config.branding, ...updates.branding }
    }
    
    // Features
    if (updates.features) {
      config.config.features = { ...config.config.features, ...updates.features }
    }
    
    // Limits
    if (updates.limits) {
      config.config.limits = { ...config.config.limits, ...updates.limits }
    }
    
    // Auth - local
    if (updates.auth?.local) {
      config.config.auth.local = { ...config.config.auth.local, ...updates.auth.local }
    }
    
    // Security
    if (updates.security) {
      if (updates.security.jwtExpiry) config.config.security.jwtExpiry = updates.security.jwtExpiry
      if (updates.security.bcryptRounds) config.config.security.bcryptRounds = updates.security.bcryptRounds
      if (updates.security.rateLimit) config.config.security.rateLimit = updates.security.rateLimit
      if (updates.security.adminUsers) config.config.security.adminUsers = updates.security.adminUsers
    }
    
    // Federation
    if (updates.federation) {
      config.config.federation = { ...config.config.federation, ...updates.federation }
    }
    
    // Storage type
    if (updates.storage?.type) {
      config.config.storage.type = updates.storage.type
    }
    
    // CDN
    if (updates.cdn) {
      config.config.cdn = { ...config.config.cdn, ...updates.cdn }
    }
    
    // Cache
    if (updates.cache) {
      config.config.cache = { ...config.config.cache, ...updates.cache }
    }
    
    // Queue
    if (updates.queue) {
      config.config.queue = { ...config.config.queue, ...updates.queue }
    }
    
    // Monitoring
    if (updates.monitoring) {
      config.config.monitoring = { ...config.config.monitoring, ...updates.monitoring }
    }
    
    // Save to file
    const configPath = path.join(__dirname, '..', 'config.json')
    if (fs.existsSync(configPath)) {
      const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      const mergedConfig = config.mergeDeep(currentConfig, config.config)
      fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2))
    }
    
    res.json({ success: true, message: 'Config updated. Restart server for full effect.' })
  } catch (error) {
    console.error('[Admin/Config] Update error:', error)
    res.status(500).json({ error: 'Failed to update config: ' + error.message })
  }
})

// Reset config to defaults
router.post('/reset', authenticateToken, requireOwner, (req, res) => {
  try {
    config.reset()
    res.json({ success: true, message: 'Config reset to defaults' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset config' })
  }
})

// Import config from JSON
router.post('/import', authenticateToken, requireOwner, (req, res) => {
  const newConfig = req.body
  
  try {
    const configPath = path.join(__dirname, '..', 'config.json')
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2))
    config.config = newConfig
    
    res.json({ success: true, message: 'Config imported. Restart server for full effect.' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to import config' })
  }
})

// Get available options/limits
router.get('/schema', (req, res) => {
  res.json({
    server: {
      mode: ['mainline', 'self-volt', 'federated'],
      port: { min: 1, max: 65535 }
    },
    storage: {
      type: ['sqlite', 'json', 'postgres']
    },
    auth: {
      type: ['all', 'local', 'oauth'],
      providers: ['enclica', 'discord', 'google']
    },
    security: {
      jwtExpiry: ['1h', '6h', '12h', '1d', '7d', '30d'],
      bcryptRounds: { min: 8, max: 15 },
      rateLimit: {
        windowMs: [60000, 120000, 300000],
        maxRequests: [10, 50, 100, 200, 500]
      }
    },
    features: {
      discovery: { type: 'boolean' },
      selfVolt: { type: 'boolean' },
      voiceChannels: { type: 'boolean' },
      videoChannels: { type: 'boolean' },
      e2eEncryption: { type: 'boolean' },
      communities: { type: 'boolean' }
    },
    limits: {
      maxUploadSize: { min: 1024, max: 104857600, unit: 'bytes' },
      maxServersPerUser: { min: 1, max: 1000 },
      maxMessageLength: { min: 100, max: 10000 }
    },
    cdn: {
      provider: ['local', 's3', 'cloudflare']
    },
    cache: {
      provider: ['memory', 'redis']
    },
    queue: {
      provider: ['memory', 'redis']
    }
  })
})

// Get default config template
router.get('/template', (req, res) => {
  res.json({
    server: {
      name: 'Volt',
      version: '1.0.0',
      mode: 'mainline',
      url: 'https://your-server.com',
      imageServerUrl: 'https://api.your-server.com',
      port: 5000
    },
    branding: {
      logo: null,
      primaryColor: '#5865f2',
      accentColor: '#7289da'
    },
    storage: {
      type: 'sqlite',
      sqlite: { dbPath: './data/voltage.db' }
    },
    auth: {
      type: 'all',
      local: {
        enabled: true,
        allowRegistration: true,
        minPasswordLength: 8
      },
      oauth: {
        enabled: true,
        provider: 'enclica'
      }
    },
    security: {
      jwtSecret: 'CHANGE_ME',
      jwtExpiry: '7d',
      bcryptRounds: 12,
      rateLimit: { windowMs: 60000, maxRequests: 100 }
    },
    features: {
      discovery: true,
      selfVolt: true,
      voiceChannels: true,
      videoChannels: true,
      e2eEncryption: true,
      communities: true
    },
    limits: {
      maxUploadSize: 10485760,
      maxServersPerUser: 100,
      maxMessageLength: 4000
    }
  })
})

// Get config metadata/info
router.get('/info', (req, res) => {
  res.json({
    configPath: path.join(__dirname, '..', 'config.json'),
    configExists: fs.existsSync(path.join(__dirname, '..', 'config.json')),
    serverInfo: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    }
  })
})

// Validate config
router.post('/validate', authenticateToken, requireOwner, (req, res) => {
  const configToValidate = req.body
  const errors = []
  const warnings = []
  
  // Basic validation
  if (!configToValidate.server?.url) {
    errors.push('Server URL is required')
  }
  
  if (!configToValidate.storage?.type) {
    errors.push('Storage type is required')
  }
  
  if (!configToValidate.auth?.type) {
    errors.push('Auth type is required')
  }
  
  // Warnings
  if (configToValidate.security?.jwtSecret === 'CHANGE_ME' || configToValidate.security?.jwtSecret === 'volt_super_secret_key_change_in_production') {
    warnings.push('JWT secret should be changed from default')
  }
  
  if (!configToValidate.server?.imageServerUrl && configToValidate.server?.url) {
    warnings.push('Consider setting imageServerUrl for better avatar support')
  }
  
  if (configToValidate.storage?.type === 'sqlite' && configToValidate.storage?.sqlite?.dbPath?.includes('~')) {
    warnings.push('SQLite dbPath should use absolute path, not ~')
  }
  
  res.json({
    valid: errors.length === 0,
    errors,
    warnings
  })
})

export default router
