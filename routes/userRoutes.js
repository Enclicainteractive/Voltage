import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import multer from 'multer'
import { authenticateToken } from '../middleware/authMiddleware.js'
import config from '../config/config.js'
import { federationService } from '../services/federationService.js'
import { cdnService } from '../services/cdnService.js'
import { 
  userService, 
  friendService, 
  friendRequestService, 
  blockService,
  serverService,
  channelService,
  messageService,
  FILES,
  directQuery,
  supportsDirectQuery
} from '../services/dataService.js'
import { isUserOnline } from '../services/socketService.js'
import { toSafeUser } from '../services/userService.js'
import { validateUsername, validateDisplayName } from '../utils/validation.js'
import { AGE_VERIFICATION_JURISDICTIONS, getAgeVerificationJurisdiction, normalizeAgeVerification } from '../utils/ageVerificationPolicy.js'
import { validationSchemas, validateRequest, sanitizeInput, validationRateLimit } from '../middleware/builtinValidationMiddleware.js'

const toArray = (value) => {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

const router = express.Router()
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'volt-avatar-uploads')
const MAX_AVATAR_UPLOAD_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_DATA_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB decoded payload
const MAX_IMAGE_REFERENCE_LENGTH = 4096

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif'
])

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif'
])

if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
  fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true })
}

const sanitizeFilenameSegment = (value, fallback = 'user') => {
  const normalized = String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64)
  return normalized || fallback
}

const getExtensionForMimeType = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase()
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg'
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/webp') return '.webp'
  if (normalized === 'image/gif') return '.gif'
  if (normalized === 'image/avif') return '.avif'
  return null
}

const isSafeUploadFilename = (value) => {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 128) return false
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(raw)
}

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const mimeExt = getExtensionForMimeType(file?.mimetype)
      const originalExt = path.extname(file?.originalname || '').toLowerCase()
      const safeExt = mimeExt || (ALLOWED_IMAGE_EXTENSIONS.has(originalExt) ? originalExt : '.bin')
      const userPrefix = sanitizeFilenameSegment(req.user?.id, 'user')
      cb(null, `${userPrefix}-${Date.now()}${safeExt}`)
    }
  }),
  fileFilter: (req, file, cb) => {
    const mimeType = String(file?.mimetype || '').toLowerCase()
    if (ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      return cb(null, true)
    }
    cb(new Error('Only image files can be used as profile pictures'))
  },
  limits: {
    fileSize: MAX_AVATAR_UPLOAD_BYTES,
    files: 1,
    fields: 8,
    fieldSize: 4 * 1024 * 1024
  }
})

const removeTempFile = (filePath) => {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch (err) {
    console.warn(`[Avatar] Failed to remove temp file ${filePath}: ${err.message}`)
  }
}

const toAbsoluteFileUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.startsWith('data:image/')) return raw
  const baseUrl = String(config.getImageServerUrl() || config.getServerUrl() || '').replace(/\/$/, '')
  if (!baseUrl) return raw
  return `${baseUrl}${raw.startsWith('/') ? raw : `/${raw}`}`
}

const normalizeManagedUploadPath = (value) => {
  const raw = String(value || '').trim()
  if (!raw || raw.length > MAX_IMAGE_REFERENCE_LENGTH) return null
  const absoluteBase = String(config.getImageServerUrl() || config.getServerUrl() || '').replace(/\/$/, '')
  const normalized = absoluteBase && raw.startsWith(absoluteBase) ? raw.slice(absoluteBase.length) : raw
  const match = normalized.match(/^\/api\/upload\/file\/([^/?#]+)$/)
  if (!match?.[1]) return null

  let decoded = match[1]
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    return null
  }

  if (!isSafeUploadFilename(decoded)) return null
  return `/api/upload/file/${decoded}`
}

const normalizeDataImageUrl = (value, maxBytes = MAX_DATA_IMAGE_BYTES) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/)
  if (!match) return null

  const mimeType = String(match[1] || '').toLowerCase()
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) return null

  const base64Payload = String(match[2] || '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload)) return null

  const padding = base64Payload.endsWith('==') ? 2 : base64Payload.endsWith('=') ? 1 : 0
  const estimatedBytes = Math.floor((base64Payload.length * 3) / 4) - padding
  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0 || estimatedBytes > maxBytes) return null

  return `data:${mimeType};base64,${base64Payload}`
}

const sanitizeImageReference = (value, { allowDataUrl = true, maxDataBytes = MAX_DATA_IMAGE_BYTES } = {}) => {
  if (value === null || typeof value === 'undefined') return null
  const raw = String(value || '').trim()
  if (!raw || raw.length > MAX_IMAGE_REFERENCE_LENGTH) return null

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return raw
      }
    } catch {
      return null
    }
    return null
  }

  const managedPath = normalizeManagedUploadPath(raw)
  if (managedPath) return toAbsoluteFileUrl(managedPath)

  if (allowDataUrl) {
    const normalizedDataUrl = normalizeDataImageUrl(raw, maxDataBytes)
    if (normalizedDataUrl) return normalizedDataUrl
  }

  return null
}

const resolveStoredProfileImage = (value, fallbackUrl = null, options = {}) => {
  const sanitized = sanitizeImageReference(value, options)
  if (sanitized) return sanitized
  return fallbackUrl
}

const extractManagedUploadFilename = (value) => {
  const normalizedPath = normalizeManagedUploadPath(value)
  if (!normalizedPath) return null
  const filename = normalizedPath.split('/').pop() || null
  if (!isSafeUploadFilename(filename)) return null
  return filename
}

const runAvatarUpload = (req, res) => new Promise((resolve, reject) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return reject(err)
    resolve()
  })
})

const getAvatarUrl = (userId) => {
  const safeUserId = String(userId || '')
  if (!safeUserId) return null
  const baseUrl = safeUserId.startsWith('u_')
    ? (config.getServerUrl() || config.getImageServerUrl())
    : config.getImageServerUrl()
  return `${baseUrl}/api/images/users/${encodeURIComponent(safeUserId)}/profile`
}

const resolveUserAvatar = (userId, profile = null) => {
  const explicit = profile?.imageUrl || profile?.imageurl || profile?.avatar || null
  const resolved = resolveStoredProfileImage(explicit, null)
  if (resolved) return resolved
  return getAvatarUrl(userId)
}

const resolvePresenceStatus = (userId, profile = null) => {
  const profileHost = normalizeHost(profile?.host || config.getHost())
  const localHost = normalizeHost(config.getHost())
  if (profileHost && profileHost !== localHost) {
    return profile?.status || 'offline'
  }
  const online = isUserOnline(userId)
  if (!online) return 'offline'
  // User is online - return their actual status (idle, dnd, invisible, online)
  // Never return 'offline' for an online user
  const status = profile?.status
  if (!status || status === 'offline') return 'online'
  return status
}

const sanitizeProofSummary = (proof = {}, depth = 0) => {
  if (depth > 2) return {}
  const safe = {}
  Object.entries(proof || {}).forEach(([key, value]) => {
    if (typeof value === 'string') {
      if (/data:image|base64,/i.test(value)) return
      safe[key] = value.slice(0, 256)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      safe[key] = sanitizeProofSummary(value, depth + 1)
    }
  })
  return safe
}

const computeAge = (birthYear) => {
  if (!birthYear) return null
  const year = parseInt(birthYear, 10)
  if (Number.isNaN(year)) return null
  const currentYear = new Date().getFullYear()
  return currentYear - year
}

const BIRTHDATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const normalizeBirthDate = (value) => {
  if (typeof value === 'undefined') return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !BIRTHDATE_PATTERN.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed > new Date()) return null
  const ageYears = new Date().getUTCFullYear() - parsed.getUTCFullYear()
  if (ageYears > 120) return null
  return value
}

const normalizeHost = (value) => federationService.normalizeHost?.(value) || String(value || '').toLowerCase()

const resolveUserByAnyId = (rawUserId) => {
  const requestedId = String(rawUserId || '').trim()
  if (!requestedId) return null

  const direct = userService.getUser(requestedId)
  if (direct) return direct

  const allUsers = userService.getAllUsers?.() || {}
  const allValues = Object.values(allUsers)
  return allValues.find((u) => {
    if (!u) return false
    return u.id === requestedId || u.remoteUserId === requestedId || u.localUserId === requestedId
  }) || null
}

const getMutualFriendsFast = async (currentUserId, targetUserId) => {
  if (supportsDirectQuery()) {
    const rows = await directQuery(
      `SELECT f1.friendId
       FROM friends f1
       INNER JOIN friends f2 ON f1.friendId = f2.friendId
       WHERE f1.userId = ? AND f2.userId = ?`,
      [currentUserId, targetUserId]
    )
    if (Array.isArray(rows)) {
      return rows.map(row => row?.friendId).filter(Boolean)
    }
  }

  const currentFriends = friendService.getFriends(currentUserId)
  const targetFriendSet = new Set(friendService.getFriends(targetUserId))
  return currentFriends.filter(friendId => targetFriendSet.has(friendId))
}

