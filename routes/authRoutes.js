import express from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import config from '../config/config.js'
import { userService } from '../services/dataService.js'
import { validateRequestSecurity, sanitizeBody } from '../middleware/requestSecurity.js'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { loginRateLimit, authRateLimit } from '../middleware/securityMiddleware.js'
import securityLogger from '../services/securityLogger.js'
import inputValidator from '../middleware/inputValidation.js'
import { toSafeUser } from '../services/userService.js'

const router = express.Router()

const DEFAULT_JWT_SECRET = 'volt_super_secret_key_change_in_production'
const DEFAULT_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60
const GENERIC_INVALID_CREDENTIALS_RESPONSE = { error: 'Invalid credentials' }
const GENERIC_REGISTRATION_CONFLICT_RESPONSE = { error: 'Unable to register with provided details' }
const GENERIC_PASSWORD_RESET_RESPONSE = { message: 'If the email exists, a reset link has been sent' }
const DUMMY_BCRYPT_HASH = '$2b$12$neRp6PuSr3Gz9CLWmf1bYeEHJex9MgoEsp7nc0h9aXvf3Kj3RC0Uy'
const DEFAULT_BCRYPT_ROUNDS = 12
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PASSWORD_UPPER_PATTERN = /[A-Z]/
const PASSWORD_NUMBER_PATTERN = /\d/
const PASSWORD_SYMBOL_PATTERN = /[^A-Za-z0-9]/
const DEFAULT_TOKEN_VERSION = 0
const RESET_TOKEN_HEX_PATTERN = /^[a-f0-9]{64}$/i
const PASSWORD_RESET_TOKEN_BYTES = 32
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000
const LOGIN_IDENTIFIER_MAX_FAILURES = 8
const LOGIN_IDENTIFIER_LOCKOUT_MS = 15 * 60 * 1000

const loginIdentifierAttempts = new Map()

const isExternalImage = (value) => typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:image\//i.test(value))

const getAvatarUrl = (userId) => {
  const safeUserId = String(userId || '')
  if (!safeUserId) return null
  const baseUrl = safeUserId.startsWith('u_')
    ? (config.getServerUrl() || config.getImageServerUrl())
    : config.getImageServerUrl()
  return `${baseUrl}/api/images/users/${encodeURIComponent(safeUserId)}/profile`
}

const resolveUserAvatar = (userId, profile = null) => {
  const explicit = profile?.imageUrl || profile?.imageurl || profile?.avatarUrl || profile?.avatarURL || profile?.avatar || null
  if (isExternalImage(explicit)) return explicit
  return getAvatarUrl(userId)
}

const generateUserId = () => {
  return `u_${crypto.randomBytes(16).toString('hex')}`
}

