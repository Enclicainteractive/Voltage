import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as crypto from './cryptoService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const E2E_FILE = path.join(DATA_DIR, 'e2e-keys.json')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const loadData = (defaultValue = {}) => {
  try {
    if (fs.existsSync(E2E_FILE)) {
      return JSON.parse(fs.readFileSync(E2E_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[E2E] Error loading data:', err.message)
  }
  return defaultValue
}

const saveData = (data) => {
  try {
    fs.writeFileSync(E2E_FILE, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error('[E2E] Error saving data:', err.message)
    return false
  }
}

export const e2eService = {
  getServerKeys(serverId) {
    const data = loadData()
    return data.servers?.[serverId] || null
  },

  createServerKeys(serverId) {
    const data = loadData()
    
    const symmetricKey = crypto.generateSymmetricKey()
    const keyId = crypto.generateKeyIdentifier()
    
    if (!data.servers) data.servers = {}
    data.servers[serverId] = {
      keyId,
      symmetricKey: symmetricKey.toString('base64'),
      enabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      memberKeys: {}
    }
    
    saveData(data)
    return data.servers[serverId]
  },

  getOrCreateServerKeys(serverId) {
    let keys = this.getServerKeys(serverId)
    if (!keys) {
      keys = this.createServerKeys(serverId)
    }
    return keys
  },

  enableServerEncryption(serverId) {
    const data = loadData()
    if (!data.servers?.[serverId]) {
      return this.createServerKeys(serverId)
    }
    
    data.servers[serverId].enabled = true
    data.servers[serverId].updatedAt = new Date().toISOString()
    saveData(data)
    return data.servers[serverId]
  },

  disableServerEncryption(serverId) {
    const data = loadData()
    if (!data.servers?.[serverId]) {
      return null
    }
    
    data.servers[serverId].enabled = false
    data.servers[serverId].updatedAt = new Date().toISOString()
    saveData(data)
    return data.servers[serverId]
  },

  getSymmetricKey(serverId) {
    const keys = this.getServerKeys(serverId)
    if (!keys) return null
    return keys.symmetricKey ? Buffer.from(keys.symmetricKey, 'base64') : null
  },

  isEncryptionEnabled(serverId) {
    const keys = this.getServerKeys(serverId)
    return keys?.enabled || false
  },

  getMemberEncryptedKeys(serverId) {
    const keys = this.getServerKeys(serverId)
    return keys?.memberKeys || {}
  },

  setMemberEncryptedKey(serverId, userId, encryptedKey) {
    const data = loadData()
    
    if (!data.servers?.[serverId]) {
      this.createServerKeys(serverId)
    }
    
    if (!data.servers[serverId].memberKeys) {
      data.servers[serverId].memberKeys = {}
    }
    
    data.servers[serverId].memberKeys[userId] = {
      encryptedKey,
      timestamp: new Date().toISOString()
    }
    
    saveData(data)
    return true
  },

  removeMemberKey(serverId, userId) {
    const data = loadData()
    if (data.servers?.[serverId]?.memberKeys?.[userId]) {
      delete data.servers[serverId].memberKeys[userId]
      saveData(data)
    }
    return true
  },

  rotateServerKey(serverId) {
    const data = loadData()
    if (!data.servers?.[serverId]) {
      return this.createServerKeys(serverId)
    }
    
    const newSymmetricKey = crypto.generateSymmetricKey()
    const newKeyId = crypto.generateKeyIdentifier()
    
    data.servers[serverId].symmetricKey = newSymmetricKey.toString('base64')
    data.servers[serverId].keyId = newKeyId
    data.servers[serverId].updatedAt = new Date().toISOString()
    data.servers[serverId].memberKeys = {}
    
    saveData(data)
    return data.servers[serverId]
  },

  deleteServerKeys(serverId) {
    const data = loadData()
    if (data.servers?.[serverId]) {
      delete data.servers[serverId]
      saveData(data)
    }
    return true
  }
}

export const dmE2eService = {
  getDmKeys(conversationId) {
    const data = loadData()
    return data.dms?.[conversationId] || null
  },

  createDmKeys(conversationId) {
    const data = loadData()
    
    if (!data.dms) data.dms = {}
    
    const symmetricKey = crypto.generateSymmetricKey()
    const keyId = crypto.generateKeyIdentifier()
    
    data.dms[conversationId] = {
      keyId,
      symmetricKey: symmetricKey.toString('base64'),
      enabled: false,
      participants: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    saveData(data)
    return data.dms[conversationId]
  },

  getOrCreateDmKeys(conversationId) {
    let keys = this.getDmKeys(conversationId)
    if (!keys) {
      keys = this.createDmKeys(conversationId)
    }
    return keys
  },

  enableDmEncryption(conversationId) {
    const data = loadData()
    
    if (!data.dms?.[conversationId]) {
      return this.createDmKeys(conversationId)
    }
    
    data.dms[conversationId].enabled = true
    data.dms[conversationId].updatedAt = new Date().toISOString()
    saveData(data)
    return data.dms[conversationId]
  },

  disableDmEncryption(conversationId) {
    const data = loadData()
    if (!data.dms?.[conversationId]) {
      return null
    }
    
    data.dms[conversationId].enabled = false
    data.dms[conversationId].updatedAt = new Date().toISOString()
    saveData(data)
    return data.dms[conversationId]
  },

  isDmEncryptionEnabled(conversationId) {
    const keys = this.getDmKeys(conversationId)
    return keys?.enabled || false
  },

  getDmSymmetricKey(conversationId) {
    const keys = this.getDmKeys(conversationId)
    if (!keys) return null
    return keys.symmetricKey ? Buffer.from(keys.symmetricKey, 'base64') : null
  },

  setParticipantEncryptedKey(conversationId, userId, encryptedKey) {
    const data = loadData()
    
    if (!data.dms?.[conversationId]) {
      this.createDmKeys(conversationId)
    }
    
    if (!data.dms[conversationId].participants) {
      data.dms[conversationId].participants = {}
    }
    
    data.dms[conversationId].participants[userId] = {
      encryptedKey,
      timestamp: new Date().toISOString()
    }
    
    saveData(data)
    return true
  },

  getParticipantKeys(conversationId) {
    const keys = this.getDmKeys(conversationId)
    return keys?.participants || {}
  },

  rotateDmKey(conversationId) {
    const data = loadData()
    if (!data.dms?.[conversationId]) {
      return this.createDmKeys(conversationId)
    }
    
    const newSymmetricKey = crypto.generateSymmetricKey()
    const newKeyId = crypto.generateKeyIdentifier()
    
    data.dms[conversationId].symmetricKey = newSymmetricKey.toString('base64')
    data.dms[conversationId].keyId = newKeyId
    data.dms[conversationId].updatedAt = new Date().toISOString()
    data.dms[conversationId].participants = {}
    
    saveData(data)
    return data.dms[conversationId]
  },

  deleteDmKeys(conversationId) {
    const data = loadData()
    if (data.dms?.[conversationId]) {
      delete data.dms[conversationId]
      saveData(data)
    }
    return true
  }
}

export const userKeyService = {
  getUserKeys(userId) {
    const data = loadData()
    return data.users?.[userId] || null
  },

  saveUserKeys(userId, keys) {
    const data = loadData()
    
    if (!data.users) data.users = {}
    
    data.users[userId] = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      keyId: crypto.generateKeyIdentifier(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    saveData(data)
    return data.users[userId]
  },

  updateUserKeys(userId, updates) {
    const data = loadData()
    if (!data.users?.[userId]) {
      return null
    }
    
    data.users[userId] = {
      ...data.users[userId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    
    saveData(data)
    return data.users[userId]
  },

  deleteUserKeys(userId) {
    const data = loadData()
    if (data.users?.[userId]) {
      delete data.users[userId]
      saveData(data)
    }
    return true
  },

  getUserPublicKey(userId) {
    const keys = this.getUserKeys(userId)
    return keys?.publicKey || null
  }
}