const getMutualServersFast = async (currentUserId, targetUserId) => {
  if (supportsDirectQuery()) {
    const rows = await directQuery(
      `SELECT s.id, s.name, s.icon, COUNT(sm.userId) AS memberCount
       FROM server_members sm1
       INNER JOIN server_members sm2 ON sm1.serverId = sm2.serverId
       INNER JOIN servers s ON s.id = sm1.serverId
       LEFT JOIN server_members sm ON sm.serverId = s.id
       WHERE sm1.userId = ? AND sm2.userId = ?
       GROUP BY s.id, s.name, s.icon`,
      [currentUserId, targetUserId]
    )
    if (Array.isArray(rows)) {
      return rows.map(row => ({
        id: row.id,
        name: row.name,
        icon: row.icon,
        memberCount: Number(row.memberCount) || 0
      }))
    }
  }

  const serversData = toArray(serverService.getAllServers())
  return serversData
    .filter(server => {
      const members = Array.isArray(server.members) ? server.members : []
      const hasCurrent = members.some(m => m?.id === currentUserId)
      const hasTarget = members.some(m => m?.id === targetUserId)
      return hasCurrent && hasTarget
    })
    .filter(Boolean)
    .map(server => ({
      id: server.id,
      name: server.name,
      icon: server.icon,
      memberCount: server.members?.length || 0
    }))
}

const parseFederatedHandle = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const cleaned = raw.startsWith('@') ? raw.slice(1) : raw
  const idx = cleaned.lastIndexOf(':')
  if (idx <= 0) return null
  return {
    username: cleaned.slice(0, idx),
    host: normalizeHost(cleaned.slice(idx + 1))
  }
}

const buildAddress = (profile = {}) => {
  const username = profile?.customUsername || profile?.username || ''
  const host = normalizeHost(profile?.host || config.getHost())
  return username && host ? `${username}:${host}` : username || ''
}

const INTERNAL_USER_RESPONSE_DENYLIST = new Set([
  'proofSummary',
  'device',
  'remoteUserId',
  'localUserId',
  'age_verification_jurisdiction',
  'birth_date',
  'password',
  'passwordHash',
  'password_hash',
  'passwordSalt',
  'salt',
  'resetToken',
  'reset_token',
  'recoveryToken',
  'recovery_token',
  'refreshToken',
  'refresh_token',
  'accessToken',
  'access_token',
  'sessionSecret',
  'mfaSecret',
  'totpSecret',
  'twoFactorSecret',
  'jwtSecret',
  'apiKey',
  'privateKey'
])

const PUBLIC_PROFILE_FIELDS = new Set([
  'id',
  'username',
  'customUsername',
  'displayName',
  'bio',
  'customStatus',
  'socialLinks',
  'guildTag',
  'guildTagServerId',
  'guildTagPrivate',
  'accentColor',
  'profileEffect',
  'profileCSS',
  'profileTemplate',
  'bannerEffect',
  'profileLayout',
  'badgeStyle',
  'profileTheme',
  'profileBackground',
  'profileAccentColor',
  'profileFont',
  'profileAnimation',
  'profileBackgroundType',
  'profileBackgroundOpacity',
  'customization'
])

const OWN_ONLY_PROFILE_FIELDS = new Set([
  'email',
  'birthDate',
  'ageVerification',
  'ageVerificationJurisdiction',
  'clientCSS',
  'clientCSSEnabled'
])

const PUBLIC_CUSTOMIZATION_FIELDS = new Set([
  'accentColor',
  'bannerEffect',
  'profileCSS',
  'profileTemplate',
  'profileLayout',
  'badgeStyle',
  'animatedAvatar'
])

const PROFILE_UPDATE_ALLOWED_FIELDS = new Set([
  'displayName',
  'bio',
  'customStatus',
  'socialLinks',
  'banner',
  'avatar',
  'customUsername',
  'birthDate',
  'accentColor',
  'profileEffect',
  'profileCSS',
  'profileTemplate',
  'bannerEffect',
  'profileLayout',
  'badgeStyle',
  'clientCSS',
  'clientCSSEnabled'
])

const PREFERENCES_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/
const MAX_PREFERENCES_KEYS = 100
const MAX_PREFERENCE_DEPTH = 3
const MAX_PREFERENCE_ARRAY_LENGTH = 50
const MAX_PREFERENCE_STRING_LENGTH = 1024
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const hasUnsafeObjectKeys = (value, depth = 0) => {
  if (!value || typeof value !== 'object') return false
  if (depth > MAX_PREFERENCE_DEPTH + 2) return true
  if (Array.isArray(value)) {
    return value.some((item) => hasUnsafeObjectKeys(item, depth + 1))
  }
  if (!isPlainObject(value)) return true
  return Object.entries(value).some(([key, childValue]) => {
    if (UNSAFE_OBJECT_KEYS.has(String(key || '').toLowerCase())) return true
    return hasUnsafeObjectKeys(childValue, depth + 1)
  })
}

const sanitizePreferenceValue = (value, depth = 0) => {
  if (depth > MAX_PREFERENCE_DEPTH) return undefined
  if (value === null) return null
  if (typeof value === 'string') return value.slice(0, MAX_PREFERENCE_STRING_LENGTH)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined

  if (Array.isArray(value)) {
    const sanitized = []
    for (const entry of value.slice(0, MAX_PREFERENCE_ARRAY_LENGTH)) {
      const normalized = sanitizePreferenceValue(entry, depth + 1)
      if (typeof normalized !== 'undefined') sanitized.push(normalized)
    }
    return sanitized
  }

  if (!isPlainObject(value)) return undefined
  const sanitized = {}
  let count = 0
  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = String(key || '')
    if (!PREFERENCES_KEY_PATTERN.test(normalizedKey)) continue
    if (UNSAFE_OBJECT_KEYS.has(normalizedKey.toLowerCase())) continue
    const normalizedValue = sanitizePreferenceValue(childValue, depth + 1)
    if (typeof normalizedValue === 'undefined') continue
    sanitized[normalizedKey] = normalizedValue
    count += 1
    if (count >= MAX_PREFERENCES_KEYS) break
  }
  return sanitized
}

const sanitizePreferencePatch = (value) => {
  if (!isPlainObject(value)) return null
  if (hasUnsafeObjectKeys(value)) return null

  const sanitized = {}
  let count = 0
  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = String(key || '')
    if (!PREFERENCES_KEY_PATTERN.test(normalizedKey)) continue
    if (UNSAFE_OBJECT_KEYS.has(normalizedKey.toLowerCase())) continue
    const normalizedValue = sanitizePreferenceValue(childValue, 0)
    if (typeof normalizedValue === 'undefined') continue
    sanitized[normalizedKey] = normalizedValue
    count += 1
    if (count >= MAX_PREFERENCES_KEYS) break
  }
  return sanitized
}

const sanitizeCustomizationPatch = (value) => {
  if (!isPlainObject(value)) return null
  if (hasUnsafeObjectKeys(value)) return null
  return sanitizePublicCustomization(value) || {}
}

const pickFields = (source, fields) => {
  const selected = {}
  if (!source || typeof source !== 'object') return selected
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      selected[field] = source[field]
    }
  })
  return selected
}

const sanitizeSelfUserPayload = (user) => {
  const safe = toSafeUser(user) || {}
  if (!safe || typeof safe !== 'object') return {}
  const sanitized = { ...safe }
  INTERNAL_USER_RESPONSE_DENYLIST.forEach((key) => {
    delete sanitized[key]
  })
  return sanitized
}

const sanitizePublicCustomization = (customization) => {
  if (!customization || typeof customization !== 'object' || Array.isArray(customization)) return undefined
  const sanitized = {}
  PUBLIC_CUSTOMIZATION_FIELDS.forEach((key) => {
    const value = customization[key]
    if (typeof value === 'string') {
      const maxLen = key === 'profileCSS' ? 20480 : 256
      sanitized[key] = value.slice(0, maxLen)
      return
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      sanitized[key] = value
    }
  })
  return Object.keys(sanitized).length ? sanitized : undefined
}

