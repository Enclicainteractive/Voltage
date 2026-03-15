import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { userService } from '../services/dataService.js'
import config from '../config/config.js'

const router = express.Router()

// Get user's theme settings
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const user = await userService.getUser(req.user.id)
    res.json({
      theme: user?.theme || 'dark',
      accentColor: user?.accentColor || '#1fb6ff',
      font: user?.font || 'default',
      animation: user?.animation || 'none',
      backgroundType: user?.backgroundType || 'solid',
      backgroundImage: user?.backgroundImage || null,
      backgroundOpacity: user?.backgroundOpacity || 100,
      profileAccentColor: user?.profileAccentColor || null,
      profileFont: user?.profileFont || 'default',
      profileAnimation: user?.profileAnimation || 'none',
      profileBackground: user?.profileBackground || null,
      profileBackgroundType: user?.profileBackgroundType || 'solid',
      profileBackgroundOpacity: user?.profileBackgroundOpacity || 100
    })
  } catch (error) {
    console.error('[API] Get theme settings error:', error)
    res.status(500).json({ error: 'Failed to get theme settings' })
  }
})

// Update theme settings
router.put('/settings', authenticateToken, async (req, res) => {
  try {
    const {
      theme,
      accentColor,
      font,
      animation,
      backgroundType,
      backgroundImage,
      backgroundOpacity,
      profileAccentColor,
      profileFont,
      profileAnimation,
      profileBackground,
      profileBackgroundType,
      profileBackgroundOpacity
    } = req.body

    const updates = {}

    // App theme settings
    if (theme && typeof theme === 'string') {
      updates.theme = theme.slice(0, 50)
    }
    
    if (accentColor && /^#[0-9A-Fa-f]{6}$/.test(accentColor)) {
      updates.accentColor = accentColor
    }
    
    if (font && typeof font === 'string') {
      const allowedFonts = ['default', 'system', 'sans-serif', 'serif', 'monospace', 'inter', 'roboto', 'poppins']
      if (allowedFonts.includes(font)) {
        updates.font = font
      }
    }
    
    if (animation && typeof animation === 'string') {
      const allowedAnimations = ['none', 'fade', 'slide', 'bounce', 'pulse', 'wave']
      if (allowedAnimations.includes(animation)) {
        updates.animation = animation
      }
    }
    
    if (backgroundType && typeof backgroundType === 'string') {
      const allowedTypes = ['solid', 'gradient', 'image']
      if (allowedTypes.includes(backgroundType)) {
        updates.backgroundType = backgroundType
      }
    }
    
    if (backgroundImage !== undefined) {
      if (backgroundImage === null) {
        updates.backgroundImage = null
      } else if (typeof backgroundImage === 'string' && backgroundImage.length <= 500000) {
        updates.backgroundImage = backgroundImage
      }
    }
    
    if (backgroundOpacity !== undefined) {
      const opacity = parseInt(backgroundOpacity)
      if (!isNaN(opacity) && opacity >= 0 && opacity <= 100) {
        updates.backgroundOpacity = opacity
      }
    }

    // Profile customization settings
    if (profileAccentColor !== undefined) {
      if (profileAccentColor === null || /^#[0-9A-Fa-f]{6}$/.test(profileAccentColor)) {
        updates.profileAccentColor = profileAccentColor
      }
    }
    
    if (profileFont !== undefined) {
      const allowedFonts = ['default', 'system', 'sans-serif', 'serif', 'monospace', 'inter', 'roboto', 'poppins', 'open-sans', 'lato', 'montserrat', 'source-code-pro', 'fira-code', 'jetbrains-mono']
      if (allowedFonts.includes(profileFont) || profileFont === null) {
        updates.profileFont = profileFont
      }
    }
    
    if (profileAnimation !== undefined) {
      const allowedAnimations = ['none', 'fade', 'slide', 'bounce', 'pulse', 'wave']
      if (allowedAnimations.includes(profileAnimation) || profileAnimation === null) {
        updates.profileAnimation = profileAnimation
      }
    }
    
    if (profileBackground !== undefined) {
      if (profileBackground === null) {
        updates.profileBackground = null
      } else if (typeof profileBackground === 'string' && profileBackground.length <= 500000) {
        updates.profileBackground = profileBackground
      }
    }
    
    if (profileBackgroundType !== undefined) {
      const allowedTypes = ['solid', 'gradient', 'image', 'blur']
      if (allowedTypes.includes(profileBackgroundType) || profileBackgroundType === null) {
        updates.profileBackgroundType = profileBackgroundType
      }
    }
    
    if (profileBackgroundOpacity !== undefined) {
      const opacity = parseInt(profileBackgroundOpacity)
      if (!isNaN(opacity) && opacity >= 0 && opacity <= 100) {
        updates.profileBackgroundOpacity = opacity
      }
    }

    await userService.updateProfile(req.user.id, updates)
    
    console.log(`[API] Theme settings updated for ${req.user.username}`)
    
    res.json({
      success: true,
      settings: updates
    })
  } catch (error) {
    console.error('[API] Update theme settings error:', error)
    res.status(500).json({ error: 'Failed to update theme settings' })
  }
})

