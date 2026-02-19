import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const BOTS_FILE = path.join(DATA_DIR, 'bots.json')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const loadData = (defaultValue = {}) => {
  try {
    if (fs.existsSync(BOTS_FILE)) {
      return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[Bots] Error loading data:', err.message)
  }
  return defaultValue
}

const saveData = (data) => {
  try {
    fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error('[Bots] Error saving data:', err.message)
    return false
  }
}

export const botService = {
  createBot(ownerId, botData) {
    const data = loadData()
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
      permissions: botData.permissions || ['messages:read', 'messages:send'],
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

    data.bots[botId] = bot
    saveData(data)
    console.log(`[Bots] Created bot: ${bot.name} (${botId}) by ${ownerId}`)
    return { ...bot, token }
  },

  getBot(botId) {
    const data = loadData()
    const bot = data.bots?.[botId]
    if (!bot) return null
    const { token, ...safe } = bot
    return safe
  },

  getBotByToken(token) {
    const data = loadData()
    if (!data.bots) return null
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    return Object.values(data.bots).find(b => b.tokenHash === tokenHash) || null
  },

  getBotsByOwner(ownerId) {
    const data = loadData()
    if (!data.bots) return []
    return Object.values(data.bots)
      .filter(b => b.ownerId === ownerId)
      .map(({ token, ...safe }) => safe)
  },

  updateBot(botId, ownerId, updates) {
    const data = loadData()
    if (!data.bots?.[botId]) return null
    if (data.bots[botId].ownerId !== ownerId) return { error: 'Not authorized' }

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
    saveData(data)
    const { token, ...safe } = data.bots[botId]
    return safe
  },

  deleteBot(botId, ownerId) {
    const data = loadData()
    if (!data.bots?.[botId]) return false
    if (data.bots[botId].ownerId !== ownerId) return false

    delete data.bots[botId]
    saveData(data)
    return true
  },

  regenerateToken(botId, ownerId) {
    const data = loadData()
    if (!data.bots?.[botId]) return null
    if (data.bots[botId].ownerId !== ownerId) return null

    const newToken = `vbot_${crypto.randomBytes(32).toString('hex')}`
    data.bots[botId].token = newToken
    data.bots[botId].tokenHash = crypto.createHash('sha256').update(newToken).digest('hex')
    data.bots[botId].updatedAt = new Date().toISOString()
    saveData(data)
    return newToken
  },

  addBotToServer(botId, serverId) {
    const data = loadData()
    if (!data.bots?.[botId]) return false

    if (!data.bots[botId].servers.includes(serverId)) {
      data.bots[botId].servers.push(serverId)
      saveData(data)
    }
    return true
  },

  removeBotFromServer(botId, serverId) {
    const data = loadData()
    if (!data.bots?.[botId]) return false

    data.bots[botId].servers = data.bots[botId].servers.filter(s => s !== serverId)
    saveData(data)
    return true
  },

  getServerBots(serverId) {
    const data = loadData()
    if (!data.bots) return []
    return Object.values(data.bots)
      .filter(b => b.servers.includes(serverId))
      .map(({ token, ...safe }) => safe)
  },

  setBotStatus(botId, status, customStatus) {
    const data = loadData()
    if (!data.bots?.[botId]) return false
    data.bots[botId].status = status
    // customStatus: null clears it, undefined leaves it unchanged
    if (customStatus !== undefined) {
      data.bots[botId].customStatus = customStatus || null
    }
    data.bots[botId].lastActive = new Date().toISOString()
    saveData(data)
    return true
  },

  // Commands registry
  registerCommands(botId, commands) {
    const data = loadData()
    if (!data.bots?.[botId]) return false

    data.bots[botId].commands = commands.map(cmd => ({
      name: cmd.name,
      description: cmd.description || '',
      usage: cmd.usage || '',
      options: cmd.options || []
    }))

    data.bots[botId].updatedAt = new Date().toISOString()
    saveData(data)
    return true
  },

  getBotCommands(botId) {
    const data = loadData()
    return data.bots?.[botId]?.commands || []
  },

  getAllPublicBots() {
    const data = loadData()
    if (!data.bots) return []
    return Object.values(data.bots)
      .filter(b => b.public)
      .map(({ token, tokenHash, webhookSecret, ...safe }) => safe)
  },

  // Webhook event delivery
  async deliverWebhookEvent(botId, event, payload) {
    const data = loadData()
    const bot = data.bots?.[botId]
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

  // Bot permissions check
  hasPermission(botId, permission) {
    const data = loadData()
    const bot = data.bots?.[botId]
    if (!bot) return false
    return bot.permissions.includes(permission) || bot.permissions.includes('*')
  },

  PERMISSIONS: {
    MESSAGES_READ: 'messages:read',
    MESSAGES_SEND: 'messages:send',
    MESSAGES_DELETE: 'messages:delete',
    CHANNELS_READ: 'channels:read',
    CHANNELS_MANAGE: 'channels:manage',
    MEMBERS_READ: 'members:read',
    MEMBERS_MANAGE: 'members:manage',
    REACTIONS_ADD: 'reactions:add',
    VOICE_CONNECT: 'voice:connect',
    WEBHOOKS_MANAGE: 'webhooks:manage',
    SERVER_MANAGE: 'server:manage',
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
  }
}

export default botService
