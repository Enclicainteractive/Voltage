import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

const TEST_JWT_SECRET = 'pinned-messages-test-secret'
const TEST_USER_ID = 'u_test_user'
const TEST_ADMIN_ID = 'u_test_admin'
const TEST_CHANNEL_ID = 'c_test_channel'
const TEST_SERVER_ID = 's_test_server'
const TEST_MESSAGE_ID = 'msg_test_123'

// Create hoisted state that can be shared between mock factory and tests
const { getMockStore, setMockStore } = vi.hoisted(() => {
  const store = {
    users: {},
    channels: {},
    servers: {},
    messages: {},
    pinnedMessages: {}
  }

  return {
    getMockStore: () => store,
    setMockStore: (newStore) => {
      Object.keys(newStore).forEach(key => {
        store[key] = newStore[key]
      })
    }
  }
})

// Mock redis service for rate limiting
vi.mock('../services/redisService.js', () => ({
  rateLimitCheck: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetIn: 60 })
}))

// Mock data service - uses getMockStore() to always get current state
vi.mock('../services/dataService.js', () => {
  const loadData = vi.fn((file, defaultVal) => {
    const store = getMockStore()
    if (file === 'pinned-messages.json') return store.pinnedMessages
    if (file === 'messages.json') return store.messages
    if (file === 'channels.json') return store.channels
    if (file === 'servers.json') return store.servers
    return defaultVal || {}
  })

  const saveData = vi.fn(async (file, data) => {
    const store = getMockStore()
    if (file === 'pinned-messages.json') store.pinnedMessages = data
    return true
  })

  return {
    userService: {
      getUser: vi.fn((id) => {
        const store = getMockStore()
        return store.users[id] ? { ...store.users[id] } : null
      }),
      getAllUsers: vi.fn(() => {
        const store = getMockStore()
        return store.users
      })
    },
    channelService: {
      getChannel: vi.fn((id) => {
        const store = getMockStore()
        return store.channels[id] ? { ...store.channels[id] } : null
      }),
      getAllChannels: vi.fn(() => {
        const store = getMockStore()
        return Object.values(store.channels)
      })
    },
    serverService: {
      getServer: vi.fn((id) => {
        const store = getMockStore()
        return store.servers[id] ? { ...store.servers[id] } : null
      }),
      getServerChannels: vi.fn((serverId) => {
        const store = getMockStore()
        return Object.values(store.channels).filter(c => c.serverId === serverId)
      }),
      getAllServers: vi.fn(() => {
        const store = getMockStore()
        return Object.values(store.servers)
      })
    },
    messageService: {
      getMessages: vi.fn(() => []),
      saveMessage: vi.fn(() => true),
      getAllMessages: vi.fn(() => {
        const store = getMockStore()
        return store.messages
      })
    },
    fileService: {
      saveFile: vi.fn(),
      getFile: vi.fn()
    },
    FILES: {
      pinnedMessages: 'pinned-messages.json',
      messages: 'messages.json',
      channels: 'channels.json',
      servers: 'servers.json'
    },
    loadData,
    saveData,
    directQuery: vi.fn((query, params) => {
      const store = getMockStore()
      if (query.includes('SELECT * FROM pinned_messages')) {
        const channelId = params?.[0]
        if (channelId && store.pinnedMessages[channelId]) {
          return store.pinnedMessages[channelId]
        }
        return []
      }
      if (query.includes('SELECT * FROM messages')) {
        const messageId = params?.[0]
        const channelId = params?.[1]
        const msgs = store.messages[channelId] || []
        return msgs.filter(m => m.id === messageId)
      }
      return []
    }),
    supportsDirectQuery: vi.fn(() => false)
  }
})

vi.mock('../server.js', () => ({
  io: {
    to: vi.fn().mockReturnThis(),
    emit: vi.fn()
  }
}))

vi.mock('../services/socketService.js', () => ({
  isUserOnline: vi.fn(() => false),
  getBotSockets: vi.fn(() => [])
}))

vi.mock('../services/rateLimiter.js', () => ({
  default: {
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetIn: 60 }),
    checkMessageRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetIn: 60 }),
    checkHighFrequencyLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetIn: 60 }),
    checkCanvasRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetIn: 60 })
  }
}))

vi.mock('../middleware/authMiddleware.js', () => ({
  authenticateToken: (req, res, next) => {
    const authHeader = req.headers.authorization
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' })
    try {
      const token = authHeader.split(' ')[1]
      const decoded = jwt.verify(token, TEST_JWT_SECRET)
      req.user = decoded
      next()
    } catch {
      res.status(403).json({ error: 'Invalid token' })
    }
  }
}))

vi.mock('../utils/ageVerificationPolicy.js', () => ({
  normalizeAgeVerification: vi.fn((user) => user)
}))

