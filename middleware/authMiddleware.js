import jwt from 'jsonwebtoken'
import config from '../config/config.js'
import botService from '../services/botService.js'
import { adminService, userService } from '../services/dataService.js'

const JWT_FALLBACK_SECRET = 'volt_super_secret_key_change_in_production'
const JWT_VERIFY_OPTIONS = { algorithms: ['HS256', 'HS384', 'HS512'] }
const DEFAULT_TOKEN_VERSION = 0
const MIN_JWT_SECRET_LENGTH = 32
const INSECURE_JWT_SECRETS = new Set([
  JWT_FALLBACK_SECRET,
  'CHANGE_ME_TO_SECURE_RANDOM_STRING',
  'CHANGE_ME_IN_PRODUCTION'
])

const resolveConfiguredJwtSecret = () => (
  process.env.JWT_SECRET || config.config.security?.jwtSecret || JWT_FALLBACK_SECRET
)

const isWeakJwtSecret = (secret) => {
  if (typeof secret !== 'string') return true
  const normalized = secret.trim()
  if (!normalized) return true
  if (INSECURE_JWT_SECRETS.has(normalized)) return true
  return normalized.length < MIN_JWT_SECRET_LENGTH
}

// Fail fast when production is using a weak/default JWT secret.
if (process.env.NODE_ENV === 'production' && isWeakJwtSecret(resolveConfiguredJwtSecret())) {
  throw new Error('A secure JWT_SECRET (>=32 chars, non-default) is required in production')
}

const getJwtSecret = () => {
  const resolved = resolveConfiguredJwtSecret()
  if (process.env.NODE_ENV === 'production' && isWeakJwtSecret(resolved)) {
    throw new Error('A secure JWT_SECRET (>=32 chars, non-default) is required in production')
  }
  return typeof resolved === 'string' && resolved.trim() ? resolved.trim() : JWT_FALLBACK_SECRET
}

const truthyFlag = (value) => value === true || value === 1 || value === '1' || value === 'true'
const ALLOW_LEGACY_UNVERSIONED_TOKENS = truthyFlag(process.env.ALLOW_LEGACY_UNVERSIONED_TOKENS)

const normalizeTokenText = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const normalizeRole = (value) => {
  const normalized = normalizeTokenText(value)
  return normalized ? normalized.toLowerCase() : null
}

const normalizeTokenVersion = (value) => {
  if (value === undefined || value === null) return null
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue < 0) return null
  return Math.floor(numericValue)
}

const getTokenVersionFromPayload = (decoded = {}) => {
  return normalizeTokenVersion(
    decoded.tokenVersion ?? decoded.sessionVersion ?? decoded.tv ?? decoded.sv
  )
}

const getPersistedTokenVersion = (user = {}) => {
  const persistedVersion = normalizeTokenVersion(user.tokenVersion ?? user.sessionVersion)
  return persistedVersion === null ? DEFAULT_TOKEN_VERSION : persistedVersion
}

const isTokenVersionValid = (decoded, user) => {
  const tokenVersion = getTokenVersionFromPayload(decoded)
  const persistedVersion = getPersistedTokenVersion(user)

  // Harden revocation semantics: unversioned tokens are rejected unless
  // explicitly allowed for a migration window.
  if (tokenVersion === null) {
    return ALLOW_LEGACY_UNVERSIONED_TOKENS && persistedVersion === DEFAULT_TOKEN_VERSION
  }

  return tokenVersion === persistedVersion
}

const normalizeTokenUserId = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return normalizeTokenText(value)
}

const getValidatedTokenUserId = (decoded = {}) => {
  const candidates = [
    normalizeTokenUserId(decoded.userId),
    normalizeTokenUserId(decoded.id),
    normalizeTokenUserId(decoded.sub),
    normalizeTokenUserId(decoded.user?.id)
  ].filter(Boolean)

  if (candidates.length === 0) return null
  const canonical = candidates[0]
  if (candidates.some((candidate) => candidate !== canonical)) {
    return null
  }
  return canonical
}

const extractBearerToken = (req) => {
  const authHeader = req?.headers?.authorization
  if (typeof authHeader !== 'string') return null

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return null

  const token = normalizeTokenText(match[1])
  if (!token || token.length > 4096) return null
  return token
}

const normalizeTokenUser = (decoded = {}) => {
  const userId = getValidatedTokenUserId(decoded)
  const username = normalizeTokenText(decoded.username || decoded.preferred_username || decoded.user?.username || decoded.user?.displayName)
  const email = normalizeTokenText(decoded.email || decoded.user?.email)
  const host = normalizeTokenText(decoded.host || decoded.user?.host) || config.getHost()
  const displayName = normalizeTokenText(decoded.displayName || decoded.user?.displayName) || username
  const authProvider = normalizeTokenText(decoded.authProvider || decoded.iss) || 'local'

  return { userId, username, email, host, displayName, authProvider }
}

const isExternalImage = (value) => typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:image\//i.test(value))

