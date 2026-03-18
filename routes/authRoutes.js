import express from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import config from '../config/config.js'
import { userService } from '../services/dataService.js'
import { validateRequestSecurity, sanitizeBody } from '../middleware/requestSecurity.js'
import securityLogger from '../services/securityLogger.js'
import inputValidator from '../middleware/inputValidation.js'

const router = express.Router()

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

const normalizeUsername = (username) => {
  const config_host = config.getHost()
  
  if (username.includes('@')) {
    const [localPart, host] = username.split('@')
    return {
      username: localPart,
      host: host === config_host ? null : host,
      fullUsername: username
    }
  }
  
  return {
    username,
    host: null,
    fullUsername: `${username}@${config_host}`
  }
}

const parseUsername = (usernameInput) => {
  if (usernameInput.includes('@')) {
    const [username, host] = usernameInput.split('@')
    const config_host = config.getHost()
    
    if (host && host !== config_host) {
      return {
        username: username,
        host: host,
        isLocal: false,
        isFederated: true
      }
    }
    
    return {
      username: username,
      host: config_host,
      isLocal: true,
      isFederated: false
    }
  }
  
  return {
    username: usernameInput,
    host: config.getHost(),
    isLocal: true,
    isFederated: false
  }
}

router.post('/register', async (req, res) => {
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

    const normalizedEmail = inputValidator.normalizeEmail(email)
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'Invalid email format' })
    }

    const normalizedBirthDate = normalizeBirthDate(birthDate)
    if (!normalizedBirthDate) {
      return res.status(400).json({ error: 'A valid birth date is required' })
    }
    
    const minLength = config.config.auth.local.minPasswordLength || 8
    if (password.length < minLength) {
      return res.status(400).json({ error: `Password must be at least ${minLength} characters` })
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' })
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
    } else {
      // Derive username from email local part (e.g. "user" from "user@gmail.com")
      const emailLocalPart = normalizedEmail.split('@')[0]
      parsedUsername = {
        username: emailLocalPart,
        host: config.getHost(),
        isLocal: true,
        isFederated: false
      }
    }
    
    const existingUsers = userService.getAllUsers()
    const existingByEmail = Object.values(existingUsers).find(u => u.email?.toLowerCase() === normalizedEmail.toLowerCase())
    if (existingByEmail) {
      return res.status(400).json({ error: 'Email already registered' })
    }
    
    const existingByUsername = Object.values(existingUsers).find(
      u => u.username?.toLowerCase() === parsedUsername.username.toLowerCase()
    )
    if (existingByUsername) {
      return res.status(400).json({ error: 'Username already taken' })
    }
    
    const userId = generateUserId()
    const hashedPassword = await bcrypt.hash(password, config.config.security.bcryptRounds || 12)
    
    const userData = {
      id: userId,
      username: parsedUsername.username,
      displayName: parsedUsername.username,
      email: normalizedEmail.toLowerCase(),
      passwordHash: hashedPassword,
      authProvider: 'local',
      birthDate: normalizedBirthDate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    await userService.saveUser(userId, userData)
    
    const token = jwt.sign(
      {
        userId: userId,
        id: userId,
        sub: userId,
        username: parsedUsername.username,
        email: normalizedEmail.toLowerCase(),
        host: parsedUsername.host,
        adminRole: userData.adminRole || userData.role || null,
        isAdmin: toTruthyFlag(userData.isAdmin),
        isModerator: toTruthyFlag(userData.isModerator)
      },
      config.config.security.jwtSecret
    )
    
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
      expires_in: 7 * 24 * 60 * 60
    })
  } catch (error) {
    console.error('[Auth] Registration error:', error)
    res.status(500).json({ error: 'Registration failed' })
  }
})

