import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { authenticateToken, requireOwner } from '../middleware/authMiddleware.js'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)
const SERVER_ROOT = path.join(__dirname, '..')
const LOGS_DIR = path.join(SERVER_ROOT, 'logs')
const DATA_DIR = path.join(SERVER_ROOT, 'data')
const DRIVER_PACKAGE_BY_STORAGE = {
  sqlite: 'better-sqlite3',
  mysql: 'mysql2',
  mariadb: 'mariadb',
  postgres: 'pg',
  cockroachdb: 'pg',
  mssql: 'mssql',
  mongodb: 'mongodb',
  redis: 'redis'
}
const INSTALL_ALLOWLIST = new Set(Object.values(DRIVER_PACKAGE_BY_STORAGE))

const router = express.Router()

const tailLines = (content, lines = 200) => {
  const chunks = String(content || '').split(/\r?\n/)
  return chunks.slice(Math.max(0, chunks.length - lines)).join('\n')
}

const checkPackageInstalled = async (packageName) => {
  try {
    await import(packageName)
    return true
  } catch {
    return false
  }
}

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
      mysql: cfg.storage?.mysql ? { 
        host: cfg.storage.mysql.host,
        port: cfg.storage.mysql.port,
        database: cfg.storage.mysql.database,
        user: cfg.storage.mysql.user
      } : undefined,
      mariadb: cfg.storage?.mariadb ? { 
        host: cfg.storage.mariadb.host,
        port: cfg.storage.mariadb.port,
        database: cfg.storage.mariadb.database,
        user: cfg.storage.mariadb.user
      } : undefined,
      postgres: cfg.storage?.postgres ? { 
        host: cfg.storage.postgres.host,
        port: cfg.storage.postgres.port,
        database: cfg.storage.postgres.database,
        user: cfg.storage.postgres.user
      } : undefined,
      cockroachdb: cfg.storage?.cockroachdb ? { 
        host: cfg.storage.cockroachdb.host,
        port: cfg.storage.cockroachdb.port,
        database: cfg.storage.cockroachdb.database,
        user: cfg.storage.cockroachdb.user
      } : undefined,
      mssql: cfg.storage?.mssql ? { 
        host: cfg.storage.mssql.host,
        port: cfg.storage.mssql.port,
        database: cfg.storage.mssql.database,
        user: cfg.storage.mssql.user
      } : undefined,
      mongodb: cfg.storage?.mongodb ? { 
        host: cfg.storage.mongodb.host,
        port: cfg.storage.mongodb.port,
        database: cfg.storage.mongodb.database
      } : undefined,
      redis: cfg.storage?.redis ? { 
        host: cfg.storage.redis.host,
        port: cfg.storage.redis.port,
        db: cfg.storage.redis.db
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
    if (masked.storage?.mysql?.password) masked.storage.mysql.password = '(hidden)'
    if (masked.storage?.mariadb?.password) masked.storage.mariadb.password = '(hidden)'
    if (masked.storage?.postgres?.password) masked.storage.postgres.password = '(hidden)'
    if (masked.storage?.cockroachdb?.password) masked.storage.cockroachdb.password = '(hidden)'
    if (masked.storage?.mssql?.password) masked.storage.mssql.password = '(hidden)'
    if (masked.storage?.mongodb?.password) masked.storage.mongodb.password = '(hidden)'
    if (masked.storage?.redis?.password) masked.storage.redis.password = '(hidden)'
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
    fs.writeFileSync(config.configFilePath, JSON.stringify(merged, null, 2))
    
    // Re-read from disk to guarantee in-memory matches on-disk (no cache drift)
    const written = JSON.parse(fs.readFileSync(config.configFilePath, 'utf8'))
    config.config = written
    
    console.log('[Admin/Config] Raw config saved and reloaded from disk')
    res.json({ success: true, message: 'Config saved and refreshed. Some changes (e.g. storage backend) require a restart.' })
  } catch (error) {
    console.error('[Admin/Config] Raw update error:', error)
    res.status(500).json({ error: 'Failed to update config: ' + error.message })
  }
})

// Update config (GUI mode)
router.put('/', authenticateToken, requireOwner, (req, res) => {
  const updates = req.body
  
  try {
    // Deep-merge updates into current in-memory config
    config.config = config.mergeDeep(config.config, updates)

    // Always write the full merged config to disk so restarts don't lose changes
    const saved = config.save()
    if (!saved) {
      return res.status(500).json({ error: 'Config updated in memory but failed to write to disk' })
    }

    // Re-load from disk immediately to guarantee in-memory matches on-disk (no cache drift)
    const written = JSON.parse(fs.readFileSync(config.configFilePath, 'utf8'))
    config.config = written

    console.log('[Admin/Config] Config saved and reloaded from disk')
    res.json({ success: true, message: 'Config saved and refreshed. Some changes (e.g. storage backend) require a restart.' })
  } catch (error) {
    console.error('[Admin/Config] Update error:', error)
    res.status(500).json({ error: 'Failed to update config: ' + error.message })
  }
})

