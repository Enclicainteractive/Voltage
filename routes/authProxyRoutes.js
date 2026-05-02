import express from 'express'
import axios from 'axios'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import config from '../config/config.js'
import { userService } from '../services/dataService.js'
import inputValidator from '../middleware/inputValidation.js'
import { authRateLimit } from '../middleware/securityMiddleware.js'
import { toSafeUser } from '../services/userService.js'

const router = express.Router()

const DEFAULT_JWT_SECRET = 'volt_super_secret_key_change_in_production'
const DEFAULT_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60
const OAUTH_REQUEST_TIMEOUT_MS = 10000
const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1'])
const OAUTH_GRANT_TYPES = new Set(['authorization_code', 'refresh_token'])
const OAUTH_CONFIG_PLACEHOLDERS = new Set([
  '(set)',
  '<set>',
  'set',
  'change_me',
  'changeme',
  'replace_me',
  'your_client_id',
  'your-client-id'
])
const TOKEN_REQUEST_ALLOWED_FIELDS = [
  'grant_type',
  'code',
  'redirect_uri',
  'client_id',
  'refresh_token',
  'code_verifier',
  'scope'
]
const REVOKE_REQUEST_ALLOWED_FIELDS = ['token', 'token_type_hint', 'client_id']
const OAUTH_USER_STRING_FIELDS = [
  'avatar',
  'imageUrl',
  'imageurl',
  'banner',
  'bio',
  'customStatus',
  'customUsername',
  'avatarHost',
  'status',
  'profileTheme',
  'profileBackground',
  'profileAccentColor',
  'profileFont',
  'profileAnimation',
  'profileBackgroundType',
  'profileBackgroundOpacity',
  'profileCSS',
  'profileTemplate',
  'bannerEffect',
  'profileLayout',
  'badgeStyle',
  'clientCSS',
  'guildTag',
  'guildTagServerId'
]
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/
const BIRTHDATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const toTruthyFlag = (value) => value === true || value === 1 || value === '1' || value === 'true'

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const createClientError = (status, message) => {
  const error = new Error(message)
  error.status = status
  return error
}

const normalizeOptionalString = (value, maxLength = 2048) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

const normalizeConfiguredString = (value, maxLength = 2048) => {
  const normalized = normalizeOptionalString(value, maxLength)
  if (!normalized) return null
  const compact = normalized.trim().toLowerCase().replace(/\s+/g, '_')
  if (OAUTH_CONFIG_PLACEHOLDERS.has(compact)) return null
  return normalized
}

const normalizeOptionalBoolean = (value) => {
  if (value === true || value === false) return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return null
}

const normalizeUrlValue = (value, label, { required = true } = {}) => {
  const normalized = normalizeOptionalString(value, 4096)
  if (!normalized) {
    if (required) throw createClientError(500, `OAuth provider misconfigured (${label})`)
    return null
  }

  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    throw createClientError(500, `OAuth provider misconfigured (${label})`)
  }

  if (parsed.protocol === 'https:') return parsed.toString()
  const isLocalInsecureUrl = parsed.protocol === 'http:' && LOCALHOST_NAMES.has(parsed.hostname.toLowerCase())
  if (process.env.NODE_ENV !== 'production' && isLocalInsecureUrl) {
    return parsed.toString()
  }
  throw createClientError(500, `OAuth provider URL must use HTTPS (${label})`)
}

const getJwtSecret = () => process.env.JWT_SECRET || config.config.security?.jwtSecret || ''

const ensureJwtSecretForIssuance = () => {
  const secret = getJwtSecret()
  if (!secret) {
    throw createClientError(500, 'JWT signing secret is not configured')
  }
  if (process.env.NODE_ENV === 'production' && secret === DEFAULT_JWT_SECRET) {
    throw createClientError(500, 'JWT signing secret is using an insecure default in production')
  }
  return secret
}

const getJwtExpiry = () => config.config.security?.jwtExpiry || '7d'