router.post('/login', async (req, res) => {
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
    
    const loginIdentifier = username || email
    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' })
    }

    // Detect if the identifier is an email address.
    // An email has the form local@domain.tld — we check for a dot after the @.
    // If it IS an email, we always treat it as a local login (look up by email),
    // never as a federated username, because email domains are not Voltage hosts.
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const isEmailLogin = EMAIL_REGEX.test(loginIdentifier)

    const normalizedLogin = isEmailLogin
      ? (inputValidator.normalizeEmail(loginIdentifier) || loginIdentifier.toLowerCase())
      : loginIdentifier

    // Only run federation check for non-email identifiers (e.g. user@otherserver.volt)
    if (!isEmailLogin) {
      const parsed = parseUsername(loginIdentifier)
      if (!parsed.isLocal) {
        return res.status(400).json({ error: 'Please use the correct server for this user' })
      }
    }

    const parsedUsername = isEmailLogin ? { username: loginIdentifier.split('@')[0] } : parseUsername(loginIdentifier)

    const allUsers = userService.getAllUsers()
    const user = Object.values(allUsers).find(
      u => (u.username?.toLowerCase() === parsedUsername.username.toLowerCase()) ||
           (u.email?.toLowerCase() === normalizedLogin.toLowerCase())
    )
    
    if (!user || !user.passwordHash) {
      securityLogger.logLogin(null, req.ip, false)
      return res.status(401).json({ error: 'Invalid credentials' })
    }
    
    const validPassword = await bcrypt.compare(password, user.passwordHash)
    if (!validPassword) {
      securityLogger.logLogin(user.id, req.ip, false)
      return res.status(401).json({ error: 'Invalid credentials' })
    }
    
    const token = jwt.sign(
      {
        userId: user.id,
        id: user.id,
        sub: user.id,
        username: user.username,
        email: user.email,
        host: config.getHost(),
        adminRole: user.adminRole || user.role || null,
        isAdmin: toTruthyFlag(user.isAdmin),
        isModerator: toTruthyFlag(user.isModerator)
      },
      config.config.security.jwtSecret
    )
    
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
      expires_in: 7 * 24 * 60 * 60
    })
  } catch (error) {
    console.error('[Auth] Login error:', error)
    res.status(500).json({ error: 'Login failed' })
  }
})

router.post('/forgot-password', async (req, res) => {
  try {
    if (!config.isLocalAuthEnabled()) {
      return res.status(403).json({ error: 'Local authentication is disabled' })
    }
    
    const { email } = req.body
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }
    
    const normalizedEmail = inputValidator.normalizeEmail(email)
    const allUsers = userService.getAllUsers()
    const user = Object.values(allUsers).find(
      u => u.email?.toLowerCase() === normalizedEmail.toLowerCase() && u.authProvider === 'local'
    )
    
    if (!user) {
      return res.json({ message: 'If the email exists, a reset link has been sent' })
    }
    
    const resetToken = crypto.randomBytes(32).toString('hex')
    const resetExpiry = Date.now() + 3600000
    
    await userService.updateProfile(user.id, {
      resetToken,
      resetExpiry
    })
    
    console.log(`[Auth] Password reset requested for: ${user.username}`)
    
    res.json({ message: 'If the email exists, a reset link has been sent' })
  } catch (error) {
    console.error('[Auth] Forgot password error:', error)
    res.status(500).json({ error: 'Request failed' })
  }
})

router.post('/reset-password', async (req, res) => {
  try {
    if (!config.isLocalAuthEnabled()) {
      return res.status(403).json({ error: 'Local authentication is disabled' })
    }
    
    const { token, password } = req.body
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required' })
    }
    
    const minLength = config.config.auth.local.minPasswordLength || 8
    if (password.length < minLength) {
      return res.status(400).json({ error: `Password must be at least ${minLength} characters` })
    }
    
    const allUsers = userService.getAllUsers()
    const user = Object.values(allUsers).find(
      u => u.resetToken === token && u.resetExpiry > Date.now()
    )
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' })
    }
    
    const hashedPassword = await bcrypt.hash(password, config.config.security.bcryptRounds || 12)
    
    await userService.updateProfile(user.id, {
      passwordHash: hashedPassword,
      resetToken: null,
      resetExpiry: null
    })
    
    console.log(`[Auth] Password reset for: ${user.username}`)
    
    res.json({ message: 'Password has been reset successfully' })
  } catch (error) {
    console.error('[Auth] Reset password error:', error)
    res.status(500).json({ error: 'Reset failed' })
  }
})

router.get('/me', async (req, res) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' })
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || config.config.security?.jwtSecret || 'volt_super_secret_key_change_in_production')
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' })
    }
    
    const tokenUserId = decoded.userId || decoded.id || decoded.sub || decoded.user?.id
    const user = userService.getUser(tokenUserId)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    res.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      birthDate: user.birthDate || null,
      ageVerification: user.ageVerification || null,
      ageVerificationJurisdiction: user.ageVerificationJurisdiction || null,
      imageUrl: user.imageUrl || user.imageurl || user.avatarUrl || user.avatarURL || (isExternalImage(user.avatar) ? user.avatar : null),
      avatar: resolveUserAvatar(user.id, user)
    })
  } catch (_error) {
    res.status(500).json({ error: 'Failed to get user info' })
  }
})

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
    clientId: oauthEnabled && oauthProvider === 'enclica' ? (enclica.clientId || null) : null,
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
