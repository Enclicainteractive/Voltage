import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { e2eService, userKeyService, dmE2eService } from '../services/e2eService.js'
import { io } from '../server.js'
import * as crypto from '../services/cryptoService.js'
import { dmService, serverService } from '../services/dataService.js'

const getServers = () => {
  try {
    const data = serverService.getAllServers()
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') return Object.values(data)
  } catch (err) {
    console.error('[E2E] Failed to load servers for access check:', err?.message)
  }
  return []
}

const getServerById = (serverId) => getServers().find(s => s?.id === serverId) || null

const isServerMember = (server, userId) => {
  if (!server || !userId) return false
  if (server.ownerId === userId) return true
  const members = Array.isArray(server.members) ? server.members : []
  return members.some(member => {
    if (!member) return false
    if (typeof member === 'string') return member === userId
    return member.id === userId
  })
}

const getMemberAccessibleServer = (serverId, userId) => {
  const server = getServerById(serverId)
  if (!server) return null
  if (!isServerMember(server, userId)) return null
  return server
}

const getConversationForUser = (userId, conversationId) => {
  try {
    return dmService.getConversationForUser(userId, conversationId)
  } catch (err) {
    console.error('[E2E] Failed to resolve DM conversation access:', err?.message)
    return null
  }
}

const router = express.Router()

router.get('/status/:serverId', authenticateToken, (req, res) => {
  const { serverId } = req.params
  const server = getMemberAccessibleServer(serverId, req.user.id)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  const keys = e2eService.getServerKeys(serverId)
  
  if (!keys) {
    return res.json({ enabled: false })
  }
  
  res.json({
    enabled: keys.enabled,
    keyId: keys.keyId
  })
})

router.post('/enable/:serverId', authenticateToken, async (req, res) => {
  const { serverId } = req.params
  const server = getMemberAccessibleServer(serverId, req.user.id)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (server.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Only server owner can enable encryption' })
  }
  
  const keys = await e2eService.enableServerEncryption(serverId)
  
  io.to(`server:${serverId}`).emit('e2e:enabled', {
    serverId,
    keyId: keys.keyId
  })
  
  console.log(`[E2E] Encryption enabled on server ${serverId}`)
  res.json({
    enabled: true,
    keyId: keys.keyId
  })
})

router.post('/disable/:serverId', authenticateToken, async (req, res) => {
  const { serverId } = req.params
  const server = getMemberAccessibleServer(serverId, req.user.id)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (server.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Only server owner can disable encryption' })
  }
  
  await e2eService.disableServerEncryption(serverId)
  
  io.to(`server:${serverId}`).emit('e2e:disabled', {
    serverId
  })
  
  console.log(`[E2E] Encryption disabled on server ${serverId}`)
  res.json({ enabled: false })
})

router.post('/rotate/:serverId', authenticateToken, async (req, res) => {
  const { serverId } = req.params
  const server = getMemberAccessibleServer(serverId, req.user.id)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (server.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Only server owner can rotate encryption keys' })
  }
  
  if (!e2eService.isEncryptionEnabled(serverId)) {
    return res.status(400).json({ error: 'Encryption is not enabled on this server' })
  }
  
  const keys = await e2eService.rotateServerKey(serverId)
  
  io.to(`server:${serverId}`).emit('e2e:key-rotated', {
    serverId,
    keyId: keys.keyId
  })
  
  console.log(`[E2E] Keys rotated on server ${serverId}`)
  res.json({
    keyId: keys.keyId
  })
})

router.get('/keys/:serverId', authenticateToken, (req, res) => {
  const { serverId } = req.params
  const server = getMemberAccessibleServer(serverId, req.user.id)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!e2eService.isEncryptionEnabled(serverId)) {
    return res.status(400).json({ error: 'Encryption is not enabled on this server' })
  }
  
  const symmetricKey = e2eService.getSymmetricKey(serverId)
  if (!symmetricKey) {
    return res.status(500).json({ error: 'Encryption keys not found' })
  }
  
  const serverKeys = e2eService.getServerKeys(serverId)
  
  const userId = req.user.id
  const memberEncryptedKeys = serverKeys?.memberKeys || {}
  const userEncryptedKey = memberEncryptedKeys[userId]
  
  if (!userEncryptedKey) {
    return res.status(404).json({ error: 'No encrypted key found for user' })
  }
  
  res.json({
    keyId: serverKeys.keyId,
    encryptedKey: userEncryptedKey.encryptedKey
  })
})

