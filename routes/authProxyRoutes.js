import express from 'express'
import axios from 'axios'
import jwt from 'jsonwebtoken'
import config from '../config/config.js'
import { userService } from '../services/dataService.js'
import inputValidator from '../middleware/inputValidation.js'

const router = express.Router()

const getJwtSecret = () => {
  return process.env.JWT_SECRET || config.config.security?.jwtSecret || 'volt_super_secret_key_change_in_production'
}

const getOAuthConfig = () => {
  const oauthConfig = config.config.auth.oauth
  if (!oauthConfig?.enabled) {
    throw new Error('OAuth is not enabled')
  }
  
  if (oauthConfig.provider === 'enclica') {
    return {
      tokenUrl: oauthConfig.enclica.tokenUrl,
      revokeUrl: oauthConfig.enclica.revokeUrl,
      userInfoUrl: oauthConfig.enclica.userInfoUrl
    }
  }
  
  throw new Error('Unknown OAuth provider')
}

const createLocalToken = (userData) => {
  return jwt.sign(
    {
      userId: userData.id || userData.userId,
      id: userData.id || userData.userId,
      sub: userData.id || userData.userId,
      username: userData.username,
      email: userData.email,
      host: userData.host || config.getHost(),
      adminRole: userData.adminRole || userData.role || null,
      isAdmin: userData.isAdmin ?? false,
      isModerator: userData.isModerator ?? false
    },
    getJwtSecret()
  )
}

router.post('/token', async (req, res) => {
  try {
    if (!config.isOAuthEnabled()) {
      return res.status(403).json({ error: 'OAuth is not enabled' })
    }
    
    console.log('[OAuth Proxy] Token exchange request')
    
    const oauthConfig = getOAuthConfig()
    
    const tokenResponse = await axios.post(oauthConfig.tokenUrl, req.body, {
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    })
    
    console.log('[OAuth Proxy] Token response status:', tokenResponse.status)
    
    if (tokenResponse.status !== 200) {
      return res.status(tokenResponse.status).json(tokenResponse.data)
    }
    
    const oauthAccessToken = tokenResponse.data.access_token
    
    let userData = null
    
    if (oauthAccessToken && oauthConfig.userInfoUrl) {
      try {
        const userResponse = await axios.get(oauthConfig.userInfoUrl, {
          headers: {
            'Authorization': `Bearer ${oauthAccessToken}`
          },
          validateStatus: () => true
        })
        
        if (userResponse.status === 200 && userResponse.data) {
          userData = userResponse.data
          console.log('[OAuth Proxy] User info:', userData.username)
        }
      } catch (userError) {
        console.error('[OAuth Proxy] User info fetch error:', userError.message)
      }
    }
    
    if (!userData && tokenResponse.data.user) {
      userData = tokenResponse.data.user
    }
    
    if (userData) {
      userData.host = config.getHost()
      const existingUser = userService.getUser(userData.id)
      
      if (userData.email) {
        const normalizedEmail = inputValidator.normalizeEmail(userData.email)
        const allUsers = userService.getAllUsers()
        const emailConflict = Object.values(allUsers).find(
          u => u.email?.toLowerCase() === normalizedEmail.toLowerCase() && u.id !== userData.id
        )
        if (emailConflict) {
          return res.status(400).json({ error: 'Email already registered to another account' })
        }
        userData.email = normalizedEmail.toLowerCase()
      }
      
      await userService.saveUser(userData.id, {
        username: userData.username,
        displayName: userData.displayName || userData.username,
        email: userData.email || existingUser?.email || null,
        authProvider: config.config.auth?.oauth?.provider || 'oauth',
        host: config.getHost(),
        avatar: userData.avatar || existingUser?.avatar || null,
        imageUrl: userData.imageUrl || existingUser?.imageUrl || null,
        birthDate: existingUser?.birthDate || null
      })
      
      const localToken = createLocalToken(userData)
      
      res.json({
        access_token: localToken,
        token_type: 'Bearer',
        upstream_access_token: oauthAccessToken,
        user: userData
      })
    } else {
      res.json(tokenResponse.data)
    }
  } catch (error) {
    console.error('[OAuth Proxy] Token exchange error:', error.message)
    res.status(500).json({
      error: 'Token exchange failed',
      message: error.message
    })
  }
})

router.post('/revoke', async (req, res) => {
  try {
    if (!config.isOAuthEnabled()) {
      return res.status(403).json({ error: 'OAuth is not enabled' })
    }
    
    console.log('[OAuth Proxy] Token revoke request')
    
    const oauthConfig = getOAuthConfig()
    
    const response = await axios.post(oauthConfig.revokeUrl, req.body, {
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    })
    
    res.status(response.status).json(response.data)
  } catch (error) {
    console.error('[OAuth Proxy] Token revoke error:', error.message)
    res.status(500).json({
      error: 'Token revoke failed',
      message: error.message
    })
  }
})

export default router