const buildSelfProfileResponse = (authUser = {}, profile = null) => {
  const safeAuthUser = sanitizeSelfUserPayload(authUser)
  const safeProfile = sanitizeSelfUserPayload(profile)
  const merged = { ...safeAuthUser, ...safeProfile }
  const userId = String(authUser?.id || safeProfile?.id || safeAuthUser?.id || '').trim()

  return {
    ...merged,
    id: userId || merged.id || null,
    host: profile?.host || authUser?.host || config.getHost(),
    avatarHost: profile?.avatarHost || safeProfile?.avatarHost || config.getImageServerUrl(),
    imageUrl: resolveStoredProfileImage(
      profile?.imageUrl || profile?.imageurl || profile?.avatar || merged.imageUrl || merged.avatar,
      null,
      { allowDataUrl: true, maxDataBytes: MAX_AVATAR_UPLOAD_BYTES }
    ),
    avatar: resolveUserAvatar(userId || authUser?.id, profile || safeProfile),
    banner: resolveStoredProfileImage(profile?.banner || merged.banner, null, {
      allowDataUrl: true,
      maxDataBytes: MAX_DATA_IMAGE_BYTES
    })
  }
}

const buildPublicProfileResponse = (viewerId, targetUserId, profile) => {
  const safeProfile = sanitizeSelfUserPayload(profile)
  const isOwn = viewerId === targetUserId
  const publicProfile = pickFields(safeProfile, PUBLIC_PROFILE_FIELDS)
  const safeCustomization = sanitizePublicCustomization(safeProfile.customization)
  if (safeCustomization) {
    publicProfile.customization = safeCustomization
  } else {
    delete publicProfile.customization
  }

  const response = {
    ...publicProfile,
    id: targetUserId,
    username: publicProfile.customUsername || publicProfile.username || safeProfile.username || 'Unknown User',
    host: profile?.host || config.getHost(),
    avatarHost: profile?.avatarHost || config.getImageServerUrl(),
    imageUrl: resolveStoredProfileImage(profile?.imageUrl || profile?.imageurl || profile?.avatar, null, {
      allowDataUrl: true,
      maxDataBytes: MAX_AVATAR_UPLOAD_BYTES
    }),
    avatar: resolveUserAvatar(targetUserId, profile),
    banner: resolveStoredProfileImage(profile?.banner, null, {
      allowDataUrl: true,
      maxDataBytes: MAX_DATA_IMAGE_BYTES
    }),
    status: resolvePresenceStatus(targetUserId, profile),
    address: buildAddress(profile),
    isFriend: friendService.areFriends(viewerId, targetUserId),
    isBlocked: blockService.isBlocked(viewerId, targetUserId)
  }

  if (isOwn) {
    Object.assign(response, pickFields(safeProfile, OWN_ONLY_PROFILE_FIELDS))
  }

  return response
}

const resolveCanonicalUser = (rawUserId) => {
  const profile = resolveUserByAnyId(rawUserId)
  if (!profile) return null
  const canonicalId = String(profile?.id || rawUserId || '').trim()
  if (!canonicalId) return null
  return { profile, userId: canonicalId }
}

const hasBlockedRelationship = (viewerId, targetUserId) => {
  if (!viewerId || !targetUserId) return false
  return blockService.isBlocked(viewerId, targetUserId)
}

const canAccessUserScopedData = (viewerId, targetUserId, { requireFriend = false } = {}) => {
  if (!viewerId || !targetUserId) return false
  if (viewerId === targetUserId) return true
  if (hasBlockedRelationship(viewerId, targetUserId)) return false
  if (requireFriend && !friendService.areFriends(viewerId, targetUserId)) return false
  return true
}