const toTokenExpirySeconds = (expiresInValue) => {
  if (typeof expiresInValue === 'number' && Number.isFinite(expiresInValue) && expiresInValue > 0) {
    return Math.floor(expiresInValue)
  }
  if (typeof expiresInValue !== 'string') {
    return DEFAULT_TOKEN_EXPIRY_SECONDS
  }

  const trimmed = expiresInValue.trim()
  const directNumber = Number(trimmed)
  if (Number.isFinite(directNumber) && directNumber > 0) {
    return Math.floor(directNumber)
  }

  const durationMatch = trimmed.match(/^(\d+)([smhd])$/i)
  if (!durationMatch) return DEFAULT_TOKEN_EXPIRY_SECONDS

  const amount = Number(durationMatch[1])
  const unit = durationMatch[2].toLowerCase()
  let multiplier = 0
  switch (unit) {
    case 's':
      multiplier = 1
      break
    case 'm':
      multiplier = 60
      break
    case 'h':
      multiplier = 3600
      break
    case 'd':
      multiplier = 86400
      break
    default:
      multiplier = 0
  }
  if (!multiplier) return DEFAULT_TOKEN_EXPIRY_SECONDS
  return amount * multiplier
}

const getAuthTokenExpirySeconds = () => toTokenExpirySeconds(getJwtExpiry())

const shouldExposeUpstreamAccessToken = () => config.config.auth?.oauth?.exposeUpstreamAccessToken === true

const getOAuthConfig = () => {
  const oauthConfig = config.config.auth?.oauth
  if (!oauthConfig?.enabled) {
    throw createClientError(403, 'OAuth is not enabled')
  }

  if (oauthConfig.provider === 'enclica') {
    const clientId = normalizeConfiguredString(oauthConfig.enclica?.clientId, 512)

    const clientSecret = normalizeConfiguredString(
      process.env.ENCLICA_CLIENT_SECRET || oauthConfig.enclica?.clientSecret,
      4096
    )

    return {
      clientId,
      clientSecret,
      tokenUrl: normalizeUrlValue(oauthConfig.enclica?.tokenUrl, 'tokenUrl'),
      revokeUrl: normalizeUrlValue(oauthConfig.enclica?.revokeUrl, 'revokeUrl'),
      userInfoUrl: normalizeUrlValue(oauthConfig.enclica?.userInfoUrl, 'userInfoUrl', { required: false })
    }
  }

  throw createClientError(500, 'Unknown OAuth provider')
}

const createLocalToken = (userData) => {
  const userId = userData.id || userData.userId
  const resolvedTokenVersionRaw = userData.tokenVersion ?? userData.sessionVersion
  const resolvedTokenVersion = Number.isFinite(Number(resolvedTokenVersionRaw)) && Number(resolvedTokenVersionRaw) >= 0
    ? Math.floor(Number(resolvedTokenVersionRaw))
    : 0
  return jwt.sign(
    {
      userId,
      id: userId,
      sub: userId,
      username: userData.username,
      email: userData.email,
      host: userData.host || config.getHost(),
      adminRole: userData.adminRole || userData.role || null,
      isAdmin: toTruthyFlag(userData.isAdmin),
      isModerator: toTruthyFlag(userData.isModerator),
      tokenVersion: resolvedTokenVersion,
      sessionVersion: resolvedTokenVersion
    },
    ensureJwtSecretForIssuance(),
    { expiresIn: getJwtExpiry() }
  )
}

const pickStringFields = (payload, allowedFields) => {
  const picked = {}
  for (const field of allowedFields) {
    // `field` is constrained by a static allowlist (TOKEN/REVOKE_REQUEST_ALLOWED_FIELDS).
    // eslint-disable-next-line security/detect-object-injection
    const value = normalizeOptionalString(payload[field], 4096)
    // eslint-disable-next-line security/detect-object-injection
    if (value) picked[field] = value
  }
  return picked
}

