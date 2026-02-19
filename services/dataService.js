import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

export const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  friends: path.join(DATA_DIR, 'friends.json'),
  friendRequests: path.join(DATA_DIR, 'friend-requests.json'),
  dms: path.join(DATA_DIR, 'dms.json'),
  dmMessages: path.join(DATA_DIR, 'dm-messages.json'),
  servers: path.join(DATA_DIR, 'servers.json'),
  channels: path.join(DATA_DIR, 'channels.json'),
  messages: path.join(DATA_DIR, 'messages.json'),
  reactions: path.join(DATA_DIR, 'reactions.json'),
  serverInvites: path.join(DATA_DIR, 'server-invites.json'),
  blocked: path.join(DATA_DIR, 'blocked.json'),
  files: path.join(DATA_DIR, 'files.json'),
  attachments: path.join(DATA_DIR, 'attachments.json'),
  discovery: path.join(DATA_DIR, 'discovery.json'),
  globalBans: path.join(DATA_DIR, 'global-bans.json'),
  adminLogs: path.join(DATA_DIR, 'admin-logs.json'),
  systemMessages: path.join(DATA_DIR, 'system-messages.json')
}

let storageService = null
let useStorage = false
let storageCache = {}
let cacheDirty = {}

const initStorage = async () => {
  try {
    const storageModule = await import('./storageService.js')
    storageService = storageModule.initStorage()
    useStorage = storageService && storageService.type !== 'json'
    
    if (useStorage) {
      console.log('[DataService] Using storage layer:', storageService.type)
      await loadAllData()
    } else {
      console.log('[DataService] Using file-based storage')
    }
  } catch (err) {
    console.error('[DataService] Storage initialization error:', err.message)
    useStorage = false
  }
}

const loadAllData = async () => {
  if (!useStorage || !storageService) return
  
  const tables = [
    'users', 'friends', 'friend_requests', 'servers', 'channels',
    'messages', 'server_members', 'invites', 'dms', 'dm_messages',
    'reactions', 'blocked', 'files', 'attachments', 'discovery',
    'global_bans', 'admin_logs'
  ]
  
  for (const table of tables) {
    try {
      if (storageService.load) {
        if (storageService.type === 'mongodb' || storageService.type === 'redis' || 
            storageService.type?.startsWith('mysql') || storageService.type?.startsWith('postgres') ||
            storageService.type === 'cockroachdb' || storageService.type === 'mssql') {
          storageCache[table] = await storageService.load(table, {})
        } else {
          storageCache[table] = storageService.load(table, {})
        }
      }
    } catch (err) {
      console.error(`[DataService] Error loading ${table}:`, err.message)
      storageCache[table] = {}
    }
  }
}

const saveToStorage = async (table, data) => {
  if (!useStorage || !storageService) return
  
  try {
    if (storageService.type === 'mongodb' || storageService.type === 'redis' || 
        storageService.type?.startsWith('mysql') || storageService.type?.startsWith('postgres') ||
        storageService.type === 'cockroachdb' || storageService.type === 'mssql') {
      await storageService.save(table, data)
    } else {
      storageService.save(table, data)
    }
  } catch (err) {
    console.error(`[DataService] Error saving ${table}:`, err.message)
  }
}

const loadData = (file, defaultValue = {}) => {
  if (useStorage) {
    return storageCache[file] || defaultValue
  }
  
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (err) {
    console.error(`[Data] Error loading ${file}:`, err.message)
  }
  return defaultValue
}

const saveData = (file, data) => {
  if (useStorage) {
    storageCache[file] = data
    saveToStorage(file, data)
    return true
  }
  
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error(`[Data] Error saving ${file}:`, err.message)
    return false
  }
}

const getTableName = (file) => {
  const fileMap = {
    [FILES.users]: 'users',
    [FILES.friends]: 'friends',
    [FILES.friendRequests]: 'friend_requests',
    [FILES.servers]: 'servers',
    [FILES.channels]: 'channels',
    [FILES.messages]: 'messages',
    [FILES.serverInvites]: 'invites',
    [FILES.dms]: 'dms',
    [FILES.dmMessages]: 'dm_messages',
    [FILES.reactions]: 'reactions',
    [FILES.blocked]: 'blocked',
    [FILES.files]: 'files',
    [FILES.attachments]: 'attachments',
    [FILES.discovery]: 'discovery',
    [FILES.globalBans]: 'global_bans',
    [FILES.adminLogs]: 'admin_logs'
  }
  return fileMap[file] || file
}

