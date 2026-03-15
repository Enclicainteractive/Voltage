import crypto from 'crypto'
import { FILES, supportsDirectQuery, directQuery } from './dataService.js'
import { botCache, globalCoalescer, globalRateLimiter } from './cacheService.js'

const BOTS_FILE = FILES.bots

const normalizeStringArray = (value, fallback = []) => {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim())
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (value && typeof value === 'object') {
    return Object.values(value)
      .filter(item => typeof item === 'string' && item.trim())
      .map(item => item.trim())
  }
  return [...fallback]
}

const normalizeBotRecord = (bot = {}) => {
  // Handle DB columns that come back as servers_json, permissions_json, etc.
  // (MariaDB/MySQL/SQLite store these as JSON strings in _json columns)
  const resolveJsonField = (direct, jsonField, fallback = []) => {
    if (direct !== undefined && direct !== null) return direct
    if (jsonField !== undefined && jsonField !== null) {
      if (typeof jsonField === 'string') {
        try { return JSON.parse(jsonField) } catch { /* ignore */ }
      }
      if (Array.isArray(jsonField) || typeof jsonField === 'object') return jsonField
    }
    return fallback
  }

  return {
    ...bot,
    permissions: normalizeStringArray(
      resolveJsonField(bot.permissions, bot.permissions_json),
      ['messages:read', 'messages:send', 'channels:read']
    ),
    servers: normalizeStringArray(
      resolveJsonField(bot.servers, bot.servers_json),
      []
    ),
    intents: normalizeStringArray(
      resolveJsonField(bot.intents, bot.intents_json),
      ['GUILD_MESSAGES', 'DIRECT_MESSAGES']
    ),
    commands: (() => {
      const raw = resolveJsonField(bot.commands, bot.commands_json)
      return Array.isArray(raw) ? raw.filter(command => command && typeof command === 'object') : []
    })()
  }
}

const normalizeBotsPayload = (raw, defaultValue = {}) => {
  if (!raw || typeof raw !== 'object') return defaultValue
  if (raw.bots && typeof raw.bots === 'object') return raw
  return { bots: raw }
}

let botsCache = { bots: {} }
let botsCacheLoaded = false

const loadData = async (defaultValue = {}) => {
  // Always try to load if cache is empty, even if previously marked as loaded
  // (storage might not have been ready on first attempt)
  if (botsCacheLoaded && botsCache.bots && Object.keys(botsCache.bots).length > 0) {
    return botsCache
  }

  return globalCoalescer.coalesce('bots:load', async () => {
    // Re-check inside coalescer in case another call already loaded
    if (botsCacheLoaded && botsCache.bots && Object.keys(botsCache.bots).length > 0) {
      return botsCache
    }

    await doLoadData()
    return botsCache
  })
}

const doLoadData = async () => {
  console.log('[BotService] Loading bots, supportsDirectQuery:', supportsDirectQuery())
  
  let dbLoaded = false
  if (supportsDirectQuery()) {
    try {
      const rows = await directQuery('SELECT * FROM bots')
      console.log('[BotService] DB query result:', rows ? rows.length : 'null', 'rows')
      if (rows && rows.length > 0) {
        const botsFromDb = {}
        for (const row of rows) {
          const botId = row.id
          botsFromDb[botId] = {
            ...row,
            permissions_json: row.permissions_json,
            servers_json: row.servers_json,
            intents_json: row.intents_json,
            commands_json: row.commands_json
          }
        }
        botsCache = normalizeBotsPayload({ bots: botsFromDb }, {})
        if (botsCache?.bots && typeof botsCache.bots === 'object') {
          botsCache.bots = Object.fromEntries(
            Object.entries(botsCache.bots).map(([id, bot]) => [id, normalizeBotRecord({ ...bot, id: bot?.id || id })])
          )
        }
        dbLoaded = true
        botsCacheLoaded = true
        console.log('[BotService] Loaded', Object.keys(botsCache.bots).length, 'bots from database')
      } else {
        console.log('[BotService] No bots found in database')
        botsCache = { bots: {} }
        dbLoaded = true
        botsCacheLoaded = true
      }
    } catch (err) {
      console.error('[BotService] Error loading from DB:', err.message)
    }
  } else {
    // Storage not ready, don't mark as loaded - will retry on next request
    console.log('[BotService] Storage not ready, will retry on next request')
  }
}