const bindOAuthClientCredentials = (requestBody, oauthConfig, { errorMessage }) => {
  const configuredClientId = normalizeConfiguredString(oauthConfig?.clientId, 512)
  const requesterClientId = normalizeOptionalString(requestBody.client_id, 512)

  if (configuredClientId) {
    if (requesterClientId && requesterClientId !== configuredClientId) {
      throw createClientError(400, errorMessage)
    }
    requestBody.client_id = configuredClientId
  } else if (requesterClientId) {
    requestBody.client_id = requesterClientId
  } else {
    throw createClientError(400, errorMessage)
  }

  const requesterClientSecret = normalizeOptionalString(requestBody.client_secret, 4096)
  const configuredClientSecret = normalizeConfiguredString(oauthConfig?.clientSecret, 4096)
  if (requesterClientSecret && configuredClientSecret && requesterClientSecret !== configuredClientSecret) {
      throw createClientError(400, errorMessage)
  }

  if (configuredClientSecret) {
    requestBody.client_secret = configuredClientSecret
  } else if (!requesterClientSecret) {
    delete requestBody.client_secret
  } else {
    requestBody.client_secret = requesterClientSecret
  }

  return requestBody
}

const pickFirstPresentString = (payload, keys) => {
  for (const key of keys) {
    const normalized = normalizeOptionalString(payload?.[key], 4096)
    if (normalized) return normalized
  }
  return null
}

const extractAuthorizationCodeFromRedirectUri = (rawRedirectUri) => {
  const raw = normalizeOptionalString(rawRedirectUri, 4096)
  if (!raw) return { code: null, redirectUri: null }

  try {
    const parsed = new URL(raw)
    const code = normalizeOptionalString(parsed.searchParams.get('code'), 4096)
    if (!code) return { code: null, redirectUri: null }

    parsed.searchParams.delete('code')
    parsed.searchParams.delete('state')
    parsed.searchParams.delete('scope')
    const cleaned = `${parsed.origin}${parsed.pathname}${parsed.search || ''}`
    return { code, redirectUri: cleaned }
  } catch {
    return { code: null, redirectUri: null }
  }
}

const sanitizeTokenRequestBody = (body, oauthConfig) => {
  if (!isPlainObject(body)) {
    throw createClientError(400, 'Invalid OAuth request')
  }

  const requestBody = {
    grant_type: pickFirstPresentString(body, ['grant_type', 'grantType']),
    code: pickFirstPresentString(body, ['code', 'authorization_code', 'authorizationCode']),
    redirect_uri: pickFirstPresentString(body, ['redirect_uri', 'redirectUri']),
    client_id: pickFirstPresentString(body, ['client_id', 'clientId']),
    refresh_token: pickFirstPresentString(body, ['refresh_token', 'refreshToken']),
    code_verifier: pickFirstPresentString(body, ['code_verifier', 'codeVerifier', 'pkce_verifier', 'pkceVerifier']),
    scope: pickFirstPresentString(body, ['scope'])
  }

  for (const key of TOKEN_REQUEST_ALLOWED_FIELDS) {
    if (!requestBody[key]) delete requestBody[key]
  }

  if (!requestBody.code && requestBody.redirect_uri) {
    const extracted = extractAuthorizationCodeFromRedirectUri(requestBody.redirect_uri)
    if (extracted.code) requestBody.code = extracted.code
    if (extracted.redirectUri) requestBody.redirect_uri = extracted.redirectUri
  }

  if (!Object.keys(requestBody).length) {
    throw createClientError(400, 'Invalid OAuth request')
  }

  const inferredGrantType = requestBody.grant_type || (requestBody.refresh_token ? 'refresh_token' : 'authorization_code')
  if (!OAUTH_GRANT_TYPES.has(inferredGrantType)) {
    throw createClientError(400, 'Invalid OAuth request')
  }
  requestBody.grant_type = inferredGrantType

  if (inferredGrantType === 'authorization_code' && !requestBody.code) {
    throw createClientError(400, 'Invalid OAuth request')
  }
  if (inferredGrantType === 'refresh_token' && !requestBody.refresh_token) {
    throw createClientError(400, 'Invalid OAuth request')
  }

  return bindOAuthClientCredentials(requestBody, oauthConfig, { errorMessage: 'Invalid OAuth request' })
}

const sanitizeRevokeRequestBody = (body, oauthConfig) => {
  if (!isPlainObject(body)) {
    throw createClientError(400, 'Invalid OAuth revoke request')
  }

  const requestBody = pickStringFields(body, REVOKE_REQUEST_ALLOWED_FIELDS)
  if (!requestBody.token) {
    throw createClientError(400, 'Invalid OAuth revoke request')
  }
  return bindOAuthClientCredentials(requestBody, oauthConfig, { errorMessage: 'Invalid OAuth revoke request' })
}