export const migrateData = async (sourceType, targetConfig) => {
  const results = { success: true, tables: {}, errors: [] }
  
  try {
    for (const [file, tableName] of Object.entries({
      [FILES.users]: 'users',
      [FILES.friends]: 'friends',
      [FILES.friendRequests]: 'friend_requests',
      [FILES.servers]: 'servers',
      [FILES.channels]: 'channels',
      [FILES.messages]: 'messages',
      [FILES.serverInvites]: 'invites',
      [FILES.dms]: 'dms',
      [FILES.dmMessages]: 'dm_messages',
      [FILES.reactions]: 'reactions',
      [FILES.blocked]: 'blocked',
      [FILES.files]: 'files',
      [FILES.attachments]: 'attachments',
      [FILES.discovery]: 'discovery',
      [FILES.globalBans]: 'global_bans',
      [FILES.adminLogs]: 'admin_logs'
    })) {
      try {
        const data = loadData(file, {})
        results.tables[tableName] = Object.keys(data).length
      } catch (err) {
        results.errors.push(`${tableName}: ${err.message}`)
      }
    }
  } catch (err) {
    results.success = false
    results.errors.push(err.message)
  }
  
  return results
}

export const getStorageInfo = () => {
  return {
    type: useStorage ? (storageService?.type || 'json') : 'json',
    provider: storageService?.provider || 'json',
    usingStorage: useStorage
  }
}

export const reloadData = async () => {
  if (useStorage) {
    await loadAllData()
  }
}

