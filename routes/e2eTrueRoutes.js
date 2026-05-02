import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { e2eTrueService } from '../services/e2eTrueService.js'
import { io } from '../server.js'
import { serverService } from '../services/dataService.js'

const router = express.Router()

const getServers = () => {
  try {
    const data = serverService.getAllServers()
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') return Object.values(data)
  } catch (err) {
    console.error('[E2E-True] Failed to load servers for access check:', err?.message)
  }
  return []
}

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

const isServerOwner = (server, userId) => Boolean(server?.ownerId && server.ownerId === userId)

const getServerById = (serverId) => getServers().find(server => server?.id === serverId) || null

const sharesAtLeastOneServer = (userA, userB) => {
  if (!userA || !userB) return false
  if (userA === userB) return true
  return getServers().some(server => isServerMember(server, userA) && isServerMember(server, userB))
}

const requireGroupAccess = (req, res, { ownerOnly = false } = {}) => {
  const groupId = req.params.groupId
  const server = getServerById(groupId)

  if (!server || !isServerMember(server, req.user.id)) {
    res.status(404).json({ error: 'Group not found' })
    return null
  }

  if (ownerOnly && !isServerOwner(server, req.user.id)) {
    res.status(403).json({ error: 'Only server owner can modify group membership' })
    return null
  }

  return server
}

const userCanAccessDeviceDirectory = (requesterId, targetUserId) => {
  if (!requesterId || !targetUserId) return false
  if (requesterId === targetUserId) return true
  return sharesAtLeastOneServer(requesterId, targetUserId)
}

// === Device Key Management ===

// Upload device key bundle (client publishes public keys only)
router.post('/devices/keys', authenticateToken, async (req, res) => {
  const { deviceId, identityPublicKey, signedPreKey, signedPreKeySignature, oneTimePreKeys } = req.body

  if (!deviceId || !identityPublicKey || !signedPreKey) {
    return res.status(400).json({ error: 'deviceId, identityPublicKey, and signedPreKey are required' })
  }

  await e2eTrueService.uploadDeviceKeyBundle(req.user.id, deviceId, {
    identityPublicKey,
    signedPreKey,
    signedPreKeySignature,
    oneTimePreKeys: oneTimePreKeys || []
  })

  console.log(`[E2E-True] Device key bundle uploaded: user=${req.user.id} device=${deviceId}`)
  res.json({ success: true })
})

// Get a user's device key bundle (for establishing pairwise sessions)
router.get('/devices/keys/:userId/:deviceId', authenticateToken, async (req, res) => {
  const { userId, deviceId } = req.params
  if (!userCanAccessDeviceDirectory(req.user.id, userId)) {
    return res.status(404).json({ error: 'Device key bundle not found' })
  }

  const bundle = await e2eTrueService.getDeviceKeyBundle(userId, deviceId)
  if (!bundle) return res.status(404).json({ error: 'Device key bundle not found' })
  res.json(bundle)
})

// List all devices for a user
router.get('/devices/:userId', authenticateToken, async (req, res) => {
  const { userId } = req.params
  if (!userCanAccessDeviceDirectory(req.user.id, userId)) {
    return res.status(404).json({ error: 'Devices not found' })
  }

  const devices = await e2eTrueService.getUserDevices(userId)
  if (req.user.id === userId) {
    return res.json((devices || []).map(d => ({
      deviceId: d.deviceId,
      uploadedAt: d.uploadedAt || null
    })))
  }

  res.json((devices || []).map(d => ({ deviceId: d.deviceId })))
})

// Remove a device
router.delete('/devices/:deviceId', authenticateToken, async (req, res) => {
  await e2eTrueService.removeDevice(req.user.id, req.params.deviceId)
  res.json({ success: true })
})

// === Group E2EE Epoch Management ===