// Ensure authenticated user's profile exists in storage
// OPTIMIZATION: Only create profile if it truly doesn't exist
// This prevents excessive "Auto-created profile" logs and unnecessary DB writes
const ensureUserProfile = async (req, res, next) => {
  try {
    const existingProfile = userService.getUser(req.user.id)
    if (!existingProfile) {
      // Check if there's a cached/stored profile elsewhere to preserve admin status
      const cachedProfile = await userService.getCachedUser?.(req.user.id)
      
      const newProfile = {
        id: req.user.id,
        username: req.user.username,
        displayName: req.user.displayName || req.user.username,
        email: req.user.email || null,
        host: req.user.host || config.getHost(),
        avatarHost: config.getImageServerUrl(),
        authProvider: req.user.authProvider || 'local',
        // CRITICAL: Preserve admin/moderator flags - prioritize cached profile over JWT token
        // This prevents admin status from being lost when profiles are re-created
        adminRole: cachedProfile?.adminRole || req.user.adminRole || null,
        isAdmin: cachedProfile?.isAdmin ?? req.user.isAdmin ?? 0,
        isModerator: cachedProfile?.isModerator ?? req.user.isModerator ?? 0,
        // Preserve other important user details from cached profile if available
        birthDate: cachedProfile?.birthDate || null,
        ageVerification: cachedProfile?.ageVerification || null,
        profileTheme: cachedProfile?.profileTheme || null,
        createdAt: cachedProfile?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await userService.saveUser(req.user.id, newProfile)
      console.log(`[Auth] Auto-created profile for user: ${req.user.username} (${req.user.id})`)
    } else {
      // Skip writes when the token-derived fields already match persisted state.
      const desiredProfile = {
        username: req.user.username,
        displayName: req.user.displayName || existingProfile.displayName || req.user.username,
        email: req.user.email || existingProfile.email || null,
        host: req.user.host || existingProfile.host || config.getHost(),
        authProvider: req.user.authProvider || existingProfile.authProvider || 'local',
        adminRole: existingProfile.adminRole || req.user.adminRole || null,
        isAdmin: existingProfile.isAdmin ?? req.user.isAdmin ?? 0,
        isModerator: existingProfile.isModerator ?? req.user.isModerator ?? 0
      }
      const hasChanges = Object.entries(desiredProfile).some(([key, value]) => existingProfile?.[key] !== value)
      if (hasChanges) {
        await userService.updateProfile(req.user.id, desiredProfile)
      }
    }
  } catch (err) {
    console.error('[Auth] ensureUserProfile error:', err.message)
  }
  next()
}

// Require auth for all routes in this router and persist profile once per request
router.use(authenticateToken, ensureUserProfile)

// Current user
router.get('/me', async (req, res) => {
  try {
    const profile = userService.getUser(req.user.id)
    res.json(buildSelfProfileResponse(req.user, profile))
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user info' })
  }
})

router.post('/avatar', async (req, res) => {
  try {
    await runAvatarUpload(req, res)

    if (!req.file && typeof req.body?.avatar === 'string') {
      const avatarUrl = sanitizeImageReference(req.body.avatar, {
        allowDataUrl: true,
        maxDataBytes: MAX_AVATAR_UPLOAD_BYTES
      })
      if (!avatarUrl) {
        return res.status(400).json({ error: 'Invalid avatar image format' })
      }
      const profile = await userService.updateProfile(req.user.id, {
        avatar: avatarUrl,
        imageUrl: avatarUrl,
        imageurl: avatarUrl,
        avatarHost: config.getImageServerUrl()
      })

      return res.json({
        success: true,
        avatar: avatarUrl,
        imageUrl: avatarUrl,
        avatarHost: profile?.avatarHost || config.getImageServerUrl()
      })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No avatar image uploaded' })
    }

    const existingProfile = userService.getUser(req.user.id) || {}
    const previousFilename = extractManagedUploadFilename(existingProfile.imageUrl || existingProfile.avatar)
    const uploadResult = await cdnService.upload(req.file, { userId: req.user.id, type: 'avatar' })
    const avatarUrl = resolveStoredProfileImage(uploadResult?.url, null, { allowDataUrl: false })
    if (!avatarUrl) {
      throw new Error('Uploaded avatar URL is invalid')
    }

    const profile = await userService.updateProfile(req.user.id, {
      avatar: avatarUrl,
      imageUrl: avatarUrl,
      imageurl: avatarUrl,
      avatarHost: config.getImageServerUrl()
    })

    if (previousFilename && previousFilename !== uploadResult?.filename) {
      try {
        await cdnService.delete(previousFilename)
      } catch (err) {
        console.warn(`[Avatar] Failed to delete previous avatar ${previousFilename}: ${err.message}`)
      }
    }

    removeTempFile(req.file.path)

    res.json({
      success: true,
      avatar: avatarUrl,
      imageUrl: avatarUrl,
      avatarHost: profile?.avatarHost || config.getImageServerUrl()
    })
  } catch (error) {
    removeTempFile(req.file?.path)
    console.error('[API] Avatar upload failed:', error)
    const errorMessage = String(error?.message || '')
    const clientError = (
      errorMessage.includes('Only image files') ||
      errorMessage.includes('File too large') ||
      errorMessage.includes('Invalid avatar image format') ||
      errorMessage.includes('Field value too long') ||
      error?.code === 'LIMIT_FILE_SIZE' ||
      error?.code === 'LIMIT_FIELD_VALUE' ||
      error?.code === 'LIMIT_UNEXPECTED_FILE'
    )
    const statusCode = clientError ? 400 : 500
    res.status(statusCode).json({ error: error.message || 'Avatar upload failed' })
  }
})

router.delete('/avatar', async (req, res) => {
  try {
    const existingProfile = userService.getUser(req.user.id) || {}
    const previousFilename = extractManagedUploadFilename(existingProfile.imageUrl || existingProfile.avatar)

    await userService.updateProfile(req.user.id, {
      avatar: null,
      imageUrl: null,
      imageurl: null,
      avatarHost: config.getImageServerUrl()
    })

    if (previousFilename) {
      try {
        await cdnService.delete(previousFilename)
      } catch (err) {
        console.warn(`[Avatar] Failed to delete avatar ${previousFilename}: ${err.message}`)
      }
    }

    res.json({ success: true })
  } catch (error) {
    console.error('[API] Avatar delete failed:', error)
    res.status(500).json({ error: 'Failed to delete avatar' })
  }
})

// Update profile
router.put('/profile', 
  validationRateLimit,
  sanitizeInput,
  validateRequest(validationSchemas.userProfile),
  async (req, res) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: 'Invalid request body' })
  }
  if (hasUnsafeObjectKeys(req.body)) {
    return res.status(400).json({ error: 'Invalid request body keys' })
  }
  const unknownKeys = Object.keys(req.body).filter((key) => !PROFILE_UPDATE_ALLOWED_FIELDS.has(key))
  if (unknownKeys.length > 0) {
    return res.status(400).json({ error: `Unsupported profile fields: ${unknownKeys.join(', ')}` })
  }

  const {
    displayName, bio, customStatus, socialLinks, banner, avatar, customUsername, birthDate,
    accentColor, profileEffect,
    // New customization fields
    profileCSS, profileTemplate, bannerEffect, profileLayout, badgeStyle,
    clientCSS, clientCSSEnabled
  } = req.body
  const updates = {}
  
  if (customUsername !== undefined) {
    const validation = validateUsername(customUsername)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }
    const allUsers = userService.getAllUsers()
    const existingUser = Object.values(allUsers).find(
      u => u.customUsername?.toLowerCase() === customUsername.toLowerCase() && u.id !== req.user.id
    )
    if (existingUser) {
      return res.status(400).json({ error: 'Username already taken' })
    }
    updates.customUsername = customUsername
  }
  
  if (displayName !== undefined) {
    const validation = validateDisplayName(displayName)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }
    updates.displayName = displayName
  }
  if (birthDate !== undefined) {
    const normalizedBirthDate = normalizeBirthDate(birthDate)
    if (birthDate && !normalizedBirthDate) {
      return res.status(400).json({ error: 'Birth date must be a valid date in YYYY-MM-DD format' })
    }
    updates.birthDate = normalizedBirthDate
  }
  if (bio !== undefined) updates.bio = bio
  if (customStatus !== undefined) updates.customStatus = customStatus
  if (banner !== undefined) {
    if (banner === null || banner === '') {
      updates.banner = null
    } else {
      const sanitizedBanner = sanitizeImageReference(banner, {
        allowDataUrl: true,
        maxDataBytes: MAX_DATA_IMAGE_BYTES
      })
      if (!sanitizedBanner) {
        return res.status(400).json({ error: 'Invalid banner image format' })
      }
      updates.banner = sanitizedBanner
    }
  }
  if (avatar !== undefined) {
    const resolvedAvatar = avatar === null || avatar === ''
      ? null
      : sanitizeImageReference(avatar, {
          allowDataUrl: true,
          maxDataBytes: MAX_AVATAR_UPLOAD_BYTES
        })
    if (avatar !== null && avatar !== '' && !resolvedAvatar) {
      return res.status(400).json({ error: 'Invalid avatar image format' })
    }
    updates.avatar = resolvedAvatar
    updates.imageUrl = resolvedAvatar
    updates.imageurl = resolvedAvatar
  }
  if (socialLinks !== undefined) {
    const allowed = ['github', 'twitter', 'youtube', 'twitch', 'website', 'steam', 'spotify']
    const sanitized = {}
    if (socialLinks && typeof socialLinks === 'object' && !Array.isArray(socialLinks)) {
      for (const [key, value] of Object.entries(socialLinks)) {
        if (allowed.includes(key) && typeof value === 'string') {
          sanitized[key] = value.slice(0, 256)
        }
      }
    }
    updates.socialLinks = sanitized
  }
  if (accentColor !== undefined) {
    // Validate hex color or null
    if (accentColor === null || /^#[0-9a-fA-F]{6}$/.test(accentColor)) {
      updates.accentColor = accentColor
    }
  }
  if (profileEffect !== undefined) {
    updates.profileEffect = typeof profileEffect === 'string' ? profileEffect.slice(0, 64) : null
  }
  // Profile customization fields
  if (profileCSS !== undefined) {
    // Limit to 20 KB
    updates.profileCSS = typeof profileCSS === 'string' ? profileCSS.slice(0, 20480) : null
  }
  if (profileTemplate !== undefined) {
    updates.profileTemplate = typeof profileTemplate === 'string' ? profileTemplate.slice(0, 64) : 'default'
  }
  if (bannerEffect !== undefined) {
    const validEffects = ['none', 'gradient-shift', 'pulse', 'wave', 'aurora', 'shimmer', 'particles']
    updates.bannerEffect = validEffects.includes(bannerEffect) ? bannerEffect : 'none'
  }
  if (profileLayout !== undefined) {
    const validLayouts = ['standard', 'compact', 'expanded', 'card']
    updates.profileLayout = validLayouts.includes(profileLayout) ? profileLayout : 'standard'
  }
  if (badgeStyle !== undefined) {
    const validBadgeStyles = ['default', 'glow', 'bordered', 'minimal', '3d']
    updates.badgeStyle = validBadgeStyles.includes(badgeStyle) ? badgeStyle : 'default'
  }
  // Client-side custom CSS (synced across devices)
  if (clientCSS !== undefined) {
    updates.clientCSS = typeof clientCSS === 'string' ? clientCSS.slice(0, 51200) : null
  }
  if (clientCSSEnabled !== undefined) {
    updates.clientCSSEnabled = Boolean(clientCSSEnabled)
  }
  
  const profile = await userService.updateProfile(req.user.id, updates)
  console.log(`[API] Profile updated for ${req.user.username}`)
  res.json(buildSelfProfileResponse(req.user, profile))
})

// Get user guild tag
router.get('/guild-tag', async (req, res) => {
  const profile = userService.getUser(req.user.id)
  res.json({ guildTag: profile?.guildTag || null, guildTagServerId: profile?.guildTagServerId || null })
})

// Set/update user guild tag (display a server's tag on your profile globally)
router.put('/guild-tag', async (req, res) => {
  const { serverId } = req.body
  if (serverId === null || serverId === undefined || serverId === '') {
    // Clear guild tag
    await userService.updateProfile(req.user.id, { guildTag: null, guildTagServerId: null })
    return res.json({ guildTag: null, guildTagServerId: null })
  }
  const servers = serverService.getAllServers ? toArray(serverService.getAllServers()) : []
  const server = (Array.isArray(servers) ? servers : Object.values(servers || {})).find(s => s.id === serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  // User must be a member
  const isMember = Array.isArray(server.members) && server.members.some(m => m.id === req.user.id)
  if (!isMember) return res.status(403).json({ error: 'You are not a member of this server' })
  if (!server.guildTag) return res.status(400).json({ error: 'This server has no guild tag set' })
  await userService.updateProfile(req.user.id, { guildTag: server.guildTag, guildTagServerId: serverId })
  res.json({ guildTag: server.guildTag, guildTagServerId: serverId })
})

// Get server nick for current user in a server
router.get('/server-nick/:serverId', async (req, res) => {
  const profile = userService.getUser(req.user.id)
  const serverNicks = profile?.serverNicks || {}
  res.json({ nick: serverNicks[req.params.serverId] || null })
})

// Set server nick for current user in a server
router.put('/server-nick/:serverId', async (req, res) => {
  const { nick } = req.body
  const profile = userService.getUser(req.user.id)
  const serverNicks = { ...(profile?.serverNicks || {}) }
  if (!nick || nick.trim() === '') {
    delete serverNicks[req.params.serverId]
  } else {
    const trimmed = nick.trim().slice(0, 32)
    serverNicks[req.params.serverId] = trimmed
  }
  await userService.updateProfile(req.user.id, { serverNicks })
  res.json({ nick: serverNicks[req.params.serverId] || null })
})

// Update status
router.put('/status', async (req, res) => {
  const { status, customStatus } = req.body
  const validStatuses = ['online', 'idle', 'dnd', 'invisible']
  
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }
  
  const profile = await userService.setStatus(req.user.id, status, customStatus)
  console.log(`[API] Status updated for ${req.user.username}: ${status}`)
  res.json(buildSelfProfileResponse(req.user, profile))
})

