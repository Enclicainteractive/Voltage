import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db = null
let storage = null

const TABLES = [
  'users',
  'friends',
  'friend_requests',
  'servers',
  'channels',
  'messages',
  'server_members',
  'invites',
  'dms',
  'dm_messages',
  'reactions',
  'blocked',
  'files',
  'attachments',
  'discovery',
  'global_bans',
  'admin_logs'
]

const initJsonStorage = () => {
  const storageConfig = config.config.storage
  const dataDir = storageConfig.json?.dataDir || path.join(__dirname, '..', 'data')
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  
  return {
    type: 'json',
    provider: 'json',
    dataDir,
    files: {
      users: path.join(dataDir, 'users.json'),
      friends: path.join(dataDir, 'friends.json'),
      friendRequests: path.join(dataDir, 'friend-requests.json'),
      dms: path.join(dataDir, 'dms.json'),
      dmMessages: path.join(dataDir, 'dm-messages.json'),
      servers: path.join(dataDir, 'servers.json'),
      channels: path.join(dataDir, 'channels.json'),
      messages: path.join(dataDir, 'messages.json'),
      reactions: path.join(dataDir, 'reactions.json'),
      serverInvites: path.join(dataDir, 'server-invites.json'),
      blocked: path.join(dataDir, 'blocked.json'),
      files: path.join(dataDir, 'files.json'),
      attachments: path.join(dataDir, 'attachments.json'),
      discovery: path.join(dataDir, 'discovery.json'),
      globalBans: path.join(dataDir, 'global-bans.json'),
      adminLogs: path.join(dataDir, 'admin-logs.json')
    },
    load(file, defaultValue = {}) {
      try {
        if (fs.existsSync(file)) {
          return JSON.parse(fs.readFileSync(file, 'utf8'))
        }
      } catch (err) {
        console.error(`[Data] Error loading ${file}:`, err.message)
      }
      return defaultValue
    },
    save(file, data) {
      try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2))
        return true
      } catch (err) {
        console.error(`[Data] Error saving ${file}:`, err.message)
        return false
      }
    }
  }
}