const getAvatarUrl = (userId) => {
  const safeUserId = String(userId || '')
  if (!safeUserId) return null
  const baseUrl = safeUserId.startsWith('u_')
    ? (config.getServerUrl() || config.getImageServerUrl())
    : config.getImageServerUrl()
  return `${baseUrl}/api/images/users/${encodeURIComponent(safeUserId)}/profile`
}

const resolveAvatarFromToken = (decoded, userId) => {
  const tokenImageUrl = decoded?.imageUrl || decoded?.imageurl || decoded?.avatarUrl || decoded?.avatarURL || null
  if (isExternalImage(tokenImageUrl)) return tokenImageUrl
  if (isExternalImage(decoded?.avatar)) return decoded.avatar
  return getAvatarUrl(userId)
}

const bootstrapUserFromValidatedToken = async (decoded, normalized) => {
  const userId = normalizeTokenUserId(normalized?.userId)
  if (!userId) return null

  const existing = userService.getUser(userId)
  if (existing) return existing

  const usernameFromEmail = normalized?.email ? String(normalized.email).split('@')[0] : null
  const username = normalizeTokenText(normalized?.username) || normalizeTokenText(usernameFromEmail) || userId
  const displayName = normalizeTokenText(normalized?.displayName) || username
  if (!username) return null

  const tokenVersion = getTokenVersionFromPayload(decoded)
  const persistedTokenVersion = tokenVersion === null ? DEFAULT_TOKEN_VERSION : tokenVersion

  const seedProfile = {
    id: userId,
    username,
    displayName,
    email: normalized?.email || null,
    host: normalized?.host || config.getHost(),
    avatar: resolveAvatarFromToken(decoded, userId),
    avatarHost: config.getImageServerUrl(),
    authProvider: normalized?.authProvider || 'oauth',
    adminRole: null,
    isAdmin: 0,
    isModerator: 0,
    tokenVersion: persistedTokenVersion,
    sessionVersion: persistedTokenVersion,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  let savedUser = null
  try {
    savedUser = await userService.saveUser(userId, seedProfile)
    console.warn('[Auth] Bootstrapped missing user profile from validated token:', userId)
  } catch (error) {
    console.error('[Auth] Failed to bootstrap token-backed user profile:', error?.message || error)
    return null
  }

  // Prefer DB/cache-backed profile when available, but keep the saved fallback
  // so auth remains stable even during cache propagation delays.
  return userService.getUser(userId) || savedUser || seedProfile
}

const getTrustedRoleState = (userId, fallbackUser = null) => {
  const normalizedFallbackUserId = normalizeTokenUserId(fallbackUser?.id)
  const user = userService.getUser(userId) ||
    (normalizedFallbackUserId === userId ? fallbackUser : null)
  if (!user) {
    return {
      user: null,
      adminRole: null,
      isAdmin: false,
      isModerator: false
    }
  }

  const storedRole = normalizeRole(user.adminRole || user.role)
  const isAdmin = adminService.isAdmin(userId)
  const isModerator = adminService.isModerator(userId)

  return {
    user,
    adminRole: storedRole || (isAdmin ? 'admin' : (isModerator ? 'moderator' : null)),
    isAdmin,
    isModerator
  }
}

const buildAuthenticatedUser = (decoded, normalized, trustedRoles) => {
  const trustedProfile = trustedRoles?.user || {}
  const trustedUsername = normalizeTokenText(trustedProfile.username)
  const trustedDisplayName = normalizeTokenText(trustedProfile.displayName)
  const trustedEmail = normalizeTokenText(trustedProfile.email)
  const trustedHost = normalizeTokenText(trustedProfile.host)
  const trustedAuthProvider = normalizeTokenText(trustedProfile.authProvider)
  const trustedAvatar = normalizeTokenText(
    trustedProfile.imageUrl ||
    trustedProfile.imageurl ||
    trustedProfile.avatar ||
    trustedProfile.avatarUrl ||
    trustedProfile.avatarURL
  )

  const resolvedHost = trustedHost || normalized.host || config.getHost()
  const resolvedUsername = trustedUsername || normalized.username ||
    (normalized.email ? normalized.email.split('@')[0] : null) ||
    normalized.userId

  return {
    id: normalized.userId,
    username: resolvedUsername,
    displayName: trustedDisplayName || normalized.displayName || resolvedUsername,
    email: trustedEmail || normalized.email || `${resolvedUsername}@${resolvedHost}`,
    avatar: isExternalImage(trustedAvatar) ? trustedAvatar : resolveAvatarFromToken(decoded, normalized.userId),
    host: resolvedHost,
    adminRole: trustedRoles.adminRole,
    isAdmin: trustedRoles.isAdmin,
    isModerator: trustedRoles.isModerator,
    authProvider: trustedAuthProvider || normalized.authProvider
  }
}

const getConfiguredOwnerIdSet = () => {
  const entries = Array.isArray(config.config.security?.adminUsers)
    ? config.config.security.adminUsers
    : []
  return new Set(entries.map(normalizeTokenUserId).filter(Boolean))
}

export const optionalAuth = async (req, res, next) => {
  const token = extractBearerToken(req)

  if (token) {
    try {
      // Verify the token; on failure we silently skip populating req.user
      // (this is "optional" auth — invalid tokens must not authenticate, but
      // they also must not reject the request).
      const decoded = jwt.verify(token, getJwtSecret(), JWT_VERIFY_OPTIONS)
      if (decoded) {
        const normalized = normalizeTokenUser(decoded)
        if (!normalized.userId) return next()
        let trustedRoles = getTrustedRoleState(normalized.userId)
        if (!trustedRoles.user) {
          const bootstrappedUser = await bootstrapUserFromValidatedToken(decoded, normalized)
          trustedRoles = getTrustedRoleState(normalized.userId, bootstrappedUser)
        }
        if (!trustedRoles.user) return next()
        if (!isTokenVersionValid(decoded, trustedRoles.user)) return next()
        req.user = buildAuthenticatedUser(decoded, normalized, trustedRoles)
      }
    } catch (_error) {
      // Verification failed — proceed without populating req.user.
    }
  }
  next()
}

export const authenticateToken = async (req, res, next) => {
  const token = extractBearerToken(req)

  if (!token) {
    return res.status(401).json({ error: 'Access token required' })
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret(), JWT_VERIFY_OPTIONS)

    if (!decoded) {
      return res.status(403).json({ error: 'Invalid token' })
    }

    const normalized = normalizeTokenUser(decoded)
    if (!normalized.userId) {
      return res.status(403).json({ error: 'Invalid token payload' })
    }
    let trustedRoles = getTrustedRoleState(normalized.userId)
    if (!trustedRoles.user) {
      const bootstrappedUser = await bootstrapUserFromValidatedToken(decoded, normalized)
      trustedRoles = getTrustedRoleState(normalized.userId, bootstrappedUser)
      if (!trustedRoles.user) {
        return res.status(403).json({ error: 'Invalid token payload' })
      }
    }
    if (!isTokenVersionValid(decoded, trustedRoles.user)) {
      return res.status(403).json({ error: 'Token has been revoked' })
    }
    req.user = buildAuthenticatedUser(decoded, normalized, trustedRoles)
    
    console.log('[Auth] User authenticated:', req.user.username)
    next()
  } catch (error) {
    console.error('[Auth] Token validation error:', error.message)
    return res.status(403).json({ error: 'Invalid or expired token' })
  }
}

