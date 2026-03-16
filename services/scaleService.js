/**
 * scaleService.js — Horizontal Scaling / Multi-Node Support
 *
 * This is NOT federation. This is the same Voltage instance running across
 * multiple VPS servers, all sharing the same database (MySQL cluster,
 * PostgreSQL with replication, etc.) and the same config.json file.
 *
 * Problem this solves:
 *   User uploads a file → lands on VPS-1.
 *   Another user is routed by HAProxy to VPS-2.
 *   VPS-2 doesn't have the file locally → 404.
 *
 * Solution:
 *   Nodes register themselves in the database's `scale_nodes` table.
 *   When a file isn't found locally, this service asks peer nodes
 *   "hey, do you have this file?" and either proxies or redirects.
 *
 *   Socket.IO cross-node communication is handled by the Redis adapter
 *   (already a dep: @socket.io/redis-adapter) — so sockets just work.
 *
 * If you have S3/R2/CDN configured, file routing is irrelevant since
 * files aren't stored locally anyway. The node registry still matters
 * for admin visibility and health tracking.
 */

import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import config from '../config/config.js'
import { supportsDirectQuery, directQuery } from './dataService.js'
import { cdnService } from './cdnService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  DEGRADED: 'degraded'
}

// In-memory registry — updated by heartbeats. Source of truth is the DB.
const liveRegistry = new Map()

let heartbeatTimer = null
let initialized = false

// ─── Database Schema Bootstrap ────────────────────────────────────────────────

/**
 * Ensure the scale_nodes table exists.
 * We use a raw directQuery so this works regardless of which storage
 * backend is active (SQLite, MySQL, MariaDB, PostgreSQL).
 */
async function ensureSchema() {
  if (!supportsDirectQuery()) return

  try {
    // Try SQLite syntax first, then MySQL/PG-compatible
    const storageType = config.config.storage?.type || 'sqlite'

    if (storageType === 'sqlite') {
      await directQuery(`
        CREATE TABLE IF NOT EXISTS scale_nodes (
          id          TEXT PRIMARY KEY,
          url         TEXT NOT NULL,
          label       TEXT,
          status      TEXT DEFAULT 'online',
          last_seen   INTEGER DEFAULT 0,
          registered_at INTEGER DEFAULT 0,
          metadata    TEXT DEFAULT '{}'
        )
      `)
    } else {
      // MySQL / MariaDB / PostgreSQL compatible
      await directQuery(`
        CREATE TABLE IF NOT EXISTS scale_nodes (
          id            VARCHAR(128) PRIMARY KEY,
          url           VARCHAR(512) NOT NULL,
          label         VARCHAR(255),
          status        VARCHAR(32) DEFAULT 'online',
          last_seen     BIGINT DEFAULT 0,
          registered_at BIGINT DEFAULT 0,
          metadata      TEXT DEFAULT '{}'
        )
      `)
    }

    console.log('[Scale] schema ready (scale_nodes table)')
  } catch (err) {
    console.warn('[Scale] Could not ensure schema:', err.message)
  }
}

// ─── Node Registration ────────────────────────────────────────────────────────

/**
 * Register THIS node into the shared database so peers know it exists.
 * Called on startup and repeated every heartbeatInterval.
 */
