import jwt from 'jsonwebtoken'
import config from '../config/config.js'

const getJwtSecret = () => process.env.JWT_SECRET || config.config.security?.jwtSecret || 'volt_super_secret_key_change_in_production'
const truthyFlag = (value) => value === true || value === 1 || value === '1' || value === 'true'

export const requireAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }

  const token = authHeader.substring(7)

  try {
    const decoded = jwt.verify(token, getJwtSecret())
    
    if (!truthyFlag(decoded.isAdmin) && decoded.role !== 'admin' && decoded.role !== 'owner') {
      return res.status(403).json({ error: 'Admin access required' })
    }

    req.admin = decoded
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export const requireSuperAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }

  const token = authHeader.substring(7)

  try {
    const decoded = jwt.verify(token, getJwtSecret())
    
    if (!truthyFlag(decoded.isSuperAdmin) && decoded.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin access required' })
    }

    req.admin = decoded
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export const generateAdminToken = (userId, isSuperAdmin = false) => {
  const payload = {
    id: userId,
    isAdmin: true,
    isSuperAdmin,
    role: isSuperAdmin ? 'superadmin' : 'admin'
  }

  return jwt.sign(
    payload,
    getJwtSecret(),
    { expiresIn: '24h' }
  )
}