// Age verification status
router.get('/age-verification/status', async (req, res) => {
  const profile = userService.getUser(req.user.id)
  const ageVerification = normalizeAgeVerification(profile?.ageVerification, profile || {})
  res.json({
    ageVerification,
    jurisdictionCode: profile?.ageVerificationJurisdiction || ageVerification?.jurisdictionCode,
    jurisdictions: AGE_VERIFICATION_JURISDICTIONS
  })
})

router.post('/age-verification/jurisdiction', async (req, res) => {
  const { jurisdictionCode } = req.body || {}
  const jurisdiction = getAgeVerificationJurisdiction(jurisdictionCode)
  await userService.updateProfile(req.user.id, { ageVerificationJurisdiction: jurisdiction.code })
  const profile = userService.getUser(req.user.id)
  res.json({
    ageVerification: normalizeAgeVerification(profile?.ageVerification, profile || {}),
    jurisdictionCode: jurisdiction.code,
    jurisdictions: AGE_VERIFICATION_JURISDICTIONS
  })
})

router.post('/age-verification/self-attest', async (req, res) => {
  const profile = userService.getUser(req.user.id) || {}
  const status = normalizeAgeVerification(profile?.ageVerification, profile)

  if (status.requiresProofVerification) {
    return res.status(400).json({ error: 'This jurisdiction requires full age verification before 18+ access is granted.' })
  }

  const verificationRecord = await userService.setAgeVerification(req.user.id, {
    verified: false,
    method: 'self_attestation',
    category: 'adult',
    selfDeclaredAdult: true,
    age: 18,
    estimatedAge: 18,
    device: req.body?.device || 'web',
    source: 'self_attestation',
    jurisdictionCode: profile?.ageVerificationJurisdiction || status.jurisdictionCode
  })

  res.json({
    ageVerification: verificationRecord.ageVerification,
    jurisdictionCode: verificationRecord.ageVerificationJurisdiction,
    jurisdictions: AGE_VERIFICATION_JURISDICTIONS
  })
})

router.post('/age-verification', async (req, res) => {
  const { method, birthYear, proofSummary = {}, device, category, estimatedAge, jurisdictionCode } = req.body || {}

  if (!method || !['face', 'id', 'hybrid'].includes(method)) {
    return res.status(400).json({ error: 'method must be "face", "id", or "hybrid"' })
  }

  const normalizedCategory = category === 'child' ? 'child' : 'adult'

  const age = computeAge(birthYear)
  const sanitizedProof = sanitizeProofSummary(proofSummary)
  const verificationRecord = await userService.setAgeVerification(req.user.id, {
    method,
    birthYear: birthYear || null,
    age,
    proofSummary: sanitizedProof,
    device: device || null,
    category: normalizedCategory,
    estimatedAge: estimatedAge || age,
    jurisdictionCode
  })

  console.log(`[API] Age verification stored for ${req.user.username} via ${method} - ${normalizedCategory}`)
  res.json({
    ageVerification: verificationRecord.ageVerification,
    jurisdictionCode: verificationRecord.ageVerificationJurisdiction,
    jurisdictions: AGE_VERIFICATION_JURISDICTIONS
  })
})

// Search users
router.get('/search', async (req, res) => {
  const { q } = req.query
  if (!q || q.length < 2) {
    return res.json([])
  }
  
  const localHost = config.getHost()
  let searchUsername = q
  let searchHost = null
  
  const federatedHandle = parseFederatedHandle(q)
  if (federatedHandle) {
    searchUsername = federatedHandle.username
    searchHost = federatedHandle.host
  } else if (q.includes('@')) {
    const parts = q.split('@')
    searchUsername = parts[0]
    searchHost = parts[1]
  }
  
  const allUsers = userService.getAllUsers()
  const results = Object.values(allUsers)
    .filter(u => {
      if (!u?.id || hasBlockedRelationship(req.user.id, u.id)) return false
      const usernameMatch = u.username?.toLowerCase().includes(searchUsername.toLowerCase()) || 
                           u.customUsername?.toLowerCase().includes(searchUsername.toLowerCase()) ||
                           u.displayName?.toLowerCase().includes(searchUsername.toLowerCase())
      
      if (!searchHost) {
        return usernameMatch
      }
      
      const userHost = u.host || localHost
      return usernameMatch && userHost.toLowerCase() === searchHost.toLowerCase()
    })
    .slice(0, 20)
    .map(u => ({
      id: u.id,
      username: u.customUsername || u.username,
      originalUsername: u.username,
      displayName: u.displayName,
      imageUrl: resolveStoredProfileImage(u.imageUrl || u.imageurl || u.avatar, null, {
        allowDataUrl: true,
        maxDataBytes: MAX_AVATAR_UPLOAD_BYTES
      }),
      avatar: resolveUserAvatar(u.id, u),
      host: u.host || localHost,
      address: buildAddress(u)
    }))
  
  res.json(results)
})

// Get friends list - MUST be before /:userId
router.get('/friends', async (req, res) => {
  const friendIds = typeof friendService.getFriendsFresh === 'function'
    ? await friendService.getFriendsFresh(req.user.id)
    : friendService.getFriends(req.user.id)
  const localHost = config.getHost()
  const friends = friendIds.map(friendId => {
    const profile = userService.getUser(friendId)
    const status = resolvePresenceStatus(friendId, profile)
    return {
      id: friendId,
      username: profile?.customUsername || profile?.username || 'Unknown',
      originalUsername: profile?.username,
      displayName: profile?.displayName,
      imageUrl: resolveStoredProfileImage(profile?.imageUrl || profile?.imageurl || profile?.avatar, null, {
        allowDataUrl: true,
        maxDataBytes: MAX_AVATAR_UPLOAD_BYTES
      }),
      avatar: resolveUserAvatar(friendId, profile),
      status,
      customStatus: profile?.customStatus,
      host: profile?.host || localHost,
      address: buildAddress(profile)
    }
  })
  
  console.log(`[API] Get friends for ${req.user.username} - ${friends.length} friends`)
  res.json(friends)
})

// Get friend requests - MUST be before /:userId
router.get('/friend-requests', async (req, res) => {
  const requests = typeof friendRequestService.getRequestsFresh === 'function'
    ? await friendRequestService.getRequestsFresh(req.user.id)
    : friendRequestService.getRequests(req.user.id)
  console.log(`[API] Get friend requests for ${req.user.username} - ${requests.incoming.length} incoming, ${requests.outgoing.length} outgoing`)
  res.json(requests)
})

// Get blocked users - MUST be before /:userId
router.get('/blocked', async (req, res) => {
  const blockedIds = await blockService.getBlocked(req.user.id)
  const blocked = blockedIds.map(id => {
    const profile = userService.getUser(id)
    return {
      id,
      username: profile?.username || 'Unknown',
      imageUrl: resolveStoredProfileImage(profile?.imageUrl || profile?.imageurl || profile?.avatar, null, {
        allowDataUrl: true,
        maxDataBytes: MAX_AVATAR_UPLOAD_BYTES
      }),
      avatar: resolveUserAvatar(id, profile)
    }
  })
  res.json(blocked)
})

const handleGetUserProfile = async (req, res) => {
  const userId = String(req.params.userId || '').trim()
  const profile = userService.getUser(userId)
  if (!profile) {
    return res.json({
      id: userId,
      username: 'Unknown User',
      status: 'offline'
    })
  }

  if (hasBlockedRelationship(req.user.id, userId)) {
    return res.status(404).json({ error: 'User not found' })
  }

  res.json(buildPublicProfileResponse(req.user.id, userId, profile))
}

// Get user profile - This must come AFTER all specific GET routes
router.get('/:userId', handleGetUserProfile)

// Profile alias - GET /:userId/profile is an alias for GET /:userId
// This fixes 404s from clients calling /users/:userId/profile
router.get('/:userId/profile', handleGetUserProfile)

