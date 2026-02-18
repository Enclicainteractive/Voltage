import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { e2eTrueService } from '../services/e2eTrueService.js'
import { io } from '../server.js'

const router = express.Router()

// === Device Key Management ===

// Upload device key bundle (client publishes public keys only)
router.post('/devices/keys', authenticateToken, (req, res) => {
  const { deviceId, identityPublicKey, signedPreKey, signedPreKeySignature, oneTimePreKeys } = req.body

  if (!deviceId || !identityPublicKey || !signedPreKey) {
    return res.status(400).json({ error: 'deviceId, identityPublicKey, and signedPreKey are required' })
  }

  e2eTrueService.uploadDeviceKeyBundle(req.user.id, deviceId, {
    identityPublicKey,
    signedPreKey,
    signedPreKeySignature,
    oneTimePreKeys: oneTimePreKeys || []
  })

  console.log(`[E2E-True] Device key bundle uploaded: user=${req.user.id} device=${deviceId}`)
  res.json({ success: true })
})

// Get a user's device key bundle (for establishing pairwise sessions)
router.get('/devices/keys/:userId/:deviceId', authenticateToken, (req, res) => {
  const bundle = e2eTrueService.getDeviceKeyBundle(req.params.userId, req.params.deviceId)
  if (!bundle) return res.status(404).json({ error: 'Device key bundle not found' })
  res.json(bundle)
})

// List all devices for a user
router.get('/devices/:userId', authenticateToken, (req, res) => {
  const devices = e2eTrueService.getUserDevices(req.params.userId)
  res.json(devices)
})

// Remove a device
router.delete('/devices/:deviceId', authenticateToken, (req, res) => {
  e2eTrueService.removeDevice(req.user.id, req.params.deviceId)
  res.json({ success: true })
})

// === Group E2EE Epoch Management ===

// Get current epoch for a group/server
router.get('/groups/:groupId/epoch', authenticateToken, (req, res) => {
  const epoch = e2eTrueService.getGroupEpoch(req.params.groupId)
  if (!epoch) return res.json({ epoch: null })
  // Only return metadata, never key material
  res.json({
    groupId: epoch.groupId,
    epoch: epoch.epoch,
    members: epoch.members,
    createdAt: epoch.createdAt,
    updatedAt: epoch.updatedAt,
    lastRotationReason: epoch.lastRotationReason
  })
})

// Initialize group E2EE (client creates group and distributes keys)
router.post('/groups/:groupId/init', authenticateToken, (req, res) => {
  const { deviceId } = req.body
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' })

  const existing = e2eTrueService.getGroupEpoch(req.params.groupId)
  if (existing) return res.json(existing)

  const epoch = e2eTrueService.createGroupEpoch(req.params.groupId, req.user.id, deviceId)
  console.log(`[E2E-True] Group initialized: ${req.params.groupId} by ${req.user.id}`)
  res.json(epoch)
})

// Advance epoch (triggered by client after key rotation)
router.post('/groups/:groupId/advance-epoch', authenticateToken, (req, res) => {
  const { reason } = req.body
  const epoch = e2eTrueService.advanceEpoch(req.params.groupId, reason || 'manual', req.user.id)
  if (!epoch) return res.status(404).json({ error: 'Group not found' })

  // Notify all group members about the epoch change
  io.to(`server:${req.params.groupId}`).emit('e2e:epoch-advanced', {
    groupId: req.params.groupId,
    epoch: epoch.epoch,
    reason: reason || 'manual',
    triggeredBy: req.user.id
  })

  console.log(`[E2E-True] Epoch advanced: group=${req.params.groupId} epoch=${epoch.epoch} reason=${reason}`)
  res.json({ epoch: epoch.epoch })
})

// Add member to group (triggers epoch advance on client side)
router.post('/groups/:groupId/members', authenticateToken, (req, res) => {
  const { userId, deviceIds } = req.body
  if (!userId) return res.status(400).json({ error: 'userId required' })

  const devices = deviceIds || e2eTrueService.getUserDevices(userId).map(d => d.deviceId)
  const group = e2eTrueService.addMemberToGroup(req.params.groupId, userId, devices)
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // Notify existing members
  io.to(`server:${req.params.groupId}`).emit('e2e:member-added', {
    groupId: req.params.groupId,
    userId,
    deviceIds: devices
  })

  res.json({ success: true })
})

