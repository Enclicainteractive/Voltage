import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_CONFIG = {
  server: {
    name: 'Volt',
    version: '1.0.0',
    mode: 'mainline',
    host: 'localhost',
    port: process.env.PORT || 5000,
    url: process.env.SERVER_URL || 'http://localhost:5000',
    imageServerUrl: process.env.IMAGE_SERVER_URL || 'https://api.enclicainteractive.com',
    description: 'Volt - Decentralized Chat Platform'
  },
  
  branding: {
    logo: null,
    primaryColor: '#5865f2',
    accentColor: '#7289da'
  },
  
  storage: {
    type: 'json',
    json: {
      dataDir: path.join(__dirname, '..', '..', 'data')
    },
    sqlite: {
      dbPath: path.join(__dirname, '..', '..', 'data', 'voltage.db')
    },
    mysql: {
      host: 'localhost',
      port: 3306,
      database: 'voltchat',
      user: 'root',
      password: '',
      connectionLimit: 10,
      charset: 'utf8mb4'
    },
    mariadb: {
      host: 'localhost',
      port: 3306,
      database: 'voltchat',
      user: 'root',
      password: '',
      connectionLimit: 10,
      charset: 'utf8mb4'
    },
    postgres: {
      host: 'localhost',
      port: 5432,
      database: 'voltchat',
      user: 'postgres',
      password: '',
      ssl: false,
      connectionString: null
    },
    cockroachdb: {
      host: 'localhost',
      port: 26257,
      database: 'voltchat',
      user: 'root',
      password: '',
      ssl: true,
      connectionString: null
    },
    mssql: {
      host: 'localhost',
      port: 1433,
      database: 'voltchat',
      user: 'sa',
      password: '',
      encrypt: false,
      trustServerCertificate: true
    },
    mongodb: {
      host: 'localhost',
      port: 27017,
      database: 'voltchat',
      user: '',
      password: '',
      connectionString: null,
      authSource: 'admin'
    },
    redis: {
      host: 'localhost',
      port: 6379,
      password: '',
      db: 0,
      keyPrefix: 'voltchat:'
    }
  },
  
  cdn: {
    enabled: false,
    provider: 'local',
    local: {
      uploadDir: path.join(__dirname, '..', 'uploads'),
      baseUrl: null
    },
    s3: {
      bucket: null,
      region: 'us-east-1',
      accessKeyId: null,
      secretAccessKey: null,
      endpoint: null,
      publicUrl: null
    },
    cloudflare: {
      accountId: null,
      bucket: null,
      accessKeyId: null,
      secretAccessKey: null,
      publicUrl: null
    }
  },
  
  cache: {
    enabled: true,
    provider: 'memory',
    redis: {
      host: 'localhost',
      port: 6379,
      password: null,
      db: 0
    }
  },
  
  queue: {
    enabled: false,
    provider: 'memory',
    redis: {
      host: 'localhost',
      port: 6379,
      password: null,
      db: 1
    }
  },
  
  auth: {
    type: 'all',
    local: {
      enabled: true,
      allowRegistration: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      passwordRequirements: {
        requireUppercase: false,
        requireNumbers: true,
        requireSymbols: false
      }
    },
    oauth: {
      enabled: true,
      provider: 'enclica',
      enclica: {
        clientId: process.env.ENCLICA_CLIENT_ID || 'app_54f92e4d526840789998b4cca492aea1',
        authUrl: process.env.ENCLICA_AUTH_URL || 'https://voltchatapp.enclicainteractive.com/oauth/authorize',
        tokenUrl: process.env.ENCLICA_TOKEN_URL || 'https://voltchatapp.enclicainteractive.com/api/oauth/token',
        userInfoUrl: process.env.ENCLICA_USER_INFO_URL || 'https://voltchatapp.enclicainteractive.com/api/user/me',
        revokeUrl: process.env.ENCLICA_REVOKE_URL || 'https://voltchatapp.enclicainteractive.com/api/oauth/revoke'
      }
    }
  },
  
  security: {
    jwtSecret: process.env.JWT_SECRET || 'volt_super_secret_key_change_in_production',
    jwtExpiry: '7d',
    bcryptRounds: 12,
    rateLimit: {
      windowMs: 60000,
      maxRequests: 100
    }
  },
  
  federation: {
    enabled: false,
    serverName: null,
    allowedServers: [],
    maxHops: 3
  },
  
  features: {
    discovery: true,
    selfVolt: true,
    ageVerification: false,
    voiceChannels: true,
    videoChannels: true,
    e2eEncryption: true,
    e2eTrueEncryption: true,
    communities: true,
    threads: true,
    bots: true,
    federation: true
  },
  
  limits: {
    maxUploadSize: 10 * 1024 * 1024,
    maxServersPerUser: 100,
    maxChannelsPerServer: 500,
    maxMembersPerServer: 100000,
    maxMessageLength: 4000,
    maxDmParticipants: 10
  },
  
  logging: {
    level: 'info',
    format: 'json',
    outputs: ['console']
  },
  
  monitoring: {
    enabled: false,
    prometheus: false,
    healthCheckPath: '/health'
  }
}