const toTruthyFlag = (value) => value === true || value === 1 || value === '1' || value === 'true'
const BIRTHDATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const normalizeBirthDate = (value) => {
  if (!value) return null
  if (typeof value !== 'string' || !BIRTHDATE_PATTERN.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  const now = new Date()
  if (parsed > now) return null
  const ageYears = now.getUTCFullYear() - parsed.getUTCFullYear()
  if (ageYears > 120) return null
  return value
}

const getJwtSecret = () => process.env.JWT_SECRET || config.config.security?.jwtSecret || ''

const isUnsafeJwtSecret = (secret) => !secret || secret === DEFAULT_JWT_SECRET

const ensureJwtSecretForIssuance = () => {
  const secret = getJwtSecret()
  if (!secret) {
    throw new Error('JWT signing secret is not configured')
  }
  if (process.env.NODE_ENV === 'production' && isUnsafeJwtSecret(secret)) {
    throw new Error('JWT signing secret is using an insecure default in production')
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
  if (!durationMatch) {
    return DEFAULT_TOKEN_EXPIRY_SECONDS
  }

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

const signAuthToken = (payload) => {
  return jwt.sign(payload, ensureJwtSecretForIssuance(), { expiresIn: getJwtExpiry() })
}

const getBcryptRounds = () => {
  const rawRounds = Number(config.config.security?.bcryptRounds)
  if (!Number.isFinite(rawRounds)) return DEFAULT_BCRYPT_ROUNDS
  return Math.min(15, Math.max(10, Math.floor(rawRounds)))
}

const normalizeTokenVersion = (value, fallback = DEFAULT_TOKEN_VERSION) => {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue < 0) return fallback
  return Math.floor(numericValue)
}

const getPersistedTokenVersion = (user) => {
  const rawVersion = user?.tokenVersion ?? user?.sessionVersion
  return normalizeTokenVersion(rawVersion, DEFAULT_TOKEN_VERSION)
}

const buildAuthTokenPayload = (user, host) => {
  const tokenVersion = getPersistedTokenVersion(user)
  return {
    userId: user.id,
    id: user.id,
    sub: user.id,
    username: user.username,
    email: user.email,
    host,
    adminRole: user.adminRole || user.role || null,
    isAdmin: toTruthyFlag(user.isAdmin),
    isModerator: toTruthyFlag(user.isModerator),
    tokenVersion,
    sessionVersion: tokenVersion
  }
}

const getPasswordPolicy = () => {
  const localAuthConfig = config.config.auth?.local || {}
  const rawMin = Number(localAuthConfig.minPasswordLength)
  const rawMax = Number(localAuthConfig.maxPasswordLength)
  const minLength = Number.isFinite(rawMin) ? Math.max(8, Math.floor(rawMin)) : 8
  const maxLength = Number.isFinite(rawMax)
    ? Math.min(256, Math.max(minLength, Math.floor(rawMax)))
    : 128
  return {
    minLength,
    maxLength,
    requirements: localAuthConfig.passwordRequirements || {}
  }
}

const validatePasswordAgainstPolicy = (password) => {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password is required' }
  }

  const { minLength, maxLength, requirements } = getPasswordPolicy()
  if (password.length < minLength) {
    return { valid: false, error: `Password must be at least ${minLength} characters` }
  }
  if (password.length > maxLength) {
    return { valid: false, error: `Password must be at most ${maxLength} characters` }
  }
  if (requirements.requireUppercase && !PASSWORD_UPPER_PATTERN.test(password)) {
    return { valid: false, error: 'Password must include at least one uppercase letter' }
  }
  if (requirements.requireNumbers && !PASSWORD_NUMBER_PATTERN.test(password)) {
    return { valid: false, error: 'Password must include at least one number' }
  }
  if (requirements.requireSymbols && !PASSWORD_SYMBOL_PATTERN.test(password)) {
    return { valid: false, error: 'Password must include at least one symbol' }
  }
  return { valid: true }
}

const normalizePasswordResetToken = (value) => {
  if (typeof value !== 'string') return ''
  return value.trim()
}

const hashPasswordResetToken = (rawToken) => {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

const safeStringEquals = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

const isLocalPasswordAccount = (user) => {
  if (!user || typeof user !== 'object') return false
  const hasPasswordHash = typeof user.passwordHash === 'string' && user.passwordHash.length > 0
  if (!hasPasswordHash) return false
  const authProvider = typeof user.authProvider === 'string' ? user.authProvider.trim().toLowerCase() : ''
  return !authProvider || authProvider === 'local'
}

const normalizeLoginAttemptKey = (identifier) => {
  if (typeof identifier !== 'string') return ''
  return identifier.trim().toLowerCase()
}

const cleanupExpiredLoginAttemptEntries = (now = Date.now()) => {
  for (const [key, entry] of loginIdentifierAttempts.entries()) {
    const lockExpired = !entry.lockUntil || entry.lockUntil <= now
    const windowExpired = !entry.lastFailureAt || (now - entry.lastFailureAt > LOGIN_FAILURE_WINDOW_MS)
    if (lockExpired && windowExpired) {
      loginIdentifierAttempts.delete(key)
    }
  }
}

const isLoginAttemptLocked = (attemptKey, now = Date.now()) => {
  if (!attemptKey) return false
  cleanupExpiredLoginAttemptEntries(now)
  const entry = loginIdentifierAttempts.get(attemptKey)
  if (!entry || !entry.lockUntil) return false
  return entry.lockUntil > now
}

const recordLoginAttemptFailure = (attemptKey, now = Date.now()) => {
  if (!attemptKey) return null
  cleanupExpiredLoginAttemptEntries(now)
  const previous = loginIdentifierAttempts.get(attemptKey)
  const isWithinWindow = Boolean(previous?.lastFailureAt) && (now - previous.lastFailureAt <= LOGIN_FAILURE_WINDOW_MS)
  const failureCount = isWithinWindow ? ((previous.failureCount || 0) + 1) : 1
  const shouldLock = failureCount >= LOGIN_IDENTIFIER_MAX_FAILURES
  const lockUntil = shouldLock
    ? now + LOGIN_IDENTIFIER_LOCKOUT_MS
    : (previous?.lockUntil && previous.lockUntil > now ? previous.lockUntil : null)

  const next = { failureCount, lastFailureAt: now, lockUntil }
  loginIdentifierAttempts.set(attemptKey, next)
  return next
}

const clearLoginAttemptFailures = (attemptKey) => {
  if (!attemptKey) return
  loginIdentifierAttempts.delete(attemptKey)
}

const normalizeUsername = (username) => {
  const config_host = config.getHost()
  const normalizedUsername = typeof username === 'string' ? username.trim() : ''
  if (!normalizedUsername) {
    return {
      username: '',
      host: null,
      fullUsername: ''
    }
  }

  if (normalizedUsername.includes('@')) {
    const [localPart, host] = normalizedUsername.split('@')
    return {
      username: localPart.trim(),
      host: host === config_host ? null : host,
      fullUsername: normalizedUsername
    }
  }
  
  return {
    username: normalizedUsername,
    host: null,
    fullUsername: `${normalizedUsername}@${config_host}`
  }
}

const parseUsername = (usernameInput) => {
  const normalizedInput = typeof usernameInput === 'string' ? usernameInput.trim() : ''
  if (normalizedInput.includes('@')) {
    const [username, host] = normalizedInput.split('@')
    const config_host = config.getHost()
    const normalizedHost = String(host || '').trim()
    
    if (normalizedHost && normalizedHost.toLowerCase() !== String(config_host).toLowerCase()) {
      return {
        username: String(username || '').trim(),
        host: normalizedHost,
        isLocal: false,
        isFederated: true
      }
    }
    
    return {
      username: String(username || '').trim(),
      host: config_host,
      isLocal: true,
      isFederated: false
    }
  }
  
  return {
    username: normalizedInput,
    host: config.getHost(),
    isLocal: true,
    isFederated: false
  }
}

router.post('/register', authRateLimit, async (req, res) => {
  try {
    const securityCheck = validateRequestSecurity(req.body)
    if (!securityCheck.valid) {
      securityLogger.logSecurityEvent('HONEYPOT_TRIGGERED', { ip: req.ip, endpoint: '/register' })
      return res.status(400).json({ error: securityCheck.error })
    }
    
    const body = sanitizeBody(req.body)
    
    if (!config.isLocalAuthEnabled()) {
      return res.status(403).json({ error: 'Local registration is disabled' })
    }
    
    if (!config.isRegistrationAllowed()) {
      return res.status(403).json({ error: 'Registration is closed' })
    }
    
    const { email, password, username, birthDate } = body
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const emailValidation = inputValidator.validateEmail(email)
    if (!emailValidation.valid || !emailValidation.normalized || !EMAIL_PATTERN.test(emailValidation.normalized)) {
      return res.status(400).json({ error: 'Invalid email format' })
    }
    const normalizedEmail = emailValidation.normalized

    const normalizedBirthDate = normalizeBirthDate(birthDate)
    if (!normalizedBirthDate) {
      return res.status(400).json({ error: 'A valid birth date is required' })
    }
    
    const passwordValidation = validatePasswordAgainstPolicy(password)
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error })
    }
    
    // If a username was provided, parse it for federation check.
    // If only an email was provided (no username), derive the username from the email
    // local part and treat it as a local registration — never treat the email domain
    // as a Voltage federation host.
    let parsedUsername
    if (username) {
      const normalized = normalizeUsername(username)
      parsedUsername = parseUsername(normalized.fullUsername)
      if (!parsedUsername.isLocal) {
        return res.status(400).json({ error: 'Cannot register users from other servers' })
      }
      const usernameValidation = inputValidator.validateUsername(parsedUsername.username)
      if (!usernameValidation.valid) {
        return res.status(400).json({ error: usernameValidation.error })
      }
    } else {
      // Derive username from email local part (e.g. "user" from "user@gmail.com")
      const emailLocalPart = normalizedEmail.split('@')[0]
      parsedUsername = {
        username: emailLocalPart,
        host: config.getHost(),
        isLocal: true,
        isFederated: false
      }
      const usernameValidation = inputValidator.validateUsername(parsedUsername.username)
      if (!usernameValidation.valid) {
        return res.status(400).json({ error: 'Please provide a valid username for this email address' })
      }
    }
    
    const existingUsers = userService.getAllUsers() || {}
    const existingByEmail = Object.values(existingUsers).find(u => u.email?.toLowerCase() === normalizedEmail.toLowerCase())
    const existingByUsername = Object.values(existingUsers).find(
      u => u.username?.toLowerCase() === parsedUsername.username.toLowerCase()
    )
    if (existingByEmail || existingByUsername) {
      return res.status(409).json(GENERIC_REGISTRATION_CONFLICT_RESPONSE)
    }
    
    const userId = generateUserId()
    const hashedPassword = await bcrypt.hash(password, getBcryptRounds())
    
    const userData = {
      id: userId,
      username: parsedUsername.username,
      displayName: parsedUsername.username,
      email: normalizedEmail.toLowerCase(),
      passwordHash: hashedPassword,
      authProvider: 'local',
      tokenVersion: DEFAULT_TOKEN_VERSION,
      sessionVersion: DEFAULT_TOKEN_VERSION,
      birthDate: normalizedBirthDate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    await userService.saveUser(userId, userData)
    
    const token = signAuthToken(buildAuthTokenPayload(userData, parsedUsername.host))

    console.log(`[Auth] New local user registered: ${parsedUsername.username}@${parsedUsername.host}`)
    
    res.status(201).json({
      user: {
        id: userId,
        username: parsedUsername.username,
        displayName: parsedUsername.username,
        email: normalizedEmail.toLowerCase(),
        avatar: null,
        birthDate: normalizedBirthDate
      },
      access_token: token,
      token_type: 'Bearer',
      expires_in: getAuthTokenExpirySeconds()
    })
  } catch (error) {
    console.error('[Auth] Registration error:', error)
    res.status(500).json({ error: 'Registration failed' })
  }
})

