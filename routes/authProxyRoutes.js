import express from 'express'
import axios from 'axios'
import config from '../config/config.js'

const router = express.Router()

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

router.post('/token', async (req, res) => {
  try {
    if (!config.isOAuthEnabled()) {
      return res.status(403).json({ error: 'OAuth is not enabled' })
    }
    
    console.log('[OAuth Proxy] Token exchange request')
    
    const oauthConfig = getOAuthConfig()
    
    const response = await axios.post(oauthConfig.tokenUrl, req.body, {
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    })
    
    console.log('[OAuth Proxy] Token response status:', response.status)
    
    if (response.data.user) {
      console.log('[OAuth Proxy] User info:', response.data.user.username)
      
      response.data.user.host = config.getHost()
    }
    
    res.status(response.status).json(response.data)
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
      }
    })
    
    res.json(response.data)
  } catch (error) {
    console.error('[OAuth Proxy] Token revoke error:', error.message)
    res.status(500).json({
      error: 'Token revoke failed',
      message: error.message
    })
  }
})

export default router
