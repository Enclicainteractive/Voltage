import jwt from 'jsonwebtoken'
import config from '../config/config.js'
import botService from '../services/botService.js'
import { adminService, userService } from '../services/dataService.js'

const getJwtSecret = () => {
  return process.env.JWT_SECRET || config.config.security?.jwtSecret || 'volt_super_secret_key_change_in_production'
}

const normalizeTokenUser = (decoded = {}) => {
  const userId = decoded.userId || decoded.id || decoded.sub || decoded.user?.id || null
  const username = decoded.username || decoded.preferred_username || decoded.user?.username || decoded.user?.displayName || null
  const email = decoded.email || decoded.user?.email || null
  const host = decoded.host || decoded.user?.host || config.getHost()
  const adminRole = decoded.adminRole || decoded.role || decoded.user?.adminRole || decoded.user?.role || null
  const isAdmin = decoded.isAdmin ?? decoded.user?.isAdmin
  const isModerator = decoded.isModerator ?? decoded.user?.isModerator

  return { userId, username, email, host, adminRole, isAdmin, isModerator }
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

export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (token) {
    try {
      const decoded = jwt.decode(token)
      if (decoded) {
        const normalized = normalizeTokenUser(decoded)
        req.user = {
          id: normalized.userId,
          username: normalized.username,
          displayName: decoded.displayName || normalized.username,
          email: normalized.email || `${normalized.username || 'user'}@${normalized.host}`,
          avatar: resolveAvatarFromToken(decoded, normalized.userId),
          host: normalized.host,
          adminRole: normalized.adminRole,
          isAdmin: normalized.isAdmin,
          isModerator: normalized.isModerator
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
    // Try to verify with local JWT secret first
    let decoded
    try {
      decoded = jwt.verify(token, getJwtSecret())
    } catch (verifyError) {
      // If verification fails, try to decode without verification (for OAuth tokens)
      // OAuth tokens from Enclica are already validated by the OAuth provider
      decoded = jwt.decode(token)
      if (!decoded) {
        throw new Error('Token decode failed')
      }
      console.log('[Auth] Using decoded OAuth token (unverified)')
    }
    
    if (!decoded) {
      return res.status(403).json({ error: 'Invalid token' })
    }

    const normalized = normalizeTokenUser(decoded)
    if (!normalized.userId) {
      return res.status(403).json({ error: 'Invalid token payload' })
    }

    // Username may be null for local accounts that registered with email only
    // Fall back to email prefix or userId to avoid blocking valid sessions
    const resolvedUsername = normalized.username ||
      (normalized.email ? normalized.email.split('@')[0] : null) ||
      normalized.userId

    req.user = {
      id: normalized.userId,
      username: resolvedUsername,
      displayName: decoded.displayName || resolvedUsername,
      email: normalized.email || `${resolvedUsername}@${normalized.host}`,
      avatar: resolveAvatarFromToken(decoded, normalized.userId),
      host: normalized.host,
      adminRole: normalized.adminRole,
      isAdmin: normalized.isAdmin,
      isModerator: normalized.isModerator,
      authProvider: decoded.authProvider || decoded.iss || 'local'
    }
    
    console.log('[Auth] User authenticated:', req.user.username)
    next()
  } catch (error) {
    console.error('[Auth] Token validation error:', error.message)
    return res.status(403).json({ error: 'Invalid or expired token' })
  }
}

export const authenticateSocket = async (socket, next) => {
    const token = socket.handshake.auth.token

    if (!token) {
        return next(new Error('Authentication error'))
    }

    // Validate token is a string to prevent JWT verification errors
    if (typeof token !== 'string') {
        console.error('[Socket] Auth error: token must be a string, got:', typeof token)
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
        // Try to verify with local JWT secret first
        let decoded
        try {
            decoded = jwt.verify(token, getJwtSecret())
        } catch (verifyError) {
            // If verification fails, try to decode without verification (for OAuth tokens)
            // OAuth tokens from Enclica are already validated by the OAuth provider
            decoded = jwt.decode(token)
            if (!decoded) {
                throw new Error('Token decode failed')
            }
            console.log('[Socket] Using decoded OAuth token (unverified)')
        }
        
        if (!decoded) {
            return next(new Error('Invalid token'))
        }

        const normalized = normalizeTokenUser(decoded)
        if (!normalized.userId) {
            return next(new Error('Invalid token payload'))
        }

        // Username may be null for local accounts that registered with email only
        const resolvedSocketUsername = normalized.username ||
          (normalized.email ? normalized.email.split('@')[0] : null) ||
          normalized.userId

        socket.user = {
            id: normalized.userId,
            username: resolvedSocketUsername,
            displayName: decoded.displayName || resolvedSocketUsername,
            email: normalized.email || `${resolvedSocketUsername}@${normalized.host}`,
            avatar: resolveAvatarFromToken(decoded, normalized.userId),
            host: normalized.host,
            adminRole: normalized.adminRole,
            isAdmin: normalized.isAdmin,
            isModerator: normalized.isModerator,
            authProvider: decoded.authProvider || decoded.iss || 'local'
        }
        
        console.log('[Socket] User connected:', socket.user.username)
        next()
    } catch (error) {
        console.error('[Socket] Auth error:', error.message)
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
  if (adminService.isAdmin(userId)) return next()
  const user = userService.getUser(userId)
  if (user?.adminRole === 'owner' || user?.adminRole === 'admin' || user?.role === 'owner' || user?.role === 'admin') {
    return next()
  }
  
  console.warn('[Auth] Owner access denied for user:', userId)
  return res.status(403).json({ error: 'Owner access required' })
}
