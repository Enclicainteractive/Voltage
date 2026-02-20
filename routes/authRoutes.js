import express from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import config from '../config/config.js'
import { userService } from '../services/dataService.js'

const router = express.Router()

const getAvatarUrl = (userId) => {
  const imageServerUrl = config.getImageServerUrl()
  return `${imageServerUrl}/api/images/users/${userId}/profile`
}

const generateUserId = () => {
  return `u_${crypto.randomBytes(16).toString('hex')}`
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
    if (!config.isLocalAuthEnabled()) {
      return res.status(403).json({ error: 'Local registration is disabled' })
    }
    
    if (!config.isRegistrationAllowed()) {
      return res.status(403).json({ error: 'Registration is closed' })
    }
    
    const { email, password, username } = req.body
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }
    
    const minLength = config.config.auth.local.minPasswordLength || 8
    if (password.length < minLength) {
      return res.status(400).json({ error: `Password must be at least ${minLength} characters` })
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' })
    }
    
    const normalized = normalizeUsername(username || email)
    const parsedUsername = parseUsername(normalized.fullUsername)
    
    if (!parsedUsername.isLocal) {
      return res.status(400).json({ error: 'Cannot register users from other servers' })
    }
    
    const existingUsers = userService.getAllUsers()
    const existingByEmail = Object.values(existingUsers).find(u => u.email?.toLowerCase() === email.toLowerCase())
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
      email: email.toLowerCase(),
      passwordHash: hashedPassword,
      authProvider: 'local',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    userService.saveUser(userId, userData)
    
    const token = jwt.sign(
      {
        userId: userId,
        username: parsedUsername.username,
        email: email.toLowerCase(),
        host: parsedUsername.host
      },
      config.config.security.jwtSecret,
      { expiresIn: config.config.security.jwtExpiry || '7d' }
    )
    
    console.log(`[Auth] New local user registered: ${parsedUsername.username}@${parsedUsername.host}`)
    
    res.status(201).json({
      user: {
        id: userId,
        username: parsedUsername.username,
        displayName: parsedUsername.username,
        email: email.toLowerCase(),
        avatar: null
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
    if (!config.isLocalAuthEnabled()) {
      return res.status(403).json({ error: 'Local authentication is disabled' })
    }
    
    const { username, password, email } = req.body
    
    const loginIdentifier = username || email
    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' })
    }
    
    const parsed = parseUsername(loginIdentifier)
    
    if (!parsed.isLocal) {
      return res.status(400).json({ error: 'Please use the correct server for this user' })
    }
    
    const allUsers = userService.getAllUsers()
    const user = Object.values(allUsers).find(
      u => (u.username?.toLowerCase() === parsed.username.toLowerCase()) ||
           (u.email?.toLowerCase() === loginIdentifier.toLowerCase())
    )
    
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }
    
    const validPassword = await bcrypt.compare(password, user.passwordHash)
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }
    
    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        email: user.email,
        host: config.getHost()
      },
      config.config.security.jwtSecret,
      { expiresIn: config.config.security.jwtExpiry || '7d' }
    )
    
    console.log(`[Auth] Local user logged in: ${user.username}`)
    
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName || user.username,
        email: user.email,
        avatar: getAvatarUrl(user.id)
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
    
    const allUsers = userService.getAllUsers()
    const user = Object.values(allUsers).find(
      u => u.email?.toLowerCase() === email.toLowerCase() && u.authProvider === 'local'
    )
    
    if (!user) {
      return res.json({ message: 'If the email exists, a reset link has been sent' })
    }
    
    const resetToken = crypto.randomBytes(32).toString('hex')
    const resetExpiry = Date.now() + 3600000
    
    userService.updateProfile(user.id, {
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
    
    userService.updateProfile(user.id, {
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
    const decoded = jwt.decode(token)
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' })
    }
    
    const user = userService.getUser(decoded.userId)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    res.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatar: getAvatarUrl(user.id)
    })
  } catch (_error) {
    res.status(500).json({ error: 'Failed to get user info' })
  }
})

router.get('/config', (req, res) => {
  res.json({
    allowRegistration: config.isRegistrationAllowed(),
    localAuthEnabled: config.isLocalAuthEnabled(),
    oauthEnabled: config.isOAuthEnabled(),
    serverName: config.config.server.name,
    serverMode: config.config.server.mode
  })
})

export { router as authRoutes, parseUsername, normalizeUsername }
export default router
