const { dbPromise } = require('../config/database.js')

/**
 * Database Optimization Script
 * Creates optimal indexes for VoltChat performance
 */

const INDEXES = {
  // Messages table - Critical for message loading performance
  messages: [
    {
      name: 'idx_messages_channel_timestamp',
      columns: ['channel_id', 'timestamp DESC'],
      description: 'Primary index for message loading by channel with time ordering'
    },
    {
      name: 'idx_messages_user_timestamp',
      columns: ['user_id', 'timestamp DESC'],
      description: 'Index for user message history'
    },
    {
      name: 'idx_messages_server_timestamp',
      columns: ['server_id', 'timestamp DESC'],
      description: 'Index for server-wide message queries'
    },
    {
      name: 'idx_messages_content_search',
      columns: ['content'],
      type: 'fulltext',
      description: 'Full-text search index for message content'
    },
    {
      name: 'idx_messages_thread',
      columns: ['thread_id', 'timestamp DESC'],
      description: 'Index for threaded conversations'
    },
    {
      name: 'idx_messages_mentions',
      columns: ['mentions'],
      type: 'gin',
      description: 'Index for message mentions (PostgreSQL GIN)'
    }
  ],

  // Users table - For authentication and user lookups
  users: [
    {
      name: 'idx_users_email_unique',
      columns: ['email'],
      unique: true,
      description: 'Unique index for email authentication'
    },
    {
      name: 'idx_users_username_unique',
      columns: ['username'],
      unique: true,
      description: 'Unique index for username lookups'
    },
    {
      name: 'idx_users_last_active',
      columns: ['last_active DESC'],
      description: 'Index for active user queries'
    },
    {
      name: 'idx_users_search',
      columns: ['username', 'display_name'],
      description: 'Composite index for user search'
    }
  ],

  // Servers table - For server management
  servers: [
    {
      name: 'idx_servers_owner',
      columns: ['owner_id'],
      description: 'Index for server ownership queries'
    },
    {
      name: 'idx_servers_public',
      columns: ['is_public', 'created_at DESC'],
      description: 'Index for public server discovery'
    },
    {
      name: 'idx_servers_name_search',
      columns: ['name'],
      description: 'Index for server name searches'
    }
  ],

  // Channels table - For channel operations
  channels: [
    {
      name: 'idx_channels_server',
      columns: ['server_id', 'position ASC'],
      description: 'Index for channel listing by server'
    },
    {
      name: 'idx_channels_type',
      columns: ['type', 'server_id'],
      description: 'Index for filtering channels by type'
    }
  ],

  // Server members - Critical for permission checks
  server_members: [
    {
      name: 'idx_server_members_user_server',
      columns: ['user_id', 'server_id'],
      unique: true,
      description: 'Unique composite index for membership'
    },
    {
      name: 'idx_server_members_server_role',
      columns: ['server_id', 'role_id'],
      description: 'Index for role-based queries'
    },
    {
      name: 'idx_server_members_joined',
      columns: ['joined_at DESC'],
      description: 'Index for recent member queries'
    }
  ],

  // Sessions - For authentication performance
  sessions: [
    {
      name: 'idx_sessions_token_unique',
      columns: ['token'],
      unique: true,
      description: 'Unique index for session token lookups'
    },
    {
      name: 'idx_sessions_user_active',
      columns: ['user_id', 'expires_at DESC'],
      description: 'Index for active user sessions'
    },
    {
      name: 'idx_sessions_cleanup',
      columns: ['expires_at ASC'],
      description: 'Index for session cleanup operations'
    }
  ],

  // Attachments - For file management
  attachments: [
    {
      name: 'idx_attachments_message',
      columns: ['message_id'],
      description: 'Index for message attachment lookups'
    },
    {
      name: 'idx_attachments_user',
      columns: ['uploaded_by', 'uploaded_at DESC'],
      description: 'Index for user file history'
    },
    {
      name: 'idx_attachments_type_size',
      columns: ['file_type', 'file_size'],
      description: 'Index for file type and size queries'
    }
  ],

  // Reactions - For reaction performance
  reactions: [
    {
      name: 'idx_reactions_message_emoji',
      columns: ['message_id', 'emoji'],
      description: 'Index for reaction counts'
    },
    {
      name: 'idx_reactions_user_message',
      columns: ['user_id', 'message_id'],
      unique: true,
      description: 'Unique index to prevent duplicate reactions'
    }
  ],

  // Direct messages - For DM performance
  direct_messages: [
    {
      name: 'idx_dm_participants',
      columns: ['user1_id', 'user2_id'],
      unique: true,
      description: 'Unique index for DM participants'
    },
    {
      name: 'idx_dm_user_updated',
      columns: ['user1_id', 'last_updated DESC'],
      description: 'Index for user DM list'
    }
  ]
}

// Database-specific index creation functions
const createPostgreSQLIndex = async (db, table, index) => {
  let sql = `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX`
  
  if (index.type === 'gin') {
    sql += ` ${index.name} ON ${table} USING GIN (${index.columns[0]})`
  } else if (index.type === 'fulltext') {
    sql += ` ${index.name} ON ${table} USING GIN (to_tsvector('english', ${index.columns[0]}))`
  } else {
    sql += ` ${index.name} ON ${table} (${index.columns.join(', ')})`
  }
  
  return db.query(sql)
}