const initSqliteStorage = () => {
  let Database
  try {
    Database = require('better-sqlite3')
  } catch (err) {
    console.error('[Storage] better-sqlite3 not available, falling back to JSON')
    return initJsonStorage()
  }
  
  const storageConfig = config.config.storage
  const dbPath = storageConfig.sqlite?.dbPath || path.join(__dirname, '..', '..', 'data', 'voltage.db')
  const dbDir = path.dirname(dbPath)
  
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }
  
  db = new Database(dbPath)
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      displayName TEXT,
      email TEXT,
      passwordHash TEXT,
      authProvider TEXT,
      avatar TEXT,
      banner TEXT,
      bio TEXT,
      customStatus TEXT,
      status TEXT DEFAULT 'offline',
      socialLinks TEXT,
      ageVerification TEXT,
      host TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS friends (
      userId TEXT NOT NULL,
      friendId TEXT NOT NULL,
      createdAt TEXT,
      PRIMARY KEY (userId, friendId)
    );
    
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      fromUserId TEXT NOT NULL,
      toUserId TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      banner TEXT,
      ownerId TEXT NOT NULL,
      createdAt TEXT,
      updatedAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      serverId TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      topic TEXT,
      position INTEGER,
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channelId TEXT NOT NULL,
      authorId TEXT NOT NULL,
      content TEXT,
      type TEXT DEFAULT 'text',
      createdAt TEXT,
      updatedAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS server_members (
      serverId TEXT NOT NULL,
      userId TEXT NOT NULL,
      roles TEXT,
      joinedAt TEXT,
      PRIMARY KEY (serverId, userId)
    );
    
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      serverId TEXT NOT NULL,
      inviterId TEXT,
      uses INTEGER DEFAULT 0,
      maxUses INTEGER,
      expiresAt TEXT,
      createdAt TEXT
    );
  `)
  
  console.log('[Storage] SQLite initialized:', dbPath)
  
  return {
    type: 'sqlite',
    provider: 'sqlite',
    db,
    load(table, defaultValue = {}) {
      try {
        const stmt = db.prepare(`SELECT * FROM ${table}`)
        const rows = stmt.all()
        const result = {}
        rows.forEach(row => {
          try {
            result[row.id] = JSON.parse(row.data)
          } catch {
            result[row.id] = row
          }
        })
        return result
      } catch (err) {
        console.error(`[Storage] Error loading ${table}:`, err.message)
        return defaultValue
      }
    },
    save(table, data) {
      try {
        const insert = db.prepare(`
          INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)
        `)
        const transaction = db.transaction(() => {
          for (const [id, row] of Object.entries(data)) {
            insert.run(id, JSON.stringify(row))
          }
        })
        transaction()
        return true
      } catch (err) {
        console.error(`[Storage] Error saving ${table}:`, err.message)
        return false
      }
    }
  }
}

const initMysqlStorage = () => {
  let pool
  try {
    const mysql = require('mysql2/promise')
    const storageConfig = config.config.storage.mysql
    
    pool = mysql.createPool({
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 3306,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'root',
      password: storageConfig.password || '',
      connectionLimit: storageConfig.connectionLimit || 10,
      charset: storageConfig.charset || 'utf8mb4',
      waitForConnections: true,
      queueLimit: 0
    })
    
    const createTables = async () => {
      const conn = await pool.getConnection()
      try {
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(255) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            displayName VARCHAR(255),
            email VARCHAR(255),
            passwordHash VARCHAR(255),
            authProvider VARCHAR(50),
            avatar TEXT,
            banner TEXT,
            bio TEXT,
            customStatus TEXT,
            status VARCHAR(50) DEFAULT 'offline',
            socialLinks TEXT,
            ageVerification VARCHAR(50),
            host VARCHAR(255),
            createdAt TEXT,
            updatedAt TEXT
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS friends (
            userId VARCHAR(255) NOT NULL,
            friendId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            PRIMARY KEY (userId, friendId),
            INDEX idx_friendId (friendId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS friend_requests (
            id VARCHAR(255) PRIMARY KEY,
            fromUserId VARCHAR(255) NOT NULL,
            toUserId VARCHAR(255) NOT NULL,
            status VARCHAR(50) DEFAULT 'pending',
            createdAt TEXT,
            INDEX idx_fromUserId (fromUserId),
            INDEX idx_toUserId (toUserId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS servers (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            icon TEXT,
            banner TEXT,
            ownerId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            updatedAt TEXT,
            INDEX idx_ownerId (ownerId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS channels (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            type VARCHAR(50) DEFAULT 'text',
            topic TEXT,
            position INTEGER,
            createdAt TEXT,
            INDEX idx_serverId (serverId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(255) PRIMARY KEY,
            channelId VARCHAR(255) NOT NULL,
            authorId VARCHAR(255) NOT NULL,
            content TEXT,
            type VARCHAR(50) DEFAULT 'text',
            createdAt TEXT,
            updatedAt TEXT,
            INDEX idx_channelId (channelId),
            INDEX idx_authorId (authorId),
            INDEX idx_createdAt (createdAt)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS server_members (
            serverId VARCHAR(255) NOT NULL,
            userId VARCHAR(255) NOT NULL,
            roles TEXT,
            joinedAt TEXT,
            PRIMARY KEY (serverId, userId),
            INDEX idx_userId (userId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS invites (
            code VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            inviterId VARCHAR(255),
            uses INTEGER DEFAULT 0,
            maxUses INTEGER,
            expiresAt TEXT,
            createdAt TEXT,
            INDEX idx_serverId (serverId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS dms (
            id VARCHAR(255) PRIMARY KEY,
            createdAt TEXT,
            INDEX idx_createdAt (createdAt)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS dm_messages (
            id VARCHAR(255) PRIMARY KEY,
            conversationId VARCHAR(255) NOT NULL,
            authorId VARCHAR(255) NOT NULL,
            content TEXT,
            createdAt TEXT,
            INDEX idx_conversationId (conversationId),
            INDEX idx_createdAt (createdAt)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS reactions (
            id VARCHAR(255) PRIMARY KEY,
            messageId VARCHAR(255) NOT NULL,
            userId VARCHAR(255) NOT NULL,
            emoji VARCHAR(255) NOT NULL,
            createdAt TEXT,
            INDEX idx_messageId (messageId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS blocked (
            id VARCHAR(255) PRIMARY KEY,
            userId VARCHAR(255) NOT NULL,
            blockedUserId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            INDEX idx_userId (userId),
            INDEX idx_blockedUserId (blockedUserId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS files (
            id VARCHAR(255) PRIMARY KEY,
            filename VARCHAR(255) NOT NULL,
            originalName VARCHAR(255),
            mimetype VARCHAR(255),
            size BIGINT,
            path TEXT,
            url TEXT,
            uploaderId VARCHAR(255),
            createdAt TEXT
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS attachments (
            id VARCHAR(255) PRIMARY KEY,
            messageId VARCHAR(255) NOT NULL,
            fileId VARCHAR(255) NOT NULL,
            INDEX idx_messageId (messageId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS discovery (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            name VARCHAR(255),
            description TEXT,
            category VARCHAR(100),
            tags TEXT,
            memberCount INTEGER DEFAULT 0,
            INDEX idx_serverId (serverId),
            INDEX idx_category (category)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS global_bans (
            id VARCHAR(255) PRIMARY KEY,
            userId VARCHAR(255) NOT NULL,
            reason TEXT,
            bannedBy VARCHAR(255),
            expiresAt TEXT,
            createdAt TEXT,
            INDEX idx_userId (userId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS admin_logs (
            id VARCHAR(255) PRIMARY KEY,
            action VARCHAR(100) NOT NULL,
            userId VARCHAR(255),
            targetId VARCHAR(255),
            details TEXT,
            createdAt TEXT,
            INDEX idx_userId (userId),
            INDEX idx_createdAt (createdAt)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        console.log('[Storage] MySQL tables initialized')
      } finally {
        conn.release()
      }
    }
    
    createTables().catch(err => {
      console.error('[Storage] Error creating MySQL tables:', err.message)
    })
    
    console.log('[Storage] MySQL pool created')
    
    return {
      type: 'mysql',
      provider: 'mysql',
      pool,
      load: async (table, defaultValue = {}) => {
        try {
          const [rows] = await pool.execute(`SELECT * FROM ${table}`)
          const result = {}
          rows.forEach(row => {
            try {
              result[row.id] = JSON.parse(row.data || '{}')
            } catch {
              delete row.data
              result[row.id] = row
            }
          })
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          const conn = await pool.getConnection()
          try {
            await conn.beginTransaction()
            for (const [id, row] of Object.entries(data)) {
              await conn.execute(
                `INSERT INTO ${table} (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?`,
                [id, JSON.stringify(row), JSON.stringify(row)]
              )
            }
            await conn.commit()
            return true
          } catch (err) {
            await conn.rollback()
            throw err
          } finally {
            conn.release()
          }
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await pool.end()
      }
    }
  } catch (err) {
    console.error('[Storage] MySQL not available:', err.message)
    return initJsonStorage()
  }
}

const initMariadbStorage = () => {
  let pool
  try {
    const mariadb = require('mariadb')
    const storageConfig = config.config.storage.mariadb
    
    pool = mariadb.createPool({
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 3306,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'root',
      password: storageConfig.password || '',
      connectionLimit: storageConfig.connectionLimit || 10,
      charset: storageConfig.charset || 'utf8mb4'
    })
    
    const createTables = async () => {
      const conn = await pool.getConnection()
      try {
        await conn.query(`
          CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(255) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            displayName VARCHAR(255),
            email VARCHAR(255),
            passwordHash VARCHAR(255),
            authProvider VARCHAR(50),
            avatar TEXT,
            banner TEXT,
            bio TEXT,
            customStatus TEXT,
            status VARCHAR(50) DEFAULT 'offline',
            socialLinks TEXT,
            ageVerification VARCHAR(50),
            host VARCHAR(255),
            createdAt TEXT,
            updatedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS servers (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            icon TEXT,
            banner TEXT,
            ownerId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            updatedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS channels (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            type VARCHAR(50) DEFAULT 'text',
            topic TEXT,
            position INTEGER,
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(255) PRIMARY KEY,
            channelId VARCHAR(255) NOT NULL,
            authorId VARCHAR(255) NOT NULL,
            content TEXT,
            type VARCHAR(50) DEFAULT 'text',
            createdAt TEXT,
            updatedAt TEXT
          )
        `)
        
        console.log('[Storage] MariaDB tables initialized')
      } finally {
        conn.release()
      }
    }
    
    createTables().catch(err => {
      console.error('[Storage] Error creating MariaDB tables:', err.message)
    })
    
    console.log('[Storage] MariaDB pool created')
    
    return {
      type: 'mariadb',
      provider: 'mariadb',
      pool,
      load: async (table, defaultValue = {}) => {
        try {
          const rows = await pool.query(`SELECT * FROM ${table}`)
          const result = {}
          rows.forEach(row => {
            try {
              result[row.id] = JSON.parse(row.data || '{}')
            } catch {
              delete row.data
              result[row.id] = row
            }
          })
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          const conn = await pool.getConnection()
          try {
            await conn.beginTransaction()
            for (const [id, row] of Object.entries(data)) {
              await conn.query(
                `INSERT INTO ${table} (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?`,
                [id, JSON.stringify(row), JSON.stringify(row)]
              )
            }
            await conn.commit()
            return true
          } catch (err) {
            await conn.rollback()
            throw err
          } finally {
            conn.release()
          }
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await pool.end()
      }
    }
  } catch (err) {
    console.error('[Storage] MariaDB not available:', err.message)
    return initJsonStorage()
  }
}

const initPostgresStorage = () => {
  let client
  try {
    const { Client } = require('pg')
    const storageConfig = config.config.storage.postgres
    
    const connectionConfig = {
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 5432,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'postgres',
      password: storageConfig.password || ''
    }
    
    if (storageConfig.connectionString) {
      connectionConfig.connectionString = storageConfig.connectionString
    }
    
    if (storageConfig.ssl) {
      connectionConfig.ssl = { rejectUnauthorized: false }
    }
    
    client = new Client(connectionConfig)
    
    const createTables = async () => {
      await client.connect()
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(255) PRIMARY KEY,
          username VARCHAR(255) NOT NULL,
          "displayName" VARCHAR(255),
          email VARCHAR(255),
          "passwordHash" VARCHAR(255),
          "authProvider" VARCHAR(50),
          avatar TEXT,
          banner TEXT,
          bio TEXT,
          "customStatus" TEXT,
          status VARCHAR(50) DEFAULT 'offline',
          "socialLinks" TEXT,
          "ageVerification" VARCHAR(50),
          host VARCHAR(255),
          "createdAt" TEXT,
          "updatedAt" TEXT
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS servers (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          icon TEXT,
          banner TEXT,
          "ownerId" VARCHAR(255) NOT NULL,
          "createdAt" TEXT,
          "updatedAt" TEXT
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS channels (
          id VARCHAR(255) PRIMARY KEY,
          "serverId" VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          type VARCHAR(50) DEFAULT 'text',
          topic TEXT,
          position INTEGER,
          "createdAt" TEXT
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id VARCHAR(255) PRIMARY KEY,
          "channelId" VARCHAR(255) NOT NULL,
          "authorId" VARCHAR(255) NOT NULL,
          content TEXT,
          type VARCHAR(50) DEFAULT 'text',
          "createdAt" TEXT,
          "updatedAt" TEXT
        )
      `)
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_channelId ON messages("channelId")
      `)
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_channels_serverId ON channels("serverId")
      `)
      
      console.log('[Storage] PostgreSQL tables initialized')
    }
    
    createTables().catch(err => {
      console.error('[Storage] Error creating PostgreSQL tables:', err.message)
    })
    
    console.log('[Storage] PostgreSQL client created')
    
    return {
      type: 'postgres',
      provider: 'postgres',
      client,
      load: async (table, defaultValue = {}) => {
        try {
          const res = await client.query(`SELECT * FROM ${table}`)
          const result = {}
          res.rows.forEach(row => {
            try {
              result[row.id] = JSON.parse(row.data || '{}')
            } catch {
              delete row.data
              result[row.id] = row
            }
          })
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          await client.query('BEGIN')
          for (const [id, row] of Object.entries(data)) {
            await client.query(
              `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
              [id, JSON.stringify(row)]
            )
          }
          await client.query('COMMIT')
          return true
        } catch (err) {
          await client.query('ROLLBACK')
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await client.end()
      }
    }
  } catch (err) {
    console.error('[Storage] PostgreSQL not available:', err.message)
    return initJsonStorage()
  }
}

const initCockroachdbStorage = () => {
  let client
  try {
    const { Client } = require('pg')
    const storageConfig = config.config.storage.cockroachdb
    
    const connectionConfig = {
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 26257,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'root',
      password: storageConfig.password || '',
      ssl: storageConfig.ssl ? { rejectUnauthorized: false } : false
    }
    
    if (storageConfig.connectionString) {
      connectionConfig.connectionString = storageConfig.connectionString
    }
    
    client = new Client(connectionConfig)
    
    const createTables = async () => {
      await client.connect()
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(255) PRIMARY KEY,
          username VARCHAR(255) NOT NULL,
          "displayName" VARCHAR(255),
          email VARCHAR(255),
          "passwordHash" VARCHAR(255),
          "authProvider" VARCHAR(50),
          avatar TEXT,
          banner TEXT,
          bio TEXT,
          "customStatus" TEXT,
          status VARCHAR(50) DEFAULT 'offline',
          "socialLinks" TEXT,
          "ageVerification" VARCHAR(50),
          host VARCHAR(255),
          "createdAt" TIMESTAMP,
          "updatedAt" TIMESTAMP
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS servers (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          icon TEXT,
          banner TEXT,
          "ownerId" VARCHAR(255) NOT NULL,
          "createdAt" TIMESTAMP,
          "updatedAt" TIMESTAMP
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS channels (
          id VARCHAR(255) PRIMARY KEY,
          "serverId" VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          type VARCHAR(50) DEFAULT 'text',
          topic TEXT,
          position INTEGER,
          "createdAt" TIMESTAMP
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id VARCHAR(255) PRIMARY KEY,
          "channelId" VARCHAR(255) NOT NULL,
          "authorId" VARCHAR(255) NOT NULL,
          content TEXT,
          type VARCHAR(50) DEFAULT 'text',
          "createdAt" TIMESTAMP,
          "updatedAt" TIMESTAMP
        )
      `)
      
      console.log('[Storage] CockroachDB tables initialized')
    }
    
    createTables().catch(err => {
      console.error('[Storage] Error creating CockroachDB tables:', err.message)
    })
    
    console.log('[Storage] CockroachDB client created')
    
    return {
      type: 'cockroachdb',
      provider: 'cockroachdb',
      client,
      load: async (table, defaultValue = {}) => {
        try {
          const res = await client.query(`SELECT * FROM ${table}`)
          const result = {}
          res.rows.forEach(row => {
            try {
              result[row.id] = JSON.parse(row.data || '{}')
            } catch {
              delete row.data
              result[row.id] = row
            }
          })
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          await client.query('BEGIN')
          for (const [id, row] of Object.entries(data)) {
            await client.query(
              `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
              [id, JSON.stringify(row)]
            )
          }
          await client.query('COMMIT')
          return true
        } catch (err) {
          await client.query('ROLLBACK')
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await client.end()
      }
    }
  } catch (err) {
    console.error('[Storage] CockroachDB not available:', err.message)
    return initJsonStorage()
  }
}

const initMssqlStorage = () => {
  let pool
  try {
    const mssql = require('mssql')
    const storageConfig = config.config.storage.mssql
    
    const config = {
      server: storageConfig.host || 'localhost',
      port: storageConfig.port || 1433,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'sa',
      password: storageConfig.password || '',
      options: {
        encrypt: storageConfig.encrypt || false,
        trustServerCertificate: storageConfig.trustServerCertificate || true
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    }
    
    const createTables = async () => {
      await pool.connect()
      
      const request = pool.request()
      
      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')
        CREATE TABLE users (
          id NVARCHAR(255) PRIMARY KEY,
          username NVARCHAR(255) NOT NULL,
          displayName NVARCHAR(255),
          email NVARCHAR(255),
          passwordHash NVARCHAR(255),
          authProvider NVARCHAR(50),
          avatar NVARCHAR(MAX),
          banner NVARCHAR(MAX),
          bio NVARCHAR(MAX),
          customStatus NVARCHAR(MAX),
          status NVARCHAR(50) DEFAULT 'offline',
          socialLinks NVARCHAR(MAX),
          ageVerification NVARCHAR(50),
          host NVARCHAR(255),
          createdAt NVARCHAR(255),
          updatedAt NVARCHAR(255)
        )
      `)
      
      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='servers' AND xtype='U')
        CREATE TABLE servers (
          id NVARCHAR(255) PRIMARY KEY,
          name NVARCHAR(255) NOT NULL,
          description NVARCHAR(MAX),
          icon NVARCHAR(MAX),
          banner NVARCHAR(MAX),
          ownerId NVARCHAR(255) NOT NULL,
          createdAt NVARCHAR(255),
          updatedAt NVARCHAR(255)
        )
      `)
      
      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='channels' AND xtype='U')
        CREATE TABLE channels (
          id NVARCHAR(255) PRIMARY KEY,
          serverId NVARCHAR(255) NOT NULL,
          name NVARCHAR(255) NOT NULL,
          type NVARCHAR(50) DEFAULT 'text',
          topic NVARCHAR(MAX),
          position INT,
          createdAt NVARCHAR(255)
        )
      `)
      
      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='messages' AND xtype='U')
        CREATE TABLE messages (
          id NVARCHAR(255) PRIMARY KEY,
          channelId NVARCHAR(255) NOT NULL,
          authorId NVARCHAR(255) NOT NULL,
          content NVARCHAR(MAX),
          type NVARCHAR(50) DEFAULT 'text',
          createdAt NVARCHAR(255),
          updatedAt NVARCHAR(255)
        )
      `)
      
      console.log('[Storage] MSSQL tables initialized')
    }
    
    mssql.connect(config).then(p => {
      pool = p
      createTables().catch(err => {
        console.error('[Storage] Error creating MSSQL tables:', err.message)
      })
      console.log('[Storage] MSSQL pool created')
    }).catch(err => {
      console.error('[Storage] MSSQL connection error:', err.message)
    })
    
    return {
      type: 'mssql',
      provider: 'mssql',
      pool,
      load: async (table, defaultValue = {}) => {
        try {
          if (!pool) await mssql.connect(config)
          const result = await pool.request().query(`SELECT * FROM ${table}`)
          const res = {}
          result.recordset.forEach(row => {
            try {
              res[row.id] = JSON.parse(row.data || '{}')
            } catch {
              delete row.data
              res[row.id] = row
            }
          })
          return res
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          if (!pool) await mssql.connect(config)
          const transaction = new mssql.Transaction(pool)
          await transaction.begin()
          try {
            for (const [id, row] of Object.entries(data)) {
              await transaction.request()
                .input('id', mssql.VarChar, id)
                .input('data', mssql.VarChar, JSON.stringify(row))
                .query(`MERGE INTO ${table} AS target USING (SELECT @id as id, @data as data) AS source ON target.id = source.id WHEN MATCHED THEN UPDATE SET data = source.data WHEN NOT MATCHED THEN INSERT (id, data) VALUES (source.id, source.data);`)
            }
            await transaction.commit()
            return true
          } catch (err) {
            await transaction.rollback()
            throw err
          }
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await mssql.close()
      }
    }
  } catch (err) {
    console.error('[Storage] MSSQL not available:', err.message)
    return initJsonStorage()
  }
}

const initMongodbStorage = () => {
  let client
  let database
  try {
    const { MongoClient } = require('mongodb')
    const storageConfig = config.config.storage.mongodb
    
    let connectionUri
    if (storageConfig.connectionString) {
      connectionUri = storageConfig.connectionString
    } else {
      const auth = storageConfig.user && storageConfig.password 
        ? `${storageConfig.user}:${encodeURIComponent(storageConfig.password)}@`
        : ''
      const authSource = storageConfig.authSource ? `?authSource=${storageConfig.authSource}` : ''
      connectionUri = `mongodb://${auth}${storageConfig.host || 'localhost'}:${storageConfig.port || 27017}/${storageConfig.database || 'voltchat'}${authSource}`
    }
    
    client = new MongoClient(connectionUri)
    
    const createCollections = async () => {
      await client.connect()
      database = client.db(storageConfig.database || 'voltchat')
      
      await database.createCollection('users').catch(() => {})
      await database.createCollection('servers').catch(() => {})
      await database.createCollection('channels').catch(() => {})
      await database.createCollection('messages').catch(() => {})
      await database.createCollection('friends').catch(() => {})
      await database.createCollection('friend_requests').catch(() => {})
      await database.createCollection('dms').catch(() => {})
      await database.createCollection('dm_messages').catch(() => {})
      await database.createCollection('reactions').catch(() => {})
      await database.createCollection('blocked').catch(() => {})
      await database.createCollection('files').catch(() => {})
      await database.createCollection('attachments').catch(() => {})
      await database.createCollection('discovery').catch(() => {})
      await database.createCollection('global_bans').catch(() => {})
      await database.createCollection('admin_logs').catch(() => {})
      
      await database.collection('messages').createIndex({ channelId: 1, createdAt: -1 }).catch(() => {})
      await database.collection('channels').createIndex({ serverId: 1 }).catch(() => {})
      await database.collection('servers').createIndex({ ownerId: 1 }).catch(() => {})
      
      console.log('[Storage] MongoDB collections initialized')
    }
    
    createCollections().catch(err => {
      console.error('[Storage] Error creating MongoDB collections:', err.message)
    })
    
    console.log('[Storage] MongoDB client created')
    
    return {
      type: 'mongodb',
      provider: 'mongodb',
      client,
      db: database,
      load: async (table, defaultValue = {}) => {
        try {
          if (!database) await createCollections()
          const collection = database.collection(table)
          const cursor = collection.find({})
          const result = {}
          await cursor.forEach(doc => {
            result[doc._id] = doc.data || doc
            if (result[doc._id]._id) delete result[doc._id]._id
          })
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          if (!database) await createCollections()
          const collection = database.collection(table)
          const bulkOps = []
          for (const [id, row] of Object.entries(data)) {
            bulkOps.push({
              replaceOne: {
                filter: { _id: id },
                replacement: { _id: id, data: row },
                upsert: true
              }
            })
          }
          if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps)
          }
          return true
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await client.close()
      }
    }
  } catch (err) {
    console.error('[Storage] MongoDB not available:', err.message)
    return initJsonStorage()
  }
}