const mapUpstreamOAuthError = (statusCode) => {
  if (statusCode === 429) return { status: 429, error: 'OAuth provider rate limit exceeded' }
  if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
    return { status: 401, error: 'OAuth authentication failed' }
  }
  if (statusCode >= 500) return { status: 502, error: 'OAuth provider unavailable' }
  return { status: 502, error: 'OAuth request failed' }
}

const normalizeOAuthUsername = (value) => {
  const normalized = normalizeOptionalString(value, 64)
  if (!normalized) return null
  return USERNAME_PATTERN.test(normalized) ? normalized : null
}

const deriveOAuthUsernameFromEmail = (email) => {
  const localPart = String(email || '').split('@')[0] || ''
  const candidate = localPart
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
  if (!USERNAME_PATTERN.test(candidate)) return null
  return candidate
}

const normalizeSocialLinks = (value) => {
  if (!isPlainObject(value)) return null
  const normalizedEntries = []
  for (const [key, rawLink] of Object.entries(value)) {
    const safeKey = normalizeOptionalString(key, 64)
    const safeLink = normalizeOptionalString(rawLink, 1024)
    if (safeKey && safeLink) {
      normalizedEntries.push([safeKey, safeLink])
    }
    if (normalizedEntries.length >= 10) break
  }
  if (!normalizedEntries.length) return null
  return Object.fromEntries(normalizedEntries)
}

const normalizeOAuthEmail = (value) => {
  const validation = inputValidator.validateEmail(value)
  if (!validation.valid || !validation.normalized) return null
  return validation.normalized.toLowerCase()
}

const normalizeUpstreamOAuthUser = (rawUser) => {
  if (!isPlainObject(rawUser)) return null

  const normalized = {}
  normalized.id = normalizeOptionalString(rawUser.id ?? rawUser.sub, 128)
  normalized.email = normalizeOAuthEmail(rawUser.email)
  const emailVerified = normalizeOptionalBoolean(rawUser.email_verified ?? rawUser.emailVerified)
  if (emailVerified !== null) {
    normalized.emailVerified = emailVerified
  }
  normalized.username = normalizeOAuthUsername(rawUser.username ?? rawUser.preferred_username)
  if (!normalized.username && normalized.email) {
    normalized.username = deriveOAuthUsernameFromEmail(normalized.email)
  }
  if (!normalized.username) return null

  normalized.displayName = normalizeOptionalString(rawUser.displayName ?? rawUser.name, 128) || normalized.username

  for (const field of OAUTH_USER_STRING_FIELDS) {
    const maxLength = field === 'profileCSS' || field === 'clientCSS' ? 20000 : 2048
    // `field` is constrained by static OAUTH_USER_STRING_FIELDS.
    // eslint-disable-next-line security/detect-object-injection
    const value = normalizeOptionalString(rawUser[field], maxLength)
    // eslint-disable-next-line security/detect-object-injection
    if (value !== null) normalized[field] = value
  }

  const normalizedSocialLinks = normalizeSocialLinks(rawUser.socialLinks)
  if (normalizedSocialLinks) {
    normalized.socialLinks = normalizedSocialLinks
  }

  const birthDate = normalizeOptionalString(rawUser.birthDate, 10)
  if (birthDate && BIRTHDATE_PATTERN.test(birthDate)) {
    normalized.birthDate = birthDate
  }

  return normalized
}

const stripUntrustedPrivilegeFields = (upstreamUser = {}) => {
  const safeUser = { ...upstreamUser }
  delete safeUser.adminRole
  delete safeUser.role
  delete safeUser.isAdmin
  delete safeUser.isModerator
  delete safeUser.ageVerification
  delete safeUser.ageVerificationJurisdiction
  delete safeUser.proofSummary
  delete safeUser.device
  return safeUser
}

