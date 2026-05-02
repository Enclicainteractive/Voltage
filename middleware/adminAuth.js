import jwt from 'jsonwebtoken'
import config from '../config/config.js'
import { userService } from '../services/dataService.js'

const JWT_FALLBACK_SECRET = 'volt_super_secret_key_change_in_production'
const JWT_VERIFY_OPTIONS = { algorithms: ['HS256', 'HS384', 'HS512'] }
const DEFAULT_TOKEN_VERSION = 0
const MIN_JWT_SECRET_LENGTH = 32
const INSECURE_JWT_SECRETS = new Set([
  JWT_FALLBACK_SECRET,
  'CHANGE_ME_TO_SECURE_RANDOM_STRING',
  'CHANGE_ME_IN_PRODUCTION'
])

const truthyFlag = (value) => value === true || value === 1 || value === '1' || value === 'true'
const ALLOW_LEGACY_UNVERSIONED_TOKENS = truthyFlag(process.env.ALLOW_LEGACY_UNVERSIONED_TOKENS)

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

const normalizeTokenText = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const normalizeRole = (value) => {
  const normalized = normalizeTokenText(value)
  return normalized ? normalized.toLowerCase() : null
}

const normalizeUserId = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return normalizeTokenText(value)
}

const getValidatedTokenUserId = (decoded = {}) => {
  const candidates = [
    normalizeUserId(decoded.userId),
    normalizeUserId(decoded.id),
    normalizeUserId(decoded.sub),
    normalizeUserId(decoded.user?.id)
  ].filter(Boolean)

  if (candidates.length === 0) return null
  const canonical = candidates[0]
  if (candidates.some((candidate) => candidate !== canonical)) {
    return null
  }
  return canonical
}

const normalizeTokenVersion = (value) => {
  if (value === undefined || value === null) return null
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue < 0) return null
  return Math.floor(numericValue)
}

const getTokenVersionFromPayload = (decoded = {}) => (
  normalizeTokenVersion(
    decoded.tokenVersion ?? decoded.sessionVersion ?? decoded.tv ?? decoded.sv
  )
)

const getPersistedTokenVersion = (user = {}) => {
  const persistedVersion = normalizeTokenVersion(user.tokenVersion ?? user.sessionVersion)
  return persistedVersion === null ? DEFAULT_TOKEN_VERSION : persistedVersion
}

const isTokenVersionValid = (decoded, user) => {
  const tokenVersion = getTokenVersionFromPayload(decoded)
  const persistedVersion = getPersistedTokenVersion(user)
  if (tokenVersion === null) {
    return ALLOW_LEGACY_UNVERSIONED_TOKENS && persistedVersion === DEFAULT_TOKEN_VERSION
  }
  return tokenVersion === persistedVersion
}

const extractBearerToken = (authHeader) => {
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
  const displayName = normalizeTokenText(decoded.displayName || decoded.user?.displayName) || username || userId
  const authProvider = normalizeTokenText(decoded.authProvider || decoded.iss) || 'local'
  return { userId, username, email, host, displayName, authProvider }
}

const bootstrapUserFromValidatedToken = async (decoded = {}) => {
  const normalized = normalizeTokenUser(decoded)
  if (!normalized.userId) return null

  const existing = userService.getUser(normalized.userId)
  if (existing) return existing

  const usernameFromEmail = normalized.email ? String(normalized.email).split('@')[0] : null
  const username = normalizeTokenText(normalized.username) || normalizeTokenText(usernameFromEmail) || normalized.userId
  if (!username) return null

  const tokenVersion = getTokenVersionFromPayload(decoded)
  const persistedTokenVersion = tokenVersion === null ? DEFAULT_TOKEN_VERSION : tokenVersion
  const seedProfile = {
    id: normalized.userId,
    username,
    displayName: normalized.displayName || username,
    email: normalized.email || null,
    host: normalized.host,
    authProvider: normalized.authProvider,
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
    savedUser = await userService.saveUser(normalized.userId, seedProfile)
    console.warn('[AdminAuth] Bootstrapped missing user profile from validated token:', normalized.userId)
  } catch (error) {
    console.error('[AdminAuth] Failed to bootstrap token-backed user profile:', error?.message || error)
    return null
  }

  return userService.getUser(normalized.userId) || savedUser || seedProfile
}

const verifyAndResolveUser = async (token) => {
  const decoded = jwt.verify(token, getJwtSecret(), JWT_VERIFY_OPTIONS)
  const userId = getValidatedTokenUserId(decoded)
  if (!userId) return null

  let user = userService.getUser(userId)
  if (!user) {
    user = await bootstrapUserFromValidatedToken(decoded)
  }
  if (!user) return null
  if (!isTokenVersionValid(decoded, user)) return null

  const role = normalizeRole(user.adminRole || user.role) || 'user'
  const isConfiguredOwner = configuredOwnerIds().has(userId)
  const isOwner = isConfiguredOwner || role === 'owner'
  const isAdmin = isOwner || role === 'admin' || truthyFlag(user.isAdmin)

  return {
    decoded,
    user,
    userId,
    role: isOwner ? 'owner' : role,
    isConfiguredOwner,
    isAdmin,
    isOwner
  }
}

const configuredOwnerIds = () => {
  const entries = Array.isArray(config.config.security?.adminUsers)
    ? config.config.security.adminUsers
    : []
  return new Set(entries.map(normalizeUserId).filter(Boolean))
}

export const requireAdmin = async (req, res, next) => {
  const token = extractBearerToken(req.headers?.authorization)
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' })
  }

  try {
    const resolved = await verifyAndResolveUser(token)
    if (!resolved) {
      return res.status(401).json({ error: 'Invalid token' })
    }

    if (!resolved.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' })
    }

    req.admin = {
      id: resolved.userId,
      username: resolved.user.username || resolved.decoded?.username || null,
      role: resolved.role,
      isAdmin: true,
      isSuperAdmin: resolved.isOwner
    }
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export const requireSuperAdmin = async (req, res, next) => {
  const token = extractBearerToken(req.headers?.authorization)
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' })
  }

  try {
    const resolved = await verifyAndResolveUser(token)
    if (!resolved) {
      return res.status(401).json({ error: 'Invalid token' })
    }
    
    if (!resolved.isOwner) {
      return res.status(403).json({ error: 'Super admin access required' })
    }

    req.admin = {
      id: resolved.userId,
      username: resolved.user.username || resolved.decoded?.username || null,
      role: resolved.role,
      isAdmin: true,
      isSuperAdmin: true
    }
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export const generateAdminToken = (userId, isSuperAdmin = false) => {
  const normalizedUserId = normalizeUserId(userId)
  if (!normalizedUserId) {
    throw new Error('Valid userId is required to generate admin token')
  }

  const user = userService.getUser(normalizedUserId) || {}
  const tokenVersion = getPersistedTokenVersion(user)
  const role = normalizeRole(user.adminRole || user.role)
  const resolvedSuperAdmin = Boolean(isSuperAdmin) || role === 'owner' || configuredOwnerIds().has(normalizedUserId)

  const payload = {
    id: normalizedUserId,
    userId: normalizedUserId,
    sub: normalizedUserId,
    isAdmin: true,
    isSuperAdmin: resolvedSuperAdmin,
    role: resolvedSuperAdmin ? 'owner' : 'admin',
    tokenVersion,
    sessionVersion: tokenVersion
  }

  return jwt.sign(
    payload,
    getJwtSecret(),
    { expiresIn: '24h' }
  )
}
