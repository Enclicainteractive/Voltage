import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { deleteMessage as deleteChannelMessage, loadMessages, canViewChannel } from './channelRoutes.js'
import { supportsDirectQuery, directQuery } from '../services/dataService.js'

const router = express.Router()
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

const findMessageContextInMemory = (messageId) => {
  const allMessages = loadMessages()
  if (!allMessages || typeof allMessages !== 'object') return null

  for (const [key, value] of Object.entries(allMessages)) {
    if (Array.isArray(value)) {
      const found = value.find(message => message?.id === messageId)
      if (found) {
        return {
          channelId: found.channelId || key,
          userId: found.userId || null
        }
      }
      continue
    }
    if (value && typeof value === 'object' && value.id === messageId) {
      return {
        channelId: value.channelId || key,
        userId: value.userId || null
      }
    }
  }

  return null
}

const findMessageContext = async (messageId) => {
  if (supportsDirectQuery()) {
    try {
      const rows = await directQuery('SELECT id, channelId, userId FROM messages WHERE id = ? LIMIT 1', [messageId])
      if (Array.isArray(rows) && rows.length > 0) {
        return {
          channelId: rows[0].channelId,
          userId: rows[0].userId || null
        }
      }
    } catch (err) {
      console.error('[MessageRoutes] DB message lookup failed:', err.message)
    }
  }
  return findMessageContextInMemory(messageId)
}

router.delete('/:messageId', authenticateToken, async (req, res) => {
  const messageId = typeof req.params.messageId === 'string' ? req.params.messageId.trim() : ''
  if (!messageId || !MESSAGE_ID_RE.test(messageId)) {
    return res.status(400).json({ error: 'Valid message ID is required' })
  }

  const context = await findMessageContext(messageId)
  if (!context?.channelId) {
    return res.status(404).json({ error: 'Message not found' })
  }

  if (!canViewChannel(context.channelId, req.user.id)) {
    // Do not disclose cross-channel message existence.
    return res.status(404).json({ error: 'Message not found' })
  }

  const result = await deleteChannelMessage(context.channelId, messageId, req.user.id)
  if (!result?.success) {
    if (result?.error === 'Message not found') {
      return res.status(404).json({ error: 'Message not found' })
    }
    if (result?.error === 'Unauthorized') {
      return res.status(403).json({ error: 'Not authorized to delete this message' })
    }
    return res.status(400).json({ error: result?.error || 'Failed to delete message' })
  }

  res.json({ success: true, message: result.message })
})

export default router
