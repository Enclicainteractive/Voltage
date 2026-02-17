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

// Get all DM conversations
router.get('/', authenticateToken, (req, res) => {
  const conversations = dmService.getConversations(req.user.id)
  
  const enrichedConversations = conversations.map(conv => {
    const recipientProfile = userService.getUser(conv.recipientId)
    const online = isUserOnline(conv.recipientId)
    const status = online ? (recipientProfile?.status === 'invisible' ? 'invisible' : (recipientProfile?.status || 'online')) : 'offline'
    return {
      ...conv,
      recipient: {
        id: conv.recipientId,
        username: recipientProfile?.username || 'Unknown',
        displayName: recipientProfile?.displayName,
        avatar: getImageUrl(conv.recipientId),
        status
      }
    }
  }).sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
  
  console.log(`[API] Get DMs for ${req.user.username} - ${enrichedConversations.length} conversations`)
  res.json(enrichedConversations)
})

// Create or get DM conversation
router.post('/', authenticateToken, (req, res) => {
  const { userId } = req.body
  
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
  const { limit = 50 } = req.query
  const messages = dmMessageService.getMessages(req.params.conversationId, parseInt(limit))
  
  console.log(`[API] Get DM messages for ${req.params.conversationId} - ${messages.length} messages`)
  res.json(messages)
})

// Send message in DM
router.post('/:conversationId/messages', authenticateToken, (req, res) => {
  const { content, attachments } = req.body
  const conversationId = req.params.conversationId
  
  if (!content?.trim()) {
    return res.status(400).json({ error: 'Message content required' })
  }
  
  const conversations = dmService.getConversations(req.user.id)
  const conversation = conversations.find(c => c.id === conversationId)
  
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  if (blockService.isBlocked(req.user.id, conversation.recipientId)) {
    return res.status(400).json({ error: 'Cannot send message to blocked user' })
  }
  
  const message = {
    id: uuidv4(),
    conversationId,
    userId: req.user.id,
    username: req.user.username,
    avatar: getImageUrl(req.user.id),
    content: content.trim(),
    attachments: attachments || [],
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
