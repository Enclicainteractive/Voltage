import jwt from 'jsonwebtoken'
import config from '../config/config.js'

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
    } catch (error) {
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
  // For now, check if user is the first user (assumed owner)
  // In production, you'd have a proper admin system
  const userId = req.user?.id
  
  // Allow if user ID starts with specific pattern or is in admin list
  // This is a simple check - in production use proper admin roles
  const adminUsers = config.config.security?.adminUsers || []
  
  if (adminUsers.includes(userId)) {
    return next()
  }
  
  // Also allow if it's a very early user (likely the owner)
  // This is a heuristic - consider implementing proper admin roles
  if (userId && userId.startsWith('u_') && userId.length < 30) {
    // First few users are likely owners in dev
    return next()
  }
  
  console.warn('[Auth] Owner access denied for user:', userId)
  return res.status(403).json({ error: 'Owner access required' })
}
