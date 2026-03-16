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
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import config from '../config/config.js'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { requireAdmin } from '../middleware/adminAuth.js'
import {
  getClusterStatus,
  getAllNodes,
  runHeartbeat,
  existsLocally
} from '../services/scaleService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = express.Router()

// ─── Scale Secret Middleware ──────────────────────────────────────────────────

/**
 * Validates that the request comes from a known peer node by checking the
 * shared scaling.nodeSecret header. Applied to node-to-node endpoints only.
 */
function requireNodeSecret(req, res, next) {
  if (!config.isScalingEnabled()) {
    return res.status(503).json({ error: 'Scaling not enabled on this node' })
  }

  const secret = config.getNodeSecret()
  const presented = req.headers['x-scale-secret']

  if (!secret || !presented || presented !== secret) {
    return res.status(401).json({ error: 'Invalid or missing node secret' })
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
  const scaleCfg = config.getScalingConfig()
  res.json({
    ok: true,
    nodeId: scaleCfg.nodeId || 'unknown',
    nodeUrl: scaleCfg.nodeUrl || config.getServerUrl(),
    serverName: config.config.server.name || 'Volt',
    version: config.config.server.version || '1.0.0',
    timestamp: Date.now(),
    scalingEnabled: config.isScalingEnabled()
  })
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
  const { filename } = req.params

  // Basic path traversal guard
  const safe = path.basename(filename)
  if (safe !== filename || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' })
  }

  const exists = existsLocally(safe)
  const scaleCfg = config.getScalingConfig()

  res.json({
    exists,
    filename: safe,
    nodeId: scaleCfg.nodeId,
    fileUrl: exists
      ? `${scaleCfg.nodeUrl || config.getServerUrl()}/api/upload/file/${safe}`
      : null
  })
})

/**
 * GET /api/scale/status
 * Returns this node's view of the cluster (registry + health).
 * Called by peer nodes to cross-check their own registry state.
 */
router.get('/status', requireNodeSecret, (req, res) => {
  const status = getClusterStatus()
  res.json(status)
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
  const { nodeId, nodeUrl, label } = req.body

  if (!nodeId || !nodeUrl) {
    return res.status(400).json({ error: 'nodeId and nodeUrl are required' })
  }

  // Trigger a fresh heartbeat pass to pick up the new node
  runHeartbeat().catch(err => console.warn('[Scale] Post-register heartbeat failed:', err.message))

  const scaleCfg = config.getScalingConfig()
  res.json({
    ok: true,
    selfNodeId: scaleCfg.nodeId,
    message: `Acknowledged registration of ${nodeId}`
  })
})

// ─── Admin Routes ─────────────────────────────────────────────────────────────

/**
 * GET /api/scale/admin/status
 * Returns the full cluster status for the admin/owner dashboard.
 * Requires user to be logged in AND have admin privileges.
 */
router.get('/admin/status', authenticateToken, requireAdmin, (req, res) => {
  const status = getClusterStatus()
  res.json(status)
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
    res.status(500).json({ error: 'Refresh failed', message: err.message })
  }
})

/**
 * GET /api/scale/admin/nodes
 * Returns the current node list with full detail.
 */
router.get('/admin/nodes', authenticateToken, requireAdmin, (req, res) => {
  const nodes = getAllNodes()
  const scaleCfg = config.getScalingConfig()

  res.json({
    selfNodeId: scaleCfg.nodeId,
    configuredNodes: scaleCfg.nodes || [],
    liveNodes: nodes
  })
})

export default router