// Remove member from group (triggers epoch advance + rekey)
router.delete('/groups/:groupId/members/:userId', authenticateToken, (req, res) => {
  const group = e2eTrueService.removeMemberFromGroup(req.params.groupId, req.params.userId)
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // Advance epoch since a member left
  e2eTrueService.advanceEpoch(req.params.groupId, 'member_removed', req.user.id)

  io.to(`server:${req.params.groupId}`).emit('e2e:member-removed', {
    groupId: req.params.groupId,
    userId: req.params.userId
  })

  res.json({ success: true })
})

// Get group members (to know who to distribute keys to)
router.get('/groups/:groupId/members', authenticateToken, (req, res) => {
  const members = e2eTrueService.getGroupMembers(req.params.groupId)
  res.json(members)
})

// === Encrypted Sender Key Distribution ===

// Store encrypted sender key for a specific device (opaque to server)
router.post('/groups/:groupId/sender-keys', authenticateToken, (req, res) => {
  const { epoch, toUserId, toDeviceId, encryptedKeyBlob, fromDeviceId } = req.body
  if (!epoch || !toUserId || !toDeviceId || !encryptedKeyBlob || !fromDeviceId) {
    return res.status(400).json({ error: 'epoch, toUserId, toDeviceId, fromDeviceId, and encryptedKeyBlob are required' })
  }

  e2eTrueService.storeEncryptedSenderKey(
    req.params.groupId, epoch,
    req.user.id, fromDeviceId,
    toUserId, toDeviceId,
    encryptedKeyBlob
  )

  // If recipient is online, notify them immediately
  io.to(`user:${toUserId}`).emit('e2e:sender-key-available', {
    groupId: req.params.groupId,
    epoch,
    fromUserId: req.user.id,
    fromDeviceId
  })

  res.json({ success: true })
})

// Batch distribute sender keys to all devices in a group
router.post('/groups/:groupId/sender-keys/distribute', authenticateToken, (req, res) => {
  const { epoch, fromDeviceId, keys } = req.body
  // keys = [{ toUserId, toDeviceId, encryptedKeyBlob }, ...]

  if (!epoch || !fromDeviceId || !Array.isArray(keys)) {
    return res.status(400).json({ error: 'epoch, fromDeviceId, and keys array are required' })
  }

  let distributed = 0
  for (const k of keys) {
    e2eTrueService.storeEncryptedSenderKey(
      req.params.groupId, epoch,
      req.user.id, fromDeviceId,
      k.toUserId, k.toDeviceId,
      k.encryptedKeyBlob
    )

    // Queue for offline devices
    e2eTrueService.queueKeyUpdate(k.toUserId, k.toDeviceId, {
      groupId: req.params.groupId,
      epoch,
      encryptedKeyBlob: k.encryptedKeyBlob,
      fromUserId: req.user.id,
      fromDeviceId
    })

    io.to(`user:${k.toUserId}`).emit('e2e:sender-key-available', {
      groupId: req.params.groupId,
      epoch,
      fromUserId: req.user.id,
      fromDeviceId
    })

    distributed++
  }

  res.json({ success: true, distributed })
})

// Fetch sender keys for my device
router.get('/groups/:groupId/sender-keys/:epoch', authenticateToken, (req, res) => {
  const { deviceId } = req.query
  if (!deviceId) return res.status(400).json({ error: 'deviceId query param required' })

  const keys = e2eTrueService.getEncryptedSenderKeys(
    req.params.groupId,
    parseInt(req.params.epoch),
    req.user.id,
    deviceId
  )

  res.json(keys)
})

// === Queued Updates (for when device comes back online) ===

// Fetch all queued key updates for my device
router.get('/queue/key-updates', authenticateToken, (req, res) => {
  const { deviceId } = req.query
  if (!deviceId) return res.status(400).json({ error: 'deviceId query param required' })

  const updates = e2eTrueService.dequeueKeyUpdates(req.user.id, deviceId)
  res.json(updates)
})

// Fetch queued encrypted messages for my device
router.get('/queue/messages', authenticateToken, (req, res) => {
  const { deviceId, limit } = req.query
  if (!deviceId) return res.status(400).json({ error: 'deviceId query param required' })

  const messages = e2eTrueService.dequeueEncryptedMessages(req.user.id, deviceId, parseInt(limit) || 100)
  res.json(messages)
})

// === Safety Numbers ===

// Compute safety number between two identity keys
router.post('/safety-number', authenticateToken, (req, res) => {
  const { myIdentityKey, theirIdentityKey } = req.body
  if (!myIdentityKey || !theirIdentityKey) {
    return res.status(400).json({ error: 'Both identity keys required' })
  }

  const safetyNumber = e2eTrueService.computeSafetyNumber(myIdentityKey, theirIdentityKey)
  res.json({ safetyNumber })
})

export default router