router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const securityCheck = validateRequestSecurity(req.body)
    if (!securityCheck.valid) {
      securityLogger.logSecurityEvent('HONEYPOT_TRIGGERED', { ip: req.ip, endpoint: '/login' })
      return res.status(400).json({ error: securityCheck.error })
    }
    
    const body = sanitizeBody(req.body)
    
    if (!config.isLocalAuthEnabled()) {
      return res.status(403).json({ error: 'Local authentication is disabled' })
    }
    
    const { username, password, email } = body
    
    const loginIdentifier = typeof username === 'string' && username.trim().length > 0
      ? username.trim()
      : (typeof email === 'string' ? email.trim() : '')
    if (!loginIdentifier || typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'Username/email and password are required' })
    }
    const loginAttemptKey = normalizeLoginAttemptKey(loginIdentifier)
    if (isLoginAttemptLocked(loginAttemptKey)) {
      securityLogger.logSecurityEvent('LOGIN_IDENTIFIER_LOCKED', { ip: req.ip })
      return res.status(401).json(GENERIC_INVALID_CREDENTIALS_RESPONSE)
    }

    // Detect if the identifier is an email address.
    // An email has the form local@domain.tld — we check for a dot after the @.
    // If it IS an email, we always treat it as a local login (look up by email),
    // never as a federated username, because email domains are not Voltage hosts.
    const isEmailLogin = EMAIL_PATTERN.test(loginIdentifier)

    let normalizedLogin = loginIdentifier
    if (isEmailLogin) {
      const emailValidation = inputValidator.validateEmail(loginIdentifier)
      if (!emailValidation.valid || !emailValidation.normalized) {
        recordLoginAttemptFailure(loginAttemptKey)
        return res.status(401).json(GENERIC_INVALID_CREDENTIALS_RESPONSE)
      }
      normalizedLogin = emailValidation.normalized.toLowerCase()
    }

    // Only run federation check for non-email identifiers (e.g. user@otherserver.volt)
    let parsedUsername = null
    if (!isEmailLogin) {
      parsedUsername = parseUsername(loginIdentifier)
      if (!parsedUsername.isLocal) {
        recordLoginAttemptFailure(loginAttemptKey)
        return res.status(401).json(GENERIC_INVALID_CREDENTIALS_RESPONSE)
      }
      const usernameValidation = inputValidator.validateUsername(parsedUsername.username)
      if (!usernameValidation.valid) {
        recordLoginAttemptFailure(loginAttemptKey)
        return res.status(401).json(GENERIC_INVALID_CREDENTIALS_RESPONSE)
      }
    }

    const allUsers = userService.getAllUsers() || {}
    const user = isEmailLogin
      ? Object.values(allUsers).find((u) => u.email?.toLowerCase() === normalizedLogin)
      : Object.values(allUsers).find((u) => u.username?.toLowerCase() === parsedUsername.username.toLowerCase())
    
    if (!isLocalPasswordAccount(user)) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH)
      recordLoginAttemptFailure(loginAttemptKey)
      securityLogger.logLogin(null, req.ip, false)
      return res.status(401).json(GENERIC_INVALID_CREDENTIALS_RESPONSE)
    }
    
    const validPassword = await bcrypt.compare(password, user.passwordHash)
    if (!validPassword) {
      recordLoginAttemptFailure(loginAttemptKey)
      securityLogger.logLogin(user.id, req.ip, false)
      return res.status(401).json(GENERIC_INVALID_CREDENTIALS_RESPONSE)
    }
    clearLoginAttemptFailures(loginAttemptKey)
    
    const token = signAuthToken(buildAuthTokenPayload(user, config.getHost()))

    console.log(`[Auth] Local user logged in: ${user.username}`)
    securityLogger.logLogin(user.id, req.ip, true)
    
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName || user.username,
        email: user.email,
        birthDate: user.birthDate || null,
        ageVerification: user.ageVerification || null,
        ageVerificationJurisdiction: user.ageVerificationJurisdiction || null,
        imageUrl: user.imageUrl || user.imageurl || user.avatarUrl || user.avatarURL || (isExternalImage(user.avatar) ? user.avatar : null),
        avatar: resolveUserAvatar(user.id, user)
      },
      access_token: token,
      token_type: 'Bearer',
      expires_in: getAuthTokenExpirySeconds()
    })
  } catch (error) {
    console.error('[Auth] Login error:', error)
    res.status(500).json({ error: 'Login failed' })
  }
})

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const tokenUserId = req.user?.id
    if (!tokenUserId) {
      return res.status(401).json({ error: 'Invalid token' })
    }

    const user = userService.getUser(tokenUserId)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    const nextTokenVersion = getPersistedTokenVersion(user) + 1
    await userService.updateProfile(tokenUserId, {
      tokenVersion: nextTokenVersion,
      sessionVersion: nextTokenVersion
    })

    securityLogger.logSecurityEvent('LOGOUT', {
      userId: tokenUserId,
      ip: req.ip,
      tokenVersion: nextTokenVersion
    })

    return res.json({ message: 'Logged out successfully' })
  } catch (error) {
    console.error('[Auth] Logout error:', error)
    return res.status(500).json({ error: 'Logout failed' })
  }
})