router.post('/join/:serverId', authenticateToken, async (req, res) => {
  const { serverId } = req.params
  const { encryptedKey } = req.body
  const server = getMemberAccessibleServer(serverId, req.user.id)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!e2eService.isEncryptionEnabled(serverId)) {
    return res.status(400).json({ error: 'Encryption is not enabled on this server' })
  }
  
  if (!encryptedKey) {
    return res.status(400).json({ error: 'Encrypted key required' })
  }
  
  const userId = req.user.id
  await e2eService.setMemberEncryptedKey(serverId, userId, encryptedKey)
  
  io.to(`server:${serverId}`).emit('e2e:member-key-added', {
    serverId,
    userId
  })
  
  console.log(`[E2E] User ${userId} joined encryption on server ${serverId}`)
  res.json({ success: true })
})

router.get('/member-keys/:serverId', authenticateToken, (req, res) => {
  const { serverId } = req.params
  const server = getMemberAccessibleServer(serverId, req.user.id)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!e2eService.isEncryptionEnabled(serverId)) {
    return res.json({ enabled: false, members: [] })
  }
  
  const serverKeys = e2eService.getServerKeys(serverId)
  const memberKeys = serverKeys?.memberKeys || {}
  
  const membersWithKeys = Object.keys(memberKeys).map(userId => ({
    userId,
    hasKey: true
  }))
  
  res.json({
    enabled: true,
    keyId: serverKeys?.keyId,
    members: membersWithKeys
  })
})

router.get('/user/keys', authenticateToken, (req, res) => {
  const userId = req.user.id
  let keys = userKeyService.getUserKeys(userId)
  
  if (!keys) {
    const newKeys = crypto.generateKeyPair()
    keys = userKeyService.saveUserKeys(userId, newKeys)
    console.log(`[E2E] Generated new key pair for user ${userId}`)
  }
  
  res.json({
    publicKey: keys.publicKey,
    keyId: keys.keyId
  })
})

router.get('/user/keys/:serverId', authenticateToken, (req, res) => {
  const userId = req.user.id
  const { serverId } = req.params
  const server = getMemberAccessibleServer(serverId, userId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  let keys = userKeyService.getUserKeys(userId)
  
  if (!keys) {
    const newKeys = crypto.generateKeyPair()
    keys = userKeyService.saveUserKeys(userId, newKeys)
  }
  
  if (!e2eService.isEncryptionEnabled(serverId)) {
    return res.json({
      publicKey: keys.publicKey,
      keyId: keys.keyId,
      serverEncryptionEnabled: false
    })
  }
  
  const symmetricKey = e2eService.getSymmetricKey(serverId)
  if (!symmetricKey) {
    return res.status(500).json({ error: 'Server encryption keys not found' })
  }
  
  const encryptedKey = crypto.encryptKeyForUser(symmetricKey, keys.publicKey)
  
  res.json({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    serverEncryptionEnabled: true,
    encryptedKey
  })
})

router.post('/user/backup', authenticateToken, (req, res) => {
  const { password } = req.body
  
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }
  
  const userId = req.user.id
  const keys = userKeyService.getUserKeys(userId)
  
  if (!keys?.privateKey) {
    return res.status(404).json({ error: 'No keys found' })
  }
  
  const backup = crypto.exportKeyForBackup(keys.privateKey, password)
  
  res.json(backup)
})

router.post('/user/restore', authenticateToken, (req, res) => {
  const { backup, password } = req.body
  
  if (!backup || !password) {
    return res.status(400).json({ error: 'Backup data and password required' })
  }
  
  try {
    const privateKey = crypto.importKeyFromBackup(backup, password)
    
    const existingKeys = userKeyService.getUserKeys(req.user.id)
    if (existingKeys) {
      userKeyService.updateUserKeys(req.user.id, { privateKey })
    } else {
      const publicKey = crypto.generateKeyPair()
      publicKey.privateKey = privateKey
      userKeyService.saveUserKeys(req.user.id, {
        publicKey: publicKey.publicKey,
        privateKey
      })
    }
    
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: 'Invalid backup or password' })
  }
})

router.get('/dm/status/:conversationId', authenticateToken, (req, res) => {
  const { conversationId } = req.params
  const conversation = getConversationForUser(req.user.id, conversationId)
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }

  const keys = dmE2eService.getDmKeys(conversationId)
  
  if (!keys) {
    return res.json({ enabled: false })
  }
  
  res.json({
    enabled: keys.enabled,
    keyId: keys.keyId
  })
})

