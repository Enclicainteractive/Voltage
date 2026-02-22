import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { 
  dmService, 
  dmMessageService, 
  userService,
  blockService 
} from '../services/dataService.js'
import { isUserOnline } from '../services/socketService.js'
import config from '../config/config.js'

const getImageUrl = (userId) => {
  const imageServerUrl = config.getImageServerUrl()
  return `${imageServerUrl}/api/images/users/${userId}/profile`
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
router.get('/', authenticateToken, (req, res) => {
  const { search } = req.query
  let conversations = dmService.getConversations(req.user.id)
  
  let enrichedConversations = conversations.map(conv => {
    const participantIds = Array.isArray(conv.participants)
      ? conv.participants
      : [req.user.id, conv.recipientId].filter(Boolean)
    const otherIds = participantIds.filter(id => id !== req.user.id)
    const isGroup = !!conv.isGroup || otherIds.length > 1

    const recipients = otherIds.map(id => {
      const profile = userService.getUser(id)
      const online = isUserOnline(id)
      const status = online ? (profile?.status === 'invisible' ? 'invisible' : (profile?.status || 'online')) : 'offline'
      return {
        id,
        username: profile?.username || 'Unknown',
        displayName: profile?.displayName,
        customUsername: profile?.customUsername,
        avatar: getImageUrl(id),
        status
      }
    })
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
  })
  
  // Filter by search query if provided
  if (search && search.trim()) {
    const searchLower = search.toLowerCase().trim()
    enrichedConversations = enrichedConversations.filter(conv => {
      if (conv.isGroup) {
        const groupName = conv.groupName?.toLowerCase() || ''
        const title = conv.title?.toLowerCase() || ''
        const memberMatch = (conv.recipients || []).some(r =>
          (r.username || '').toLowerCase().includes(searchLower) ||
          (r.displayName || '').toLowerCase().includes(searchLower) ||
          (r.customUsername || '').toLowerCase().includes(searchLower)
        )
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
router.get('/search', authenticateToken, (req, res) => {
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
  const results = Object.values(allUsers)
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
    .slice(0, 20) // Limit results
    .map(user => {
      const online = isUserOnline(user.id)
      const status = online ? (user.status === 'invisible' ? 'invisible' : (user.status || 'online')) : 'offline'
      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        customUsername: user.customUsername,
        avatar: getImageUrl(user.id),
        status,
        hasExistingDM: existingRecipientIds.has(user.id)
      }
    })
  
  console.log(`[API] DM user search for "${q}" - ${results.length} results`)
  res.json(results)
})

// Create or get DM conversation
router.post('/', authenticateToken, (req, res) => {
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
      const conversation = dmService.createGroupConversation(req.user.id, ids, groupName)
      const recipients = conversation.participants
        .filter(id => id !== req.user.id)
        .map(id => {
          const profile = userService.getUser(id)
          const online = isUserOnline(id)
          const status = online ? (profile?.status === 'invisible' ? 'invisible' : (profile?.status || 'online')) : 'offline'
          return {
            id,
            username: profile?.username || 'Unknown',
            displayName: profile?.displayName,
            customUsername: profile?.customUsername,
            avatar: getImageUrl(id),
            status
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
  
  const conversation = dmService.getOrCreateConversation(req.user.id, userId)
  const recipientProfile = userService.getUser(userId)
  const online = isUserOnline(userId)
  const status = online ? (recipientProfile?.status === 'invisible' ? 'invisible' : (recipientProfile?.status || 'online')) : 'offline'
  
  userService.saveUser(req.user.id, {
    username: req.user.username
  })
  
  console.log(`[API] DM conversation created/retrieved between ${req.user.id} and ${userId}`)
  res.json({
    ...conversation,
    recipient: {
      id: userId,
      username: recipientProfile?.username || 'Unknown',
      displayName: recipientProfile?.displayName,
      avatar: getImageUrl(userId),
      status
    }
  })
})

// Get messages for a DM conversation
router.get('/:conversationId/messages', authenticateToken, (req, res) => {
  const { limit = 50, search } = req.query
  let messages = dmMessageService.getMessages(req.params.conversationId, parseInt(limit))
  
  // Filter by search query if provided
  if (search && search.trim()) {
    const searchLower = search.toLowerCase().trim()
    messages = messages.filter(msg => 
      msg.content?.toLowerCase().includes(searchLower) ||
      msg.username?.toLowerCase().includes(searchLower)
    )
  }
  
  const all = dmMessageService.getAllMessages()
  const conversationMessages = Array.isArray(all?.[req.params.conversationId]) ? all[req.params.conversationId] : []
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
          avatar: getImageUrl(id)
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
router.post('/:conversationId/messages', authenticateToken, (req, res) => {
  const { content, attachments, replyTo } = req.body
  const conversationId = req.params.conversationId
  
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
    const others = (conversation.participants || []).filter(id => id !== req.user.id)
    if (others.some(id => blockService.isBlocked(req.user.id, id))) {
      return res.status(400).json({ error: 'Cannot send message to one or more blocked users in this group' })
    }
  }
  
  const message = {
    id: uuidv4(),
    conversationId,
    userId: req.user.id,
    username: req.user.username,
    avatar: getImageUrl(req.user.id),
    content: content.trim(),
    attachments: attachments || [],
    replyTo: buildDMReplyReference(dmMessageService.getAllMessages()?.[conversationId] || [], replyTo),
    timestamp: new Date().toISOString()
  }
  
  dmMessageService.addMessage(conversationId, message)
  dmService.updateLastMessage(conversationId, req.user.id, conversation.recipientId)
  
  console.log(`[API] DM message sent in ${conversationId}`)
  res.status(201).json(message)
})

// Edit DM message
router.put('/:conversationId/messages/:messageId', authenticateToken, (req, res) => {
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
  
  const updated = dmMessageService.editMessage(conversationId, messageId, content.trim())
  console.log(`[API] DM message ${messageId} edited`)
  res.json(updated)
})

// Delete DM message
router.delete('/:conversationId/messages/:messageId', authenticateToken, (req, res) => {
  const { conversationId, messageId } = req.params
  
  const messages = dmMessageService.getMessages(conversationId, 100)
  const message = messages.find(m => m.id === messageId)
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' })
  }
  
  if (message.userId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot delete others messages' })
  }
  
  dmMessageService.deleteMessage(conversationId, messageId)
  console.log(`[API] DM message ${messageId} deleted`)
  res.json({ success: true })
})

export default router
