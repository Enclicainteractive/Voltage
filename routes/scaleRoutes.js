/**
 * scaleRoutes.js — Internal Node-to-Node Scale API
 *
 * These routes are called BY OTHER VOLTAGE NODES, not by clients.
 * They are protected by the shared scaling.nodeSecret.
 *
 * Public endpoints (no auth, safe to expose):
 *   GET  /api/scale/ping           — liveness check, returns node info
 *
 * Node-to-node endpoints (require x-scale-secret header):
 *   GET  /api/scale/file-exists/:filename — does this node have the file?
 *   GET  /api/scale/status                — full cluster status (admin)
 *   POST /api/scale/nodes/register        — dynamic node self-registration
 *
 * Admin endpoints (require user admin auth):
 *   GET  /api/scale/admin/status          — cluster overview for admin UI
 *   POST /api/scale/admin/refresh         — force heartbeat refresh now
 */

import express from 'express'
import crypto from 'crypto'
import config from '../config/config.js'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { requireAdmin } from '../middleware/adminAuth.js'
import {
  getClusterStatus,
  getAllNodes,
  runHeartbeat,
  existsLocally
} from '../services/scaleService.js'

const router = express.Router()
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const SAFE_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MIN_NODE_SECRET_LENGTH = 16
const WEAK_NODE_SECRETS = new Set([
  'change_me_scaling_secret',
  'changeme',
  'change_me',
  'change-me',
  'default',
  'secret',
  'scale-secret',
  'node-secret',
  'test',
  'dev'
])

const normalizeText = (value, maxLen = 255) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLen) return null
  return normalized
}

const normalizeHeaderValue = (value) => {
  if (Array.isArray(value)) return normalizeText(value[0], 4096)
  return normalizeText(value, 4096)
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isValidNodeUrl = (rawUrl) => {
  const normalized = normalizeText(rawUrl, 2048)
  if (!normalized) return false
  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const safeCompareSecret = (expected, provided) => {
  if (!expected || !provided) return false
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  if (expectedBuffer.length !== providedBuffer.length) return false
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

const hasStrongConfiguredNodeSecret = () => {
  const configuredSecret = normalizeText(config.getNodeSecret(), 4096)
  if (!configuredSecret || configuredSecret.length < MIN_NODE_SECRET_LENGTH) {
    return false
  }
  return !WEAK_NODE_SECRETS.has(configuredSecret.toLowerCase())
}

const hasValidNodeSecret = (req) => {
  if (!config.isScalingEnabled()) return false
  if (!hasStrongConfiguredNodeSecret()) return false

  const configuredSecret = normalizeText(config.getNodeSecret(), 4096)
  const presentedSecret = normalizeHeaderValue(req.headers['x-scale-secret'])

  // Reject merged duplicate headers to avoid ambiguous multi-value parsing.
  if (!presentedSecret || presentedSecret.includes(',')) return false

  return safeCompareSecret(configuredSecret, presentedSecret)
}

// ─── Scale Secret Middleware ──────────────────────────────────────────────────

/**
 * Validates that the request comes from a known peer node by checking the
 * shared scaling.nodeSecret header. Applied to node-to-node endpoints only.
 */
function requireNodeSecret(req, res, next) {
  if (!config.isScalingEnabled()) {
    return res.status(503).json({ error: 'Service unavailable' })
  }

  if (!hasStrongConfiguredNodeSecret()) {
    return res.status(503).json({ error: 'Service unavailable' })
  }

  if (!hasValidNodeSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}

// ─── Public Routes ────────────────────────────────────────────────────────────

/**
 * GET /api/scale/ping
 * Simple liveness check — safe to expose publicly.
 * Other nodes call this to verify this node is up.
 */
router.get('/ping', (req, res) => {
  const trustedPeer = hasValidNodeSecret(req)
  const scaleCfg = config.getScalingConfig()

  const response = {
    ok: true,
    timestamp: Date.now()
  }

  // Only trusted peers get internal topology details.
  if (trustedPeer) {
    response.scalingEnabled = true
    response.nodeId = scaleCfg.nodeId || 'unknown'
    response.nodeUrl = scaleCfg.nodeUrl || config.getServerUrl()
    response.version = config.config.server.version || '1.0.0'
  }

  res.json(response)
})

// ─── Node-to-Node Routes ──────────────────────────────────────────────────────

/**
 * GET /api/scale/file-exists/:filename
 * Peers ask this when they can't find a file locally.
 * Returns whether this node has the file in its uploads directory.
 *
 * CDN note: if this node uses S3/R2, this endpoint will always return false
 * because files aren't stored locally — which is correct, the CDN handles it.
 */
router.get('/file-exists/:filename', requireNodeSecret, (req, res) => {
  const filename = normalizeText(req.params.filename, 255)

  if (!filename || !SAFE_FILENAME_PATTERN.test(filename) || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' })
  }

  const exists = existsLocally(filename)
  const scaleCfg = config.getScalingConfig()

  res.json({
    exists,
    filename,
    nodeId: scaleCfg.nodeId,
    fileUrl: exists
      ? `${scaleCfg.nodeUrl || config.getServerUrl()}/api/upload/file/${encodeURIComponent(filename)}`
      : null
  })
})

/**
 * GET /api/scale/status
 * Returns this node's view of the cluster (registry + health).
 * Called by peer nodes to cross-check their own registry state.
 */
router.get('/status', requireNodeSecret, (req, res) => {
  try {
    const status = getClusterStatus()
    res.json(status)
  } catch (err) {
    console.error('[Scale] Failed to fetch cluster status:', err.message)
    res.status(500).json({ error: 'Failed to fetch cluster status' })
  }
})

/**
 * POST /api/scale/nodes/register
 * Allows a new node to dynamically register itself with all existing nodes.
 * Body: { nodeId, nodeUrl, label }
 *
 * This is optional — nodes already self-register via the shared DB.
 * This endpoint is for in-memory registry refresh across nodes that might
 * be running without DB access (e.g. SQLite per-node, not recommended).
 */
router.post('/nodes/register', requireNodeSecret, (req, res) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: 'Invalid request payload' })
  }

  const nodeId = normalizeText(req.body.nodeId, 128)
  const nodeUrl = normalizeText(req.body.nodeUrl, 2048)

  if (!nodeId || !SAFE_NODE_ID_PATTERN.test(nodeId)) {
    return res.status(400).json({ error: 'Invalid nodeId' })
  }

  if (!nodeUrl || !isValidNodeUrl(nodeUrl)) {
    return res.status(400).json({ error: 'Invalid nodeUrl' })
  }

  // Trigger a fresh heartbeat pass to pick up the new node
  runHeartbeat().catch(err => console.warn('[Scale] Post-register heartbeat failed:', err.message))

  const scaleCfg = config.getScalingConfig()
  res.json({
    ok: true,
    selfNodeId: scaleCfg.nodeId,
    message: 'Registration acknowledged',
    registeredNodeId: nodeId
  })
})