async function registerSelf() {
  const scaleCfg = config.getScalingConfig()
  const nodeId = scaleCfg.nodeId
  const nodeUrl = scaleCfg.nodeUrl || config.getServerUrl()

  if (!nodeId || !nodeUrl) {
    console.warn('[Scale] scaling.nodeId or scaling.nodeUrl not set — skipping self-registration')
    return false
  }

  const now = Date.now()

  try {
    if (supportsDirectQuery()) {
      const storageType = config.config.storage?.type || 'sqlite'

      if (storageType === 'sqlite') {
        await directQuery(
          `INSERT OR REPLACE INTO scale_nodes (id, url, label, status, last_seen, registered_at, metadata)
           VALUES (?, ?, ?, ?, ?, COALESCE((SELECT registered_at FROM scale_nodes WHERE id = ?), ?), ?)`,
          [nodeId, nodeUrl, nodeId, NODE_STATUS.ONLINE, now, nodeId, now, JSON.stringify({ port: config.config.server.port })]
        )
      } else {
        // MySQL/MariaDB: INSERT ... ON DUPLICATE KEY UPDATE
        // PostgreSQL: INSERT ... ON CONFLICT DO UPDATE
        try {
          await directQuery(
            `INSERT INTO scale_nodes (id, url, label, status, last_seen, registered_at, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE url=VALUES(url), label=VALUES(label), status=VALUES(status), last_seen=VALUES(last_seen), metadata=VALUES(metadata)`,
            [nodeId, nodeUrl, nodeId, NODE_STATUS.ONLINE, now, now, JSON.stringify({ port: config.config.server.port })]
          )
        } catch {
          // PostgreSQL upsert
          await directQuery(
            `INSERT INTO scale_nodes (id, url, label, status, last_seen, registered_at, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET url=EXCLUDED.url, label=EXCLUDED.label, status=EXCLUDED.status, last_seen=EXCLUDED.last_seen, metadata=EXCLUDED.metadata`,
            [nodeId, nodeUrl, nodeId, NODE_STATUS.ONLINE, now, now, JSON.stringify({ port: config.config.server.port })]
          )
        }
      }
    }

    // Also update in-memory registry
    liveRegistry.set(nodeId, {
      id: nodeId,
      url: nodeUrl,
      label: nodeId,
      status: NODE_STATUS.ONLINE,
      last_seen: now,
      isSelf: true
    })

    return true
  } catch (err) {
    console.error('[Scale] Failed to register self:', err.message)
    return false
  }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * Ping all configured peer nodes, update their status in the DB,
 * and refresh the in-memory registry.
 */
async function runHeartbeat() {
  const scaleCfg = config.getScalingConfig()
  const selfId = scaleCfg.nodeId
  const nodes = scaleCfg.nodes || []
  const secret = scaleCfg.nodeSecret
  const timeout = scaleCfg.heartbeatTimeout || 90000

  // Refresh self registration
  await registerSelf()

  // Ping each configured peer
  for (const node of nodes) {
    if (!node.id || !node.url) continue
    if (node.id === selfId) continue  // don't ping self

    try {
      const response = await axios.get(`${node.url}/api/scale/ping`, {
        headers: { 'x-scale-secret': secret, 'x-node-id': selfId },
        timeout: 5000
      })

      const now = Date.now()
      const peerData = response.data || {}

      const entry = {
        id: node.id,
        url: node.url,
        label: peerData.nodeId || node.id,
        status: NODE_STATUS.ONLINE,
        last_seen: now,
        isSelf: false,
        nodeInfo: peerData
      }

      liveRegistry.set(node.id, entry)
      await persistNodeStatus(node.id, node.url, NODE_STATUS.ONLINE, now)

    } catch (err) {
      const now = Date.now()
      const existing = liveRegistry.get(node.id)

      // Only flip to offline after timeout has elapsed since last_seen
      const lastSeen = existing?.last_seen || 0
      const status = (now - lastSeen > timeout) ? NODE_STATUS.OFFLINE : NODE_STATUS.DEGRADED

      liveRegistry.set(node.id, {
        ...(existing || { id: node.id, url: node.url, label: node.id }),
        status,
        isSelf: false
      })

      await persistNodeStatus(node.id, node.url, status, lastSeen || 0)
      console.warn(`[Scale] Node ${node.id} unreachable (${status}): ${err.message}`)
    }
  }

  // Also load any nodes from DB that weren't in config (dynamic nodes)
  await refreshFromDatabase()
}

async function persistNodeStatus(nodeId, nodeUrl, status, lastSeen) {
  if (!supportsDirectQuery()) return
  try {
    const storageType = config.config.storage?.type || 'sqlite'
    if (storageType === 'sqlite') {
      await directQuery(
        `INSERT OR REPLACE INTO scale_nodes (id, url, status, last_seen, registered_at, metadata)
         VALUES (?, ?, ?, ?, COALESCE((SELECT registered_at FROM scale_nodes WHERE id = ?), ?), '{}')`,
        [nodeId, nodeUrl, status, lastSeen, nodeId, Date.now()]
      )
    } else {
      try {
        await directQuery(
          `INSERT INTO scale_nodes (id, url, status, last_seen, registered_at, metadata)
           VALUES (?, ?, ?, ?, ?, '{}')
           ON DUPLICATE KEY UPDATE url=VALUES(url), status=VALUES(status), last_seen=VALUES(last_seen)`,
          [nodeId, nodeUrl, status, lastSeen, Date.now()]
        )
      } catch {
        await directQuery(
          `INSERT INTO scale_nodes (id, url, status, last_seen, registered_at, metadata)
           VALUES ($1, $2, $3, $4, $5, '{}')
           ON CONFLICT (id) DO UPDATE SET url=EXCLUDED.url, status=EXCLUDED.status, last_seen=EXCLUDED.last_seen`,
          [nodeId, nodeUrl, status, lastSeen, Date.now()]
        )
      }
    }
  } catch (err) {
    // Non-critical — in-memory registry is the fallback
  }
}

/**
 * Load the current node registry from the database into memory.
 */
async function refreshFromDatabase() {
  if (!supportsDirectQuery()) return
  try {
    const rows = await directQuery('SELECT * FROM scale_nodes')
    if (!Array.isArray(rows)) return

    for (const row of rows) {
      const selfId = config.getNodeId()
      // Don't overwrite self entry
      if (row.id === selfId) continue

      liveRegistry.set(row.id, {
        id: row.id,
        url: row.url,
        label: row.label || row.id,
        status: row.status || NODE_STATUS.OFFLINE,
        last_seen: Number(row.last_seen) || 0,
        isSelf: false
      })
    }
  } catch (err) {
    // table might not exist yet on very first boot
  }
}

// ─── File Location ────────────────────────────────────────────────────────────

/**
 * Check if a filename exists on THIS node's active upload directory.
 * Works for local storage and NFS mounts (NFS mounts look like local dirs to the OS).
 * When NFS is configured, cdnService.getUploadDir() returns the NFS mount path,
 * so this check operates on the shared remote disk transparently.
 */
function existsLocally(filename) {
  let uploadsDir
  try {
    uploadsDir = cdnService.getUploadDir()
  } catch {
    uploadsDir = path.join(__dirname, '..', 'uploads')
  }
  return fs.existsSync(path.join(uploadsDir, filename))
}

/**
 * Ask all online peer nodes whether they have a specific file.
 * Returns the first peer node entry that confirms having the file, or null.
 *
 * @param {string} filename  - e.g. "uuid.png"
 * @returns {object|null}    - node entry { id, url, ... } or null
 */
async function findFileOnPeer(filename) {
  const scaleCfg = config.getScalingConfig()
  const secret = scaleCfg.nodeSecret
  const selfId = scaleCfg.nodeId

  // Build list of online peer nodes to query
  const peers = Array.from(liveRegistry.values()).filter(n =>
    !n.isSelf && n.id !== selfId && n.status !== NODE_STATUS.OFFLINE && n.url
  )

  if (peers.length === 0) return null

  // Query all peers in parallel, return first positive
  const checks = peers.map(async (node) => {
    try {
      const response = await axios.get(`${node.url}/api/scale/file-exists/${encodeURIComponent(filename)}`, {
        headers: { 'x-scale-secret': secret, 'x-node-id': selfId },
        timeout: 3000
      })
      if (response.data?.exists === true) {
        return node
      }
    } catch {
      // node unreachable or doesn't have it
    }
    return null
  })

  const results = await Promise.all(checks)
  return results.find(r => r !== null) || null
}

/**
 * Proxy a file from a peer node through THIS node back to the client.
 * Called when fileResolutionMode is "proxy".
 *
 * @param {object} peerNode  - node entry with .url
 * @param {string} filename
 * @param {object} res       - Express response object
 */
async function proxyFileFromPeer(peerNode, filename, res) {
  const scaleCfg = config.getScalingConfig()
  const secret = scaleCfg.nodeSecret
  const selfId = scaleCfg.nodeId

  try {
    const upstream = await axios.get(
      `${peerNode.url}/api/upload/file/${encodeURIComponent(filename)}`,
      {
        headers: { 'x-scale-secret': secret, 'x-node-id': selfId },
        responseType: 'stream',
        timeout: 30000
      }
    )

    // Forward content headers
    const ct = upstream.headers['content-type']
    const cl = upstream.headers['content-length']
    const cc = upstream.headers['cache-control']

    if (ct) res.setHeader('Content-Type', ct)
    if (cl) res.setHeader('Content-Length', cl)
    if (cc) res.setHeader('Cache-Control', cc)
    res.setHeader('X-Served-By-Node', peerNode.id)
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')

    upstream.data.pipe(res)
  } catch (err) {
    console.error(`[Scale] Proxy from ${peerNode.id} failed:`, err.message)
    if (!res.headersSent) {
      res.status(502).json({ error: 'Peer node unreachable', nodeId: peerNode.id })
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all nodes from the in-memory registry.
 * @returns {Array} Array of node objects
 */
function getAllNodes() {
  return Array.from(liveRegistry.values())
}

/**
 * Get only currently-online nodes (not self).
 */
function getOnlineNodes() {
  const selfId = config.getNodeId()
  return Array.from(liveRegistry.values()).filter(
    n => n.status === NODE_STATUS.ONLINE && n.id !== selfId
  )
}

/**
 * Return a simple status summary suitable for admin API responses.
 */
function getClusterStatus() {
  const scaleCfg = config.getScalingConfig()
  const nodes = getAllNodes()
  const online = nodes.filter(n => n.status === NODE_STATUS.ONLINE).length
  const offline = nodes.filter(n => n.status === NODE_STATUS.OFFLINE).length
  const degraded = nodes.filter(n => n.status === NODE_STATUS.DEGRADED).length

  return {
    enabled: scaleCfg.enabled || false,
    selfNodeId: scaleCfg.nodeId || null,
    selfNodeUrl: scaleCfg.nodeUrl || config.getServerUrl(),
    fileResolutionMode: scaleCfg.fileResolutionMode || 'proxy',
    nodes: nodes.map(n => ({
      id: n.id,
      url: n.url,
      label: n.label || n.id,
      status: n.status,
      last_seen: n.last_seen,
      isSelf: n.isSelf || false
    })),
    summary: { total: nodes.length, online, offline, degraded }
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Boot the scale service. Called from server.js on startup.
 * No-ops silently if scaling is not enabled.
 */
async function init() {
  if (initialized) return
  initialized = true

  if (!config.isScalingEnabled()) {
    return
  }

  const scaleCfg = config.getScalingConfig()

  if (!scaleCfg.nodeId) {
    console.warn('[Scale] scaling.enabled=true but scaling.nodeId is not set. Scaling will not function correctly.')
    return
  }

  console.log(`[Scale] Initializing node "${scaleCfg.nodeId}" at ${scaleCfg.nodeUrl || config.getServerUrl()}`)

  await ensureSchema()
  await registerSelf()
  await refreshFromDatabase()

  // Initial heartbeat pass
  await runHeartbeat()

  // Schedule recurring heartbeats
  const interval = scaleCfg.heartbeatInterval || 30000
  heartbeatTimer = setInterval(runHeartbeat, interval)

  console.log(`[Scale] Node registry active — ${liveRegistry.size} node(s) known, heartbeat every ${interval / 1000}s`)
}

/**
 * Graceful shutdown — mark self as offline before dying.
 */
async function shutdown() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  const selfId = config.getNodeId()
  if (!selfId || !supportsDirectQuery()) return

  try {
    await directQuery('UPDATE scale_nodes SET status = ? WHERE id = ?', [NODE_STATUS.OFFLINE, selfId])
    console.log('[Scale] Marked self as offline in registry')
  } catch {
    // best-effort
  }
}

export {
  init,
  shutdown,
  existsLocally,
  findFileOnPeer,
  proxyFileFromPeer,
  getAllNodes,
  getOnlineNodes,
  getClusterStatus,
  runHeartbeat,
  NODE_STATUS
}

export default {
  init,
  shutdown,
  existsLocally,
  findFileOnPeer,
  proxyFileFromPeer,
  getAllNodes,
  getOnlineNodes,
  getClusterStatus,
  runHeartbeat,
  NODE_STATUS
}
