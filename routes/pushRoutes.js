import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'

const router = express.Router()
const MAX_ENDPOINT_LENGTH = 2048
const MAX_PUSH_KEY_LENGTH = 512

// userId -> Map<subscriptionKey, subscription>
const pushSubscriptions = new Map()
// endpoint -> userId (prevents cross-account endpoint takeover)
const endpointOwners = new Map()

const getUserSubscriptions = (userId) => {
  let subscriptions = pushSubscriptions.get(userId)
  if (!subscriptions) {
    subscriptions = new Map()
    pushSubscriptions.set(userId, subscriptions)
  }
  return subscriptions
}

const validatePushKeys = (keys) => {
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    return { error: 'Invalid push keys' }
  }
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : ''
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : ''

  if (!auth || !p256dh) {
    return { error: 'Missing push keys' }
  }
  if (auth.length > MAX_PUSH_KEY_LENGTH || p256dh.length > MAX_PUSH_KEY_LENGTH) {
    return { error: 'Invalid push keys' }
  }

  return { auth, p256dh }
}

const normalizeEndpoint = (rawEndpoint) => {
  if (rawEndpoint == null || rawEndpoint === '') {
    return { endpoint: '' }
  }

  if (typeof rawEndpoint !== 'string') {
    return { error: 'Invalid subscription endpoint' }
  }

  const endpoint = rawEndpoint.trim()
  if (!endpoint) {
    return { endpoint: '' }
  }

  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    return { error: 'Invalid subscription endpoint' }
  }

  try {
    const endpointUrl = new URL(endpoint)
    if (endpointUrl.protocol !== 'https:') {
      return { error: 'Invalid subscription endpoint' }
    }

    // Canonicalize so equivalent URL variants cannot bypass endpoint ownership checks.
    endpointUrl.hash = ''
    return { endpoint: endpointUrl.toString() }
  } catch {
    return { error: 'Invalid subscription endpoint' }
  }
}

const normalizeSubscriptionPayload = (rawSubscription, userId) => {
  if (!rawSubscription || typeof rawSubscription !== 'object' || Array.isArray(rawSubscription)) {
    return { status: 400, error: 'Invalid subscription' }
  }

  const embeddedUserId = rawSubscription.userId
  if (embeddedUserId != null && String(embeddedUserId).trim() !== userId) {
    return { status: 403, error: 'Subscription user mismatch' }
  }

  const endpointResult = normalizeEndpoint(rawSubscription.endpoint)
  if (endpointResult.error) {
    return { status: 400, error: endpointResult.error }
  }
  const endpoint = endpointResult.endpoint
  const desktop = rawSubscription.desktop === true

  if (!endpoint && !desktop) {
    return { status: 400, error: 'Invalid subscription' }
  }

  const normalized = {
    endpoint: endpoint || undefined,
    desktop
  }

  if (endpoint && !desktop) {
    const keys = validatePushKeys(rawSubscription.keys)
    if (keys.error) {
      return { status: 400, error: keys.error }
    }
    normalized.keys = {
      auth: keys.auth,
      p256dh: keys.p256dh
    }
  } else if (rawSubscription.keys) {
    const keys = validatePushKeys(rawSubscription.keys)
    if (keys.error) {
      return { status: 400, error: keys.error }
    }
    normalized.keys = {
      auth: keys.auth,
      p256dh: keys.p256dh
    }
  }

  if (rawSubscription.expirationTime != null) {
    const expirationTime = Number(rawSubscription.expirationTime)
    if (!Number.isFinite(expirationTime) || expirationTime <= 0) {
      return { status: 400, error: 'Invalid expiration time' }
    }
    normalized.expirationTime = expirationTime
  }

  const subscriptionKey = endpoint || 'desktop'
  return { subscription: normalized, subscriptionKey }
}

router.get('/config', (req, res) => {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || ''
  res.json({
    vapidPublicKey,
    enabled: !!vapidPublicKey
  })
})

router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const rawSubscription = req.body?.subscription || req.body
    const userId = req.user.id

    const normalized = normalizeSubscriptionPayload(rawSubscription, userId)
    if (normalized.error) {
      return res.status(normalized.status || 400).json({ error: normalized.error })
    }

    const { subscription, subscriptionKey } = normalized

    if (subscription.endpoint) {
      const owner = endpointOwners.get(subscription.endpoint)
      if (owner && owner !== userId) {
        return res.status(409).json({ error: 'Subscription endpoint already registered to another user' })
      }
    }

    const userSubscriptions = getUserSubscriptions(userId)
    const existing = userSubscriptions.get(subscriptionKey)
    if (existing?.endpoint && existing.endpoint !== subscription.endpoint) {
      endpointOwners.delete(existing.endpoint)
    }

    userSubscriptions.set(subscriptionKey, subscription)
    if (subscription.endpoint) {
      endpointOwners.set(subscription.endpoint, userId)
    }

    console.log(`[Push] User ${userId} subscribed (${userSubscriptions.size} active push subscription(s))`)
    
    res.json({ success: true })
  } catch (err) {
    console.error('[Push] Subscribe error:', err)
    res.status(500).json({ error: 'Failed to subscribe' })
  }
})

router.delete('/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id
    const rawEndpoint = typeof req.body?.endpoint === 'string'
      ? req.body.endpoint
      : (typeof req.query?.endpoint === 'string' ? req.query.endpoint : '')
    const endpointResult = normalizeEndpoint(rawEndpoint)
    if (endpointResult.error) {
      return res.status(400).json({ error: endpointResult.error })
    }
    const endpoint = endpointResult.endpoint
    const userSubscriptions = pushSubscriptions.get(userId)

    if (!userSubscriptions || userSubscriptions.size === 0) {
      return res.json({ success: true })
    }

    if (endpoint) {
      const owner = endpointOwners.get(endpoint)
      if (owner && owner !== userId) {
        return res.status(403).json({ error: 'Not authorized to unsubscribe this endpoint' })
      }

      userSubscriptions.delete(endpoint)
      endpointOwners.delete(endpoint)

      if (userSubscriptions.size === 0) {
        pushSubscriptions.delete(userId)
      }

      console.log(`[Push] User ${userId} unsubscribed one endpoint`)
      return res.json({ success: true })
    }

    for (const sub of userSubscriptions.values()) {
      if (sub?.endpoint) {
        endpointOwners.delete(sub.endpoint)
      }
    }
    pushSubscriptions.delete(userId)

    console.log(`[Push] User ${userId} unsubscribed all push subscriptions`)
    
    res.json({ success: true })
  } catch (err) {
    console.error('[Push] Unsubscribe error:', err)
    res.status(500).json({ error: 'Failed to unsubscribe' })
  }
})

export function sendPushNotification(userId, data) {
  const subscriptions = pushSubscriptions.get(userId)
  
  if (!subscriptions || subscriptions.size === 0) {
    return
  }
  
  console.log(`[Push] Sending push notification to user ${userId} (${subscriptions.size} subscription(s))`)
}

export default router
