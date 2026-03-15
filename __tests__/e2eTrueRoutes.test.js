import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mock dependencies
vi.mock('../services/e2eTrueService.js', () => ({
  e2eTrueService: {
    uploadDeviceKeyBundle: vi.fn().mockResolvedValue(true),
    getDeviceKeyBundle: vi.fn().mockResolvedValue({
      identityPublicKey: 'mock-public-key',
      signedPreKey: 'mock-signed-pre-key',
      signedPreKeySignature: 'mock-signature',
      oneTimePreKey: null
    }),
    getUserDevices: vi.fn().mockResolvedValue([
      { deviceId: 'device1', identityPublicKey: 'key1' }
    ]),
    removeDevice: vi.fn().mockResolvedValue(true),
    getGroupEpoch: vi.fn().mockResolvedValue({
      groupId: 'test-group',
      epoch: 1,
      members: ['user1', 'user2'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }),
    createGroupEpoch: vi.fn().mockResolvedValue({
      groupId: 'test-group',
      epoch: 1,
      members: ['user1'],
      createdAt: new Date().toISOString()
    }),
    advanceEpoch: vi.fn().mockResolvedValue({
      groupId: 'test-group',
      epoch: 2,
      updatedAt: new Date().toISOString()
    }),
    addMemberToGroup: vi.fn().mockResolvedValue({
      groupId: 'test-group',
      members: ['user1', 'user2']
    }),
    removeMemberFromGroup: vi.fn().mockResolvedValue({
      groupId: 'test-group',
      members: ['user1']
    }),
    getGroupMembers: vi.fn().mockResolvedValue(['user1', 'user2']),
    storeEncryptedSenderKey: vi.fn().mockResolvedValue(true),
    getEncryptedSenderKeys: vi.fn().mockResolvedValue([]),
    queueKeyUpdate: vi.fn().mockResolvedValue(true),
    dequeueKeyUpdates: vi.fn().mockResolvedValue([]),
    dequeueEncryptedMessages: vi.fn().mockResolvedValue([]),
    computeSafetyNumber: vi.fn().mockReturnValue('12345 67890')
  }
}))

vi.mock('../server.js', () => ({
  io: {
    to: vi.fn().mockReturnThis(),
    emit: vi.fn()
  }
}))

vi.mock('../middleware/authMiddleware.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 'test-user-id' }
    next()
  }
}))

// Import after mocks
import e2eTrueRoutes from '../routes/e2eTrueRoutes.js'
import { e2eTrueService } from '../services/e2eTrueService.js'