// Send friend request
router.post('/friend-request', async (req, res) => {
  const { username, userId } = req.body
  
  if (!username && !userId) {
    return res.status(400).json({ error: 'Username or userId required' })
  }
  
  let targetUserId = userId
  let targetUsername = null
  let targetHost = null
  const localHost = normalizeHost(config.getHost())

  const federatedHandle = username ? parseFederatedHandle(username) : null
  
  if (federatedHandle && !userId) {
    const allUsers = userService.getAllUsers()
    const targetUser = Object.values(allUsers).find(
      (user) => (user.host || localHost) === federatedHandle.host
        && (user.username?.toLowerCase() === federatedHandle.username.toLowerCase()
          || user.customUsername?.toLowerCase() === federatedHandle.username.toLowerCase())
    )
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }
    targetUserId = targetUser.id
    targetUsername = targetUser.customUsername || targetUser.username
    targetHost = normalizeHost(targetUser.host || federatedHandle.host)
  } else if (username && !userId) {
    const allUsers = userService.getAllUsers()
    const targetUser = Object.values(allUsers).find(
      u => u.username?.toLowerCase() === username.toLowerCase()
    )
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }
    targetUserId = targetUser.id
    targetUsername = targetUser.username
  }

  if (!targetUsername && targetUserId) {
    const targetProfile = userService.getUser(targetUserId)
    targetUsername = targetProfile?.customUsername || targetProfile?.username || null
    targetHost = normalizeHost(targetProfile?.host)
  }
  
  if (targetUserId === req.user.id) {
    return res.status(400).json({ error: 'Cannot send friend request to yourself' })
  }
  
  if (friendService.areFriends(req.user.id, targetUserId)) {
    return res.status(400).json({ error: 'Already friends' })
  }
  
  if (blockService.isBlocked(req.user.id, targetUserId)) {
    return res.status(400).json({ error: 'User is blocked' })
  }

  if (targetHost && targetHost !== localHost) {
    const peer = federationService.getPeerByHost(targetHost)
    if (!peer || peer.status !== 'connected') {
      return res.status(400).json({ error: 'Remote server is not connected for federation' })
    }
  }
  
  const result = await friendRequestService.sendRequest(req.user.id, targetUserId, req.user.username, targetUsername)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }

  if (targetHost && targetHost !== localHost) {
    const peer = federationService.getPeerByHost(targetHost)
    const requesterProfile = userService.getUser(req.user.id)
    federationService.queueRelayMessage(peer.id, {
      type: 'friend:request',
      payload: {
        toUserId: userService.getUser(targetUserId)?.remoteUserId || String(targetUserId).split('@')[0],
        toUsername: targetUsername,
        from: {
          id: req.user.id,
          username: requesterProfile?.username || req.user.username,
          displayName: requesterProfile?.displayName || req.user.username,
          customUsername: requesterProfile?.customUsername || null,
          avatar: requesterProfile?.avatar || requesterProfile?.imageUrl || null,
          imageUrl: requesterProfile?.imageUrl || requesterProfile?.avatar || null,
          avatarHost: requesterProfile?.avatarHost || config.getImageServerUrl(),
          host: localHost,
          status: requesterProfile?.status || 'online',
          customStatus: requesterProfile?.customStatus || null
        }
      }
    })
  }
  
  console.log(`[API] Friend request sent from ${req.user.username} to ${targetUserId}`)
  res.json(result)
})