// Get current epoch for a group/server
router.get('/groups/:groupId/epoch', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res)
  if (!server) return

  const epoch = await e2eTrueService.getGroupEpoch(req.params.groupId)
  if (!epoch) return res.json({ epoch: null })
  // Only return metadata, never key material
  res.json({
    groupId: epoch.groupId,
    epoch: epoch.epoch,
    memberCount: Array.isArray(epoch.members) ? epoch.members.length : 0,
    lastRotationReason: epoch.lastRotationReason
  })
})

// Initialize group E2EE (client creates group and distributes keys)
router.post('/groups/:groupId/init', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res, { ownerOnly: true })
  if (!server) return

  const { deviceId } = req.body
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' })

  const existing = await e2eTrueService.getGroupEpoch(req.params.groupId)
  if (existing) {
    if (!Array.isArray(existing.members) || !existing.members.includes(req.user.id)) {
      return res.status(404).json({ error: 'Group not found' })
    }
    return res.json({
      groupId: existing.groupId,
      epoch: existing.epoch,
      memberCount: Array.isArray(existing.members) ? existing.members.length : 0,
      lastRotationReason: existing.lastRotationReason
    })
  }

  const epoch = await e2eTrueService.createGroupEpoch(req.params.groupId, req.user.id, deviceId)
  console.log(`[E2E-True] Group initialized: ${req.params.groupId} by ${req.user.id}`)
  res.json({
    groupId: epoch.groupId,
    epoch: epoch.epoch,
    memberCount: Array.isArray(epoch.members) ? epoch.members.length : 0
  })
})

// Advance epoch (triggered by client after key rotation)
router.post('/groups/:groupId/advance-epoch', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res)
  if (!server) return

  const { reason } = req.body
  const epoch = await e2eTrueService.advanceEpoch(req.params.groupId, reason || 'manual', req.user.id)
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
router.post('/groups/:groupId/members', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res, { ownerOnly: true })
  if (!server) return

  const { userId, deviceIds } = req.body
  if (!userId) return res.status(400).json({ error: 'userId required' })
  if (!isServerMember(server, userId)) {
    return res.status(400).json({ error: 'User is not a member of this server' })
  }

  const userDevices = await e2eTrueService.getUserDevices(userId)
  const devices = deviceIds || userDevices.map(d => d.deviceId)
  const group = await e2eTrueService.addMemberToGroup(req.params.groupId, userId, devices)
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
router.delete('/groups/:groupId/members/:userId', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res, { ownerOnly: true })
  if (!server) return

  const group = await e2eTrueService.removeMemberFromGroup(req.params.groupId, req.params.userId)
  if (!group) return res.status(404).json({ error: 'Group not found' })

  // Advance epoch since a member left
  await e2eTrueService.advanceEpoch(req.params.groupId, 'member_removed', req.user.id)

  io.to(`server:${req.params.groupId}`).emit('e2e:member-removed', {
    groupId: req.params.groupId,
    userId: req.params.userId
  })

  res.json({ success: true })
})

// Get group members (to know who to distribute keys to)
router.get('/groups/:groupId/members', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res)
  if (!server) return

  const members = await e2eTrueService.getGroupMembers(req.params.groupId)
  res.json(Array.isArray(members) ? members : [])
})

// === Encrypted Sender Key Distribution ===