export const userService = {
  getUser(userId) {
    const users = loadData(FILES.users, {})
    return users[userId] || null
  },

  saveUser(userId, userData) {
    const users = loadData(FILES.users, {})
    users[userId] = {
      ...users[userId],
      ...userData,
      id: userId,
      updatedAt: new Date().toISOString()
    }
    if (!users[userId].createdAt) {
      users[userId].createdAt = new Date().toISOString()
    }
    saveData(FILES.users, users)
    return users[userId]
  },

  updateProfile(userId, updates) {
    const users = loadData(FILES.users, {})
    if (!users[userId]) {
      users[userId] = { id: userId, createdAt: new Date().toISOString() }
    }
    users[userId] = {
      ...users[userId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    saveData(FILES.users, users)
    return users[userId]
  },

  setStatus(userId, status, customStatus = null) {
    const users = loadData(FILES.users, {})
    if (!users[userId]) {
      users[userId] = { id: userId, createdAt: new Date().toISOString() }
    }
    users[userId].status = status
    if (customStatus !== null) {
      users[userId].customStatus = customStatus
    }
    users[userId].updatedAt = new Date().toISOString()
    saveData(FILES.users, users)
    return users[userId]
  },

  setAgeVerification(userId, verification) {
    const users = loadData(FILES.users, {})
    const now = new Date()
    const category = verification?.category === 'child' ? 'child' : 'adult'
    const expiresAt = category === 'adult'
      ? null
      : (verification?.expiresAt || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString())

    users[userId] = {
      ...(users[userId] || { id: userId, createdAt: now.toISOString() }),
      ageVerification: {
        verified: true,
        method: verification?.method,
        birthYear: verification?.birthYear || null,
        age: verification?.age || null,
        proofSummary: verification?.proofSummary || {},
        category,
        estimatedAge: verification?.estimatedAge || null,
        verifiedAt: verification?.verifiedAt || now.toISOString(),
        expiresAt,
        device: verification?.device || null
      },
      updatedAt: now.toISOString()
    }

    saveData(FILES.users, users)
    return users[userId]
  },

  isAgeVerified(userId) {
    const profile = this.getUser(userId)
    const verification = profile?.ageVerification
    if (!verification?.verified) return false
    if (verification.category !== 'adult') return false
    if (verification.expiresAt && new Date(verification.expiresAt) < new Date()) {
      return false
    }
    return true
  },

  getAllUsers() {
    return loadData(FILES.users, {})
  }
}

export const friendService = {
  getFriends(userId) {
    const friends = loadData(FILES.friends, {})
    return friends[userId] || []
  },

  addFriend(userId, friendId) {
    const friends = loadData(FILES.friends, {})
    if (!friends[userId]) friends[userId] = []
    if (!friends[friendId]) friends[friendId] = []
    
    if (!friends[userId].includes(friendId)) {
      friends[userId].push(friendId)
    }
    if (!friends[friendId].includes(userId)) {
      friends[friendId].push(userId)
    }
    
    saveData(FILES.friends, friends)
    return true
  },

  removeFriend(userId, friendId) {
    const friends = loadData(FILES.friends, {})
    if (friends[userId]) {
      friends[userId] = friends[userId].filter(id => id !== friendId)
    }
    if (friends[friendId]) {
      friends[friendId] = friends[friendId].filter(id => id !== userId)
    }
    saveData(FILES.friends, friends)
    return true
  },

  areFriends(userId1, userId2) {
    const friends = loadData(FILES.friends, {})
    return friends[userId1]?.includes(userId2) || false
  },
  
  getAllFriends() {
    return loadData(FILES.friends, {})
  }
}

export const friendRequestService = {
  getRequests(userId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
    return {
      incoming: requests.incoming[userId] || [],
      outgoing: requests.outgoing[userId] || []
    }
  },

  sendRequest(fromUserId, toUserId, fromUsername, toUsername) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
    
    if (!requests.incoming[toUserId]) requests.incoming[toUserId] = []
    if (!requests.outgoing[fromUserId]) requests.outgoing[fromUserId] = []
    
    const existingIncoming = requests.incoming[toUserId].find(r => r.from === fromUserId)
    if (existingIncoming) return { error: 'Request already sent' }
    
    const request = {
      id: `fr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      from: fromUserId,
      fromUsername: fromUsername,
      to: toUserId,
      toUsername: toUsername,
      createdAt: new Date().toISOString()
    }
    
    requests.incoming[toUserId].push(request)
    requests.outgoing[fromUserId].push({ ...request, to: toUserId, toUsername: toUsername })
    
    saveData(FILES.friendRequests, requests)
    return request
  },

  acceptRequest(userId, requestId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
    
    const incoming = requests.incoming[userId] || []
    const request = incoming.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.incoming[userId] = incoming.filter(r => r.id !== requestId)
    if (requests.outgoing[request.from]) {
      requests.outgoing[request.from] = requests.outgoing[request.from].filter(r => r.id !== requestId)
    }
    
    saveData(FILES.friendRequests, requests)
    friendService.addFriend(userId, request.from)
    
    return { success: true, friendId: request.from }
  },

  rejectRequest(userId, requestId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
    
    const incoming = requests.incoming[userId] || []
    const request = incoming.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.incoming[userId] = incoming.filter(r => r.id !== requestId)
    if (requests.outgoing[request.from]) {
      requests.outgoing[request.from] = requests.outgoing[request.from].filter(r => r.id !== requestId)
    }
    
    saveData(FILES.friendRequests, requests)
    return { success: true }
  },

  cancelRequest(userId, requestId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
    
    const outgoing = requests.outgoing[userId] || []
    const request = outgoing.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.outgoing[userId] = outgoing.filter(r => r.id !== requestId)
    if (requests.incoming[request.to]) {
      requests.incoming[request.to] = requests.incoming[request.to].filter(r => r.id !== requestId)
    }
    
    saveData(FILES.friendRequests, requests)
    return { success: true }
  },
  
  getAllRequests() {
    return loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
  }
}

export const blockService = {
  getBlocked(userId) {
    const blocked = loadData(FILES.blocked, {})
    return blocked[userId] || []
  },

  blockUser(userId, blockedUserId) {
    const blocked = loadData(FILES.blocked, {})
    if (!blocked[userId]) blocked[userId] = []
    
    if (!blocked[userId].includes(blockedUserId)) {
      blocked[userId].push(blockedUserId)
    }
    
    friendService.removeFriend(userId, blockedUserId)
    
    saveData(FILES.blocked, blocked)
    return true
  },

  unblockUser(userId, blockedUserId) {
    const blocked = loadData(FILES.blocked, {})
    if (blocked[userId]) {
      blocked[userId] = blocked[userId].filter(id => id !== blockedUserId)
    }
    saveData(FILES.blocked, blocked)
    return true
  },

  isBlocked(userId, targetUserId) {
    const blocked = loadData(FILES.blocked, {})
    return blocked[userId]?.includes(targetUserId) || blocked[targetUserId]?.includes(userId) || false
  },
  
  getAllBlocked() {
    return loadData(FILES.blocked, {})
  }
}

export const dmService = {
  getConversations(userId) {
    const dms = loadData(FILES.dms, {})
    return dms[userId] || []
  },

  getOrCreateConversation(userId1, userId2) {
    const dms = loadData(FILES.dms, {})
    
    const participantKey = [userId1, userId2].sort().join(':')
    
    if (!dms[userId1]) dms[userId1] = []
    if (!dms[userId2]) dms[userId2] = []
    
    let conv1 = dms[userId1].find(c => c.participantKey === participantKey)
    let conv2 = dms[userId2].find(c => c.participantKey === participantKey)
    
    if (!conv1 || !conv2) {
      const conversationId = `dm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const now = new Date().toISOString()
      
      const newConv = {
        id: conversationId,
        participantKey,
        participants: [userId1, userId2],
        createdAt: now,
        lastMessageAt: now
      }
      
      if (!conv1) {
        dms[userId1].push({ ...newConv, recipientId: userId2 })
      }
      if (!conv2) {
        dms[userId2].push({ ...newConv, recipientId: userId1 })
      }
      
      saveData(FILES.dms, dms)
      return newConv
    }
    
    return conv1
  },

  updateLastMessage(conversationId, userId1, userId2) {
    const dms = loadData(FILES.dms, {})
    const now = new Date().toISOString()
    
    if (dms[userId1]) {
      const conv = dms[userId1].find(c => c.id === conversationId)
      if (conv) conv.lastMessageAt = now
    }
    if (dms[userId2]) {
      const conv = dms[userId2].find(c => c.id === conversationId)
      if (conv) conv.lastMessageAt = now
    }
    
    saveData(FILES.dms, dms)
  },
  
  getAllConversations() {
    return loadData(FILES.dms, {})
  }
}

export const dmMessageService = {
  getMessages(conversationId, limit = 50) {
    const messages = loadData(FILES.dmMessages, {})
    const convMessages = messages[conversationId] || []
    return convMessages.slice(-limit)
  },

  addMessage(conversationId, message) {
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) messages[conversationId] = []
    messages[conversationId].push(message)
    saveData(FILES.dmMessages, messages)
    return message
  },

  editMessage(conversationId, messageId, newContent) {
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) return null
    
    const msg = messages[conversationId].find(m => m.id === messageId)
    if (msg) {
      msg.content = newContent
      msg.edited = true
      msg.editedAt = new Date().toISOString()
      saveData(FILES.dmMessages, messages)
    }
    return msg
  },

  deleteMessage(conversationId, messageId) {
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) return false
    
    const idx = messages[conversationId].findIndex(m => m.id === messageId)
    if (idx >= 0) {
      messages[conversationId].splice(idx, 1)
      saveData(FILES.dmMessages, messages)
      return true
    }
    return false
  },
  
  getAllMessages() {
    return loadData(FILES.dmMessages, {})
  }
}