// ─── Admin Routes ─────────────────────────────────────────────────────────────

/**
 * GET /api/scale/admin/status
 * Returns the full cluster status for the admin/owner dashboard.
 * Requires user to be logged in AND have admin privileges.
 */
router.get('/admin/status', authenticateToken, requireAdmin, (req, res) => {
  try {
    const status = getClusterStatus()
    res.json(status)
  } catch (err) {
    console.error('[Scale] Failed to fetch admin status:', err.message)
    res.status(500).json({ error: 'Failed to fetch cluster status' })
  }
})

/**
 * POST /api/scale/admin/refresh
 * Triggers an immediate heartbeat / registry refresh.
 * Useful after adding/removing a node.
 */
router.post('/admin/refresh', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await runHeartbeat()
    const status = getClusterStatus()
    res.json({ ok: true, message: 'Heartbeat completed', ...status })
  } catch (err) {
    console.error('[Scale] Manual refresh failed:', err.message)
    res.status(500).json({ error: 'Refresh failed' })
  }
})

/**
 * GET /api/scale/admin/nodes
 * Returns the current node list with full detail.
 */
router.get('/admin/nodes', authenticateToken, requireAdmin, (req, res) => {
  try {
    const nodes = getAllNodes()
    const scaleCfg = config.getScalingConfig()

    res.json({
      selfNodeId: scaleCfg.nodeId,
      configuredNodes: scaleCfg.nodes || [],
      liveNodes: nodes
    })
  } catch (err) {
    console.error('[Scale] Failed to fetch admin nodes:', err.message)
    res.status(500).json({ error: 'Failed to fetch nodes' })
  }
})

export default router