const toSafeAuthUserResponse = (user) => {
  const safeUser = toSafeUser(user || {})
  return {
    id: safeUser.id || null,
    username: safeUser.username || null,
    displayName: safeUser.displayName || safeUser.username || null,
    email: safeUser.email || null,
    host: safeUser.host || config.getHost(),
    authProvider: safeUser.authProvider || 'oauth',
    avatar: safeUser.avatar ?? safeUser.imageUrl ?? safeUser.imageurl ?? null,
    imageUrl: safeUser.imageUrl ?? safeUser.imageurl ?? null,
    birthDate: safeUser.birthDate || null,
    ageVerification: safeUser.ageVerification || null,
    ageVerificationJurisdiction: safeUser.ageVerificationJurisdiction || null
  }
}

export const findExistingOAuthUser = (incomingUser = {}) => {
  const resolution = resolveExistingOAuthUser(incomingUser)
  if (resolution.conflict) {
    throw new Error(resolution.conflict)
  }
  return resolution.user
}

export const resolveExistingOAuthUser = (incomingUser = {}) => {
  const allUsers = Object.values(userService.getAllUsers?.() || {})
  if (!allUsers.length) return { user: null, matches: [], conflict: null }

  const matches = []
  const seenIds = new Set()
  const addMatch = (user, reason, priority) => {
    if (!user?.id || seenIds.has(user.id)) return
    seenIds.add(user.id)
    matches.push({ user, reason, priority })
  }

  const normalizedIncomingId = incomingUser.id ? String(incomingUser.id).trim() : null
  const normalizedEmail = incomingUser.email ? inputValidator.normalizeEmail(incomingUser.email)?.toLowerCase() : null
  const normalizedUsername = incomingUser.username ? String(incomingUser.username).trim().toLowerCase() : null

  // 1. Primary: match by stored OAuth subject (returning OAuth users)
  if (normalizedIncomingId) {
    const byOAuthSubject = allUsers.find((user) => String(user?.oauthSubject || '').trim() === normalizedIncomingId)
    if (byOAuthSubject) addMatch(byOAuthSubject, 'oauthSubject', 1)
  }

  // 2. Match by email - verified (strongest email match)
  if (normalizedEmail && incomingUser.emailVerified === true) {
    const byVerifiedEmail = allUsers.find((user) => user?.email?.toLowerCase() === normalizedEmail)
    if (byVerifiedEmail) addMatch(byVerifiedEmail, 'emailVerified', 2)
  }

  // 3. Match by email - unverified (catches local users logging in via OAuth)
  if (normalizedEmail) {
    const byEmail = allUsers.find((user) => user?.email?.toLowerCase() === normalizedEmail)
    if (byEmail) addMatch(byEmail, 'email', 3)
  }

  // 4. Match by username (fallback for users with same OAuth username)
  if (normalizedUsername) {
    const byUsername = allUsers.find((user) => user?.username?.toLowerCase() === normalizedUsername)
    if (byUsername) addMatch(byUsername, 'username', 4)
  }

  if (matches.length <= 1) {
    return { user: matches[0]?.user || null, matches, conflict: null }
  }

  // Sort by priority - higher priority wins
  matches.sort((a, b) => a.priority - b.priority)

  const distinctIds = Array.from(new Set(matches.map((match) => match.user.id)))
  if (distinctIds.length === 1) {
    return { user: matches[0].user, matches, conflict: null }
  }

  return {
    user: null,
    matches,
    conflict: `OAuth account matches multiple existing users (${distinctIds.join(', ')}); refusing to create or merge a duplicate account`
  }
}