export const reactionService = {
  getReactions(messageId) {
    const reactions = loadData(FILES.reactions, {})
    return reactions[messageId] || {}
  },

  addReaction(messageId, userId, emoji) {
    const reactions = loadData(FILES.reactions, {})
    if (!reactions[messageId]) reactions[messageId] = {}
    if (!reactions[messageId][emoji]) reactions[messageId][emoji] = []
    
    if (!reactions[messageId][emoji].includes(userId)) {
      reactions[messageId][emoji].push(userId)
    }
    
    saveData(FILES.reactions, reactions)
    return reactions[messageId]
  },

  removeReaction(messageId, userId, emoji) {
    const reactions = loadData(FILES.reactions, {})
    if (!reactions[messageId]?.[emoji]) return reactions[messageId] || {}
    
    reactions[messageId][emoji] = reactions[messageId][emoji].filter(id => id !== userId)
    if (reactions[messageId][emoji].length === 0) {
      delete reactions[messageId][emoji]
    }
    
    saveData(FILES.reactions, reactions)
    return reactions[messageId]
  },
  
  getAllReactions() {
    return loadData(FILES.reactions, {})
  }
}

export const inviteService = {
  createInvite(serverId, creatorId, options = {}) {
    const invites = loadData(FILES.serverInvites, {})
    if (!invites[serverId]) invites[serverId] = []
    
    const code = Math.random().toString(36).substr(2, 8).toUpperCase()
    const invite = {
      code,
      serverId,
      createdBy: creatorId,
      uses: 0,
      maxUses: options.maxUses || 0,
      expiresAt: options.expiresAt || null,
      createdAt: new Date().toISOString()
    }
    
    invites[serverId].push(invite)
    saveData(FILES.serverInvites, invites)
    return invite
  },

  getInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      const invite = invites[serverId].find(i => i.code === code)
      if (invite) return invite
    }
    return null
  },

  useInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      const invite = invites[serverId].find(i => i.code === code)
      if (invite) {
        if (invite.maxUses && invite.uses >= invite.maxUses) {
          return { error: 'Invite expired' }
        }
        if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
          return { error: 'Invite expired' }
        }
        invite.uses++
        saveData(FILES.serverInvites, invites)
        return { serverId: invite.serverId }
      }
    }
    return { error: 'Invite not found' }
  },

  deleteInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      const idx = invites[serverId].findIndex(i => i.code === code)
      if (idx >= 0) {
        invites[serverId].splice(idx, 1)
        saveData(FILES.serverInvites, invites)
        return true
      }
    }
    return false
  },

  getServerInvites(serverId) {
    const invites = loadData(FILES.serverInvites, {})
    return invites[serverId] || []
  },
  
  getAllInvites() {
    return loadData(FILES.serverInvites, {})
  }
}