router.post('/forgot-password', authRateLimit, async (req, res) => {
  try {
    const securityCheck = validateRequestSecurity(req.body)
    if (!securityCheck.valid) {
      securityLogger.logSecurityEvent('HONEYPOT_TRIGGERED', { ip: req.ip, endpoint: '/forgot-password' })
      return res.status(400).json({ error: securityCheck.error })
    }

    const body = sanitizeBody(req.body)

    if (!config.isLocalAuthEnabled()) {
      return res.status(403).json({ error: 'Local authentication is disabled' })
    }
    
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    if (!email) {
      return res.json(GENERIC_PASSWORD_RESET_RESPONSE)
    }
    
    const emailValidation = inputValidator.validateEmail(email)
    if (!emailValidation.valid || !emailValidation.normalized) {
      return res.json(GENERIC_PASSWORD_RESET_RESPONSE)
    }

    const normalizedEmail = emailValidation.normalized.toLowerCase()
    const allUsers = userService.getAllUsers() || {}
    const user = Object.values(allUsers).find(
      (u) => u.email?.toLowerCase() === normalizedEmail && isLocalPasswordAccount(u)
    )
    
    if (!user) {
      return res.json(GENERIC_PASSWORD_RESET_RESPONSE)
    }
    
    const resetToken = crypto.randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('hex')
    const resetTokenHash = hashPasswordResetToken(resetToken)
    const resetExpiry = Date.now() + 3600000
    
    await userService.updateProfile(user.id, {
      resetToken: resetTokenHash,
      resetExpiry
    })
    
    console.log(`[Auth] Password reset requested for: ${user.username}`)
    
    res.json(GENERIC_PASSWORD_RESET_RESPONSE)
  } catch (error) {
    console.error('[Auth] Forgot password error:', error)
    res.status(500).json({ error: 'Request failed' })
  }
})