describe('E2E-True Routes - Server-Agnostic Security Model', () => {
  let app

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use('/e2e-true', e2eTrueRoutes)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // === Device Key Management Tests ===

  describe('POST /devices/keys - Upload Device Key Bundle', () => {
    it('should accept device key bundle with valid data', async () => {
      const response = await request(app)
        .post('/e2e-true/devices/keys')
        .send({
          deviceId: 'device1',
          identityPublicKey: 'mock-public-key',
          signedPreKey: 'mock-signed-pre-key',
          signedPreKeySignature: 'mock-signature'
        })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
    })

    it('should reject request without required fields', async () => {
      const response = await request(app)
        .post('/e2e-true/devices/keys')
        .send({ deviceId: 'device1' })

      expect(response.status).toBe(400)
      expect(response.body.error).toContain('required')
    })
  })

  describe('GET /devices/keys/:userId/:deviceId - Get Device Key Bundle', () => {
    it('should return device key bundle', async () => {
      const response = await request(app)
        .get('/e2e-true/devices/keys/user1/device1')

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('identityPublicKey')
      expect(response.body).toHaveProperty('signedPreKey')
    })

    it('should return 404 for non-existent device', async () => {
      e2eTrueService.getDeviceKeyBundle.mockResolvedValueOnce(null)
      
      const response = await request(app)
        .get('/e2e-true/devices/keys/user1/invalid-device')

      expect(response.status).toBe(404)
    })
  })

  describe('GET /devices/:userId - List User Devices', () => {
    it('should return list of user devices', async () => {
      const response = await request(app)
        .get('/e2e-true/devices/user1')

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    })
  })

  describe('DELETE /devices/:deviceId - Remove Device', () => {
    it('should remove device successfully', async () => {
      const response = await request(app)
        .delete('/e2e-true/devices/device1')

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
    })
  })

  // === Group E2EE Epoch Management Tests ===

  describe('GET /groups/:groupId/epoch - Get Group Epoch', () => {
    it('should return epoch metadata without key material', async () => {
      const response = await request(app)
        .get('/e2e-true/groups/test-group/epoch')

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('epoch')
      expect(response.body).toHaveProperty('members')
      expect(response.body).not.toHaveProperty('senderKey')
      expect(response.body).not.toHaveProperty('encryptionKey')
    })

    it('should return null for non-existent group', async () => {
      e2eTrueService.getGroupEpoch.mockResolvedValueOnce(null)
      
      const response = await request(app)
        .get('/e2e-true/groups/non-existent-group/epoch')

      expect(response.status).toBe(200)
      expect(response.body.epoch).toBeNull()
    })
  })

  describe('POST /groups/:groupId/init - Initialize Group E2EE', () => {
    it('should create new epoch for group', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/new-group/init')
        .send({ deviceId: 'device1' })

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('epoch')
    })

    it('should reject request without deviceId', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/new-group/init')
        .send({})

      expect(response.status).toBe(400)
      expect(response.body.error).toContain('deviceId')
    })

    it('should return existing epoch if group already initialized', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/init')
        .send({ deviceId: 'device1' })

      expect(response.status).toBe(200)
    })
  })

  describe('POST /groups/:groupId/advance-epoch - Advance Epoch', () => {
    it('should advance epoch and notify members', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/advance-epoch')
        .send({ reason: 'manual' })

      expect(response.status).toBe(200)
      expect(response.body.epoch).toBeDefined()
    })

    it('should return 404 for non-existent group', async () => {
      e2eTrueService.advanceEpoch.mockResolvedValueOnce(null)
      
      const response = await request(app)
        .post('/e2e-true/groups/non-existent/advance-epoch')
        .send({ reason: 'test' })

      expect(response.status).toBe(404)
    })
  })

  describe('POST /groups/:groupId/members - Add Member', () => {
    it('should add member to group', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/members')
        .send({ userId: 'new-user', deviceIds: ['device1'] })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
    })

    it('should reject request without userId', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/members')
        .send({})

      expect(response.status).toBe(400)
    })
  })

  describe('DELETE /groups/:groupId/members/:userId - Remove Member', () => {
    it('should remove member and trigger epoch advance', async () => {
      const response = await request(app)
        .delete('/e2e-true/groups/test-group/members/user2')

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(e2eTrueService.advanceEpoch).toHaveBeenCalled()
    })
  })

  describe('GET /groups/:groupId/members - Get Group Members', () => {
    it('should return list of group members', async () => {
      const response = await request(app)
        .get('/e2e-true/groups/test-group/members')

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    })
  })

  // === Sender Key Distribution Tests ===

  describe('POST /groups/:groupId/sender-keys - Store Encrypted Sender Key', () => {
    it('should store encrypted key blob (opaque to server)', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/sender-keys')
        .send({
          epoch: 1,
          toUserId: 'user2',
          toDeviceId: 'device1',
          encryptedKeyBlob: 'encrypted-blob-data',
          fromDeviceId: 'device1'
        })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
    })

    it('should reject request without required fields', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/sender-keys')
        .send({ epoch: 1 })

      expect(response.status).toBe(400)
    })

    it('should NEVER decrypt or access the encrypted key blob', async () => {
      await request(app)
        .post('/e2e-true/groups/test-group/sender-keys')
        .send({
          epoch: 1,
          toUserId: 'user2',
          toDeviceId: 'device1',
          encryptedKeyBlob: 'ENCRYPTED_DATA_SERVER_CANNOT_READ',
          fromDeviceId: 'device1'
        })

      // Verify the service was called with the blob as-is
      expect(e2eTrueService.storeEncryptedSenderKey).toHaveBeenCalledWith(
        'test-group', 1,
        'test-user-id', 'device1',
        'user2', 'device1',
        'ENCRYPTED_DATA_SERVER_CANNOT_READ'
      )
    })
  })

  describe('POST /groups/:groupId/sender-keys/distribute - Batch Distribute', () => {
    it('should distribute keys to multiple recipients', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/sender-keys/distribute')
        .send({
          epoch: 1,
          fromDeviceId: 'device1',
          keys: [
            { toUserId: 'user2', toDeviceId: 'device1', encryptedKeyBlob: 'blob1' },
            { toUserId: 'user3', toDeviceId: 'device1', encryptedKeyBlob: 'blob2' }
          ]
        })

      expect(response.status).toBe(200)
      expect(response.body.distributed).toBe(2)
    })

    it('should reject invalid keys array', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/sender-keys/distribute')
        .send({
          epoch: 1,
          fromDeviceId: 'device1',
          keys: 'not-an-array'
        })

      expect(response.status).toBe(400)
    })
  })

  describe('GET /groups/:groupId/sender-keys/:epoch - Fetch Sender Keys', () => {
    it('should return encrypted key blobs for device', async () => {
      e2eTrueService.getEncryptedSenderKeys.mockResolvedValueOnce([
        { encryptedKeyBlob: 'blob1', fromUserId: 'user1' }
      ])

      const response = await request(app)
        .get('/e2e-true/groups/test-group/sender-keys/1')
        .query({ deviceId: 'device1' })

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    })

    it('should require deviceId query param', async () => {
      const response = await request(app)
        .get('/e2e-true/groups/test-group/sender-keys/1')

      expect(response.status).toBe(400)
      expect(response.body.error).toContain('deviceId')
    })
  })

  describe('POST /groups/:groupId/sender-keys/request - Request Sender Keys', () => {
    it('should relay key request to existing members', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/sender-keys/request')
        .send({ deviceId: 'device1' })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
    })

    it('should reject request without deviceId', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/sender-keys/request')
        .send({})

      expect(response.status).toBe(400)
    })

    it('should relay request without accessing key content', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/sender-keys/request')
        .send({ deviceId: 'device1' })

      // Verify the server only relays - it doesn't process keys
      expect(response.body.message).toContain('relayed')
    })
  })

  // === Queued Updates Tests ===

  describe('GET /queue/key-updates - Get Queued Key Updates', () => {
    it('should return queued key updates', async () => {
      const response = await request(app)
        .get('/e2e-true/queue/key-updates')
        .query({ deviceId: 'device1' })

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    })

    it('should require deviceId', async () => {
      const response = await request(app)
        .get('/e2e-true/queue/key-updates')

      expect(response.status).toBe(400)
    })
  })

  describe('GET /queue/messages - Get Queued Messages', () => {
    it('should return queued messages', async () => {
      const response = await request(app)
        .get('/e2e-true/queue/messages')
        .query({ deviceId: 'device1' })

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    })

    it('should accept limit parameter', async () => {
      const response = await request(app)
        .get('/e2e-true/queue/messages')
        .query({ deviceId: 'device1', limit: 50 })

      expect(response.status).toBe(200)
    })
  })

  // === Safety Number Tests ===

  describe('POST /safety-number - Compute Safety Number', () => {
    it('should compute safety number between two keys', async () => {
      const response = await request(app)
        .post('/e2e-true/safety-number')
        .send({
          myIdentityKey: 'my-key',
          theirIdentityKey: 'their-key'
        })

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('safetyNumber')
    })

    it('should reject request without both keys', async () => {
      const response = await request(app)
        .post('/e2e-true/safety-number')
        .send({ myIdentityKey: 'only-one' })

      expect(response.status).toBe(400)
    })
  })
})

