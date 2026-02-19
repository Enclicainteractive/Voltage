/**
 * systemMessageScheduler.js
 *
 * Background scheduler that periodically checks for conditions that should
 * trigger system messages to users or admins/owners.
 *
 * Current checks:
 *  1. Voltage update check — polls GitHub Releases API for Voltage backend
 *     and notifies admins/owners when a newer version is available.
 *
 * More triggers (account standing, discovery status) are exposed as helper
 * functions so other parts of Voltage can call them directly.
 */

import config from '../config/config.js'
import { userService, systemMessageService } from './dataService.js'

// GitHub repo for Voltage backend releases
const VOLTAGE_REPO = 'Enclicainteractive/Voltage'
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${VOLTAGE_REPO}/releases/latest`

// How often to poll for updates (default: every 6 hours)
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// io instance — set via init()
let _io = null

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Parse a semver-ish tag like "v1.2.3" or "1.2.3" into [major, minor, patch].
 */
function parseVersion(v) {
  const clean = String(v).replace(/^v/i, '').trim()
  const parts = clean.split('.').map(n => parseInt(n, 10) || 0)
  while (parts.length < 3) parts.push(0)
  return parts
}

/**
 * Returns true if versionA is strictly newer than versionB.
 */
function isNewer(versionA, versionB) {
  const [aMaj, aMin, aPat] = parseVersion(versionA)
  const [bMaj, bMin, bPat] = parseVersion(versionB)
  if (aMaj !== bMaj) return aMaj > bMaj
  if (aMin !== bMin) return aMin > bMin
  return aPat > bPat
}

// ---------------------------------------------------------------------------
// GitHub release fetch
// ---------------------------------------------------------------------------

async function fetchLatestRelease() {
  try {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        'User-Agent': 'Voltage-Server/1.0',
        'Accept': 'application/vnd.github+json'
      },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      tag: data.tag_name,          // e.g. "v1.2.0"
      name: data.name || data.tag_name,
      url: data.html_url,
      publishedAt: data.published_at,
      body: (data.body || '').slice(0, 500)  // first 500 chars of release notes
    }
  } catch (err) {
    console.warn('[SystemScheduler] GitHub check failed:', err.message)
    return null
  }
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

async function checkForVoltageUpdate() {
  const currentVersion = config.config?.server?.version || '1.0.0'
  const release = await fetchLatestRelease()
  if (!release) return

  if (!isNewer(release.tag, currentVersion)) {
    console.log(`[SystemScheduler] Voltage is up to date (${currentVersion})`)
    return
  }

  console.log(`[SystemScheduler] New Voltage release detected: ${release.tag} (current: ${currentVersion})`)

  // Find all platform-level admins and owners
  const admins = userService.getAllUsers().filter(u => {
    const role = u.adminRole || u.role
    return role === 'admin' || role === 'owner' || u.isAdmin === true
  })

  if (admins.length === 0) return

  const dedupeKey = `voltage_update_${release.tag}`
  const created = systemMessageService.send({
    category: 'update',
    title: `Voltage ${release.tag} is available`,
    body: [
      `A new version of **Voltage** is available. You are currently running **v${currentVersion}**.`,
      '',
      release.body ? `**Release notes:**\n${release.body}` : '',
      '',
      `[View release on GitHub](${release.url})`
    ].filter(l => l !== undefined).join('\n').trim(),
    icon: 'RefreshCw',
    severity: 'info',
    dedupeKey,
    meta: {
      currentVersion,
      newVersion: release.tag,
      releaseUrl: release.url,
      publishedAt: release.publishedAt
    },
    recipients: admins.map(u => u.id)
  })

  // Push live socket notification to online admins
  if (_io && created.length > 0) {
    for (const msg of created) {
      _io.to(`user:${msg.userId}`).emit('system:message', {
        id: msg.id,
        category: msg.category,
        title: msg.title,
        body: msg.body,
        icon: msg.icon,
        severity: msg.severity,
        meta: msg.meta,
        read: false,
        createdAt: msg.createdAt
      })
    }
    console.log(`[SystemScheduler] Sent update notice to ${created.length} admin(s)`)
  }
}

// ---------------------------------------------------------------------------
// Public trigger helpers — call these from route handlers or other services
// ---------------------------------------------------------------------------

/**
 * Notify a user about their account standing (e.g. warning, suspension).
 */
export function sendAccountStandingMessage({ userId, title, body, severity = 'warning', meta }) {
  const created = systemMessageService.send({
    category: 'account',
    title,
    body,
    icon: severity === 'error' ? 'ShieldAlert' : 'Shield',
    severity,
    recipients: [userId],
    meta
  })
  if (_io && created.length > 0) {
    _io.to(`user:${userId}`).emit('system:message', created[0])
  }
}

/**
 * Notify a server owner/admin about the status of their discovery application.
 */
export function sendDiscoveryStatusMessage({ userId, serverId, serverName, status, reason }) {
  const approved = status === 'approved'
  const created = systemMessageService.send({
    category: 'discovery',
    title: approved
      ? `${serverName} has been approved for Discovery`
      : `${serverName} discovery application update`,
    body: approved
      ? `Your server **${serverName}** has been approved and is now listed in the server discovery directory.`
      : `Your server **${serverName}** discovery application was **${status}**.${reason ? `\n\n**Reason:** ${reason}` : ''}`,
    icon: approved ? 'Search' : 'SearchX',
    severity: approved ? 'success' : 'warning',
    recipients: [userId],
    dedupeKey: `discovery_${serverId}_${status}_${Date.now()}`,
    meta: { serverId, serverName, status, reason }
  })
  if (_io && created.length > 0) {
    _io.to(`user:${userId}`).emit('system:message', created[0])
  }
}

/**
 * Broadcast an announcement to all users or a specific audience.
 * @param {'all'|string[]} recipients  'all' or array of user IDs
 */
export function sendAnnouncement({ title, body, severity = 'info', recipients = 'all', icon, meta, dedupeKey }) {
  let targetIds
  if (recipients === 'all') {
    targetIds = userService.getAllUsers().map(u => u.id)
  } else {
    targetIds = recipients
  }

  const created = systemMessageService.send({
    category: 'announcement',
    title,
    body,
    icon: icon || 'Megaphone',
    severity,
    dedupeKey,
    meta,
    recipients: targetIds
  })

  if (_io && created.length > 0) {
    for (const msg of created) {
      _io.to(`user:${msg.userId}`).emit('system:message', {
        id: msg.id, category: msg.category, title: msg.title,
        body: msg.body, icon: msg.icon, severity: msg.severity,
        meta: msg.meta, read: false, createdAt: msg.createdAt
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler lifecycle
// ---------------------------------------------------------------------------

let _updateCheckTimer = null

/**
 * Start the scheduler.
 * @param {object} io  socket.io Server instance
 */
export function startSystemScheduler(io) {
  _io = io

  // Run an initial update check shortly after startup (30 s delay so server fully boots)
  const initialDelay = setTimeout(() => {
    checkForVoltageUpdate()
  }, 30 * 1000)
  initialDelay.unref?.()

  // Then run every UPDATE_CHECK_INTERVAL_MS
  _updateCheckTimer = setInterval(() => {
    checkForVoltageUpdate()
  }, UPDATE_CHECK_INTERVAL_MS)
  _updateCheckTimer.unref?.()

  console.log('[SystemScheduler] Started — update check every 6 h')
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
export function stopSystemScheduler() {
  if (_updateCheckTimer) {
    clearInterval(_updateCheckTimer)
    _updateCheckTimer = null
  }
}