router.post('/dm/enable/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params
  const conversation = getConversationForUser(req.user.id, conversationId)
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  const keys = await dmE2eService.enableDmEncryption(conversationId)
  
  io.to(`dm:${conversationId}`).emit('e2e:dm-enabled', {
    conversationId,
    keyId: keys.keyId
  })
  
  console.log(`[E2E] DM encryption enabled on conversation ${conversationId}`)
  res.json({
    enabled: true,
    keyId: keys.keyId
  })
})

router.post('/dm/disable/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params
  const conversation = getConversationForUser(req.user.id, conversationId)
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  await dmE2eService.disableDmEncryption(conversationId)
  
  io.to(`dm:${conversationId}`).emit('e2e:dm-disabled', {
    conversationId
  })
  
  console.log(`[E2E] DM encryption disabled on conversation ${conversationId}`)
  res.json({ enabled: false })
})

router.get('/dm/keys/:conversationId', authenticateToken, (req, res) => {
  const { conversationId } = req.params
  const conversation = getConversationForUser(req.user.id, conversationId)
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  if (!dmE2eService.isDmEncryptionEnabled(conversationId)) {
    return res.status(400).json({ error: 'Encryption is not enabled for this DM' })
  }
  
  const symmetricKey = dmE2eService.getDmSymmetricKey(conversationId)
  if (!symmetricKey) {
    return res.status(500).json({ error: 'Encryption keys not found' })
  }
  
  const dmKeys = dmE2eService.getDmKeys(conversationId)
  const userId = req.user.id
  const participantKeys = dmKeys?.participants || {}
  const userEncryptedKey = participantKeys[userId]
  
  if (!userEncryptedKey) {
    return res.status(404).json({ error: 'No encrypted key found for user' })
  }
  
  res.json({
    keyId: dmKeys.keyId,
    encryptedKey: userEncryptedKey.encryptedKey
  })
})

router.post('/dm/join/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params
  const { encryptedKey } = req.body
  const conversation = getConversationForUser(req.user.id, conversationId)
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  if (!dmE2eService.isDmEncryptionEnabled(conversationId)) {
    return res.status(400).json({ error: 'Encryption is not enabled for this DM' })
  }
  
  if (!encryptedKey) {
    return res.status(400).json({ error: 'Encrypted key required' })
  }
  
  const userId = req.user.id
  await dmE2eService.setParticipantEncryptedKey(conversationId, userId, encryptedKey)
  
  io.to(`dm:${conversationId}`).emit('e2e:dm-member-key-added', {
    conversationId,
    userId
  })
  
  console.log(`[E2E] User ${userId} joined DM encryption on conversation ${conversationId}`)
  res.json({ success: true })
})

router.get('/dm/keys', authenticateToken, (req, res) => {
  const userId = req.user.id
  let keys = userKeyService.getUserKeys(userId)
  
  if (!keys) {
    const newKeys = crypto.generateKeyPair()
    keys = userKeyService.saveUserKeys(userId, newKeys)
  }
  
  res.json({
    publicKey: keys.publicKey,
    keyId: keys.keyId
  })
})

router.get('/dm/user-keys/:conversationId', authenticateToken, (req, res) => {
  const userId = req.user.id
  const { conversationId } = req.params
  const conversation = getConversationForUser(userId, conversationId)
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  let keys = userKeyService.getUserKeys(userId)
  
  if (!keys) {
    const newKeys = crypto.generateKeyPair()
    keys = userKeyService.saveUserKeys(userId, newKeys)
  }
  
  if (!dmE2eService.isDmEncryptionEnabled(conversationId)) {
    return res.json({
      publicKey: keys.publicKey,
      keyId: keys.keyId,
      dmEncryptionEnabled: false
    })
  }
  
  const symmetricKey = dmE2eService.getDmSymmetricKey(conversationId)
  if (!symmetricKey) {
    return res.status(500).json({ error: 'DM encryption keys not found' })
  }
  
  const encryptedKey = crypto.encryptKeyForUser(symmetricKey, keys.publicKey)
  
  res.json({
    publicKey: keys.publicKey,
    keyId: keys.keyId,
    dmEncryptionEnabled: true,
    encryptedKey
  })
})

router.post('/dm/rotate/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params
  const conversation = getConversationForUser(req.user.id, conversationId)
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  if (!dmE2eService.isDmEncryptionEnabled(conversationId)) {
    return res.status(400).json({ error: 'Encryption is not enabled for this DM' })
  }
  
  const keys = await dmE2eService.rotateDmKey(conversationId)
  
  io.to(`dm:${conversationId}`).emit('e2e:dm-key-rotated', {
    conversationId,
    keyId: keys.keyId
  })
  
  console.log(`[E2E] Keys rotated on DM conversation ${conversationId}`)
  res.json({
    keyId: keys.keyId
  })
})

export default router