const createMySQLIndex = async (db, table, index) => {
  let sql = `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} ON ${table}`
  
  if (index.type === 'fulltext') {
    sql += ` (${index.columns.join(', ')}) USING FULLTEXT`
  } else {
    sql += ` (${index.columns.join(', ')})`
  }
  
  return db.query(sql)
}

const createSQLiteIndex = async (db, table, index) => {
  const sql = `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} ON ${table} (${index.columns.join(', ')})`
  return db.query(sql)
}

// Get database type
const getDatabaseType = (connectionString) => {
  if (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://')) {
    return 'postgresql'
  } else if (connectionString.startsWith('mysql://')) {
    return 'mysql'
  } else if (connectionString.includes('sqlite') || connectionString.endsWith('.db')) {
    return 'sqlite'
  }
  return 'unknown'
}

// Check if index exists
const indexExists = async (db, indexName, dbType) => {
  try {
    let query
    switch (dbType) {
      case 'postgresql':
        query = "SELECT 1 FROM pg_indexes WHERE indexname = $1"
        break
      case 'mysql':
        query = "SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE INDEX_NAME = ?"
        break
      case 'sqlite':
        query = "SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?"
        break
      default:
        return false
    }
    
    const result = await db.query(query, [indexName])
    return result.length > 0
  } catch (error) {
    console.warn(`Failed to check if index ${indexName} exists:`, error.message)
    return false
  }
}

// Main optimization function
async function optimizeDatabase() {
  console.log('🔧 Starting database optimization...')
  
  try {
    const db = await dbPromise
    const dbType = getDatabaseType(process.env.DATABASE_URL || '')
    
    console.log(`📊 Database type: ${dbType}`)
    
    let totalIndexes = 0
    let createdIndexes = 0
    let skippedIndexes = 0
    let failedIndexes = 0
    
    for (const [tableName, indexes] of Object.entries(INDEXES)) {
      console.log(`\n📋 Optimizing table: ${tableName}`)
      
      for (const index of indexes) {
        totalIndexes++
        
        try {
          // Skip unsupported index types for certain databases
          if ((index.type === 'gin' || index.type === 'fulltext') && dbType === 'sqlite') {
            console.log(`  ⏭️  Skipping ${index.name} (${index.type} not supported in SQLite)`)
            skippedIndexes++
            continue
          }
          
          // Check if index already exists
          const exists = await indexExists(db, index.name, dbType)
          if (exists) {
            console.log(`  ✅ Index ${index.name} already exists`)
            skippedIndexes++
            continue
          }
          
          // Create index based on database type
          console.log(`  🔨 Creating index: ${index.name}`)
          console.log(`     ${index.description}`)
          
          switch (dbType) {
            case 'postgresql':
              await createPostgreSQLIndex(db, tableName, index)
              break
            case 'mysql':
              await createMySQLIndex(db, tableName, index)
              break
            case 'sqlite':
              await createSQLiteIndex(db, tableName, index)
              break
            default:
              throw new Error(`Unsupported database type: ${dbType}`)
          }
          
          console.log(`  ✅ Created index: ${index.name}`)
          createdIndexes++
          
        } catch (error) {
          console.error(`  ❌ Failed to create index ${index.name}:`, error.message)
          failedIndexes++
        }
      }
    }
    
    console.log('\n📊 Optimization Summary:')
    console.log(`  Total indexes: ${totalIndexes}`)
    console.log(`  Created: ${createdIndexes}`)
    console.log(`  Skipped (already exist): ${skippedIndexes}`)
    console.log(`  Failed: ${failedIndexes}`)
    
    if (failedIndexes > 0) {
      console.warn('\n⚠️  Some indexes failed to create. This might be due to:')
      console.warn('  - Missing tables (run migrations first)')
      console.warn('  - Insufficient permissions')
      console.warn('  - Database-specific syntax issues')
    }
    
    // Additional optimizations
    await performAdditionalOptimizations(db, dbType)
    
    console.log('\n🎉 Database optimization completed!')
    
  } catch (error) {
    console.error('❌ Database optimization failed:', error)
    process.exit(1)
  }
}

async function performAdditionalOptimizations(db, dbType) {
  console.log('\n🔧 Performing additional optimizations...')
  
  try {
    switch (dbType) {
      case 'postgresql':
        // Update table statistics
        console.log('  📊 Updating PostgreSQL statistics...')
        await db.query('ANALYZE')
        
        // Set optimal PostgreSQL settings
        await db.query("SET work_mem = '256MB'")
        await db.query("SET shared_buffers = '256MB'")
        await db.query("SET effective_cache_size = '1GB'")
        break
        
      case 'mysql':
        // Optimize tables
        console.log('  🔧 Optimizing MySQL tables...')
        for (const tableName of Object.keys(INDEXES)) {
          try {
            await db.query(`OPTIMIZE TABLE ${tableName}`)
          } catch (error) {
            console.warn(`    Warning: Failed to optimize table ${tableName}:`, error.message)
          }
        }
        break
        
      case 'sqlite':
        // Vacuum and analyze
        console.log('  🗑️  Running SQLite VACUUM...')
        await db.query('VACUUM')
        await db.query('ANALYZE')
        break
    }
    
    console.log('  ✅ Additional optimizations completed')
    
  } catch (error) {
    console.warn('  ⚠️  Some additional optimizations failed:', error.message)
  }
}

// CLI execution
if (require.main === module) {
  optimizeDatabase()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Database optimization failed:', error)
      process.exit(1)
    })
}

module.exports = { optimizeDatabase, INDEXES }