export const buildOAuthUserRecord = (upstreamUser, existingUser = null) => ({
  username: upstreamUser.username ?? existingUser?.username ?? null,
  displayName: upstreamUser.displayName ?? existingUser?.displayName ?? upstreamUser.username ?? null,
  email: upstreamUser.email ?? existingUser?.email ?? null,
  authProvider: config.config.auth?.oauth?.provider || existingUser?.authProvider || 'oauth',
  host: config.getHost(),
  avatar: upstreamUser.avatar ?? existingUser?.avatar ?? null,
  imageUrl: upstreamUser.imageUrl ?? upstreamUser.avatar ?? existingUser?.imageUrl ?? existingUser?.avatar ?? null,
  imageurl: upstreamUser.imageurl ?? upstreamUser.imageUrl ?? upstreamUser.avatar ?? existingUser?.imageurl ?? existingUser?.imageUrl ?? existingUser?.avatar ?? null,
  banner: upstreamUser.banner ?? existingUser?.banner ?? null,
  bio: upstreamUser.bio ?? existingUser?.bio ?? null,
  customStatus: upstreamUser.customStatus ?? existingUser?.customStatus ?? null,
  socialLinks: upstreamUser.socialLinks ?? existingUser?.socialLinks ?? null,
  customUsername: upstreamUser.customUsername ?? existingUser?.customUsername ?? null,
  avatarHost: upstreamUser.avatarHost ?? existingUser?.avatarHost ?? null,
  status: upstreamUser.status ?? existingUser?.status ?? null,
  profileTheme: upstreamUser.profileTheme ?? existingUser?.profileTheme ?? null,
  profileBackground: upstreamUser.profileBackground ?? existingUser?.profileBackground ?? null,
  profileAccentColor: upstreamUser.profileAccentColor ?? existingUser?.profileAccentColor ?? null,
  profileFont: upstreamUser.profileFont ?? existingUser?.profileFont ?? null,
  profileAnimation: upstreamUser.profileAnimation ?? existingUser?.profileAnimation ?? null,
  profileBackgroundType: upstreamUser.profileBackgroundType ?? existingUser?.profileBackgroundType ?? null,
  profileBackgroundOpacity: upstreamUser.profileBackgroundOpacity ?? existingUser?.profileBackgroundOpacity ?? null,
  profileCSS: upstreamUser.profileCSS ?? existingUser?.profileCSS ?? null,
  profileTemplate: upstreamUser.profileTemplate ?? existingUser?.profileTemplate ?? null,
  bannerEffect: upstreamUser.bannerEffect ?? existingUser?.bannerEffect ?? null,
  profileLayout: upstreamUser.profileLayout ?? existingUser?.profileLayout ?? null,
  badgeStyle: upstreamUser.badgeStyle ?? existingUser?.badgeStyle ?? null,
  clientCSS: upstreamUser.clientCSS ?? existingUser?.clientCSS ?? null,
  clientCSSEnabled: upstreamUser.clientCSSEnabled ?? existingUser?.clientCSSEnabled ?? null,
  guildTag: upstreamUser.guildTag ?? existingUser?.guildTag ?? null,
  guildTagServerId: upstreamUser.guildTagServerId ?? existingUser?.guildTagServerId ?? null,
  ageVerification: existingUser?.ageVerification ?? upstreamUser.ageVerification ?? null,
  ageVerificationJurisdiction: existingUser?.ageVerificationJurisdiction ?? upstreamUser.ageVerificationJurisdiction ?? null,
  proofSummary: existingUser?.proofSummary ?? upstreamUser.proofSummary ?? null,
  device: existingUser?.device ?? upstreamUser.device ?? null,
  adminRole: existingUser?.adminRole ?? upstreamUser.adminRole ?? upstreamUser.role ?? null,
  isAdmin: existingUser?.isAdmin ?? upstreamUser.isAdmin ?? false,
  isModerator: existingUser?.isModerator ?? upstreamUser.isModerator ?? false,
  tokenVersion: Number.isFinite(Number(existingUser?.tokenVersion ?? existingUser?.sessionVersion))
    ? Math.floor(Number(existingUser?.tokenVersion ?? existingUser?.sessionVersion))
    : 0,
  sessionVersion: Number.isFinite(Number(existingUser?.sessionVersion ?? existingUser?.tokenVersion))
    ? Math.floor(Number(existingUser?.sessionVersion ?? existingUser?.tokenVersion))
    : 0,
  birthDate: existingUser?.birthDate ?? upstreamUser.birthDate ?? null,
  oauthSubject: existingUser?.oauthSubject ?? upstreamUser.oauthSubject ?? upstreamUser.id ?? null
})

