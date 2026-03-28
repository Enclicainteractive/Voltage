import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { 
  dmService, 
  dmMessageService, 
  userService,
  blockService 
} from '../services/dataService.js'
import { botService } from '../services/botService.js'
import { federationService } from '../services/federationService.js'
import { isUserOnline } from '../services/socketService.js'
import config from '../config/config.js'
import rateLimiter from '../services/rateLimiter.js'

const isExternalImage = (value) => typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:image\//i.test(value))

const getImageUrl = (userId) => {
  const safeUserId = String(userId || '')
  if (!safeUserId) return null
  const baseUrl = safeUserId.startsWith('u_')
    ? (config.getServerUrl() || config.getImageServerUrl())
    : config.getImageServerUrl()
  return `${baseUrl}/api/images/users/${encodeURIComponent(safeUserId)}/profile`
}

const resolveUserAvatar = (userId, profile = null) => {
  const explicit = profile?.imageUrl || profile?.imageurl || profile?.avatar || null
  if (isExternalImage(explicit)) return explicit
  return getImageUrl(userId)
}

const normalizeHost = (value) => federationService?.normalizeHost?.(value) || String(value || '').toLowerCase()

const resolvePresenceStatus = (userId, profile = null) => {
  const profileHost = normalizeHost(profile?.host || config.getHost())
  const localHost = normalizeHost(config.getHost())
  if (profileHost && profileHost !== localHost) {
    return profile?.status || 'offline'
  }
  const online = isUserOnline(userId)
  return online ? (profile?.status === 'invisible' ? 'invisible' : (profile?.status || 'online')) : 'offline'
}

const buildAddress = (profile = {}) => {
  const username = profile?.customUsername || profile?.username || ''
  const host = normalizeHost(profile?.host || config.getHost())
  return username && host ? `${username}:${host}` : username || ''
}

const router = express.Router()

const buildDMReplyReference = (conversationMessages, replyTo) => {
  if (!replyTo) return null
  if (typeof replyTo === 'object' && replyTo.id) return replyTo
  if (typeof replyTo !== 'string') return null
  const target = conversationMessages.find(m => m.id === replyTo)
  return target
    ? {
        id: target.id,
        userId: target.userId,
        username: target.username,
        content: target.content,
        timestamp: target.timestamp
      }
    : {
        id: replyTo,
        deleted: true
      }
}

// Get all DM conversations
router.get('/', authenticateToken, async (req, res) => {
  const { search } = req.query
  let conversations = dmService.getConversations(req.user.id)
  
  let enrichedConversations = await Promise.all(conversations.map(async conv => {
    const participantIds = Array.isArray(conv.participants)
      ? conv.participants
      : [req.user.id, conv.recipientId].filter(Boolean)
    const otherIds = participantIds.filter(id => id !== req.user.id)
    const isGroup = !!conv.isGroup || otherIds.length > 1

    const recipients = await Promise.all(otherIds.map(async id => {
      let profile = userService.getUser(id)
      let isBot = false
      let botStatus = 'offline'
      
      if (!profile && id.startsWith('bot_')) {
        const bot = await botService.getBot(id)
        if (bot) {
          profile = {
            username: bot.name,
            displayName: bot.name,
            imageUrl: bot.avatar,
            avatar: bot.avatar,
            host: config.getHost()
          }
          isBot = true
          botStatus = bot.status || 'offline'
        }
      }
      
      const status = isBot ? botStatus : resolvePresenceStatus(id, profile)
      return {
        id,
        username: profile?.username || 'Unknown',
        displayName: profile?.displayName,
        customUsername: profile?.customUsername,
        imageUrl: profile?.imageUrl || profile?.imageurl || profile?.avatar || null,
        avatar: resolveUserAvatar(id, profile),
        status,
        host: profile?.host || config.getHost(),
        address: buildAddress(profile),
        isBot
      }
    }))
    const primaryRecipient = recipients[0] || null

    return {
      ...conv,
      isGroup,
      recipient: primaryRecipient,
      recipients,
      title: isGroup
        ? (conv.groupName || recipients.map(r => r.displayName || r.customUsername || r.username).slice(0, 3).join(', ') || 'Group DM')
        : (primaryRecipient?.displayName || primaryRecipient?.customUsername || primaryRecipient?.username || 'Unknown')
    }
  }))
  
  // Filter by search query if provided
  if (search && search.trim()) {
    const searchLower = search.toLowerCase().trim()
    enrichedConversations = enrichedConversations.filter(conv => {
      if (conv.isGroup) {
        const groupName = conv.groupName?.toLowerCase() || ''
        const title = conv.title?.toLowerCase() || ''
        const memberMatch = Array.isArray(conv.recipients) ? conv.recipients.some(r =>
          (r.username || '').toLowerCase().includes(searchLower) ||
          (r.displayName || '').toLowerCase().includes(searchLower) ||
          (r.customUsername || '').toLowerCase().includes(searchLower)
        ) : false
        return groupName.includes(searchLower) || title.includes(searchLower) || memberMatch
      }
      const username = conv.recipient?.username?.toLowerCase() || ''
      const displayName = conv.recipient?.displayName?.toLowerCase() || ''
      const customUsername = conv.recipient?.customUsername?.toLowerCase() || ''
      return username.includes(searchLower) || displayName.includes(searchLower) || customUsername.includes(searchLower)
    })
  }
  
  // Sort by last message time
  enrichedConversations.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
  
  console.log(`[API] Get DMs for ${req.user.username} - ${enrichedConversations.length} conversations${search ? ` (search: ${search})` : ''}`)
  res.json(enrichedConversations)
})

