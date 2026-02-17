import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'

const router = express.Router()

const pushSubscriptions = new Map()

router.get('/config', (req, res) => {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || ''
  res.json({
    vapidPublicKey,
    enabled: !!vapidPublicKey
  })
})

router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const { subscription } = req.body
    const userId = req.user.id
    
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' })
    }
    
    pushSubscriptions.set(userId, subscription)
    
    console.log(`[Push] User ${userId} subscribed to push notifications`)
    
    res.json({ success: true })
  } catch (err) {
    console.error('[Push] Subscribe error:', err)
    res.status(500).json({ error: 'Failed to subscribe' })
  }
})

router.delete('/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id
    
    pushSubscriptions.delete(userId)
    
    console.log(`[Push] User ${userId} unsubscribed from push notifications`)
    
    res.json({ success: true })
  } catch (err) {
    console.error('[Push] Unsubscribe error:', err)
    res.status(500).json({ error: 'Failed to unsubscribe' })
  }
})

export function sendPushNotification(userId, data) {
  const subscription = pushSubscriptions.get(userId)
  
  if (!subscription) {
    return
  }
  
  console.log(`[Push] Sending push notification to user ${userId}:`, data)
}

export default router