router.post('/token', authRateLimit, async (req, res) => {
  try {
    if (!config.isOAuthEnabled()) {
      return res.status(403).json({ error: 'OAuth is not enabled' })
    }

    const oauthConfig = getOAuthConfig()
    const tokenRequestBody = sanitizeTokenRequestBody(req.body, oauthConfig)

    const tokenResponse = await axios.post(oauthConfig.tokenUrl, tokenRequestBody, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: OAUTH_REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true
    })

    if (tokenResponse.status !== 200) {
      const mappedError = mapUpstreamOAuthError(tokenResponse.status)
      return res.status(mappedError.status).json({ error: mappedError.error })
    }

    const oauthAccessToken = normalizeOptionalString(tokenResponse.data?.access_token, 4096)
    if (!oauthAccessToken) {
      return res.status(502).json({ error: 'OAuth provider returned an invalid token response' })
    }

    let rawUserData = null

    if (oauthConfig.userInfoUrl) {
      try {
        const userResponse = await axios.get(oauthConfig.userInfoUrl, {
          headers: {
            Authorization: `Bearer ${oauthAccessToken}`
          },
          timeout: OAUTH_REQUEST_TIMEOUT_MS,
          maxRedirects: 0,
          validateStatus: () => true
        })

        if (userResponse.status === 200 && isPlainObject(userResponse.data)) {
          rawUserData = userResponse.data
        }
      } catch (_error) {
        // Fallback to token payload user object below.
      }
    }

    if (!rawUserData && isPlainObject(tokenResponse.data?.user)) {
      rawUserData = tokenResponse.data.user
    }

    const normalizedUserData = normalizeUpstreamOAuthUser(rawUserData)
    if (!normalizedUserData) {
      return res.status(502).json({ error: 'OAuth provider did not return a usable user profile' })
    }

    normalizedUserData.host = config.getHost()
    const resolution = resolveExistingOAuthUser(normalizedUserData)
    if (resolution.conflict) {
      return res.status(409).json({ error: 'OAuth account could not be linked' })
    }

    const existingUser = resolution.user

    if (normalizedUserData.email) {
      const normalizedEmail = normalizedUserData.email.toLowerCase()
      const allUsers = userService.getAllUsers() || {}
      const emailConflict = Object.values(allUsers).find(
        (user) => user.email?.toLowerCase() === normalizedEmail && user.id !== existingUser?.id
      )
      if (emailConflict) {
        return res.status(409).json({ error: 'OAuth account could not be linked' })
      }
    }

    const targetUserId = existingUser?.id || `u_${crypto.randomBytes(16).toString('hex')}`
    const trustedUpstreamUser = stripUntrustedPrivilegeFields(normalizedUserData)
    const mergedUserRecord = buildOAuthUserRecord(trustedUpstreamUser, existingUser)
    const savedUser = await userService.saveUser(targetUserId, mergedUserRecord)
    const localToken = createLocalToken(savedUser)

    const responsePayload = {
      access_token: localToken,
      token_type: 'Bearer',
      expires_in: getAuthTokenExpirySeconds(),
      user: toSafeAuthUserResponse(savedUser)
    }
    if (shouldExposeUpstreamAccessToken()) {
      responsePayload.upstream_access_token = oauthAccessToken
    }

    return res.json(responsePayload)
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500
    if (status >= 500) {
      console.error('[OAuth Proxy] Token exchange error:', error.message)
    }
    return res.status(status).json({
      error: status >= 500 ? 'Token exchange failed' : error.message
    })
  }
})

router.post('/revoke', authRateLimit, async (req, res) => {
  try {
    if (!config.isOAuthEnabled()) {
      return res.status(403).json({ error: 'OAuth is not enabled' })
    }

    const oauthConfig = getOAuthConfig()
    const revokeRequestBody = sanitizeRevokeRequestBody(req.body, oauthConfig)

    const response = await axios.post(oauthConfig.revokeUrl, revokeRequestBody, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: OAUTH_REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true
    })

    if (response.status !== 200 && response.status !== 204) {
      const mappedError = mapUpstreamOAuthError(response.status)
      return res.status(mappedError.status).json({ error: mappedError.error })
    }

    return res.status(200).json({ success: true })
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500
    if (status >= 500) {
      console.error('[OAuth Proxy] Token revoke error:', error.message)
    }
    return res.status(status).json({
      error: status >= 500 ? 'Token revoke failed' : error.message
    })
  }
})

export default router