// Accept friend request
router.post('/friend-request/:id/accept', async (req, res) => {
  const currentRequests = typeof friendRequestService.getRequestsFresh === 'function'
    ? await friendRequestService.getRequestsFresh(req.user.id)
    : friendRequestService.getRequests(req.user.id)
  const incomingRequest = currentRequests.incoming?.find(request => request.id === req.params.id)
  const result = await friendRequestService.acceptRequest(req.user.id, req.params.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  // REMOVED: This saveUser call was unnecessary and could reset admin roles
  // The friendRequestService.acceptRequest already handles all necessary updates

  const remoteProfile = incomingRequest?.from ? userService.getUser(incomingRequest.from) : null
  const remoteHost = normalizeHost(remoteProfile?.host)
  const localHost = normalizeHost(config.getHost())
  if (incomingRequest?.from && remoteHost && remoteHost !== localHost) {
    const peer = federationService.getPeerByHost(remoteHost)
    if (peer?.status === 'connected') {
      const accepterProfile = userService.getUser(req.user.id)
      federationService.queueRelayMessage(peer.id, {
        type: 'friend:accept',
        payload: {
          toUserId: remoteProfile?.remoteUserId || String(incomingRequest.from).split('@')[0],
          from: {
            id: req.user.id,
            username: accepterProfile?.username || req.user.username,
            displayName: accepterProfile?.displayName || req.user.username,
            customUsername: accepterProfile?.customUsername || null,
            avatar: accepterProfile?.avatar || accepterProfile?.imageUrl || null,
            imageUrl: accepterProfile?.imageUrl || accepterProfile?.avatar || null,
            avatarHost: accepterProfile?.avatarHost || config.getImageServerUrl(),
            host: localHost,
            status: accepterProfile?.status || 'online',
            customStatus: accepterProfile?.customStatus || null
          }
        }
      })
    }
  }
  
  console.log(`[API] Friend request ${req.params.id} accepted by ${req.user.username}`)
  res.json(result)
})

// Reject friend request
router.post('/friend-request/:id/reject', async (req, res) => {
  const result = await friendRequestService.rejectRequest(req.user.id, req.params.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  console.log(`[API] Friend request ${req.params.id} rejected by ${req.user.username}`)
  res.json(result)
})

// Cancel outgoing friend request
router.delete('/friend-request/:id', async (req, res) => {
  const result = await friendRequestService.cancelRequest(req.user.id, req.params.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  console.log(`[API] Friend request ${req.params.id} cancelled by ${req.user.username}`)
  res.json(result)
})

// Cancel friend request by userId
router.delete('/friend-request/user/:userId', async (req, res) => {
  const targetUserId = req.params.userId
  const requests = typeof friendRequestService.getRequestsFresh === 'function'
    ? await friendRequestService.getRequestsFresh(req.user.id)
    : friendRequestService.getRequests(req.user.id)
  const outgoingRequest = requests.outgoing?.find(r => r.from === targetUserId || r.to === targetUserId)
  
  if (!outgoingRequest) {
    return res.status(404).json({ error: 'No pending friend request found' })
  }
  
  const result = await friendRequestService.cancelRequest(req.user.id, outgoingRequest.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  console.log(`[API] Friend request to ${targetUserId} cancelled by ${req.user.username}`)
  res.json(result)
})

// Remove friend
router.delete('/friends/:friendId', async (req, res) => {
  await friendService.removeFriend(req.user.id, req.params.friendId)
  console.log(`[API] Friend ${req.params.friendId} removed by ${req.user.username}`)
  res.json({ success: true })
})

// Block user
router.post('/block/:userId', async (req, res) => {
  await blockService.blockUser(req.user.id, req.params.userId)
  console.log(`[API] User ${req.params.userId} blocked by ${req.user.username}`)
  res.json({ success: true })
})

// Unblock user
router.delete('/block/:userId', async (req, res) => {
  await blockService.unblockUser(req.user.id, req.params.userId)
  console.log(`[API] User ${req.params.userId} unblocked by ${req.user.username}`)
  res.json({ success: true })
})

// Get unread counts for all servers
router.get('/unread-counts', async (req, res) => {
  try {
    const userId = req.user.id
    const serversData = toArray(serverService.getAllServers())
    const channelsData = channelService.getAllChannels()
    const messagesData = messageService.getAllMessages()
    const currentUser = userService.getUser(userId) || {}
    const lastRead = currentUser.lastRead || {}
    const userServers = serversData.filter(server => Array.isArray(server.members) && server.members.some(m => m?.id === userId))
    const allChannels = []
    for (const value of Object.values(channelsData || {})) {
      if (Array.isArray(value)) {
        allChannels.push(...value)
      } else if (value && typeof value === 'object') {
        allChannels.push(value)
      }
    }
    const allMessages = Object.values(messagesData || {}).filter(m => m && typeof m === 'object')
    
    const counts = {}
    for (const server of userServers) {
      const serverId = server.id
      let unread = 0
      const serverChannels = allChannels.filter(channel => channel?.serverId === serverId)
      for (const channel of serverChannels) {
        const channelMessages = allMessages.filter(m => m.channelId === channel.id)
        const lastReadTs = lastRead[channel.id] || 0
        const newMessages = channelMessages.filter(m => {
          const ts = new Date(m.timestamp || m.createdAt || 0).getTime()
          return ts > lastReadTs && m.userId !== userId
        })
        unread += newMessages.length
      }
      
      if (unread > 0) {
        counts[serverId] = { unread }
      }
    }
    
    res.json(counts)
  } catch (err) {
    console.error('[API] Get unread counts error:', err)
    res.json({})
  }
})

// Mark channel as read - updates lastRead timestamp for the channel
router.post('/mark-read', async (req, res) => {
  try {
    const userId = req.user.id
    const channelId = String(req.body?.channelId || '').trim()
    if (!RESOURCE_ID_PATTERN.test(channelId)) {
      return res.status(400).json({ error: 'channelId required' })
    }

    const userData = userService.getUser(userId) || {}
    const lastRead = {}
    if (isPlainObject(userData.lastRead)) {
      for (const [key, value] of Object.entries(userData.lastRead)) {
        if (!RESOURCE_ID_PATTERN.test(key)) continue
        const ts = Number(value)
        if (Number.isFinite(ts) && ts > 0) {
          lastRead[key] = ts
        }
      }
    }
    lastRead[channelId] = Date.now()

    // Use updateProfile instead of saveUser to avoid full user object serialization
    await userService.updateProfile(userId, { lastRead })
    res.json({ success: true })
  } catch (err) {
    console.error('[API] Mark read error:', err)
    res.status(500).json({ error: 'Failed to mark channel as read' })
  }
})

// Update server mute setting
router.put('/settings/server-mute', async (req, res) => {
  const serverId = String(req.body?.serverId || '').trim()
  const muted = req.body?.muted
  if (!RESOURCE_ID_PATTERN.test(serverId) || typeof muted !== 'boolean') {
    return res.status(400).json({ error: 'Invalid server mute payload' })
  }
  const userId = req.user.id
  
  const userData = userService.getUser(userId) || {}
  const serverMutes = {}
  if (isPlainObject(userData.serverMutes)) {
    for (const [key, value] of Object.entries(userData.serverMutes)) {
      if (!RESOURCE_ID_PATTERN.test(key) || typeof value !== 'boolean') continue
      serverMutes[key] = value
    }
  }
  serverMutes[serverId] = muted
  
  // Use updateProfile instead of saveUser to avoid resetting admin roles
  await userService.updateProfile(userId, { serverMutes })
  
  console.log(`[API] Server ${serverId} mute: ${muted} for user ${userId}`)
  res.json({ success: true })
})

// Get mutual friends with another user
router.get('/:userId/mutual-friends', async (req, res) => {
  try {
    const currentUserId = req.user.id
    const resolvedTarget = resolveCanonicalUser(req.params.userId)
    if (!resolvedTarget) {
      return res.status(404).json({ error: 'User not found' })
    }
    const targetUserId = resolvedTarget.userId
    if (hasBlockedRelationship(currentUserId, targetUserId)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const mutualFriends = await getMutualFriendsFast(currentUserId, targetUserId)
    
    const friendsData = mutualFriends.map(friendId => {
      const profile = userService.getUser(friendId)
      return {
        id: friendId,
        username: profile?.username || 'Unknown',
        displayName: profile?.displayName,
        imageUrl: resolveStoredProfileImage(profile?.imageUrl || profile?.imageurl || profile?.avatar, null, {
          allowDataUrl: true,
          maxDataBytes: MAX_AVATAR_UPLOAD_BYTES
        }),
        avatar: resolveUserAvatar(friendId, profile)
      }
    })
    
    res.json(friendsData)
  } catch (err) {
    console.error('[API] Get mutual friends error:', err)
    res.json([])
  }
})

router.get('/me/themes', async (req, res) => {
  try {
    const user = await userService.getUser(req.user.id)
    const themes = user?.savedThemes || []
    res.json(themes)
  } catch (err) {
    console.error('[API] Get saved themes error:', err)
    res.status(500).json({ error: 'Failed to get themes' })
  }
})

router.post('/me/themes', async (req, res) => {
  try {
    const { themeId, name, theme: themeData } = req.body
    const user = await userService.getUser(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    const savedThemes = user.savedThemes || []
    const existingIndex = savedThemes.findIndex(t => t.themeId === themeId)
    
    if (existingIndex >= 0) {
      savedThemes[existingIndex] = { ...savedThemes[existingIndex], name, theme: themeData }
    } else {
      savedThemes.push({ themeId, name, theme: themeData, createdAt: new Date().toISOString() })
    }
    
    await userService.updateProfile(req.user.id, { savedThemes })
    res.json({ success: true })
  } catch (err) {
    console.error('[API] Save theme error:', err)
    res.status(500).json({ error: 'Failed to save theme' })
  }
})

router.delete('/me/themes/:themeId', async (req, res) => {
  try {
    const { themeId } = req.params
    const user = await userService.getUser(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
     const savedThemes = Array.isArray(user.savedThemes) ? user.savedThemes.filter(t => t.themeId !== themeId) : []
    await userService.updateProfile(req.user.id, { savedThemes })
    res.json({ success: true })
  } catch (err) {
    console.error('[API] Delete theme error:', err)
    res.status(500).json({ error: 'Failed to delete theme' })
  }
})

router.put('/me/themes/active', async (req, res) => {
  try {
    const { themeId } = req.body
    await userService.updateProfile(req.user.id, { activeTheme: themeId })
    res.json({ success: true })
  } catch (err) {
    console.error('[API] Set active theme error:', err)
    res.status(500).json({ error: 'Failed to set active theme' })
  }
})

// Get mutual servers with another user
router.get('/:userId/mutual-servers', async (req, res) => {
  try {
    const currentUserId = req.user.id
    const resolvedTarget = resolveCanonicalUser(req.params.userId)
    if (!resolvedTarget) {
      return res.status(404).json({ error: 'User not found' })
    }
    const targetUserId = resolvedTarget.userId
    if (hasBlockedRelationship(currentUserId, targetUserId)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const mutualServers = await getMutualServersFast(currentUserId, targetUserId)
    res.json(mutualServers)
  } catch (err) {
    console.error('[API] Get mutual servers error:', err)
    res.json([])
  }
})

// ─── Profile Comments ────────────────────────────────────────────────────────
// Stored in-memory + persisted via userService on the target user's profile.
// Shape: { id, authorId, authorUsername, authorAvatar, content, createdAt, likes: [] }

const MAX_COMMENT_LENGTH = 500
const MAX_COMMENTS_PER_PROFILE = 100

const getProfileComments = (userId) => {
  const user = userService.getUser(userId)
  return Array.isArray(user?.profileComments) ? user.profileComments : []
}

// GET /api/users/:userId/comments
router.get('/:userId/comments', authenticateToken, async (req, res) => {
  try {
    const resolvedTarget = resolveCanonicalUser(req.params.userId)
    if (!resolvedTarget) return res.status(404).json({ error: 'User not found' })
    const { profile: target, userId } = resolvedTarget

    if (userId !== req.user.id && hasBlockedRelationship(req.user.id, userId)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    // Respect allowComments privacy setting
    if (target.allowComments === false && req.user.id !== userId) {
      return res.status(403).json({ error: 'This user has disabled profile comments' })
    }

    const comments = getProfileComments(userId)
    res.json(comments)
  } catch (err) {
    console.error('[API] Get profile comments error:', err)
    res.status(500).json({ error: 'Failed to load comments' })
  }
})

// POST /api/users/:userId/comments
router.post('/:userId/comments', authenticateToken, async (req, res) => {
  try {
    const resolvedTarget = resolveCanonicalUser(req.params.userId)
    if (!resolvedTarget) return res.status(404).json({ error: 'User not found' })
    const { profile: target, userId } = resolvedTarget
    const { content } = req.body

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' })
    }
    if (content.trim().length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ error: `Comment must be ${MAX_COMMENT_LENGTH} characters or less` })
    }

    if (userId !== req.user.id && hasBlockedRelationship(req.user.id, userId)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    // Respect allowComments privacy setting
    if (target.allowComments === false) {
      return res.status(403).json({ error: 'This user has disabled profile comments' })
    }

    const author = userService.getUser(req.user.id)
    const existing = getProfileComments(userId)

    if (existing.length >= MAX_COMMENTS_PER_PROFILE) {
      return res.status(400).json({ error: 'This profile has reached the maximum number of comments' })
    }

    const comment = {
      id: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      authorId: req.user.id,
      authorUsername: author?.displayName || author?.username || req.user.username,
      authorAvatar: author?.avatar || null,
      content: content.trim(),
      createdAt: new Date().toISOString(),
      likes: []
    }

    const updated = [...existing, comment]
    await userService.updateProfile(userId, { profileComments: updated })

    res.status(201).json(comment)
  } catch (err) {
    console.error('[API] Add profile comment error:', err)
    res.status(500).json({ error: 'Failed to add comment' })
  }
})

// DELETE /api/users/comments/:commentId  (author or profile owner can delete)
router.delete('/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    const { commentId } = req.params
    // We need to find which user's profile has this comment
    // For efficiency, check if a targetUserId is passed as query param
    const targetUserIdRaw = String(req.query.profileUserId || '').trim()
    if (!targetUserIdRaw) {
      return res.status(400).json({ error: 'profileUserId query param required' })
    }

    const resolvedTarget = resolveCanonicalUser(targetUserIdRaw)
    if (!resolvedTarget) return res.status(404).json({ error: 'User not found' })
    const { userId: targetUserId } = resolvedTarget

    if (targetUserId !== req.user.id && hasBlockedRelationship(req.user.id, targetUserId)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const comments = getProfileComments(targetUserId)
    const comment = comments.find(c => c.id === commentId)
    if (!comment) return res.status(404).json({ error: 'Comment not found' })

    // Only the comment author or the profile owner can delete
    if (comment.authorId !== req.user.id && targetUserId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this comment' })
    }

    const updated = comments.filter(c => c.id !== commentId)
    await userService.updateProfile(targetUserId, { profileComments: updated })

    res.json({ success: true })
  } catch (err) {
    console.error('[API] Delete profile comment error:', err)
    res.status(500).json({ error: 'Failed to delete comment' })
  }
})

// POST /api/users/comments/:commentId/like
router.post('/comments/:commentId/like', authenticateToken, async (req, res) => {
  try {
    const { commentId } = req.params
    const targetUserIdRaw = String(req.query.profileUserId || '').trim()
    if (!targetUserIdRaw) return res.status(400).json({ error: 'profileUserId query param required' })

    const resolvedTarget = resolveCanonicalUser(targetUserIdRaw)
    if (!resolvedTarget) return res.status(404).json({ error: 'User not found' })
    const { profile: target, userId: targetUserId } = resolvedTarget

    if (targetUserId !== req.user.id && hasBlockedRelationship(req.user.id, targetUserId)) {
      return res.status(403).json({ error: 'Access denied' })
    }
    if (target.allowComments === false && req.user.id !== targetUserId) {
      return res.status(403).json({ error: 'This user has disabled profile comments' })
    }

    const comments = getProfileComments(targetUserId)
    const idx = comments.findIndex(c => c.id === commentId)
    if (idx === -1) return res.status(404).json({ error: 'Comment not found' })

    const comment = { ...comments[idx] }
    if (!Array.isArray(comment.likes)) comment.likes = []
    if (!comment.likes.includes(req.user.id)) {
      comment.likes = [...comment.likes, req.user.id]
    }
    comments[idx] = comment
    await userService.updateProfile(targetUserId, { profileComments: comments })

    res.json({ likes: comment.likes })
  } catch (err) {
    console.error('[API] Like profile comment error:', err)
    res.status(500).json({ error: 'Failed to like comment' })
  }
})

// DELETE /api/users/comments/:commentId/like
router.delete('/comments/:commentId/like', authenticateToken, async (req, res) => {
  try {
    const { commentId } = req.params
    const targetUserIdRaw = String(req.query.profileUserId || '').trim()
    if (!targetUserIdRaw) return res.status(400).json({ error: 'profileUserId query param required' })

    const resolvedTarget = resolveCanonicalUser(targetUserIdRaw)
    if (!resolvedTarget) return res.status(404).json({ error: 'User not found' })
    const { profile: target, userId: targetUserId } = resolvedTarget

    if (targetUserId !== req.user.id && hasBlockedRelationship(req.user.id, targetUserId)) {
      return res.status(403).json({ error: 'Access denied' })
    }
    if (target.allowComments === false && req.user.id !== targetUserId) {
      return res.status(403).json({ error: 'This user has disabled profile comments' })
    }

    const comments = getProfileComments(targetUserId)
    const idx = comments.findIndex(c => c.id === commentId)
    if (idx === -1) return res.status(404).json({ error: 'Comment not found' })

    const comment = { ...comments[idx] }
    comment.likes = Array.isArray(comment.likes)
      ? comment.likes.filter(id => id !== req.user.id)
      : []
    comments[idx] = comment
    await userService.updateProfile(targetUserId, { profileComments: comments })

    res.json({ likes: comment.likes })
  } catch (err) {
    console.error('[API] Unlike profile comment error:', err)
    res.status(500).json({ error: 'Failed to unlike comment' })
  }
})

// GET /api/users/me/preferences
router.get('/me/preferences', authenticateToken, async (req, res) => {
  try {
    const user = userService.getUser(req.user.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    const sanitizedPreferences = sanitizePreferencePatch(user.preferences || {}) || {}
    res.json(sanitizedPreferences)
  } catch (err) {
    console.error('[API] Get preferences error:', err)
    res.status(500).json({ error: 'Failed to get preferences' })
  }
})

// PUT /api/users/me/preferences
router.put('/me/preferences', authenticateToken, async (req, res) => {
  try {
    const user = userService.getUser(req.user.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    const existingPreferences = sanitizePreferencePatch(user.preferences || {}) || {}
    const incomingPatch = sanitizePreferencePatch(req.body)
    if (incomingPatch === null) {
      return res.status(400).json({ error: 'Invalid preferences payload' })
    }
    const updated = { ...existingPreferences, ...incomingPatch }
    await userService.updateProfile(req.user.id, { preferences: updated })
    res.json(updated)
  } catch (err) {
    console.error('[API] Update preferences error:', err)
    res.status(500).json({ error: 'Failed to update preferences' })
  }
})

// GET /api/users/:userId/activity
router.get('/:userId/activity', authenticateToken, async (req, res) => {
  try {
    const resolvedTarget = resolveCanonicalUser(req.params.userId)
    if (!resolvedTarget) return res.status(404).json({ error: 'User not found' })
    const { profile: user, userId } = resolvedTarget
    if (!canAccessUserScopedData(req.user.id, userId, { requireFriend: true })) {
      return res.status(403).json({ error: 'Access denied' })
    }
    // Return basic activity info - can be expanded later
    res.json({
      userId,
      lastSeen: user.lastSeen || user.updatedAt || null,
      status: user.status || 'offline',
      activity: user.activity || null
    })
  } catch (err) {
    console.error('[API] Get user activity error:', err)
    res.status(500).json({ error: 'Failed to get user activity' })
  }
})

// GET /api/users/:userId/stats
router.get('/:userId/stats', authenticateToken, async (req, res) => {
  try {
    const resolvedTarget = resolveCanonicalUser(req.params.userId)
    if (!resolvedTarget) return res.status(404).json({ error: 'User not found' })
    const { profile: user, userId } = resolvedTarget
    if (!canAccessUserScopedData(req.user.id, userId, { requireFriend: true })) {
      return res.status(403).json({ error: 'Access denied' })
    }
    res.json({
      userId,
      joinedAt: user.createdAt || null,
      messageCount: user.messageCount || 0,
      friendCount: friendService.getFriends(userId).length
    })
  } catch (err) {
    console.error('[API] Get user stats error:', err)
    res.status(500).json({ error: 'Failed to get user stats' })
  }
})

// GET /api/users/:userId/customization
router.get('/:userId/customization', authenticateToken, async (req, res) => {
  try {
    const resolvedTarget = resolveCanonicalUser(req.params.userId)
    if (!resolvedTarget) return res.status(404).json({ error: 'User not found' })
    const { profile: user, userId } = resolvedTarget
    if (userId !== req.user.id) {
      return res.status(403).json({ error: 'Cannot access another user\'s customization' })
    }
    const sanitizedCustomization = sanitizeCustomizationPatch(user.customization || {}) || {}
    res.json(sanitizedCustomization)
  } catch (err) {
    console.error('[API] Get customization error:', err)
    res.status(500).json({ error: 'Failed to get customization' })
  }
})

// PUT /api/users/:userId/customization
router.put('/:userId/customization', authenticateToken, async (req, res) => {
  try {
    const resolvedTarget = resolveCanonicalUser(req.params.userId) || { userId: String(req.params.userId || '').trim() }
    if (resolvedTarget.userId !== req.user.id) {
      return res.status(403).json({ error: 'Cannot update another user\'s customization' })
    }
    const user = userService.getUser(req.user.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    const existingCustomization = sanitizeCustomizationPatch(user.customization || {}) || {}
    const incomingPatch = sanitizeCustomizationPatch(req.body)
    if (incomingPatch === null) {
      return res.status(400).json({ error: 'Invalid customization payload' })
    }
    const updated = { ...existingCustomization, ...incomingPatch }
    await userService.updateProfile(req.user.id, { customization: updated })
    res.json(updated)
  } catch (err) {
    console.error('[API] Update customization error:', err)
    res.status(500).json({ error: 'Failed to update customization' })
  }
})

// GET /api/users/:userId/banner - returns banner image URL for a user
router.get('/:userId/banner', async (req, res) => {
  try {
    const resolvedTarget = resolveCanonicalUser(req.params.userId)
    if (!resolvedTarget) {
      return res.json({ banner: null })
    }
    const { profile: user, userId } = resolvedTarget
    if (hasBlockedRelationship(req.user.id, userId)) {
      return res.json({ banner: null, userId })
    }
    const bannerUrl = resolveStoredProfileImage(user.banner, null, {
      allowDataUrl: true,
      maxDataBytes: MAX_DATA_IMAGE_BYTES
    })
    res.json({ banner: bannerUrl, userId })
  } catch (err) {
    console.error('[API] Get user banner error:', err)
    res.status(500).json({ error: 'Failed to get user banner' })
  }
})

export default router
