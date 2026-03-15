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
    version: '0.2.0',
    endpoints: {
      catalog: '/api/activities/catalog',
      publicCatalog: '/api/activities/public',
      publish: '/api/activities/publish',
      authorize: '/api/activities/oauth/authorize',
      token: '/api/activities/oauth/token',
      tokenRefresh: '/api/activities/oauth/token/refresh',
      revoke: '/api/activities/oauth/revoke',
      me: '/api/activities/oauth/me',
      scopes: '/api/activities/oauth/scopes',
      appsList: '/api/activities/apps/my',
      appsCreate: '/api/activities/apps',
      appsGet: '/api/activities/apps/:appId',
      appsUpdate: '/api/activities/apps/:appId',
      appsDelete: '/api/activities/apps/:appId',
      manifestGet: '/api/activities/apps/:appId/manifest',
      manifestCreate: '/api/activities/apps/:appId/manifest',
      manifestUpdate: '/api/activities/apps/:appId/manifest',
      manifestDelete: '/api/activities/apps/:appId/manifest',
      manifestValidate: '/api/activities/manifest/validate',
      manifestSchema: '/api/activities/manifest/schema'
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
    },
    manifestSchema: {
      required: ['id', 'name', 'version', 'launch'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9-]+$' },
        name: { type: 'string' },
        version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
        launch: { type: 'object', required: ['url'] },
        features: { type: 'array', items: { enum: ['p2p', 'state-sync', 'voice', 'camera', 'screen-share', 'file-share'] } },
        scopes: { type: 'array', items: { enum: ['activities:read', 'activities:write', 'activities:state:read', 'activities:state:write', 'activities:join', 'activities:p2p', 'activities:voice', 'activities:presence'] } }
      }
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