// Export theme package
router.post('/export', authenticateToken, async (req, res) => {
  try {
    const { name, description, vars, backgroundImage, customAssets } = req.body
    
    if (!name || !vars) {
      return res.status(400).json({ error: 'Theme name and variables are required' })
    }
    
    const user = await userService.getUser(req.user.id)
    
    const themePackage = {
      magic: 'VTP1',
      version: 1,
      name: name.slice(0, 50),
      description: description?.slice(0, 500) || '',
      author: user?.displayName || user?.username || '',
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      type: 'volt-theme',
      vars,
      hasBackground: !!backgroundImage,
      hasAssets: customAssets && Object.keys(customAssets).length > 0,
      exportedBy: req.user.id
    }
    
    console.log(`[API] Theme exported by ${req.user.username}: ${name}`)
    
    res.json({
      success: true,
      theme: themePackage
    })
  } catch (error) {
    console.error('[API] Export theme error:', error)
    res.status(500).json({ error: 'Failed to export theme' })
  }
})

// Import theme package
router.post('/import', authenticateToken, async (req, res) => {
  try {
    const { themePackage } = req.body
    
    if (!themePackage || !themePackage.magic || !themePackage.vars) {
      return res.status(400).json({ error: 'Invalid theme package' })
    }
    
    if (themePackage.magic !== 'VTP1') {
      return res.status(400).json({ error: 'Invalid theme package format' })
    }
    
    // Validate and sanitize imported theme
    const validatedVars = {}
    for (const [key, value] of Object.entries(themePackage.vars)) {
      if (key.startsWith('--volt-') && typeof value === 'string') {
        validatedVars[key] = value.slice(0, 200)
      }
    }
    
    // Apply imported theme to user profile
    const updates = {
      customTheme: validatedVars,
      profileBackground: themePackage.backgroundImage || null
    }
    
    await userService.updateProfile(req.user.id, updates)
    
    console.log(`[API] Theme imported by ${req.user.username}: ${themePackage.name}`)
    
    res.json({
      success: true,
      themeName: themePackage.name,
      applied: true
    })
  } catch (error) {
    console.error('[API] Import theme error:', error)
    res.status(500).json({ error: 'Failed to import theme' })
  }
})

// Get public theme gallery (featured themes)
router.get('/gallery', async (req, res) => {
  try {
    // Return featured themes (these would come from a database in production)
    const featuredThemes = [
      {
        id: 'volt-official',
        name: 'Volt Default',
        author: 'Volt Team',
        downloads: 0,
        rating: 5,
        preview: ['#08111e', '#0c1a2c']
      },
      {
        id: 'midnight-official',
        name: 'Midnight',
        author: 'Volt Team',
        downloads: 0,
        rating: 4.8,
        preview: ['#352f4a', '#2d2840']
      },
      {
        id: 'neon-night',
        name: 'Neon Night',
        author: 'Volt Team',
        downloads: 0,
        rating: 4.9,
        preview: ['#0d0f1a', '#1b1235']
      }
    ]
    
    res.json(featuredThemes)
  } catch (error) {
    console.error('[API] Get theme gallery error:', error)
    res.status(500).json({ error: 'Failed to get theme gallery' })
  }
})

// Get user's saved custom themes
router.get('/my-themes', authenticateToken, async (req, res) => {
  try {
    const user = await userService.getUser(req.user.id)
    
    const savedThemes = user?.savedThemes || []
    
    res.json(savedThemes)
  } catch (error) {
    console.error('[API] Get my themes error:', error)
    res.status(500).json({ error: 'Failed to get saved themes' })
  }
})

// Save a custom theme
router.post('/my-themes', authenticateToken, async (req, res) => {
  try {
    const { name, vars, backgroundImage, description } = req.body
    
    if (!name || !vars) {
      return res.status(400).json({ error: 'Theme name and variables are required' })
    }
    
    const user = await userService.getUser(req.user.id)
    const savedThemes = user?.savedThemes || []
    
    // Check if theme with same name exists
    const existingIndex = savedThemes.findIndex(t => t.name === name)
    
    const newTheme = {
      id: `custom-${Date.now()}`,
      name: name.slice(0, 50),
      description: description?.slice(0, 500) || '',
      vars,
      backgroundImage: backgroundImage || null,
      createdAt: new Date().toISOString()
    }
    
    if (existingIndex >= 0) {
      savedThemes[existingIndex] = newTheme
    } else {
      savedThemes.push(newTheme)
    }
    
    // Limit to 10 saved themes
    while (savedThemes.length > 10) {
      savedThemes.shift()
    }
    
    await userService.updateProfile(req.user.id, { savedThemes })
    
    console.log(`[API] Theme saved by ${req.user.username}: ${name}`)
    
    res.json({
      success: true,
      theme: newTheme
    })
  } catch (error) {
    console.error('[API] Save theme error:', error)
    res.status(500).json({ error: 'Failed to save theme' })
  }
})

// Delete a saved theme
router.delete('/my-themes/:themeId', authenticateToken, async (req, res) => {
  try {
    const { themeId } = req.params
    
    const user = await userService.getUser(req.user.id)
    const savedThemes = user?.savedThemes || []
    
    const filteredThemes = savedThemes.filter(t => t.id !== themeId)
    
    await userService.updateProfile(req.user.id, { savedThemes: filteredThemes })
    
    console.log(`[API] Theme deleted by ${req.user.username}: ${themeId}`)
    
    res.json({ success: true })
  } catch (error) {
    console.error('[API] Delete theme error:', error)
    res.status(500).json({ error: 'Failed to delete theme' })
  }
})

export default router