const initRedisStorage = () => {
  let redisClient
  try {
    const redis = require('redis')
    const storageConfig = config.config.storage.redis
    
    const redisConfig = {
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 6379,
      password: storageConfig.password || undefined,
      db: storageConfig.db || 0
    }
    
    redisClient = redis.createClient(redisConfig)
    
    redisClient.on('error', err => {
      console.error('[Storage] Redis error:', err.message)
    })
    
    redisClient.connect().then(() => {
      console.log('[Storage] Redis client connected')
    }).catch(err => {
      console.error('[Storage] Redis connection error:', err.message)
    })
    
    const prefix = storageConfig.keyPrefix || 'voltchat:'
    
    return {
      type: 'redis',
      provider: 'redis',
      client: redisClient,
      load: async (table, defaultValue = {}) => {
        try {
          const keys = await redisClient.keys(`${prefix}${table}:*`)
          const result = {}
          for (const key of keys) {
            const id = key.replace(`${prefix}${table}:`, '')
            const data = await redisClient.get(key)
            try {
              result[id] = JSON.parse(data)
            } catch {
              result[id] = data
            }
          }
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          const pipeline = redisClient.multi()
          for (const [id, row] of Object.entries(data)) {
            pipeline.set(`${prefix}${table}:${id}`, JSON.stringify(row))
          }
          await pipeline.exec()
          return true
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await redisClient.quit()
      }
    }
  } catch (err) {
    console.error('[Storage] Redis not available:', err.message)
    return initJsonStorage()
  }
}

export const initStorage = () => {
  if (storage) return storage
  
  const storageType = config.config.storage?.type || 'json'
  
  switch (storageType) {
    case 'sqlite':
      try {
        storage = initSqliteStorage()
      } catch {
        storage = initJsonStorage()
      }
      break
      
    case 'mysql':
      try {
        storage = initMysqlStorage()
      } catch {
        storage = initJsonStorage()
      }
      break
      
    case 'mariadb':
      try {
        storage = initMariadbStorage()
      } catch {
        storage = initJsonStorage()
      }
      break
      
    case 'postgres':
      try {
        storage = initPostgresStorage()
      } catch {
        storage = initJsonStorage()
      }
      break
      
    case 'cockroachdb':
      try {
        storage = initCockroachdbStorage()
      } catch {
        storage = initJsonStorage()
      }
      break
      
    case 'mssql':
      try {
        storage = initMssqlStorage()
      } catch {
        storage = initJsonStorage()
      }
      break
      
    case 'mongodb':
      try {
        storage = initMongodbStorage()
      } catch {
        storage = initJsonStorage()
      }
      break
      
    case 'redis':
      try {
        storage = initRedisStorage()
      } catch {
        storage = initJsonStorage()
      }
      break
      
    case 'json':
    default:
      storage = initJsonStorage()
      break
  }
  
  console.log(`[Storage] Initialized: ${storage.type}`)
  return storage
}

export const getStorage = () => {
  if (!storage) {
    initStorage()
  }
  return storage
}

export const FILES = {
  users: 'users',
  friends: 'friends',
  friendRequests: 'friend_requests',
  servers: 'servers',
  channels: 'channels',
  messages: 'messages',
  serverMembers: 'server_members',
  invites: 'invites',
  dms: 'dms',
  dmMessages: 'dm_messages',
  reactions: 'reactions',
  blocked: 'blocked',
  files: 'files',
  attachments: 'attachments',
  discovery: 'discovery',
  globalBans: 'global_bans',
  adminLogs: 'admin_logs'
}

export default {
  initStorage,
  getStorage,
  FILES
}