router.delete('/publish/:activityId', authenticateToken, async (req, res) => {
  try {
    const success = await activityService.deletePublicActivity(req.user.id, req.params.activityId)
    if (!success) return buildError(res, 404, 'Activity not found')
    res.json({ success: true })
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

router.get('/oauth/scopes', async (_req, res) => {
  try {
    const scopes = activityService.getAvailableScopes()
    res.json({ scopes })
  } catch (err) {
    console.error('[Activities] Failed to load scopes:', err)
    buildError(res, 500, 'failed_to_load_scopes')
  }
})

router.post('/oauth/revoke', authenticateToken, async (req, res) => {
  try {
    const { token } = req.body || {}
    if (!token) return buildError(res, 400, 'token_required')

    const result = await activityService.revokeToken(token, req.user.id)
    if (result?.error) return buildError(res, 400, result.error)

    return res.json({ success: true })
  } catch (err) {
    console.error('[Activities] OAuth revocation failed:', err)
    buildError(res, 500, 'oauth_revoke_failed')
  }
})

router.post('/oauth/token/refresh', async (req, res) => {
  try {
    const {
      grant_type: grantType,
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    } = req.body || {}

    if (grantType !== 'refresh_token') {
      return buildError(res, 400, 'unsupported_grant_type')
    }

    if (!clientId || !clientSecret || !refreshToken) {
      return buildError(res, 400, 'client_id, client_secret, refresh_token are required')
    }

    const result = await activityService.refreshAccessToken(refreshToken, clientId, clientSecret)
    if (result?.error) {
      return buildError(res, 400, result.error)
    }

    return res.json(result)
  } catch (err) {
    console.error('[Activities] OAuth token refresh failed:', err)
    buildError(res, 500, 'oauth_refresh_failed')
  }
})

router.get('/apps/:appId', authenticateToken, async (req, res) => {
  try {
    const app = await activityService.getAppById(req.params.appId)
    if (!app) return buildError(res, 404, 'App not found')
    if (app.ownerId !== req.user.id) return buildError(res, 403, 'Not authorized')
    res.json(app)
  } catch (err) {
    console.error('[Activities] Failed to get app:', err)
    buildError(res, 500, 'Failed to get app')
  }
})

router.put('/apps/:appId', authenticateToken, async (req, res) => {
  try {
    const app = await activityService.updateApp(req.user.id, req.params.appId, req.body || {})
    if (!app) return buildError(res, 404, 'App not found or not authorized')
    res.json(app)
  } catch (err) {
    console.error('[Activities] Failed to update app:', err)
    buildError(res, 400, err.message || 'Failed to update app')
  }
})

router.delete('/apps/:appId', authenticateToken, async (req, res) => {
  try {
    const success = await activityService.deleteApp(req.user.id, req.params.appId)
    if (!success) return buildError(res, 404, 'App not found or not authorized')
    res.json({ success: true })
  } catch (err) {
    console.error('[Activities] Failed to delete app:', err)
    buildError(res, 500, 'Failed to delete app')
  }
})

router.get('/apps/:appId/manifest', authenticateToken, async (req, res) => {
  try {
    const app = await activityService.getAppById(req.params.appId)
    if (!app) return buildError(res, 404, 'App not found')
    if (app.ownerId !== req.user.id) return buildError(res, 403, 'Not authorized')

    const manifest = await activityService.getManifest(req.params.appId)
    res.json(manifest || { manifest: null })
  } catch (err) {
    console.error('[Activities] Failed to get manifest:', err)
    buildError(res, 500, 'Failed to get manifest')
  }
})

router.post('/apps/:appId/manifest', authenticateToken, async (req, res) => {
  try {
    const app = await activityService.getAppById(req.params.appId)
    if (!app) return buildError(res, 404, 'App not found')
    if (app.ownerId !== req.user.id) return buildError(res, 403, 'Not authorized')

    const { manifest } = req.body || {}
    if (!manifest) return buildError(res, 400, 'manifest_required')

    const validation = await activityService.validateManifest(manifest)
    if (!validation.valid) {
      return buildError(res, 400, 'invalid_manifest', validation.errors)
    }

    const result = await activityService.createManifest(req.params.appId, req.user.id, manifest)
    if (!result) return buildError(res, 500, 'Failed to create manifest')
    res.status(201).json(result)
  } catch (err) {
    console.error('[Activities] Failed to create manifest:', err)
    buildError(res, 400, err.message || 'Failed to create manifest')
  }
})

router.put('/apps/:appId/manifest', authenticateToken, async (req, res) => {
  try {
    const app = await activityService.getAppById(req.params.appId)
    if (!app) return buildError(res, 404, 'App not found')
    if (app.ownerId !== req.user.id) return buildError(res, 403, 'Not authorized')

    const { manifest } = req.body || {}
    if (!manifest) return buildError(res, 400, 'manifest_required')

    const validation = await activityService.validateManifest(manifest)
    if (!validation.valid) {
      return buildError(res, 400, 'invalid_manifest', validation.errors)
    }

    const result = await activityService.updateManifest(req.params.appId, req.user.id, manifest)
    if (!result) return buildError(res, 404, 'Manifest not found')
    res.json(result)
  } catch (err) {
    console.error('[Activities] Failed to update manifest:', err)
    buildError(res, 400, err.message || 'Failed to update manifest')
  }
})

router.delete('/apps/:appId/manifest', authenticateToken, async (req, res) => {
  try {
    const app = await activityService.getAppById(req.params.appId)
    if (!app) return buildError(res, 404, 'App not found')
    if (app.ownerId !== req.user.id) return buildError(res, 403, 'Not authorized')

    const success = await activityService.deleteManifest(req.params.appId, req.user.id)
    if (!success) return buildError(res, 404, 'Manifest not found')
    res.json({ success: true })
  } catch (err) {
    console.error('[Activities] Failed to delete manifest:', err)
    buildError(res, 500, 'Failed to delete manifest')
  }
})

router.post('/manifest/validate', async (req, res) => {
  try {
    const { manifest } = req.body || {}
    if (!manifest) return buildError(res, 400, 'manifest_required')

    const validation = await activityService.validateManifest(manifest)
    res.json(validation)
  } catch (err) {
    console.error('[Activities] Failed to validate manifest:', err)
    buildError(res, 500, 'Failed to validate manifest')
  }
})

router.get('/manifest/schema', async (_req, res) => {
  try {
    res.json({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['id', 'name', 'version', 'launch'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9-]+$' },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        description: { type: 'string', maxLength: 500 },
        version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
        icon: { type: 'string', format: 'uri' },
        developer: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            website: { type: 'string', format: 'uri' },
            email: { type: 'string', format: 'email' }
          }
        },
        launch: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri' },
            iframe: { type: 'boolean' },
            sizes: {
              type: 'object',
              properties: {
                width: { type: 'number', minimum: 100 },
                height: { type: 'number', minimum: 100 },
                minWidth: { type: 'number', minimum: 100 },
                minHeight: { type: 'number', minimum: 100 },
                maxWidth: { type: 'number', minimum: 100 },
                maxHeight: { type: 'number', minimum: 100 }
              }
            }
          }
        },
        features: {
          type: 'array',
          items: { type: 'string', enum: ['p2p', 'state-sync', 'voice', 'camera', 'screen-share', 'file-share'] },
          uniqueItems: true
        },
        permissions: { type: 'array', items: { type: 'string' } },
        scopes: {
          type: 'array',
          items: { type: 'string', enum: ['activities:read', 'activities:write', 'activities:state:read', 'activities:state:write', 'activities:join', 'activities:p2p', 'activities:voice', 'activities:presence'] },
          uniqueItems: true
        },
        capabilities: {
          type: 'object',
          properties: {
            maxParticipants: { type: 'number', minimum: 1 },
            persistent: { type: 'boolean' },
            offline: { type: 'boolean' }
          }
        }
      }
    })
  } catch (err) {
    console.error('[Activities] Failed to get schema:', err)
    buildError(res, 500, 'Failed to get schema')
  }
})

export default router
