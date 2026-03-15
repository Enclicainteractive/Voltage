import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { userService } from '../services/dataService.js'

const router = express.Router()

router.get('/', authenticateToken, async (req, res) => {
  try {
    const user = await userService.getUser(req.user.id)
    const settings = user?.notificationSettings || { serverMutes: [], dmMutes: [] }
    res.json(settings)
  } catch (err) {
    console.error('[Notifications] Error getting settings:', err)
    res.status(500).json({ error: 'Failed to get notification settings' })
  }
})

router.post('/server/:serverId/mute', authenticateToken, async (req, res) => {
  const { serverId } = req.params
  const { muted, duration } = req.body
  
  try {
    const user = await userService.getUser(req.user.id)
    const settings = user?.notificationSettings || { serverMutes: [], dmMutes: [] }
    let serverMutes = settings.serverMutes || []
    
    if (muted) {
      const muteEntry = { serverId, mutedAt: new Date().toISOString() }
      if (duration) {
        muteEntry.expiresAt = new Date(Date.now() + duration).toISOString()
      }
      serverMutes = serverMutes.filter(m => m.serverId !== serverId)
      serverMutes.push(muteEntry)
    } else {
      serverMutes = serverMutes.filter(m => m.serverId !== serverId)
    }
    
    settings.serverMutes = serverMutes
    await userService.updateUser(req.user.id, { notificationSettings: settings })
    
    res.json({ success: true, serverMutes })
  } catch (err) {
    console.error('[Notifications] Error muting server:', err)
    res.status(500).json({ error: 'Failed to mute server' })
  }
})

router.get('/server/:serverId/mute', authenticateToken, async (req, res) => {
  const { serverId } = req.params
  
  try {
    const user = await userService.getUser(req.user.id)
    const settings = user?.notificationSettings || { serverMutes: [], dmMutes: [] }
    const serverMutes = settings.serverMutes || []
    const mute = serverMutes.find(m => m.serverId === serverId)
    
    if (!mute) {
      return res.json({ muted: false })
    }
    
    if (mute.expiresAt && new Date(mute.expiresAt) < new Date()) {
      const newMutes = serverMutes.filter(m => m.serverId !== serverId)
      settings.serverMutes = newMutes
      await userService.updateUser(req.user.id, { notificationSettings: settings })
      return res.json({ muted: false })
    }
    
    res.json({ muted: true, ...mute })
  } catch (err) {
    console.error('[Notifications] Error getting mute status:', err)
    res.status(500).json({ error: 'Failed to get mute status' })
  }
})

router.post('/dm/:conversationId/mute', authenticateToken, async (req, res) => {
  const { conversationId } = req.params
  const { muted, duration } = req.body
  
  try {
    const user = await userService.getUser(req.user.id)
    const settings = user?.notificationSettings || { serverMutes: [], dmMutes: [] }
    let dmMutes = settings.dmMutes || []
    
    if (muted) {
      const muteEntry = { conversationId, mutedAt: new Date().toISOString() }
      if (duration) {
        muteEntry.expiresAt = new Date(Date.now() + duration).toISOString()
      }
      dmMutes = dmMutes.filter(m => m.conversationId !== conversationId)
      dmMutes.push(muteEntry)
    } else {
      dmMutes = dmMutes.filter(m => m.conversationId !== conversationId)
    }
    
    settings.dmMutes = dmMutes
    await userService.updateUser(req.user.id, { notificationSettings: settings })
    
    res.json({ success: true, dmMutes })
  } catch (err) {
    console.error('[Notifications] Error muting DM:', err)
    res.status(500).json({ error: 'Failed to mute DM' })
  }
})

router.get('/dm/:conversationId/mute', authenticateToken, async (req, res) => {
  const { conversationId } = req.params
  
  try {
    const user = await userService.getUser(req.user.id)
    const settings = user?.notificationSettings || { serverMutes: [], dmMutes: [] }
    const dmMutes = settings.dmMutes || []
    const mute = dmMutes.find(m => m.conversationId === conversationId)
    
    if (!mute) {
      return res.json({ muted: false })
    }
    
    if (mute.expiresAt && new Date(mute.expiresAt) < new Date()) {
      const newMutes = dmMutes.filter(m => m.conversationId !== conversationId)
      settings.dmMutes = newMutes
      await userService.updateUser(req.user.id, { notificationSettings: settings })
      return res.json({ muted: false })
    }
    
    res.json({ muted: true, ...mute })
  } catch (err) {
    console.error('[Notifications] Error getting mute status:', err)
    res.status(500).json({ error: 'Failed to get mute status' })
  }
})

router.get('/is-muted/:type/:id', authenticateToken, async (req, res) => {
  const { type, id } = req.params
  
  try {
    const user = await userService.getUser(req.user.id)
    const settings = user?.notificationSettings || { serverMutes: [], dmMutes: [] }
    
    if (type === 'server') {
      const mutes = settings.serverMutes || []
      const mute = mutes.find(m => m.serverId === id)
      if (!mute) return res.json({ muted: false })
      if (mute.expiresAt && new Date(mute.expiresAt) < new Date()) {
        return res.json({ muted: false })
      }
      return res.json({ muted: true })
    } else if (type === 'dm') {
      const mutes = settings.dmMutes || []
      const mute = mutes.find(m => m.conversationId === id)
      if (!mute) return res.json({ muted: false })
      if (mute.expiresAt && new Date(mute.expiresAt) < new Date()) {
        return res.json({ muted: false })
      }
      return res.json({ muted: true })
    }
    
    res.json({ muted: false })
  } catch (err) {
    console.error('[Notifications] Error checking mute status:', err)
    res.status(500).json({ error: 'Failed to check mute status' })
  }
})

export default router