// Store encrypted sender key for a specific device (opaque to server)
router.post('/groups/:groupId/sender-keys', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res)
  if (!server) return

  const { epoch, toUserId, toDeviceId, encryptedKeyBlob, fromDeviceId } = req.body
  if (!epoch || !toUserId || !toDeviceId || !encryptedKeyBlob || !fromDeviceId) {
    return res.status(400).json({ error: 'epoch, toUserId, toDeviceId, fromDeviceId, and encryptedKeyBlob are required' })
  }

  const members = await e2eTrueService.getGroupMembers(req.params.groupId)
  if (Array.isArray(members) && members.length > 0 && !members.includes(toUserId)) {
    return res.status(403).json({ error: 'Recipient is not a member of this group' })
  }

  await e2eTrueService.storeEncryptedSenderKey(
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
router.post('/groups/:groupId/sender-keys/distribute', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res)
  if (!server) return

  const { epoch, fromDeviceId, keys } = req.body
  // keys = [{ toUserId, toDeviceId, encryptedKeyBlob }, ...]

  if (!epoch || !fromDeviceId || !Array.isArray(keys)) {
    return res.status(400).json({ error: 'epoch, fromDeviceId, and keys array are required' })
  }

  const members = await e2eTrueService.getGroupMembers(req.params.groupId)
  const allowedMembers = new Set(Array.isArray(members) ? members : [])

  let distributed = 0
  for (const k of keys) {
    if (!k?.toUserId || !k?.toDeviceId || !k?.encryptedKeyBlob) {
      return res.status(400).json({ error: 'Each key entry must include toUserId, toDeviceId, and encryptedKeyBlob' })
    }
    if (allowedMembers.size > 0 && !allowedMembers.has(k.toUserId)) {
      return res.status(403).json({ error: 'One or more recipients are not group members' })
    }

    await e2eTrueService.storeEncryptedSenderKey(
      req.params.groupId, epoch,
      req.user.id, fromDeviceId,
      k.toUserId, k.toDeviceId,
      k.encryptedKeyBlob
    )

    // Queue for offline devices
    await e2eTrueService.queueKeyUpdate(k.toUserId, k.toDeviceId, {
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

// Request sender keys from group members (relay only - server never sees key content)
router.post('/groups/:groupId/sender-keys/request', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res)
  if (!server) return

  const { deviceId } = req.body
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' })

  const members = await e2eTrueService.getGroupMembers(req.params.groupId)
  if (!members || members.length === 0) {
    return res.status(404).json({ error: 'Group not found or has no members' })
  }

  // Relay key request to all other group members via socket
  io.to(`server:${req.params.groupId}`).emit('e2e:sender-key-request', {
    groupId: req.params.groupId,
    requestingUserId: req.user.id,
    requestingDeviceId: deviceId
  })

  res.json({ success: true, message: 'Key request relayed to group members' })
})

// Fetch sender keys for my device
router.get('/groups/:groupId/sender-keys/:epoch', authenticateToken, async (req, res) => {
  const server = requireGroupAccess(req, res)
  if (!server) return

  const { deviceId } = req.query
  if (!deviceId) return res.status(400).json({ error: 'deviceId query param required' })

  const keys = await e2eTrueService.getEncryptedSenderKeys(
    req.params.groupId,
    parseInt(req.params.epoch),
    req.user.id,
    deviceId
  )

  res.json(keys)
})

// === Queued Updates (for when device comes back online) ===

// Fetch all queued key updates for my device
router.get('/queue/key-updates', authenticateToken, async (req, res) => {
  const { deviceId } = req.query
  if (!deviceId) return res.status(400).json({ error: 'deviceId query param required' })

  const updates = await e2eTrueService.dequeueKeyUpdates(req.user.id, deviceId)
  res.json(updates)
})

// Fetch queued encrypted messages for my device
router.get('/queue/messages', authenticateToken, async (req, res) => {
  const { deviceId, limit } = req.query
  if (!deviceId) return res.status(400).json({ error: 'deviceId query param required' })

  const messages = await e2eTrueService.dequeueEncryptedMessages(req.user.id, deviceId, parseInt(limit) || 100)
  res.json(messages)
})

// === Safety Numbers ===

// Compute safety number between two identity keys
router.post('/safety-number', authenticateToken, async (req, res) => {
  const { myIdentityKey, theirIdentityKey } = req.body
  if (!myIdentityKey || !theirIdentityKey) {
    return res.status(400).json({ error: 'Both identity keys required' })
  }

  const safetyNumber = await e2eTrueService.computeSafetyNumber(myIdentityKey, theirIdentityKey)
  res.json({ safetyNumber })
})

export default router