// Search for users to start a new DM
router.get('/search', authenticateToken, async (req, res) => {
  const { q } = req.query
  
  if (!q || q.trim().length < 2) {
    return res.json([])
  }
  
  const searchLower = q.toLowerCase().trim()
  const allUsers = userService.getAllUsers() || {}
  const currentUserId = req.user.id
  
  // Get existing DM recipients to mark them
  const existingConversations = dmService.getConversations(currentUserId)
  const existingRecipientIds = new Set(existingConversations.map(c => c.recipientId))
  
  // Filter users by search query, exclude self and blocked users
  let userResults = Object.values(allUsers)
    .filter(user => {
      if (user.id === currentUserId) return false
      if (blockService.isBlocked(currentUserId, user.id)) return false
      
      const username = user.username?.toLowerCase() || ''
      const displayName = user.displayName?.toLowerCase() || ''
      const customUsername = user.customUsername?.toLowerCase() || ''
      const email = user.email?.toLowerCase() || ''
      
      return username.includes(searchLower) || 
             displayName.includes(searchLower) || 
             customUsername.includes(searchLower) ||
             email.includes(searchLower)
    })
    .slice(0, 20)
    .map(user => {
      const status = resolvePresenceStatus(user.id, user)
      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        customUsername: user.customUsername,
        imageUrl: user.imageUrl || user.imageurl || user.avatar || null,
        avatar: resolveUserAvatar(user.id, user),
        status,
        host: user.host || config.getHost(),
        address: buildAddress(user),
        hasExistingDM: existingRecipientIds.has(user.id),
        isBot: false
      }
    })
  
  // Also search bots
  const bots = await botService.getAllBots()
  const botResults = bots
    .filter(bot => {
      if (blockService.isBlocked(currentUserId, bot.id)) return false
      const name = bot.name?.toLowerCase() || ''
      return name.includes(searchLower)
    })
    .slice(0, 5)
    .map(bot => ({
      id: bot.id,
      username: bot.name,
      displayName: bot.name,
      customUsername: null,
      imageUrl: bot.avatar,
      avatar: bot.avatar,
      status: bot.status || 'offline',
      host: config.getHost(),
      address: `${bot.name}:${config.getHost()}`,
      hasExistingDM: existingRecipientIds.has(bot.id),
      isBot: true
    }))
  
  const results = [...userResults, ...botResults]
  
  console.log(`[API] DM user search for "${q}" - ${results.length} results`)
  res.json(results)
})

