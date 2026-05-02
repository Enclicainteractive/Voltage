import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const TEST_JWT_SECRET = 'security-regression-test-secret'
const TEST_USER_ID = 'u_security_tester'

const mockState = vi.hoisted(() => ({
  users: {},
  publicBots: [],
  files: {}
}))

vi.mock('../services/dataService.js', () => {
  const userService = {
    getUser: vi.fn((id) => {
      const user = mockState.users[id]
      return user ? { ...user } : null
    }),
    getAllUsers: vi.fn(() => mockState.users),
    updateProfile: vi.fn(async (id, updates) => {
      const current = mockState.users[id]
      if (!current) return null
      const merged = { ...current, ...updates }
      mockState.users[id] = merged
      return { ...merged }
    }),
    saveUser: vi.fn(async (id, profile) => {
      mockState.users[id] = { ...profile }
      return { ...mockState.users[id] }
    }),
    getCachedUser: vi.fn(async () => null)
  }

  const fileService = {
    saveFile: vi.fn((file) => {
      if (file?.id) mockState.files[file.id] = { ...file }
    }),
    getFile: vi.fn((id) => {
      const file = mockState.files[id]
      return file ? { ...file } : null
    }),
    deleteFile: vi.fn((id) => {
      delete mockState.files[id]
      return true
    }),
    getUserFiles: vi.fn((userId) => Object.values(mockState.files).filter((f) => f.uploadedBy === userId))
  }

  return {
    userService,
    fileService,
    adminService: {
      isAdmin: vi.fn(() => false),
      isModerator: vi.fn(() => false)
    },
    friendService: {
      areFriends: vi.fn(() => false),
      getFriends: vi.fn(() => [])
    },
    friendRequestService: {
      getPendingRequestsForUser: vi.fn(() => []),
      getSentRequestsByUser: vi.fn(() => [])
    },
    blockService: {
      isBlocked: vi.fn(() => false),
      getBlockedUsers: vi.fn(() => [])
    },
    serverService: {
      getAllServers: vi.fn(() => []),
      getServer: vi.fn(() => null),
      updateServer: vi.fn(async () => true)
    },
    channelService: {
      getChannel: vi.fn(() => null)
    },
    messageService: {
      getMessages: vi.fn(() => []),
      saveMessage: vi.fn(() => true)
    },
    FILES: {},
    directQuery: vi.fn(async () => []),
    supportsDirectQuery: vi.fn(() => false),
    saveData: vi.fn(async () => true),
    default: {}
  }
})

vi.mock('../services/socketService.js', () => ({
  isUserOnline: vi.fn(() => false),
  getBotSockets: vi.fn(() => [])
}))

vi.mock('../services/botService.js', () => {
  const botService = {
    getAllPublicBots: vi.fn(async () => mockState.publicBots),
    getBotByToken: vi.fn(async () => null),
    getBot: vi.fn(async () => null),
    getBotsByOwner: vi.fn(async () => []),
    createBot: vi.fn(async () => null),
    updateBot: vi.fn(async () => null),
    deleteBot: vi.fn(async () => false),
    regenerateToken: vi.fn(async () => null),
    addBotToServer: vi.fn(async () => true),
    removeBotFromServer: vi.fn(async () => true),
    getServerBots: vi.fn(async () => []),
    getBotCommands: vi.fn(async () => []),
    hasPermission: vi.fn(async () => false)
  }
  return {
    botService,
    default: botService
  }
})

vi.mock('../server.js', () => ({
  io: {
    to: vi.fn().mockReturnThis(),
    emit: vi.fn()
  }
}))

vi.mock('../routes/channelRoutes.js', () => ({
  addMessage: vi.fn(async () => ({})),
  loadMessages: vi.fn(() => []),
  pendingMessageWrites: new Map(),
  scheduleMessageFlush: vi.fn()
}))

import authRoutes from '../routes/authRoutes.js'
import userRoutes from '../routes/userRoutes.js'
import botRoutes from '../routes/botRoutes.js'
import uploadRoutes from '../routes/uploadRoutes.js'
import { userService } from '../services/dataService.js'

const createBearerToken = (overrides = {}) => {
  const user = mockState.users[TEST_USER_ID]
  const tokenVersion = overrides.tokenVersion ?? user?.tokenVersion ?? 0

  return jwt.sign({
    userId: TEST_USER_ID,
    id: TEST_USER_ID,
    sub: TEST_USER_ID,
    username: overrides.username || user?.username || 'security_tester',
    email: overrides.email || user?.email || 'security@test.local',
    host: overrides.host || user?.host || 'localhost',
    displayName: overrides.displayName || user?.displayName || 'Security Tester',
    tokenVersion,
    sessionVersion: tokenVersion,
    ...overrides
  }, TEST_JWT_SECRET, { expiresIn: '1h' })
}

