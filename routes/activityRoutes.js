import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { activityService } from '../services/dataService.js'
import { canViewChannel } from './channelRoutes.js'
import { isUserInActiveCall } from '../services/socketService.js'

const router = express.Router()

const buildError = (res, status, error, details = null) => {
  const payload = { error }
  if (details) payload.details = details
  return res.status(status).json(payload)
}

const validateContextAccess = async ({ userId, contextType, contextId }) => {
  if (!contextType || !contextId) return { ok: true }

  if (contextType === 'voice') {
    const canView = await canViewChannel(contextId, userId)
    return canView ? { ok: true } : { ok: false, error: 'You are not in or allowed to use this voice channel' }
  }

  if (contextType === 'call') {
    const inCall = isUserInActiveCall(contextId, userId)
    return inCall ? { ok: true } : { ok: false, error: 'You are not a participant in this call' }
  }

  return { ok: false, error: 'Unsupported context_type' }
}

router.get('/catalog', authenticateToken, async (_req, res) => {
  try {
    const catalog = await activityService.listCatalog()
    res.json({ items: catalog })
  } catch (err) {
    console.error('[Activities] Failed to load catalog:', err)
    buildError(res, 500, 'Failed to load activities')
  }
})

router.get('/sdk/manifest', async (_req, res) => {
  res.json({
    name: 'VAS',
    version: '0.1.0',
    endpoints: {
      catalog: '/api/activities/catalog',
      publicCatalog: '/api/activities/public',
      publish: '/api/activities/publish',
      authorize: '/api/activities/oauth/authorize',
      token: '/api/activities/oauth/token',
      me: '/api/activities/oauth/me'
    },
    socketEvents: {
      emit: [
        'activity:create-session',
        'activity:join-session',
        'activity:leave-session',
        'activity:update-state',
        'activity:emit-event',
        'activity:set-role',
        'activity:p2p-announce',
        'activity:p2p-signal',
        'activity:p2p-leave'
      ],
      receive: [
        'activity:sessions',
        'activity:session-created',
        'activity:state-updated',
        'activity:event',
        'activity:p2p-peers',
        'activity:p2p-signal'
      ]
    }
  })
})

router.get('/public', async (_req, res) => {
  try {
    const items = await activityService.listPublicActivities()
    res.json({ items })
  } catch (err) {
    console.error('[Activities] Failed to load public activities:', err)
    buildError(res, 500, 'Failed to load public activities')
  }
})

router.get('/apps/my', authenticateToken, async (req, res) => {
  try {
    const apps = await activityService.listMyApps(req.user.id)
    res.json({ items: apps })
  } catch (err) {
    console.error('[Activities] Failed to load apps:', err)
    buildError(res, 500, 'Failed to load apps')
  }
})

router.post('/apps', authenticateToken, async (req, res) => {
  try {
    const result = await activityService.createApp(req.user.id, req.body || {})
    res.status(201).json(result)
  } catch (err) {
    console.error('[Activities] Failed to create app:', err)
    buildError(res, 400, err.message || 'Failed to create app')
  }
})

router.post('/publish', authenticateToken, async (req, res) => {
  try {
    const activity = await activityService.createPublicActivity(req.user.id, req.body || {})
    res.status(201).json({ activity })
  } catch (err) {
    console.error('[Activities] Failed to publish public activity:', err)
    buildError(res, 400, err.message || 'Failed to publish activity')
  }
})

router.post('/apps/:appId/rotate-secret', authenticateToken, async (req, res) => {
  try {
    const result = await activityService.rotateClientSecret(req.user.id, req.params.appId)
    if (!result) return buildError(res, 404, 'App not found')
    res.json(result)
  } catch (err) {
    console.error('[Activities] Failed to rotate app secret:', err)
    buildError(res, 500, 'Failed to rotate secret')
  }
})

router.get('/oauth/authorize', authenticateToken, async (req, res) => {
  try {
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType,
      scope = '',
      state = '',
      context_type: contextType,
      context_id: contextId,
      session_id: sessionId,
      format
    } = req.query

    if (responseType !== 'code') {
      return buildError(res, 400, 'unsupported_response_type')
    }

    if (!clientId || !redirectUri) {
      return buildError(res, 400, 'client_id and redirect_uri are required')
    }

    const app = await activityService.getAppByClientId(clientId)
    if (!app) return buildError(res, 400, 'invalid_client')

    if (!app.redirectUris.includes(String(redirectUri))) {
      return buildError(res, 400, 'invalid_redirect_uri')
    }

    const access = await validateContextAccess({
      userId: req.user.id,
      contextType: contextType ? String(contextType) : null,
      contextId: contextId ? String(contextId) : null
    })

    if (!access.ok) return buildError(res, 403, access.error)

    const code = await activityService.createAuthorizationCode({
      clientId,
      userId: req.user.id,
      scope,
      redirectUri: String(redirectUri),
      contextType: contextType ? String(contextType) : null,
      contextId: contextId ? String(contextId) : null,
      sessionId: sessionId ? String(sessionId) : null,
      appId: app.id
    })

    const redirect = new URL(String(redirectUri))
    redirect.searchParams.set('code', code)
    if (state) redirect.searchParams.set('state', String(state))

    if (String(format || '').toLowerCase() === 'json') {
      return res.json({ code, redirect: redirect.toString(), state: state || null })
    }

    return res.redirect(302, redirect.toString())
  } catch (err) {
    console.error('[Activities] OAuth authorize failed:', err)
    buildError(res, 500, 'oauth_authorize_failed')
  }
})

router.post('/oauth/token', async (req, res) => {
  try {
    const {
      grant_type: grantType,
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    } = req.body || {}

    if (grantType !== 'authorization_code') {
      return buildError(res, 400, 'unsupported_grant_type')
    }

    if (!clientId || !clientSecret || !code || !redirectUri) {
      return buildError(res, 400, 'client_id, client_secret, code, redirect_uri are required')
    }

    const result = await activityService.exchangeAuthorizationCode({
      clientId,
      clientSecret,
      code,
      redirectUri
    })

    if (result?.error) {
      return buildError(res, 400, result.error)
    }

    return res.json(result)
  } catch (err) {
    console.error('[Activities] OAuth token exchange failed:', err)
    buildError(res, 500, 'oauth_token_failed')
  }
})

router.get('/oauth/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) return buildError(res, 401, 'missing_token')

    const result = await activityService.introspectAccessToken(token)
    if (!result?.active) return buildError(res, 401, 'invalid_token')

    return res.json(result)
  } catch (err) {
    console.error('[Activities] OAuth introspection failed:', err)
    buildError(res, 500, 'oauth_introspect_failed')
  }
})

export default router