// Create or get DM conversation
router.post('/', authenticateToken, async (req, res) => {
  const { userId, participantIds, groupName } = req.body

  // Group DM flow
  if (Array.isArray(participantIds) && participantIds.length > 0) {
    const ids = Array.from(new Set(participantIds.filter(Boolean)))
    if (ids.includes(req.user.id)) {
      return res.status(400).json({ error: 'Do not include yourself in participantIds' })
    }
    if (ids.some(id => blockService.isBlocked(req.user.id, id))) {
      return res.status(400).json({ error: 'One or more selected users are blocked' })
    }

    try {
      const conversation = await dmService.createGroupConversation(req.user.id, ids, groupName)
      const recipients = conversation.participants
        .filter(id => id !== req.user.id)
        .map(id => {
          const profile = userService.getUser(id)
          const status = resolvePresenceStatus(id, profile)
          return {
            id,
            username: profile?.username || 'Unknown',
            displayName: profile?.displayName,
            customUsername: profile?.customUsername,
            imageUrl: profile?.imageUrl || profile?.imageurl || profile?.avatar || null,
            avatar: resolveUserAvatar(id, profile),
            status,
            host: profile?.host || config.getHost(),
            address: buildAddress(profile)
          }
        })

      return res.json({
        ...conversation,
        isGroup: true,
        recipients,
        recipient: recipients[0] || null,
        title: conversation.groupName || recipients.map(r => r.displayName || r.customUsername || r.username).slice(0, 3).join(', ')
      })
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Failed to create group DM' })
    }
  }
  
  if (!userId) {
    return res.status(400).json({ error: 'userId required' })
  }
  
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot create DM with yourself' })
  }
  
  if (blockService.isBlocked(req.user.id, userId)) {
    return res.status(400).json({ error: 'User is blocked' })
  }
  
  const conversation = await dmService.getOrCreateConversation(req.user.id, userId)
  let recipientProfile = userService.getUser(userId)
  let isBot = false
  let botStatus = 'offline'
  
  if (!recipientProfile && userId.startsWith('bot_')) {
    const bot = await botService.getBot(userId)
    if (bot) {
      recipientProfile = {
        username: bot.name,
        displayName: bot.name,
        imageUrl: bot.avatar,
        avatar: bot.avatar,
        host: config.getHost()
      }
      isBot = true
      botStatus = bot.status || 'offline'
    }
  }
  
  const status = isBot ? botStatus : resolvePresenceStatus(userId, recipientProfile)
  
  // REMOVED: This saveUser call was unnecessary and could reset admin roles
  // The dmService.getOrCreateConversation already handles all necessary updates
  
  console.log(`[API] DM conversation created/retrieved between ${req.user.id} and ${userId}`)
  res.json({
    ...conversation,
    recipient: {
      id: userId,
      username: recipientProfile?.username || 'Unknown',
      displayName: recipientProfile?.displayName,
      imageUrl: recipientProfile?.imageUrl || recipientProfile?.imageurl || recipientProfile?.avatar || null,
      avatar: resolveUserAvatar(userId, recipientProfile),
      status,
      host: recipientProfile?.host || config.getHost(),
      address: buildAddress(recipientProfile),
      isBot
    }
  })
})

// Get messages for a DM conversation
router.get('/:conversationId/messages', authenticateToken, async (req, res) => {
  const { limit = 50, search, before, offset = 0 } = req.query
  const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 100))
  const parsedOffset = Math.max(0, parseInt(offset, 10) || 0)
  const conversationMessages = await dmMessageService.getMessagesForConversation(
    req.params.conversationId,
    Math.max(parsedLimit + parsedOffset, 100),
    before || null
  )
  let messages = [...conversationMessages]

  if (before) {
    const beforeTime = new Date(before).getTime()
    if (Number.isFinite(beforeTime)) {
      messages = messages.filter((msg) => {
        const msgTime = new Date(msg?.timestamp || 0).getTime()
        return Number.isFinite(msgTime) && msgTime < beforeTime
      })
    }
  }
  
  // Filter by search query if provided
  if (search && search.trim()) {
    const searchLower = search.toLowerCase().trim()
    messages = messages.filter(msg => 
      msg.content?.toLowerCase().includes(searchLower) ||
      msg.username?.toLowerCase().includes(searchLower)
    )
  }

  if (parsedOffset > 0) {
    messages = messages.slice(parsedOffset)
  }
  messages = messages.slice(-parsedLimit)

  const hydrated = messages.map(msg => ({
    ...msg,
    replyTo: buildDMReplyReference(conversationMessages, msg.replyTo)
  }))

  console.log(`[API] Get DM messages for ${req.params.conversationId} - ${hydrated.length} messages${search ? ` (search: ${search})` : ''}`)
  res.json(hydrated)
})