const buildDefaultUser = () => ({
  id: TEST_USER_ID,
  username: 'security_tester',
  displayName: 'Security Tester',
  email: 'security@test.local',
  host: 'localhost',
  authProvider: 'local',
  isAdmin: false,
  isModerator: false,
  tokenVersion: 0,
  sessionVersion: 0,
  passwordHash: '$2b$12$fakehash',
  mfaSecret: 'never-leak-me',
  webhookSecret: 'also-secret',
  sessionSecret: 'session-secret'
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.JWT_SECRET = TEST_JWT_SECRET
  process.env.NODE_ENV = 'test'
  mockState.users = {
    [TEST_USER_ID]: buildDefaultUser()
  }
  mockState.publicBots = []
  mockState.files = {}
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Security Regression Coverage', () => {
  it('keeps /api/auth/logout available and revokes the current token version', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRoutes)

    const token = createBearerToken()

    const beforeLogout = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)

    expect(beforeLogout.status).toBe(200)

    const logoutResponse = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)

    expect(logoutResponse.status).toBe(200)
    expect(logoutResponse.body.message).toBe('Logged out successfully')
    expect(userService.updateProfile).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ tokenVersion: 1, sessionVersion: 1 })
    )

    const afterLogout = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)

    expect(afterLogout.status).toBe(403)
    expect(afterLogout.body.error).toMatch(/revoked|invalid|expired/i)
  })

  it('never exposes passwordHash or secret fields on /api/auth/me', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRoutes)

    const token = createBearerToken()
    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.body).not.toHaveProperty('passwordHash')
    expect(response.body).not.toHaveProperty('password')
    expect(response.body).not.toHaveProperty('mfaSecret')
    expect(response.body).not.toHaveProperty('webhookSecret')
    expect(response.body).not.toHaveProperty('sessionSecret')
    expect(response.body).toHaveProperty('id', TEST_USER_ID)
  })

  it('never exposes passwordHash or secret fields on /api/user/me', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/user', userRoutes)

    const token = createBearerToken({
      passwordHash: 'token-side-secret',
      mfaSecret: 'token-side-mfa'
    })

    const response = await request(app)
      .get('/api/user/me')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.body).not.toHaveProperty('passwordHash')
    expect(response.body).not.toHaveProperty('password')
    expect(response.body).not.toHaveProperty('mfaSecret')
    expect(response.body).not.toHaveProperty('webhookSecret')
    expect(response.body).not.toHaveProperty('sessionSecret')
    expect(response.body).toHaveProperty('id', TEST_USER_ID)
  })

  it('bootstraps a missing user profile from a valid token instead of rejecting as invalid payload', async () => {
    mockState.users = {}

    const app = express()
    app.use(express.json())
    app.use('/api/user', userRoutes)

    const token = createBearerToken({
      username: 'bootstrap_user',
      displayName: 'Bootstrap User',
      email: 'bootstrap@test.local',
      host: 'localhost',
      tokenVersion: 0,
      sessionVersion: 0
    })

    const response = await request(app)
      .get('/api/user/me')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('id', TEST_USER_ID)
    expect(userService.saveUser).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        id: TEST_USER_ID,
        username: 'bootstrap_user',
        adminRole: null,
        isAdmin: 0,
        isModerator: 0
      })
    )
  })

  it('sanitizes /api/bots/public/browse projection to hide owner/server footprint fields', async () => {
    mockState.publicBots = [
      {
        id: 'bot_public_1',
        name: 'Public Bot',
        description: 'safe bot',
        public: true,
        avatar: null,
        prefix: '!',
        createdAt: '2026-04-01T00:00:00.000Z',
        ownerId: 'owner_123',
        installedServers: ['server_1', 'server_2'],
        servers: ['server_1', 'server_2'],
        permissions: ['messages:send'],
        intents: ['guilds'],
        commands: [{ name: 'ping' }],
        webhookUrl: 'https://bot.example/hook',
        webhookSecret: 'super-secret',
        token: 'plain-token',
        tokenHash: 'hashed-token',
        updatedAt: '2026-04-02T00:00:00.000Z',
        lastActive: '2026-04-03T00:00:00.000Z'
      }
    ]

    const app = express()
    app.use(express.json())
    app.use('/api/bots', botRoutes)

    const token = createBearerToken()
    const response = await request(app)
      .get('/api/bots/public/browse')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(Array.isArray(response.body)).toBe(true)
    expect(response.body).toHaveLength(1)

    const bot = response.body[0]
    expect(bot).toHaveProperty('id', 'bot_public_1')
    expect(bot).not.toHaveProperty('ownerId')
    expect(bot).not.toHaveProperty('installedServers')
    expect(bot).not.toHaveProperty('servers')
    expect(bot).not.toHaveProperty('permissions')
    expect(bot).not.toHaveProperty('intents')
    expect(bot).not.toHaveProperty('commands')
    expect(bot).not.toHaveProperty('webhookUrl')
    expect(bot).not.toHaveProperty('webhookSecret')
    expect(bot).not.toHaveProperty('token')
    expect(bot).not.toHaveProperty('tokenHash')
  })

  it('blocks html-like upload content types', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/upload', uploadRoutes)
    app.use((err, _req, res, _next) => {
      res.status(400).json({ error: err.message })
    })

    const token = createBearerToken()
    const response = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'xss-proof.html',
        contentType: 'text/html'
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/blocked upload type/i)
  })

  it('serves uploaded files with safe download headers', async () => {
    const app = express()
    app.use('/api/upload', uploadRoutes)

    const filename = `security-regression-${Date.now()}.html`
    const uploadsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')
    const filePath = path.join(uploadsDir, filename)

    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(filePath, '<html><body>unsafe if inline</body></html>', 'utf8')

    try {
      const response = await request(app).get(`/api/upload/file/${filename}`)

      expect(response.status).toBe(200)
      expect(response.headers['content-disposition']).toMatch(/^attachment;/i)
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['cross-origin-resource-policy']).toBe('same-origin')
      expect(response.headers['content-security-policy']).toContain("default-src 'none'")
      expect(response.headers['content-type']).toContain('application/octet-stream')
    } finally {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    }
  })
})