export const serverService = {
  getServer(serverId) {
    const servers = loadData(FILES.servers, {})
    return servers[serverId] || null
  },

  createServer(serverData) {
    const servers = loadData(FILES.servers, {})
    servers[serverData.id] = {
      ...serverData,
      createdAt: serverData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    saveData(FILES.servers, servers)
    return servers[serverData.id]
  },

  updateServer(serverId, updates) {
    const servers = loadData(FILES.servers, {})
    if (!servers[serverId]) return null
    
    servers[serverId] = {
      ...servers[serverId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    saveData(FILES.servers, servers)
    return servers[serverId]
  },

  deleteServer(serverId) {
    const servers = loadData(FILES.servers, {})
    delete servers[serverId]
    saveData(FILES.servers, servers)
    
    const channels = loadData(FILES.channels, {})
    const serverChannels = Object.keys(channels).filter(ch => channels[ch].serverId === serverId)
    serverChannels.forEach(chId => delete channels[chId])
    saveData(FILES.channels, channels)
    
    return true
  },

  getAllServers() {
    return loadData(FILES.servers, {})
  }
}

export const channelService = {
  getChannel(channelId) {
    const channels = loadData(FILES.channels, {})
    return channels[channelId] || null
  },

  createChannel(channelData) {
    const channels = loadData(FILES.channels, {})
    channels[channelData.id] = {
      ...channelData,
      createdAt: channelData.createdAt || new Date().toISOString()
    }
    saveData(FILES.channels, channels)
    return channels[channelData.id]
  },

  updateChannel(channelId, updates) {
    const channels = loadData(FILES.channels, {})
    if (!channels[channelId]) return null
    
    channels[channelId] = {
      ...channels[channelId],
      ...updates
    }
    saveData(FILES.channels, channels)
    return channels[channelId]
  },

  deleteChannel(channelId) {
    const channels = loadData(FILES.channels, {})
    delete channels[channelId]
    saveData(FILES.channels, channels)
    return true
  },

  getServerChannels(serverId) {
    const channels = loadData(FILES.channels, {})
    return Object.values(channels).filter(ch => ch.serverId === serverId)
  },
  
  getAllChannels() {
    return loadData(FILES.channels, {})
  }
}

export const messageService = {
  getMessage(messageId) {
    const messages = loadData(FILES.messages, {})
    return messages[messageId] || null
  },

  getChannelMessages(channelId, limit = 50, before = null) {
    const messages = loadData(FILES.messages, {})
    let channelMessages = Object.values(messages)
      .filter(m => m.channelId === channelId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    
    if (before) {
      const beforeIndex = channelMessages.findIndex(m => m.id === before)
      if (beforeIndex > 0) {
        channelMessages = channelMessages.slice(0, beforeIndex)
      }
    }
    
    return channelMessages.slice(-limit)
  },

  createMessage(messageData) {
    const messages = loadData(FILES.messages, {})
    messages[messageData.id] = {
      ...messageData,
      createdAt: messageData.createdAt || new Date().toISOString()
    }
    saveData(FILES.messages, messages)
    return messages[messageData.id]
  },

  editMessage(messageId, newContent) {
    const messages = loadData(FILES.messages, {})
    if (!messages[messageId]) return null
    
    messages[messageId].content = newContent
    messages[messageId].edited = true
    messages[messageId].editedAt = new Date().toISOString()
    saveData(FILES.messages, messages)
    return messages[messageId]
  },

  deleteMessage(messageId) {
    const messages = loadData(FILES.messages, {})
    delete messages[messageId]
    saveData(FILES.messages, messages)
    return true
  },
  
  getAllMessages() {
    return loadData(FILES.messages, {})
  }
}

export const fileService = {
  getFile(fileId) {
    const files = loadData(FILES.files, {})
    return files[fileId] || null
  },

  saveFile(fileData) {
    const files = loadData(FILES.files, {})
    files[fileData.id] = {
      ...fileData,
      createdAt: fileData.createdAt || new Date().toISOString()
    }
    saveData(FILES.files, files)
    return files[fileData.id]
  },

  deleteFile(fileId) {
    const files = loadData(FILES.files, {})
    delete files[fileId]
    saveData(FILES.files, files)
    return true
  },
  
  getAllFiles() {
    return loadData(FILES.files, {})
  }
}

export const attachmentService = {
  getMessageAttachments(messageId) {
    const attachments = loadData(FILES.attachments, {})
    return attachments[messageId] || []
  },

  addAttachment(messageId, attachment) {
    const attachments = loadData(FILES.attachments, {})
    if (!attachments[messageId]) attachments[messageId] = []
    attachments[messageId].push(attachment)
    saveData(FILES.attachments, attachments)
    return attachments[messageId]
  },

  removeAttachment(messageId, attachmentId) {
    const attachments = loadData(FILES.attachments, {})
    if (!attachments[messageId]) return false
    
    attachments[messageId] = attachments[messageId].filter(a => a.id !== attachmentId)
    saveData(FILES.attachments, attachments)
    return true
  },
  
  getAllAttachments() {
    return loadData(FILES.attachments, {})
  }
}

export const discoveryService = {
  _load() {
    const data = loadData(FILES.discovery, {})
    if (!data.submissions) data.submissions = []
    if (!data.approved) data.approved = []
    return data
  },

  getDiscoveryEntry(serverId) {
    const data = this._load()
    return data.approved.find(s => s.serverId === serverId) || null
  },

  addToDiscovery(serverId, entryData) {
    const data = this._load()
    const existing = data.approved.findIndex(s => s.serverId === serverId)
    const entry = {
      ...entryData,
      serverId,
      addedAt: new Date().toISOString()
    }
    if (existing >= 0) {
      data.approved[existing] = { ...data.approved[existing], ...entry }
    } else {
      data.approved.push(entry)
    }
    saveData(FILES.discovery, data)
    return entry
  },

  removeFromDiscovery(serverId) {
    const data = this._load()
    data.approved = data.approved.filter(s => s.serverId !== serverId)
    data.submissions = data.submissions.filter(s => s.serverId !== serverId)
    saveData(FILES.discovery, data)
    return { success: true }
  },

  isInDiscovery(serverId) {
    const data = this._load()
    return data.approved.some(s => s.serverId === serverId)
  },

  getCategories() {
    const data = this._load()
    const cats = new Set()
    data.approved.forEach(s => { if (s.category) cats.add(s.category) })
    return [...cats].map(c => ({ id: c, name: c.charAt(0).toUpperCase() + c.slice(1) }))
  },

  getApprovedServers(limit = 50, offset = 0, category = null, search = null) {
    const data = this._load()
    let list = data.approved.filter(s => s.status === 'approved')

    if (category) {
      list = list.filter(s => s.category === category)
    }
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(s =>
        (s.name && s.name.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q))
      )
    }

    return {
      servers: list.slice(offset, offset + limit),
      total: list.length
    }
  },

  submitServer(serverId, description, category, userId) {
    const data = this._load()
    const existing = data.submissions.find(s => s.serverId === serverId && s.status === 'pending')
    if (existing) {
      return { error: 'Server already has a pending submission' }
    }
    if (data.approved.some(s => s.serverId === serverId)) {
      return { error: 'Server is already in discovery' }
    }

    const servers = loadData(FILES.servers, [])
    const serverList = Array.isArray(servers) ? servers : Object.values(servers)
    const server = serverList.find(s => s.id === serverId)

    const submission = {
      id: `disc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      serverId,
      name: server?.name || 'Unknown',
      icon: server?.icon || '',
      description: description || '',
      category: category || 'community',
      memberCount: server?.members?.length || 0,
      submittedBy: userId,
      submittedAt: new Date().toISOString(),
      status: 'pending'
    }
    data.submissions.push(submission)
    saveData(FILES.discovery, data)
    return submission
  },

  getPendingSubmissions() {
    const data = this._load()
    return data.submissions.filter(s => s.status === 'pending')
  },

  approveSubmission(submissionId) {
    const data = this._load()
    const idx = data.submissions.findIndex(s => s.id === submissionId)
    if (idx === -1) return { error: 'Submission not found' }

    const submission = data.submissions[idx]
    submission.status = 'approved'
    submission.approvedAt = new Date().toISOString()
    data.submissions.splice(idx, 1)
    data.approved.push(submission)
    saveData(FILES.discovery, data)
    return submission
  },

  rejectSubmission(submissionId) {
    const data = this._load()
    const idx = data.submissions.findIndex(s => s.id === submissionId)
    if (idx === -1) return { error: 'Submission not found' }

    const submission = data.submissions[idx]
    submission.status = 'rejected'
    submission.rejectedAt = new Date().toISOString()
    data.submissions.splice(idx, 1)
    saveData(FILES.discovery, data)
    return { success: true }
  },

  getDiscoveryList(category = null, limit = 50) {
    const data = this._load()
    let list = data.approved
    if (category) {
      list = list.filter(s => s.category === category)
    }
    return list.slice(0, limit)
  },

  getSubmissions() {
    return this._load()
  },

  getAllDiscovery() {
    return this._load()
  }
}

export const globalBanService = {
  isBanned(userId) {
    const bans = loadData(FILES.globalBans, {})
    return bans[userId] || null
  },

  banUser(userId, banData) {
    const bans = loadData(FILES.globalBans, {})
    bans[userId] = {
      ...banData,
      userId,
      bannedAt: new Date().toISOString()
    }
    saveData(FILES.globalBans, bans)
    return bans[userId]
  },

  unbanUser(userId) {
    const bans = loadData(FILES.globalBans, {})
    delete bans[userId]
    saveData(FILES.globalBans, bans)
    return true
  },
  
  getAllBans() {
    return loadData(FILES.globalBans, {})
  }
}

export const adminLogService = {
  log(action, userId, targetId, details = {}) {
    const logs = loadData(FILES.adminLogs, {})
    const logId = `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    
    logs[logId] = {
      id: logId,
      action,
      userId,
      targetId,
      details,
      createdAt: new Date().toISOString()
    }
    saveData(FILES.adminLogs, logs)
    return logs[logId]
  },

  getLogs(limit = 100) {
    const logs = loadData(FILES.adminLogs, {})
    return Object.values(logs)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit)
  },
  
  getAllLogs() {
    return loadData(FILES.adminLogs, {})
  }
}

export const serverBanService = {
  isServerBanned(serverId) {
    const bans = loadData(FILES.serverBans || FILES.globalBans, {})
    return bans[serverId] || null
  },

  banServer(serverId, reason, bannedBy) {
    const bans = loadData(FILES.serverBans || FILES.globalBans, {})
    bans[serverId] = {
      serverId,
      reason,
      bannedBy,
      bannedAt: new Date().toISOString()
    }
    saveData(FILES.serverBans || FILES.globalBans, bans)
    return bans[serverId]
  },

  unbanServer(serverId) {
    const bans = loadData(FILES.serverBans || FILES.globalBans, {})
    delete bans[serverId]
    saveData(FILES.serverBans || FILES.globalBans, bans)
    return true
  },

  getAllServerBans() {
    return loadData(FILES.serverBans || FILES.globalBans, {})
  }
}

export const adminService = {
  getStats() {
    const users = loadData(FILES.users, {})
    const servers = loadData(FILES.servers, {})
    const channels = loadData(FILES.channels, {})
    const messages = loadData(FILES.messages, {})
    const dms = loadData(FILES.dms, {})
    const globalBans = loadData(FILES.globalBans, {})
    
    return {
      totalUsers: Object.keys(users).length,
      totalServers: Object.keys(servers).length,
      totalChannels: Object.keys(channels).length,
      totalMessages: Object.keys(messages).length,
      totalDms: Object.keys(dms).length,
      totalBans: Object.keys(globalBans).length,
      timestamp: new Date().toISOString()
    }
  },

  isAdmin(userId) {
    const user = userService.getUser(userId)
    const role = user?.adminRole || user?.role
    return role === 'admin' || role === 'owner' || user?.isAdmin === true
  },

  isModerator(userId) {
    const user = userService.getUser(userId)
    const role = user?.adminRole || user?.role
    return role === 'admin' || role === 'owner' || role === 'moderator' || user?.isAdmin === true || user?.isModerator === true
  },

  getUserRole(userId) {
    const user = userService.getUser(userId)
    return user?.adminRole || user?.role || 'user'
  },

  setUserRole(userId, role) {
    return userService.updateProfile(userId, { adminRole: role })
  },

  logAction(userId, action, targetId, details) {
    return adminLogService.log(action, userId, targetId, details)
  },

  getLogs(limit = 100) {
    return adminLogService.getLogs(limit)
  },

  getAllUsers() {
    const users = loadData(FILES.users, {})
    return Object.values(users)
  },

  resetUserPassword(userId) {
    const tempPassword = Math.random().toString(36).slice(-8)
    const user = userService.getUser(userId)
    if (!user) return { success: false, error: 'User not found' }
    
    import('bcrypt').then(({ default: bcrypt }) => {
      const tempHash = bcrypt.hashSync(tempPassword, 10)
      userService.updateProfile(userId, { passwordHash: tempHash })
    })
    
    return { success: true, tempPassword }
  },

  deleteUser(userId) {
    const users = loadData(FILES.users, {})
    delete users[userId]
    saveData(FILES.users, users)
    
    const friends = loadData(FILES.friends, {})
    if (friends[userId]) {
      delete friends[userId]
      Object.keys(friends).forEach((uid) => {
        friends[uid] = friends[uid].filter(fId => fId !== userId)
      })
      saveData(FILES.friends, friends)
    }
    
    return { success: true }
  }
}

// ---------------------------------------------------------------------------
// System Message Service
// System messages are sent by Voltage itself to users/admins.
// Categories: 'update' | 'account' | 'discovery' | 'announcement'
// Audience targeting: per-user id, role ('admin'|'owner'|'all'), or server-specific
// ---------------------------------------------------------------------------
export const systemMessageService = {
  /**
   * Deliver a system message to one or more users.
   * @param {object} opts
   * @param {string}   opts.category   'update'|'account'|'discovery'|'announcement'
   * @param {string}   opts.title
   * @param {string}   opts.body       Markdown supported
   * @param {string}   [opts.icon]     Lucide icon name hint for the client
   * @param {string}   [opts.severity] 'info'|'warning'|'error'|'success'
   * @param {string[]} opts.recipients Array of user IDs to receive this message
   * @param {string}   [opts.dedupeKey] If set, skip users who already have a message with this key
   * @param {object}   [opts.meta]     Extra data (e.g. version, releaseUrl)
   * @returns {object[]} Array of created message objects
   */
  send(opts) {
    const { category, title, body, icon, severity = 'info', recipients, dedupeKey, meta } = opts
    const data = loadData(FILES.systemMessages, {})
    const created = []
    const now = new Date().toISOString()

    for (const userId of (recipients || [])) {
      if (!data[userId]) data[userId] = []

      // Deduplicate: skip if a message with this dedupeKey was already sent
      if (dedupeKey && data[userId].some(m => m.dedupeKey === dedupeKey)) continue

      const msg = {
        id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        category,
        title,
        body,
        icon: icon || null,
        severity,
        dedupeKey: dedupeKey || null,
        meta: meta || null,
        read: false,
        createdAt: now
      }
      data[userId].push(msg)
      created.push({ userId, ...msg })
    }

    saveData(FILES.systemMessages, data)
    return created
  },

  /** Get all system messages for a user, newest first */
  getForUser(userId) {
    const data = loadData(FILES.systemMessages, {})
    const msgs = data[userId] || []
    return [...msgs].reverse()
  },

  /** Count unread system messages for a user */
  unreadCount(userId) {
    const data = loadData(FILES.systemMessages, {})
    return (data[userId] || []).filter(m => !m.read).length
  },

  /** Mark one message as read */
  markRead(userId, messageId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return false
    const msg = data[userId].find(m => m.id === messageId)
    if (!msg) return false
    msg.read = true
    saveData(FILES.systemMessages, data)
    return true
  },

  /** Mark all messages for a user as read */
  markAllRead(userId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return
    data[userId].forEach(m => { m.read = true })
    saveData(FILES.systemMessages, data)
  },

  /** Delete a system message */
  delete(userId, messageId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return false
    const before = data[userId].length
    data[userId] = data[userId].filter(m => m.id !== messageId)
    saveData(FILES.systemMessages, data)
    return data[userId].length < before
  },

  /** Delete all system messages for a user */
  clearAll(userId) {
    const data = loadData(FILES.systemMessages, {})
    data[userId] = []
    saveData(FILES.systemMessages, data)
  }
}

initStorage()

export default {
  initStorage,
  FILES,
  migrateData,
  getStorageInfo,
  reloadData,
  userService,
  friendService,
  friendRequestService,
  blockService,
  dmService,
  dmMessageService,
  reactionService,
  inviteService,
  serverService,
  channelService,
  messageService,
  fileService,
  attachmentService,
  discoveryService,
  globalBanService,
  adminLogService,
  adminService,
  serverBanService
}