// Search messages in all DM conversations
router.get('/search/messages', authenticateToken, (req, res) => {
  const { q } = req.query
  
  if (!q || q.trim().length < 2) {
    return res.json([])
  }
  
  const searchLower = q.toLowerCase().trim()
  const conversations = dmService.getConversations(req.user.id)
  const results = []
  
  for (const conv of conversations) {
    const messages = dmMessageService.getMessages(conv.id, 100)
    const matchingMessages = messages.filter(msg => 
      msg.content?.toLowerCase().includes(searchLower)
    ).slice(0, 10) // Limit per conversation
    
    if (matchingMessages.length > 0) {
      const others = (Array.isArray(conv.participants) ? conv.participants : [req.user.id, conv.recipientId].filter(Boolean))
        .filter(id => id !== req.user.id)
      const recipients = others.map(id => {
        const p = userService.getUser(id)
        return {
          id,
          username: p?.username || 'Unknown',
          displayName: p?.displayName,
          imageUrl: p?.imageUrl || p?.imageurl || p?.avatar || null,
          avatar: resolveUserAvatar(id, p)
        }
      })
      results.push({
        conversationId: conv.id,
        isGroup: !!conv.isGroup || others.length > 1,
        recipient: recipients[0] || null,
        recipients,
        title: conv.groupName || recipients.map(r => r.displayName || r.username).slice(0, 3).join(', '),
        messages: matchingMessages.map(msg => ({
          id: msg.id,
          content: msg.content,
          timestamp: msg.timestamp,
          userId: msg.userId,
          username: msg.username
        }))
      })
    }
  }
  
  console.log(`[API] DM message search for "${q}" - ${results.length} conversations with matches`)
  res.json(results.slice(0, 20)) // Limit total results
})

// Send message in DM
router.post('/:conversationId/messages', authenticateToken, async (req, res) => {
  const { content, attachments, replyTo } = req.body
  const conversationId = req.params.conversationId
  
  const rateLimit = await rateLimiter.checkMessageRateLimit(req.user.id)
  if (!rateLimit.allowed) {
    return res.status(429).json({ 
      error: 'Too many messages. Please slow down.', 
      retryAfter: rateLimit.retryAfter 
    })
  }
  
  if (!content?.trim()) {
    return res.status(400).json({ error: 'Message content required' })
  }
  
  const conversations = dmService.getConversations(req.user.id)
  const conversation = conversations.find(c => c.id === conversationId)
  
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  if (!conversation.isGroup && blockService.isBlocked(req.user.id, conversation.recipientId)) {
    return res.status(400).json({ error: 'Cannot send message to blocked user' })
  }
  if (conversation.isGroup) {
     const others = Array.isArray(conversation.participants) ? conversation.participants.filter(id => id !== req.user.id) : []
    if (others.some(id => blockService.isBlocked(req.user.id, id))) {
      return res.status(400).json({ error: 'Cannot send message to one or more blocked users in this group' })
    }
  }
  
  const message = {
    id: uuidv4(),
    conversationId,
    userId: req.user.id,
    username: req.user.username,
    avatar: req.user.avatar || getImageUrl(req.user.id),
    content: content.trim(),
    attachments: attachments || [],
    replyTo: buildDMReplyReference(dmMessageService.getAllMessages()?.[conversationId] || [], replyTo),
    timestamp: new Date().toISOString()
  }
  
  await dmMessageService.addMessage(conversationId, message)
  await dmService.updateLastMessage(conversationId, req.user.id, conversation.recipientId)
  
  console.log(`[API] DM message sent in ${conversationId}`)
  res.status(201).json(message)
})

// Edit DM message
router.put('/:conversationId/messages/:messageId', authenticateToken, async (req, res) => {
  const { content } = req.body
  const { conversationId, messageId } = req.params
  
  if (!content?.trim()) {
    return res.status(400).json({ error: 'Message content required' })
  }
  
  const messages = dmMessageService.getMessages(conversationId, 100)
  const message = messages.find(m => m.id === messageId)
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' })
  }
  
  if (message.userId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot edit others messages' })
  }
  
  const updated = await dmMessageService.editMessage(conversationId, messageId, content.trim())
  console.log(`[API] DM message ${messageId} edited`)
  res.json(updated)
})

// Delete DM message
router.delete('/:conversationId/messages/:messageId', authenticateToken, async (req, res) => {
  const { conversationId, messageId } = req.params
  
  const messages = dmMessageService.getMessages(conversationId, 100)
  const message = messages.find(m => m.id === messageId)
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' })
  }
  
  if (message.userId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot delete others messages' })
  }
  
  await dmMessageService.deleteMessage(conversationId, messageId)
  console.log(`[API] DM message ${messageId} deleted`)
  res.json({ success: true })
})

export default router