class Config {
  constructor() {
    this.config = { ...DEFAULT_CONFIG }
    this.configFilePath = path.join(__dirname, '..', 'config.json')
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    
    try {
      if (fs.existsSync(this.configFilePath)) {
        const fileConfig = JSON.parse(fs.readFileSync(this.configFilePath, 'utf8'))
        this.config = this.mergeDeep(DEFAULT_CONFIG, fileConfig)
        console.log('[Config] Loaded config from file')
      } else {
        const envConfig = this.loadFromEnv()
        if (Object.keys(envConfig).length > 0) {
          this.config = this.mergeDeep(DEFAULT_CONFIG, envConfig)
          console.log('[Config] Loaded config from environment')
        } else {
          console.log('[Config] Using default config')
        }
      }
    } catch (err) {
      console.error('[Config] Error loading config:', err.message)
    }
    
    this.loaded = true
    return this
  }

  loadFromEnv() {
    const envConfig = {}
    
    if (process.env.VOLTAGE_MODE) {
      envConfig.server = { mode: process.env.VOLTAGE_MODE }
    }
    
    if (process.env.SERVER_URL) {
      envConfig.server = envConfig.server || {}
      envConfig.server.url = process.env.SERVER_URL
    }
    
    if (process.env.IMAGE_SERVER_URL) {
      envConfig.server = envConfig.server || {}
      envConfig.server.imageServerUrl = process.env.IMAGE_SERVER_URL
    }
    
    if (process.env.SERVER_NAME) {
      envConfig.server = envConfig.server || {}
      envConfig.server.name = process.env.SERVER_NAME
    }
    
    if (process.env.STORAGE_TYPE) {
      envConfig.storage = { type: process.env.STORAGE_TYPE }
    }
    
    if (process.env.JWT_SECRET) {
      envConfig.security = { jwtSecret: process.env.JWT_SECRET }
    }
    
    if (process.env.ENCLICA_CLIENT_ID) {
      envConfig.auth = envConfig.auth || {}
      envConfig.auth.oauth = envConfig.auth.oauth || {}
      envConfig.auth.oauth.enclica = {
        clientId: process.env.ENCLICA_CLIENT_ID,
        authUrl: process.env.ENCLICA_AUTH_URL,
        tokenUrl: process.env.ENCLICA_TOKEN_URL,
        userInfoUrl: process.env.ENCLICA_USER_INFO_URL
      }
    }
    
    if (process.env.ALLOW_LOCAL_AUTH !== undefined) {
      envConfig.auth = envConfig.auth || {}
      envConfig.auth.local = { enabled: process.env.ALLOW_LOCAL_AUTH === 'true' }
    }
    
    if (process.env.ALLOW_REGISTRATION !== undefined) {
      envConfig.auth = envConfig.auth || {}
      envConfig.auth.local = envConfig.auth.local || {}
      envConfig.auth.local.allowRegistration = process.env.ALLOW_REGISTRATION === 'true'
    }
    
    if (process.env.FEDERATION_ENABLED === 'true') {
      envConfig.federation = {
        enabled: true,
        serverName: process.env.FEDERATION_SERVER_NAME,
        allowedServers: process.env.FEDERATION_ALLOWED_SERVERS?.split(',') || []
      }
    }
    
    return envConfig
  }

  mergeDeep(target, source) {
    const result = { ...target }
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.mergeDeep(target[key] || {}, source[key])
      } else {
        result[key] = source[key]
      }
    }
    return result
  }

  reset() {
    this.config = { ...DEFAULT_CONFIG }
    console.log('[Config] Reset to defaults')
  }

  save() {
    try {
      fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2))
      console.log('[Config] Saved config to file')
      return true
    } catch (err) {
      console.error('[Config] Error saving config:', err.message)
      return false
    }
  }

  get(key) {
    const keys = key.split('.')
    let value = this.config
    for (const k of keys) {
      value = value?.[k]
    }
    return value
  }

  set(key, value) {
    const keys = key.split('.')
    let obj = this.config
    for (let i = 0; i < keys.length - 1; i++) {
      obj[keys[i]] = obj[keys[i]] || {}
      obj = obj[keys[i]]
    }
    obj[keys[keys.length - 1]] = value
  }

  isMainline() {
    return this.config.server.mode === 'mainline'
  }

  isSelfVolt() {
    return this.config.server.mode === 'self-volt'
  }

  isOAuthEnabled() {
    return this.config.auth.oauth?.enabled === true
  }

  isLocalAuthEnabled() {
    return this.config.auth.local?.enabled === true
  }

  isRegistrationAllowed() {
    return this.config.auth.local?.allowRegistration === true
  }

  getServerUrl() {
    return this.config.server.url
  }

  getImageServerUrl() {
    return this.config.server.imageServerUrl || this.config.server.url
  }

  getHost() {
    try {
      const url = new URL(this.config.server.url)
      return url.host
    } catch {
      return this.config.server.host
    }
  }

  getServerHost() {
    return this.getHost()
  }

  getStorageConfig() {
    return this.config.storage
  }

  isCdnEnabled() {
    return this.config.cdn?.enabled === true
  }

  getCdnConfig() {
    return this.config.cdn
  }

  isCacheEnabled() {
    return this.config.cache?.enabled === true
  }

  getCacheConfig() {
    return this.config.cache
  }

  isQueueEnabled() {
    return this.config.queue?.enabled === true
  }

  getQueueConfig() {
    return this.config.queue
  }

  getRateLimit() {
    return this.config.security?.rateLimit || { windowMs: 60000, maxRequests: 100 }
  }

  getLimits() {
    return this.config.limits
  }

  getLoggingConfig() {
    return this.config.logging
  }

  getMonitoringConfig() {
    return this.config.monitoring
  }
}

export const config = new Config()
export default config