describe('E2E-True Routes - Security Model Verification', () => {
  let app

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use('/e2e-true', e2eTrueRoutes)
    vi.clearAllMocks()
  })

  describe('Server Never Sees Keys', () => {
    it('sender keys are stored as opaque blobs', async () => {
      const ENCRYPTED_KEY = 'base64encryptedkeyblobthattheservercannotdecrypt'
      
      await request(app)
        .post('/e2e-true/groups/test-group/sender-keys')
        .send({
          epoch: 1,
          toUserId: 'recipient',
          toDeviceId: 'device1',
          encryptedKeyBlob: ENCRYPTED_KEY,
          fromDeviceId: 'device1'
        })

      // The service should receive the blob as-is
      expect(e2eTrueService.storeEncryptedSenderKey).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Number),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        ENCRYPTED_KEY // Must be the encrypted blob, not decrypted
      )
    })

    it('epoch endpoint never returns encryption keys', async () => {
      const response = await request(app)
        .get('/e2e-true/groups/test-group/epoch')

      const forbiddenKeys = ['key', 'secret', 'senderKey', 'encryptionKey', 'sharedKey']
      for (const key of forbiddenKeys) {
        expect(response.body).not.toHaveProperty(key)
      }
    })

    it('member list endpoint only returns user IDs', async () => {
      const response = await request(app)
        .get('/e2e-true/groups/test-group/members')

      // Should be array of strings, not objects with keys
      expect(Array.isArray(response.body)).toBe(true)
      if (response.body.length > 0) {
        expect(typeof response.body[0]).toBe('string')
      }
    })
  })

  describe('Key Request Relay', () => {
    it('request endpoint relays to members without processing', async () => {
      const response = await request(app)
        .post('/e2e-true/groups/test-group/sender-keys/request')
        .send({ deviceId: 'new-device' })

      // Server should relay via socket, not handle the key exchange
      expect(response.body.message).toContain('relayed')
    })
  })
})