// Note: Don't trigger initial load at module import time
// Bots will be loaded lazily on first request when storage is ready

const saveData = async (data) => {
  const payload = data?.bots && typeof data.bots === 'object' ? data.bots : data
  try {
    // Update in-memory cache
    botsCache = normalizeBotsPayload({ bots: payload }, {})
    console.log('[Bots] Updated in-memory cache')
    return true
  } catch (err) {
    console.error('[Bots] Error saving data:', err.message)
    return false
  }
}

export const botService = {
  async createBot(ownerId, botData) {
    const data = await loadData()
    if (!data.bots) data.bots = {}

    const botId = `bot_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    const token = `vbot_${crypto.randomBytes(32).toString('hex')}`

    const bot = {
      id: botId,
      name: botData.name,
      description: botData.description || '',
      avatar: botData.avatar || null,
      ownerId,
      token,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      prefix: botData.prefix || '!',
      permissions: botData.permissions || ['messages:read', 'messages:send', 'channels:read'],
      servers: [],
      intents: botData.intents || ['GUILD_MESSAGES', 'DIRECT_MESSAGES'],
      status: 'offline',
      public: botData.public || false,
      webhookUrl: botData.webhookUrl || null,
      webhookSecret: botData.webhookUrl ? crypto.randomBytes(16).toString('hex') : null,
      commands: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    data.bots[botId] = normalizeBotRecord(bot)
    
    if (supportsDirectQuery()) {
      const permissionsJson = JSON.stringify(bot.permissions)
      const serversJson = JSON.stringify(bot.servers)
      const intentsJson = JSON.stringify(bot.intents)
      const commandsJson = JSON.stringify(bot.commands)
      await directQuery(
        'INSERT INTO bots (id, name, description, avatar, ownerId, token, tokenHash, prefix, permissions_json, servers_json, intents_json, commands_json, status, public, webhookUrl, webhookSecret, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [botId, bot.name, bot.description, bot.avatar, ownerId, token, bot.tokenHash, bot.prefix, permissionsJson, serversJson, intentsJson, commandsJson, bot.status, bot.public ? 1 : 0, bot.webhookUrl, bot.webhookSecret, bot.createdAt, bot.updatedAt]
      )
    }
    
    await saveData(data)
    console.log(`[Bots] Created bot: ${bot.name} (${botId}) by ${ownerId}`)
    return { ...data.bots[botId], token }
  },

  async getBot(botId) {
    const data = await loadData()
    const bot = data.bots?.[botId] ? normalizeBotRecord(data.bots[botId]) : null
    if (!bot) return null
    const { token, ...safe } = bot
    return safe
  },

  async getBotByToken(token) {
    const data = await loadData()
    if (!data.bots) return null
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const bot = Object.values(data.bots).find(b => b.tokenHash === tokenHash)
    return bot ? normalizeBotRecord(bot) : null
  },

  async getBotsByOwner(ownerId) {
    const data = await loadData()
    if (!data.bots) return []
    return Object.values(data.bots)
      .filter(b => b.ownerId === ownerId)
      .map((bot) => {
        const { token, ...safe } = normalizeBotRecord(bot)
        return safe
      })
  },

  async updateBot(botId, ownerId, updates) {
    const data = await loadData()
    if (!data.bots?.[botId]) return null
    if (data.bots[botId].ownerId !== ownerId) return { error: 'Not authorized' }
    data.bots[botId] = normalizeBotRecord(data.bots[botId])

    const allowed = ['name', 'description', 'avatar', 'prefix', 'permissions', 'intents', 'public', 'webhookUrl']
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        data.bots[botId][key] = updates[key]
      }
    }

    if (updates.webhookUrl && !data.bots[botId].webhookSecret) {
      data.bots[botId].webhookSecret = crypto.randomBytes(16).toString('hex')
    }

    data.bots[botId].updatedAt = new Date().toISOString()
    
    if (supportsDirectQuery()) {
      console.log('[BotService] Saving bot to database:', botId)
      
      // First check if bot exists in DB
      const existingBot = await directQuery('SELECT id FROM bots WHERE id = ?', [botId])
      console.log('[BotService] Bot exists in DB:', existingBot && existingBot.length > 0 ? 'yes' : 'no')
      
      const name = data.bots[botId].name
      const description = data.bots[botId].description
      const avatar = data.bots[botId].avatar
      const prefix = data.bots[botId].prefix
      const permissionsJson = JSON.stringify(data.bots[botId].permissions)
      const serversJson = JSON.stringify(data.bots[botId].servers)
      const intentsJson = JSON.stringify(data.bots[botId].intents)
      const commandsJson = JSON.stringify(data.bots[botId].commands)
      const publicBot = data.bots[botId].public ? 1 : 0
      const webhookUrl = data.bots[botId].webhookUrl
      const result = await directQuery(
        'UPDATE bots SET name = ?, description = ?, avatar = ?, prefix = ?, permissions_json = ?, servers_json = ?, intents_json = ?, commands_json = ?, public = ?, webhookUrl = ?, updatedAt = ? WHERE id = ?',
        [name, description, avatar, prefix, permissionsJson, serversJson, intentsJson, commandsJson, publicBot, webhookUrl, data.bots[botId].updatedAt, botId]
      )
      if (result === null) {
        console.error('[BotService] Failed to update bot in database:', botId)
      } else {
        console.log('[BotService] Bot saved to database successfully:', botId, 'permissions:', permissionsJson)
      }
    } else {
      console.log('[BotService] supportsDirectQuery is false - not saving to DB')
    }
    
    await saveData(data)
    const { token, ...safe } = data.bots[botId]
    return safe
  },

  async deleteBot(botId, ownerId) {
    const data = await loadData()
    if (!data.bots?.[botId]) return false
    if (data.bots[botId].ownerId !== ownerId) return false

    if (supportsDirectQuery()) {
      await directQuery('DELETE FROM bots WHERE id = ?', [botId])
    }
    
    delete data.bots[botId]
    await saveData(data)
    return true
  },

  async regenerateToken(botId, ownerId) {
    const data = await loadData()
    if (!data.bots?.[botId]) return null
    if (data.bots[botId].ownerId !== ownerId) return null

    const newToken = `vbot_${crypto.randomBytes(32).toString('hex')}`
    const tokenHash = crypto.createHash('sha256').update(newToken).digest('hex')
    const updatedAt = new Date().toISOString()

    data.bots[botId].token = newToken
    data.bots[botId].tokenHash = tokenHash
    data.bots[botId].updatedAt = updatedAt
    
    if (supportsDirectQuery()) {
      await directQuery(
        'UPDATE bots SET token = ?, tokenHash = ?, updatedAt = ? WHERE id = ?',
        [newToken, tokenHash, updatedAt, botId]
      )
    }
    
    await saveData(data)
    return newToken
  },

  async addBotToServer(botId, serverId) {
    const data = await loadData()
    if (!data.bots?.[botId]) return false

    data.bots[botId] = normalizeBotRecord(data.bots[botId])

    if (!data.bots[botId].servers.includes(serverId)) {
      data.bots[botId].servers.push(serverId)
      data.bots[botId].updatedAt = new Date().toISOString()
      
      if (supportsDirectQuery()) {
        const serversJson = JSON.stringify(data.bots[botId].servers)
        await directQuery(
          'UPDATE bots SET servers_json = ?, updatedAt = ? WHERE id = ?',
          [serversJson, data.bots[botId].updatedAt, botId]
        )
      }
      
      await saveData(data)
    }
    return true
  },

  async removeBotFromServer(botId, serverId) {
    const data = await loadData()
    if (!data.bots?.[botId]) return false

    data.bots[botId] = normalizeBotRecord(data.bots[botId])
    data.bots[botId].servers = data.bots[botId].servers.filter(s => s !== serverId)
    data.bots[botId].updatedAt = new Date().toISOString()
    
    if (supportsDirectQuery()) {
      const serversJson = JSON.stringify(data.bots[botId].servers)
      await directQuery(
        'UPDATE bots SET servers_json = ?, updatedAt = ? WHERE id = ?',
        [serversJson, data.bots[botId].updatedAt, botId]
      )
    }
    
    await saveData(data)
    return true
  },

  async getServerBots(serverId) {
    const data = await loadData()
    if (!data.bots) return []
    return Object.values(data.bots)
      .map(bot => normalizeBotRecord(bot))
      .filter(b => b.servers.includes(serverId))
      .map(({ token, ...safe }) => safe)
  },

  async setBotStatus(botId, status, customStatus) {
    const data = await loadData()
    if (!data.bots?.[botId]) return false
    data.bots[botId] = normalizeBotRecord(data.bots[botId])
    data.bots[botId].status = status
    // customStatus: null clears it, undefined leaves it unchanged
    if (customStatus !== undefined) {
      data.bots[botId].customStatus = customStatus || null
    }
    data.bots[botId].lastActive = new Date().toISOString()
    
    if (supportsDirectQuery()) {
      await directQuery(
        'UPDATE bots SET status = ?, customStatus = ?, lastActive = ? WHERE id = ?',
        [status, data.bots[botId].customStatus, data.bots[botId].lastActive, botId]
      )
    }
    
    await saveData(data)
    return true
  },

  // Commands registry
  async registerCommands(botId, commands) {
    const data = await loadData()
    if (!data.bots?.[botId]) return false
    data.bots[botId] = normalizeBotRecord(data.bots[botId])

    data.bots[botId].commands = commands.map(cmd => ({
      name: cmd.name,
      description: cmd.description || '',
      usage: cmd.usage || '',
      options: cmd.options || []
    }))

    data.bots[botId].updatedAt = new Date().toISOString()
    
    if (supportsDirectQuery()) {
      const commandsJson = JSON.stringify(data.bots[botId].commands)
      const result = await directQuery(
        'UPDATE bots SET commands_json = ?, updatedAt = ? WHERE id = ?',
        [commandsJson, data.bots[botId].updatedAt, botId]
      )
      if (result === null) {
        console.error('[BotService] Failed to save commands to database for bot:', botId)
      }
    }
    
    await saveData(data)
    return true
  },

  async getBotCommands(botId) {
    const data = await loadData()
    return data.bots?.[botId]?.commands || []
  },

  async getAllPublicBots() {
    const data = await loadData()
    if (!data.bots) return []
    return Object.values(data.bots)
      .map(bot => normalizeBotRecord(bot))
      .filter(b => b.public)
      .map(({ token, tokenHash, webhookSecret, ...safe }) => safe)
  },

  async getAllBots() {
    const data = await loadData()
    if (!data.bots) return []
    return Object.values(data.bots)
      .map(bot => normalizeBotRecord(bot))
      .map(({ token, tokenHash, webhookSecret, ...safe }) => safe)
  },

  // Webhook event delivery
  async deliverWebhookEvent(botId, event, payload) {
    const data = await loadData()
    const bot = data.bots?.[botId] ? normalizeBotRecord(data.bots[botId]) : null
    if (!bot?.webhookUrl) return false

    try {
      const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() })
      const signature = crypto.createHmac('sha256', bot.webhookSecret).update(body).digest('hex')

      const response = await fetch(bot.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Volt-Signature': signature,
          'X-Volt-Bot-Id': botId,
          'X-Volt-Event': event
        },
        body,
        signal: AbortSignal.timeout(5000)
      })

      return response.ok
    } catch (err) {
      console.error(`[Bots] Webhook delivery failed for ${botId}:`, err.message)
      return false
    }
  },

  // Permission mapping: bot API format (colon) <-> server permission format (underscore)
  PERMISSION_MAP: {
    'roles:manage': 'manage_roles',
    'channels:manage': 'manage_channels',
    'members:manage': 'members_manage',
    'messages:manage': 'manage_messages',
    'manage_roles': 'roles:manage',
    'manage_channels': 'channels:manage',
    'members_manage': 'members:manage',
    'manage_messages': 'messages:manage'
  },

  // Bot permissions check
  async hasPermission(botId, permission) {
    const data = await loadData()
    const bot = data.bots?.[botId] ? normalizeBotRecord(data.bots[botId]) : null
    if (!bot) return false
    
    // Check direct permission
    if (bot.permissions.includes(permission) || bot.permissions.includes('*')) return true
    
    // Check mapped permission
    const mappedPermission = this.PERMISSION_MAP[permission]
    if (mappedPermission && (bot.permissions.includes(mappedPermission) || bot.permissions.includes('*'))) return true
    
    return false
  },

  PERMISSIONS: {
    MESSAGES_READ: 'messages:read',
    MESSAGES_SEND: 'messages:send',
    MESSAGES_DELETE: 'messages:delete',
    CHANNELS_READ: 'channels:read',
    CHANNELS_MANAGE: 'channels:manage',
    MEMBERS_READ: 'members:read',
    MEMBERS_MANAGE: 'members:manage',
    ROLES_MANAGE: 'roles:manage',
    MANAGE_ROLES: 'manage_roles',
    REACTIONS_ADD: 'reactions:add',
    VOICE_CONNECT: 'voice:connect',
    WEBHOOKS_MANAGE: 'webhooks:manage',
    SERVER_MANAGE: 'server:manage',
    MANAGE_SERVER: 'manage_server',
    ADMIN: '*'
  },

  INTENTS: {
    GUILD_MESSAGES: 'GUILD_MESSAGES',
    DIRECT_MESSAGES: 'DIRECT_MESSAGES',
    GUILD_MEMBERS: 'GUILD_MEMBERS',
    GUILD_VOICE: 'GUILD_VOICE',
    GUILD_REACTIONS: 'GUILD_REACTIONS',
    GUILD_CHANNELS: 'GUILD_CHANNELS',
    MESSAGE_CONTENT: 'MESSAGE_CONTENT'
  },

  async syncBotsWithServerMembers(servers, saveServersFn) {
    const data = await loadData()
    if (!data.bots) return { added: 0, updated: 0 }

    let added = 0
    let updated = 0

    for (const server of servers) {
      if (!server.members) server.members = []

      const botMembers = (server.members || []).filter(m => m.isBot)
      const existingBotIds = new Set(botMembers.map(m => m.id))

      const serverBots = Object.values(data.bots)
        .map(bot => normalizeBotRecord(bot))
        .filter(b => b.servers.includes(server.id))

      for (const bot of serverBots) {
        if (!existingBotIds.has(bot.id)) {
          server.members.push({
            id: bot.id,
            username: bot.name,
            avatar: bot.avatar || null,
            roles: bot.roles || [],
            role: bot.roles?.[0] || null,
            status: bot.status || 'offline',
            isBot: true
          })
          added++
        }
      }
    }

    if (added > 0 && saveServersFn) {
      await saveServersFn(servers)
    }

    return { added, updated }
  }
}

export default botService