// Reset config to defaults
router.post('/reset', authenticateToken, requireOwner, (req, res) => {
  try {
    config.reset()
    // Persist the reset defaults to disk so restarts don't reload old config
    config.save()
    console.log('[Admin/Config] Config reset to defaults and saved to disk')
    res.json({ success: true, message: 'Config reset to defaults and saved' })
  } catch (error) {
    console.error('[Admin/Config] Reset error:', error)
    res.status(500).json({ error: 'Failed to reset config' })
  }
})

// Import config from JSON
router.post('/import', authenticateToken, requireOwner, (req, res) => {
  const newConfig = req.body
  
  try {
    fs.writeFileSync(config.configFilePath, JSON.stringify(newConfig, null, 2))
    // Re-read from disk to guarantee in-memory matches on-disk
    const written = JSON.parse(fs.readFileSync(config.configFilePath, 'utf8'))
    config.config = written
    
    console.log('[Admin/Config] Config imported and reloaded from disk')
    res.json({ success: true, message: 'Config imported and refreshed. Some changes (e.g. storage backend) require a restart.' })
  } catch (error) {
    console.error('[Admin/Config] Import error:', error)
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

router.get('/issues', authenticateToken, requireOwner, async (req, res) => {
  try {
    const warnings = []
    const errors = []
    const info = []
    const deps = {}
    const cfg = config.config
    const storageType = cfg?.storage?.type

    if (!cfg?.security?.jwtSecret || cfg.security.jwtSecret === 'CHANGE_ME' || cfg.security.jwtSecret === 'volt_super_secret_key_change_in_production') {
      warnings.push('JWT secret is using a default or missing value.')
    }
    if (!cfg?.server?.url) {
      errors.push('server.url is missing.')
    }
    if (!cfg?.storage?.type) {
      errors.push('storage.type is missing.')
    }
    if (!fs.existsSync(config.configFilePath)) {
      errors.push('Config file is missing on disk.')
    }
    if (!fs.existsSync(DATA_DIR)) {
      warnings.push('Data directory is missing.')
    }

    for (const [driverStorage, pkg] of Object.entries(DRIVER_PACKAGE_BY_STORAGE)) {
      const installed = await checkPackageInstalled(pkg)
      deps[driverStorage] = { package: pkg, installed }
      if (storageType === driverStorage && !installed) {
        errors.push(`Configured storage "${driverStorage}" requires package "${pkg}" which is not installed.`)
      }
    }

    info.push(`Node ${process.version} on ${process.platform}/${process.arch}`)
    info.push(`Uptime: ${Math.floor(process.uptime())}s`)

    res.json({
      success: true,
      issues: { errors, warnings, info },
      dependencies: deps
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.get('/logs', authenticateToken, requireOwner, async (req, res) => {
  try {
    const lines = Number.parseInt(req.query.lines, 10) || 200
    const maxFiles = Number.parseInt(req.query.maxFiles, 10) || 6
    const files = []

    if (fs.existsSync(LOGS_DIR)) {
      const entries = fs.readdirSync(LOGS_DIR)
        .map((name) => {
          const fullPath = path.join(LOGS_DIR, name)
          const stat = fs.statSync(fullPath)
          return { name, fullPath, stat }
        })
        .filter((entry) => entry.stat.isFile())
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
        .slice(0, maxFiles)

      for (const entry of entries) {
        const content = fs.readFileSync(entry.fullPath, 'utf8')
        files.push({
          file: entry.name,
          updatedAt: entry.stat.mtime.toISOString(),
          content: tailLines(content, lines)
        })
      }
    }

    let adminLogs = {}
    const adminLogPath = path.join(DATA_DIR, 'admin-logs.json')
    if (fs.existsSync(adminLogPath)) {
      try {
        adminLogs = JSON.parse(fs.readFileSync(adminLogPath, 'utf8'))
      } catch {
        adminLogs = {}
      }
    }

    const recentAdminActions = Object.values(adminLogs)
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
      .slice(0, lines)

    res.json({
      success: true,
      logs: files,
      recentAdminActions,
      runtime: {
        pid: process.pid,
        nodeVersion: process.version,
        uptime: process.uptime(),
        memory: process.memoryUsage()
      }
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/install-driver', authenticateToken, requireOwner, async (req, res) => {
  try {
    const storageType = req.body?.storageType
    const requestedPackage = req.body?.packageName
    const packageName = requestedPackage || DRIVER_PACKAGE_BY_STORAGE[storageType]

    if (!packageName || !INSTALL_ALLOWLIST.has(packageName)) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported package requested for installation.'
      })
    }

    const alreadyInstalled = await checkPackageInstalled(packageName)
    if (alreadyInstalled) {
      return res.json({
        success: true,
        packageName,
        installed: true,
        alreadyInstalled: true,
        output: `${packageName} is already installed`
      })
    }

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const { stdout, stderr } = await execFileAsync(
      npmCommand,
      ['install', packageName, '--no-audit', '--no-fund', '--save'],
      { cwd: SERVER_ROOT, maxBuffer: 1024 * 1024 * 8 }
    )

    res.json({
      success: true,
      packageName,
      installed: true,
      output: stdout || '',
      errorOutput: stderr || ''
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

router.post('/restart', authenticateToken, requireOwner, (req, res) => {
  res.json({
    success: true,
    message: 'Restart signal accepted. Process exiting now.'
  })

  setTimeout(() => {
    process.exit(0)
  }, 250)
})

export default router