// Import after all mocks
import channelRoutes from '../routes/channelRoutes.js'

const createToken = (userId, overrides = {}) => {
  return jwt.sign({
    userId,
    id: userId,
    username: `user_${userId}`,
    ...overrides
  }, TEST_JWT_SECRET, { expiresIn: '1h' })
}

const buildUser = (id, overrides = {}) => ({
  id,
  username: `user_${id}`,
  displayName: `User ${id}`,
  email: `${id}@test.local`,
  authProvider: 'local',
  isAdmin: false,
  isModerator: false,
  tokenVersion: 0,
  ...overrides
})

const buildChannel = (id, overrides = {}) => ({
  id,
  name: `channel-${id}`,
  type: 'text',
  serverId: TEST_SERVER_ID,
  ...overrides
})

const buildServer = (id, overrides = {}) => ({
  id,
  name: `Server ${id}`,
  ownerId: TEST_ADMIN_ID,
  roles: [
    { id: 'role_admin', name: 'Admin', permissions: ['admin', 'manage_messages', 'view_channels'] },
    { id: 'role_member', name: 'Member', permissions: ['view_channels'] }
  ],
  members: [
    { userId: TEST_ADMIN_ID, roleIds: ['role_admin'] },
    { userId: TEST_USER_ID, roleIds: ['role_member'] }
  ],
  ...overrides
})

const buildMessage = (id, overrides = {}) => ({
  id,
  channelId: TEST_CHANNEL_ID,
  userId: TEST_USER_ID,
  username: 'testuser',
  content: 'Test message',
  timestamp: new Date().toISOString(),
  pinned: false,
  ...overrides
})