router.post('/reset-password', authRateLimit, async (req, res) => {
  try {
    const securityCheck = validateRequestSecurity(req.body)
    if (!securityCheck.valid) {
      securityLogger.logSecurityEvent('HONEYPOT_TRIGGERED', { ip: req.ip, endpoint: '/reset-password' })
      return res.status(400).json({ error: securityCheck.error })
    }

    const body = sanitizeBody(req.body)

    if (!config.isLocalAuthEnabled()) {
      return res.status(403).json({ error: 'Local authentication is disabled' })
    }
    
    const { token, password } = body
    
    const presentedToken = normalizePasswordResetToken(token)
    if (!presentedToken || !password) {
      return res.status(400).json({ error: 'Token and new password are required' })
    }

    if (!RESET_TOKEN_HEX_PATTERN.test(presentedToken)) {
      return res.status(400).json({ error: 'Invalid or expired reset token' })
    }

    const passwordValidation = validatePasswordAgainstPolicy(password)
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error })
    }
    
    const presentedTokenHash = hashPasswordResetToken(presentedToken)
    const allUsers = userService.getAllUsers() || {}
    const now = Date.now()
    const user = Object.values(allUsers).find((candidate) => {
      const expiry = Number(candidate?.resetExpiry)
      if (!Number.isFinite(expiry) || expiry <= now) return false
      const storedToken = typeof candidate?.resetToken === 'string' ? candidate.resetToken : ''
      if (!storedToken) return false
      if (!RESET_TOKEN_HEX_PATTERN.test(storedToken)) return false
      return safeStringEquals(storedToken, presentedTokenHash)
    })
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' })
    }
    
    const hashedPassword = await bcrypt.hash(password, getBcryptRounds())
    const nextTokenVersion = getPersistedTokenVersion(user) + 1
    
    await userService.updateProfile(user.id, {
      passwordHash: hashedPassword,
      resetToken: null,
      resetExpiry: null,
      tokenVersion: nextTokenVersion,
      sessionVersion: nextTokenVersion
    })
    
    console.log(`[Auth] Password reset for: ${user.username}`)
    
    res.json({ message: 'Password has been reset successfully' })
  } catch (error) {
    console.error('[Auth] Reset password error:', error)
    res.status(500).json({ error: 'Reset failed' })
  }
})

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const tokenUserId = req.user?.id
    if (!tokenUserId) {
      return res.status(401).json({ error: 'Invalid token' })
    }

    const user = userService.getUser(tokenUserId)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // SECURITY: defense-in-depth — explicitly destructure off any credential
    // material before we touch the user object. This guards against future
    // refactors that might accidentally `res.json(user)`.
    const {
      password,
      passwordHash,
      password_hash,
      salt,
      passwordSalt,
      recoveryToken,
      recovery_token,
      resetToken,
      reset_token,
      resetExpiry,
      reset_expiry,
      mfaSecret,
      mfa_secret,
      totpSecret,
      twoFactorSecret,
      apiKey,
      sessionSecret,
      refreshToken,
      jwtSecret,
      privateKey,
      ...safeUser
    } = user

    // Belt-and-suspenders: pass through the central toSafeUser helper as well
    // so any newly-added sensitive field is stripped automatically.
    const stripped = toSafeUser(safeUser)

    res.json({
      id: stripped.id,
      username: stripped.username,
      displayName: stripped.displayName,
      email: stripped.email,
      birthDate: stripped.birthDate || null,
      ageVerification: stripped.ageVerification || null,
      ageVerificationJurisdiction: stripped.ageVerificationJurisdiction || null,
      imageUrl: stripped.imageUrl || stripped.imageurl || stripped.avatarUrl || stripped.avatarURL || (isExternalImage(stripped.avatar) ? stripped.avatar : null),
      avatar: resolveUserAvatar(stripped.id, stripped)
    })
  } catch (_error) {
    res.status(500).json({ error: 'Failed to get user info' })
  }
})

