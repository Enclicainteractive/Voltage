import jwt from 'jsonwebtoken'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import config from '../config/config.js'
import botService from '../services/botService.js'

const __authDir = path.dirname(fileURLToPath(import.meta.url))
const USERS_FILE = path.join(__authDir, '..', '..', 'data', 'users.json')

const getAvatarUrl = (userId) => {
  const imageServerUrl = config.getImageServerUrl()
  return `${imageServerUrl}/api/images/users/${userId}/profile`
}

export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (token) {
    try {
      const decoded = jwt.decode(token)
      if (decoded) {
        const host = decoded.host || config.getHost()
        req.user = {
          id: decoded.userId || decoded.sub,
          username: decoded.username,
          displayName: decoded.username,
          email: decoded.email || `${decoded.username}@${host}`,
          avatar: getAvatarUrl(decoded.userId || decoded.sub),
          host: host
        }
      }
    } catch (_error) {
      // Ignore auth errors for optional auth
    }
  }
  next()
}

export const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Access token required' })
  }

  try {
    const decoded = jwt.decode(token)
    
    if (!decoded) {
      return res.status(403).json({ error: 'Invalid token' })
    }

    const host = decoded.host || config.getHost()
    
    req.user = {
      id: decoded.userId || decoded.sub,
      username: decoded.username,
      displayName: decoded.username,
      email: decoded.email || `${decoded.username}@${host}`,
      avatar: getAvatarUrl(decoded.userId || decoded.sub),
      host: host
    }
    
    console.log('[Auth] User authenticated:', req.user.username)
    next()
  } catch (error) {
    console.error('[Auth] Token validation error:', error)
    return res.status(403).json({ error: 'Invalid or expired token' })
  }
}

export const authenticateSocket = async (socket, next) => {
  const token = socket.handshake.auth.token

  if (!token) {
    return next(new Error('Authentication error'))
  }

  // Bot tokens are random hex strings prefixed with 'vbot_', not JWTs.
  // Validate them via botService and mark the socket as a bot connection
  // so downstream handlers can distinguish bot sockets from user sockets.
  if (token.startsWith('vbot_')) {
    const bot = botService.getBotByToken(token)
    if (!bot) {
      return next(new Error('Invalid bot token'))
    }
    socket.bot = { id: bot.id, name: bot.name, servers: bot.servers }
    socket.botId = bot.id
    console.log('[Socket] Bot connected:', bot.name, `(${bot.id})`)
    return next()
  }

  try {
    const decoded = jwt.decode(token)
    
    if (!decoded) {
      return next(new Error('Invalid token'))
    }

    const host = decoded.host || config.getHost()

    socket.user = {
      id: decoded.userId || decoded.sub,
      username: decoded.username,
      displayName: decoded.username,
      email: decoded.email || `${decoded.username}@${host}`,
      avatar: getAvatarUrl(decoded.userId || decoded.sub),
      host: host
    }
    
    console.log('[Socket] User connected:', socket.user.username)
    next()
  } catch (error) {
    console.error('[Socket] Auth error:', error)
    next(new Error('Authentication error'))
  }
}

// Require owner role for admin endpoints
export const requireOwner = (req, res, next) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(403).json({ error: 'Owner access required' })
  }
  
  const adminUsers = config.config.security?.adminUsers || []
  if (adminUsers.includes(userId)) {
    return next()
  }

  // Check user profile for adminRole or role fields
  try {
    if (fs.existsSync(USERS_FILE)) {
      const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
      const user = users[userId]
      if (user?.adminRole === 'owner' || user?.adminRole === 'admin' || user?.role === 'admin') {
        return next()
      }
    }
  } catch (err) {
    console.error('[Auth] Error checking user role:', err.message)
  }
  
  console.warn('[Auth] Owner access denied for user:', userId)
  return res.status(403).json({ error: 'Owner access required' })
}