export const authenticateSocket = async (socket, next) => {
    const token = socket.handshake?.auth?.token

    if (!token) {
        return next(new Error('Authentication error'))
    }

    // Validate token is a string to prevent JWT verification errors
    if (typeof token !== 'string') {
        console.error('[Socket] Auth error: token must be a string, got:', typeof token)
        return next(new Error('Authentication error'))
    }
    if (token.length > 4096) {
        console.error('[Socket] Auth error: token too long')
        return next(new Error('Authentication error'))
    }

    // Bot tokens are random hex strings prefixed with 'vbot_', not JWTs because bots cant use JWTs because THEIR BOTS.
    // Validate them via botService and mark the socket as a bot connection
    // so downstream handlers can distinguish bot sockets from user sockets.
    if (token.startsWith('vbot_')) {
        const bot = await botService.getBotByToken(token)
        if (!bot) {
            return next(new Error('Invalid bot token'))
        }
        socket.bot = { id: bot.id, name: bot.name, servers: bot.servers }
        socket.botId = bot.id
        console.log('[Socket] Bot connected:', bot.name, `(${bot.id})`)
        return next()
    }

    try {
        const decoded = jwt.verify(token, getJwtSecret(), JWT_VERIFY_OPTIONS)

        if (!decoded) {
            return next(new Error('Invalid token'))
        }

        const normalized = normalizeTokenUser(decoded)
        if (!normalized.userId) {
            return next(new Error('Invalid token payload'))
        }
        let trustedRoles = getTrustedRoleState(normalized.userId)
        if (!trustedRoles.user) {
            const bootstrappedUser = await bootstrapUserFromValidatedToken(decoded, normalized)
            trustedRoles = getTrustedRoleState(normalized.userId, bootstrappedUser)
            if (!trustedRoles.user) {
              return next(new Error('Invalid token payload'))
            }
        }
        if (!isTokenVersionValid(decoded, trustedRoles.user)) {
            return next(new Error('Token revoked'))
        }
        socket.user = buildAuthenticatedUser(decoded, normalized, trustedRoles)
        
        console.log('[Socket] User connected:', socket.user.username)
        next()
    } catch (error) {
        console.error('[Socket] Auth error:', error.message)
        next(new Error('Authentication error'))
    }
}

// Require owner role for admin endpoints
export const requireOwner = (req, res, next) => {
  const userId = normalizeTokenUserId(req.user?.id)
  if (!userId) {
    return res.status(403).json({ error: 'Owner access required' })
  }
  
  if (getConfiguredOwnerIdSet().has(userId)) {
    return next()
  }
  const user = userService.getUser(userId)
  const role = normalizeRole(user?.adminRole || user?.role)
  if (role === 'owner') {
    return next()
  }
  
  console.warn('[Auth] Owner access denied for user:', userId)
  return res.status(403).json({ error: 'Owner access required' })
}