const maskClientId = (value) => {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.length <= 4) return '*'.repeat(value.length)
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`
}

router.get('/config', (req, res) => {
  const localAuthEnabled = config.isLocalAuthEnabled()
  const allowRegistration = config.isRegistrationAllowed()
  const oauthEnabled = config.isOAuthEnabled()
  const authType = config.config.auth?.type || 'all'
  const oauthProvider = config.config.auth?.oauth?.provider || null
  const minPasswordLength = config.config.auth?.local?.minPasswordLength || 8
  const oauthSettings = config.config.auth?.oauth || {}
  const enclica = oauthSettings?.enclica || {}
  const serverUrl = config.getServerUrl()
  const redirectUri = serverUrl ? `${serverUrl.replace(/\/+$/, '')}/callback` : null

  res.json({
    allowRegistration,
    canRegister: localAuthEnabled && allowRegistration,
    localAuthEnabled,
    oauthEnabled,
    authType,
    oauthProvider,
    clientId: oauthEnabled && oauthProvider === 'enclica' ? maskClientId(enclica.clientId) : null,
    authUrl: oauthEnabled && oauthProvider === 'enclica' ? (enclica.authUrl || null) : null,
    tokenUrl: oauthEnabled && oauthProvider === 'enclica' ? (enclica.tokenUrl || null) : null,
    revokeUrl: oauthEnabled && oauthProvider === 'enclica' ? (enclica.revokeUrl || null) : null,
    redirectUri: oauthEnabled && oauthProvider === 'enclica' ? redirectUri : null,
    minPasswordLength,
    serverName: config.config.server.name,
    serverMode: config.config.server.mode
  })
})

export { router as authRoutes, parseUsername, normalizeUsername }
export default router