describe('Pinned Messages API', () => {
  let app

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.JWT_SECRET = TEST_JWT_SECRET
    process.env.NODE_ENV = 'test'

    // Reset mock store using setMockStore
    setMockStore({
      users: {
        [TEST_USER_ID]: buildUser(TEST_USER_ID),
        [TEST_ADMIN_ID]: buildUser(TEST_ADMIN_ID, { isAdmin: true })
      },
      channels: {
        [TEST_CHANNEL_ID]: buildChannel(TEST_CHANNEL_ID)
      },
      servers: {
        [TEST_SERVER_ID]: buildServer(TEST_SERVER_ID)
      },
      messages: {
        [TEST_CHANNEL_ID]: []
      },
      pinnedMessages: {}
    })

    app = express()
    app.use(express.json())
    app.use('/api/channels', channelRoutes)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /:channelId/pins - Get Pinned Messages', () => {
    it('should return 404 for non-existent channel', async () => {
      setMockStore({ ...getMockStore(), channels: {} })
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .get('/api/channels/non_existent/pins')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Channel not found')
    })

    it('should return 403 when user cannot view channel', async () => {
      const store = getMockStore()
      store.servers[TEST_SERVER_ID].members = [{ userId: TEST_ADMIN_ID, roleIds: ['role_admin'] }]
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .get(`/api/channels/${TEST_CHANNEL_ID}/pins`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Cannot view channel')
    })

    it('should return 451 for NSFW channel without age verification', async () => {
      const store = getMockStore()
      store.channels[TEST_CHANNEL_ID].nsfw = true
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .get(`/api/channels/${TEST_CHANNEL_ID}/pins`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(451)
      expect(res.body.code).toBe('AGE_VERIFICATION_REQUIRED')
    })

    it('should return empty array when no pinned messages', async () => {
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .get(`/api/channels/${TEST_CHANNEL_ID}/pins`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('should return pinned messages for channel', async () => {
      const pinnedMsg = buildMessage(TEST_MESSAGE_ID, { pinned: true, pinnedAt: new Date().toISOString(), pinnedBy: TEST_USER_ID })
      const store = getMockStore()
      store.pinnedMessages = { [TEST_CHANNEL_ID]: [pinnedMsg] }
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .get(`/api/channels/${TEST_CHANNEL_ID}/pins`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].id).toBe(TEST_MESSAGE_ID)
      expect(res.body[0]).toHaveProperty('pinnedAt')
    })

    it('should not expose sensitive fields in response', async () => {
      const pinnedMsg = buildMessage(TEST_MESSAGE_ID, {
        pinned: true,
        pinnedAt: new Date().toISOString(),
        pinnedBy: TEST_USER_ID,
        passwordHash: 'secret',
        webhookSecret: 'secret'
      })
      const store = getMockStore()
      store.pinnedMessages = { [TEST_CHANNEL_ID]: [pinnedMsg] }
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .get(`/api/channels/${TEST_CHANNEL_ID}/pins`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body[0]).not.toHaveProperty('passwordHash')
      expect(res.body[0]).not.toHaveProperty('webhookSecret')
    })
  })

  describe('PUT /:channelId/pins/:messageId - Pin Message', () => {
    it('should return 404 for non-existent channel', async () => {
      setMockStore({ ...getMockStore(), channels: {} })
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .put(`/api/channels/non_existent/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
    })

    it('should return 404 for non-existent message', async () => {
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Message not found')
    })

    it('should return 400 for deleted message', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID, { deleted: true })
      const store = getMockStore()
      store.messages = { [TEST_CHANNEL_ID]: [msg] }
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Cannot pin deleted message')
    })

    it('should return 403 when user lacks permission to pin', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID)
      const store = getMockStore()
      store.messages = { [TEST_CHANNEL_ID]: [msg] }
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Not authorized to pin this message')
    })

    it('should return 400 when message already pinned', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID)
      const store = getMockStore()
      store.messages = { [TEST_CHANNEL_ID]: [msg] }
      store.pinnedMessages = { [TEST_CHANNEL_ID]: [{ ...msg, pinnedAt: new Date().toISOString(), pinnedBy: TEST_ADMIN_ID }] }
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Message already pinned')
    })

    it('should allow admin to pin message', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID)
      const store = getMockStore()
      store.messages = { [TEST_CHANNEL_ID]: [msg] }
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('should allow message author to pin their own message', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID, { userId: TEST_USER_ID })
      const store = getMockStore()
      store.messages = { [TEST_CHANNEL_ID]: [msg] }
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('should return 404 when pinning message from different channel', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID, { channelId: 'other_channel' })
      const store = getMockStore()
      store.messages = { [TEST_CHANNEL_ID]: [], other_channel: [msg] }
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /:channelId/pins/:messageId - Unpin Message', () => {
    it('should return 404 for non-existent channel', async () => {
      setMockStore({ ...getMockStore(), channels: {} })
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .delete(`/api/channels/non_existent/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
    })

    it('should return 404 when no pinned messages in channel', async () => {
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .delete(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('No pinned messages in this channel')
    })

    it('should return 404 when pinned message not found', async () => {
      const otherMsg = buildMessage('other_msg', { pinnedAt: new Date().toISOString(), pinnedBy: TEST_ADMIN_ID })
      const store = getMockStore()
      store.pinnedMessages = { [TEST_CHANNEL_ID]: [otherMsg] }
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .delete(`/api/channels/${TEST_CHANNEL_ID}/pins/non_existent`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Pinned message not found')
    })

    it('should return 403 when user lacks permission to unpin', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID, { userId: TEST_ADMIN_ID, pinnedAt: new Date().toISOString(), pinnedBy: TEST_ADMIN_ID })
      const store = getMockStore()
      store.pinnedMessages = { [TEST_CHANNEL_ID]: [msg] }
      store.servers[TEST_SERVER_ID].members = [{ userId: TEST_ADMIN_ID, roleIds: ['role_admin'] }]
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .delete(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Cannot view channel')
    })

    it('should allow admin to unpin message', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID, { userId: TEST_ADMIN_ID, pinnedAt: new Date().toISOString(), pinnedBy: TEST_ADMIN_ID })
      const store = getMockStore()
      store.pinnedMessages = { [TEST_CHANNEL_ID]: [msg] }
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .delete(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('should allow message author to unpin their own message', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID, {
        userId: TEST_USER_ID,
        pinnedAt: new Date().toISOString(),
        pinnedBy: TEST_USER_ID
      })
      const store = getMockStore()
      store.pinnedMessages = { [TEST_CHANNEL_ID]: [msg] }
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .delete(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })
  })

  describe('Error Handling - Prevent 500 Errors', () => {
    it('should handle loadPinnedMessages errors gracefully for GET', async () => {
      const { loadData } = await import('../services/dataService.js')
      loadData.mockImplementationOnce(() => { throw new Error('DB error') })
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .get(`/api/channels/${TEST_CHANNEL_ID}/pins`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).not.toBe(500)
    })

    it('should handle savePinnedMessages errors gracefully for PUT', async () => {
      const msg = buildMessage(TEST_MESSAGE_ID)
      const store = getMockStore()
      store.messages = { [TEST_CHANNEL_ID]: [msg] }
      const { saveData } = await import('../services/dataService.js')
      saveData.mockImplementationOnce(() => { throw new Error('DB error') })
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/${TEST_MESSAGE_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).not.toBe(500)
    })

    it('should handle invalid channelId format', async () => {
      const token = createToken(TEST_USER_ID)

      const res = await request(app)
        .get('/api/channels/invalid!!/pins')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
    })

    it('should handle invalid messageId format', async () => {
      const token = createToken(TEST_ADMIN_ID)

      const res = await request(app)
        .put(`/api/channels/${TEST_CHANNEL_ID}/pins/invalid!!`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(400)
    })
  })
})
