import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const E2E_TRUE_FILE = path.join(DATA_DIR, 'e2e-true.json')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const loadData = (defaultValue = {}) => {
  try {
    if (fs.existsSync(E2E_TRUE_FILE)) {
      return JSON.parse(fs.readFileSync(E2E_TRUE_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[E2E-True] Error loading data:', err.message)
  }
  return defaultValue
}

const saveData = (data) => {
  try {
    fs.writeFileSync(E2E_TRUE_FILE, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error('[E2E-True] Error saving data:', err.message)
    return false
  }
}

/*
  True E2EE Architecture:
  - Server NEVER stores or generates symmetric group keys
  - Server only stores opaque ciphertext blobs (encrypted key bundles, encrypted messages)
  - Key generation, distribution, and rotation are 100% client-driven
  - Server stores per-device identity public keys (uploaded by clients)
  - Server stores encrypted sender key bundles (encrypted by clients for each member's device)
  - Server manages epochs (version numbers) and queues encrypted key updates for offline devices
  - Server provides presence info (device online/offline) without seeing crypto state
*/

export const e2eTrueService = {
  // === Device Key Bundles (identity keys published by each device) ===

  uploadDeviceKeyBundle(userId, deviceId, keyBundle) {
    const data = loadData()
    if (!data.deviceKeys) data.deviceKeys = {}
    if (!data.deviceKeys[userId]) data.deviceKeys[userId] = {}

    // keyBundle contains ONLY public keys (identity, signed prekey, one-time prekeys)
    // The server never sees private keys
    data.deviceKeys[userId][deviceId] = {
      identityPublicKey: keyBundle.identityPublicKey,
      signedPreKey: keyBundle.signedPreKey,
      signedPreKeySignature: keyBundle.signedPreKeySignature,
      oneTimePreKeys: keyBundle.oneTimePreKeys || [],
      uploadedAt: new Date().toISOString()
    }

    saveData(data)
    return true
  },

  getDeviceKeyBundle(userId, deviceId) {
    const data = loadData()
    const bundle = data.deviceKeys?.[userId]?.[deviceId]
    if (!bundle) return null

    // Consume one one-time prekey if available
    let oneTimePreKey = null
    if (bundle.oneTimePreKeys?.length > 0) {
      oneTimePreKey = bundle.oneTimePreKeys.shift()
      saveData(data)
    }

    return {
      identityPublicKey: bundle.identityPublicKey,
      signedPreKey: bundle.signedPreKey,
      signedPreKeySignature: bundle.signedPreKeySignature,
      oneTimePreKey
    }
  },

  getUserDevices(userId) {
    const data = loadData()
    const devices = data.deviceKeys?.[userId]
    if (!devices) return []
    return Object.keys(devices).map(deviceId => ({
      deviceId,
      identityPublicKey: devices[deviceId].identityPublicKey,
      uploadedAt: devices[deviceId].uploadedAt
    }))
  },

  removeDevice(userId, deviceId) {
    const data = loadData()
    if (data.deviceKeys?.[userId]?.[deviceId]) {
      delete data.deviceKeys[userId][deviceId]
      saveData(data)
    }
    return true
  },

  // === Group E2EE Epochs (server tracks epoch numbers, not key material) ===

  getGroupEpoch(groupId) {
    const data = loadData()
    return data.groupEpochs?.[groupId] || null
  },

  createGroupEpoch(groupId, creatorUserId, creatorDeviceId) {
    const data = loadData()
    if (!data.groupEpochs) data.groupEpochs = {}

    const epoch = {
      groupId,
      epoch: 1,
      createdBy: creatorUserId,
      createdByDevice: creatorDeviceId,
      members: [creatorUserId],
      memberDevices: { [creatorUserId]: [creatorDeviceId] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    data.groupEpochs[groupId] = epoch
    saveData(data)
    return epoch
  },

  advanceEpoch(groupId, reason, triggerUserId) {
    const data = loadData()
    if (!data.groupEpochs?.[groupId]) return null

    data.groupEpochs[groupId].epoch += 1
    data.groupEpochs[groupId].updatedAt = new Date().toISOString()
    data.groupEpochs[groupId].lastRotationReason = reason
    data.groupEpochs[groupId].lastRotationBy = triggerUserId

    saveData(data)
    return data.groupEpochs[groupId]
  },

  addMemberToGroup(groupId, userId, deviceIds) {
    const data = loadData()
    if (!data.groupEpochs?.[groupId]) return null

    const group = data.groupEpochs[groupId]
    if (!group.members.includes(userId)) {
      group.members.push(userId)
    }
    if (!group.memberDevices) group.memberDevices = {}
    group.memberDevices[userId] = deviceIds || []
    group.updatedAt = new Date().toISOString()

    saveData(data)
    return group
  },

  removeMemberFromGroup(groupId, userId) {
    const data = loadData()
    if (!data.groupEpochs?.[groupId]) return null

    const group = data.groupEpochs[groupId]
    group.members = group.members.filter(m => m !== userId)
    delete group.memberDevices?.[userId]
    group.updatedAt = new Date().toISOString()

    saveData(data)
    return group
  },

  getGroupMembers(groupId) {
    const data = loadData()
    const group = data.groupEpochs?.[groupId]
    if (!group) return []
    return group.members
  },

  // === Encrypted Sender Key Distribution (opaque blobs, server cannot read) ===

  storeEncryptedSenderKey(groupId, epoch, fromUserId, fromDeviceId, toUserId, toDeviceId, encryptedKeyBlob) {
    const data = loadData()
    if (!data.senderKeys) data.senderKeys = {}
    const key = `${groupId}:${epoch}`
    if (!data.senderKeys[key]) data.senderKeys[key] = []

    data.senderKeys[key].push({
      id: `sk_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      fromUserId,
      fromDeviceId,
      toUserId,
      toDeviceId,
      encryptedKeyBlob, // opaque - server cannot decrypt
      epoch,
      createdAt: new Date().toISOString()
    })

    saveData(data)
    return true
  },

  getEncryptedSenderKeys(groupId, epoch, toUserId, toDeviceId) {
    const data = loadData()
    const key = `${groupId}:${epoch}`
    const all = data.senderKeys?.[key] || []
    return all.filter(sk => sk.toUserId === toUserId && sk.toDeviceId === toDeviceId)
  },

  // === Queued Key Updates for Offline Devices ===

  queueKeyUpdate(toUserId, toDeviceId, update) {
    const data = loadData()
    if (!data.keyUpdateQueue) data.keyUpdateQueue = {}
    const key = `${toUserId}:${toDeviceId}`
    if (!data.keyUpdateQueue[key]) data.keyUpdateQueue[key] = []

    data.keyUpdateQueue[key].push({
      id: `ku_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      ...update, // groupId, epoch, encryptedKeyBlob, fromUserId, fromDeviceId
      queuedAt: new Date().toISOString()
    })

    saveData(data)
    return true
  },

  dequeueKeyUpdates(toUserId, toDeviceId) {
    const data = loadData()
    const key = `${toUserId}:${toDeviceId}`
    const updates = data.keyUpdateQueue?.[key] || []

    if (updates.length > 0) {
      data.keyUpdateQueue[key] = []
      saveData(data)
    }

    return updates
  },

  // === Encrypted Message Queue (for offline devices) ===

  queueEncryptedMessage(toUserId, toDeviceId, message) {
    const data = loadData()
    if (!data.messageQueue) data.messageQueue = {}
    const key = `${toUserId}:${toDeviceId}`
    if (!data.messageQueue[key]) data.messageQueue[key] = []

    data.messageQueue[key].push({
      id: `mq_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      ciphertext: message.ciphertext, // opaque blob
      groupId: message.groupId,
      channelId: message.channelId,
      epoch: message.epoch,
      senderId: message.senderId,
      senderDeviceId: message.senderDeviceId,
      timestamp: message.timestamp || new Date().toISOString()
    })

    saveData(data)
    return true
  },

  dequeueEncryptedMessages(toUserId, toDeviceId, limit = 100) {
    const data = loadData()
    const key = `${toUserId}:${toDeviceId}`
    const messages = (data.messageQueue?.[key] || []).slice(0, limit)

    if (messages.length > 0) {
      data.messageQueue[key] = (data.messageQueue[key] || []).slice(limit)
      saveData(data)
    }

    return messages
  },

  // === Safety Numbers (for key verification between users) ===

  computeSafetyNumber(identityKey1, identityKey2) {
    // Deterministic ordering so both sides compute the same number
    const keys = [identityKey1, identityKey2].sort()
    const hash = crypto.createHash('sha256').update(keys[0] + keys[1]).digest('hex')
    // Format as groups of 5 digits
    const nums = []
    for (let i = 0; i < hash.length; i += 5) {
      nums.push(parseInt(hash.substr(i, 5), 16) % 100000)
    }
    return nums.slice(0, 8).map(n => n.toString().padStart(5, '0')).join(' ')
  },

  // === Cleanup ===

  deleteGroupData(groupId) {
    const data = loadData()
    if (data.groupEpochs?.[groupId]) delete data.groupEpochs[groupId]

    // Clean sender keys for all epochs of this group
    if (data.senderKeys) {
      for (const key of Object.keys(data.senderKeys)) {
        if (key.startsWith(`${groupId}:`)) {
          delete data.senderKeys[key]
        }
      }
    }

    saveData(data)
    return true
  },

  deleteUserData(userId) {
    const data = loadData()
    if (data.deviceKeys?.[userId]) delete data.deviceKeys[userId]

    // Clean queues
    if (data.keyUpdateQueue) {
      for (const key of Object.keys(data.keyUpdateQueue)) {
        if (key.startsWith(`${userId}:`)) delete data.keyUpdateQueue[key]
      }
    }
    if (data.messageQueue) {
      for (const key of Object.keys(data.messageQueue)) {
        if (key.startsWith(`${userId}:`)) delete data.messageQueue[key]
      }
    }

    saveData(data)
    return true
  }
}

export default e2eTrueService
