import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import config from '../config/config.js'
import path from 'path'
import { fileURLToPath } from 'url'
import { 
  userService, 
  friendService, 
  friendRequestService, 
  blockService,
  FILES
} from '../services/dataService.js'
import { isUserOnline } from '../services/socketService.js'
import { validateUsername, validateDisplayName } from '../utils/validation.js'
import fs from 'fs'

const loadData = (file, defaultValue = {}) => {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (err) {
    console.error(`[Data] Error loading ${file}:`, err.message)
  }
  return defaultValue
}

const router = express.Router()

const getAvatarUrl = (userId) => {
  const imageServerUrl = config.getImageServerUrl()
  return `${imageServerUrl}/api/images/users/${userId}/profile`
}

const sanitizeProofSummary = (proof = {}, depth = 0) => {
  if (depth > 2) return {}
  const safe = {}
  Object.entries(proof || {}).forEach(([key, value]) => {
    if (typeof value === 'string') {
      if (/data:image|base64,/i.test(value)) return
      safe[key] = value.slice(0, 256)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      safe[key] = sanitizeProofSummary(value, depth + 1)
    }
  })
  return safe
}

const computeAge = (birthYear) => {
  if (!birthYear) return null
  const year = parseInt(birthYear, 10)
  if (Number.isNaN(year)) return null
  const currentYear = new Date().getFullYear()
  return currentYear - year
}

// Ensure authenticated user's profile exists in storage
const ensureUserProfile = (req, res, next) => {
  userService.saveUser(req.user.id, {
    username: req.user.username,
    displayName: req.user.displayName || req.user.username,
    email: req.user.email,
    host: req.user.host || config.getHost(),
    avatarHost: config.getImageServerUrl()
  })
  next()
}

// Require auth for all routes in this router and persist profile once per request
router.use(authenticateToken, ensureUserProfile)

// Current user
router.get('/me', async (req, res) => {
  try {
    const profile = userService.getUser(req.user.id)
    const avatarUrl = getAvatarUrl(req.user.id)
    const bannerUrl = profile?.banner ? `${config.getImageServerUrl()}/api/images/users/${req.user.id}/banner` : null
    
    res.json({
      ...req.user,
      ...profile,
      id: req.user.id,
      host: profile?.host || req.user.host || config.getHost(),
      avatarHost: profile?.avatarHost || config.getImageServerUrl(),
      avatar: avatarUrl,
      banner: bannerUrl
    })
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user info' })
  }
})

// Update profile
router.put('/profile', async (req, res) => {
  const { displayName, bio, customStatus, socialLinks, banner, customUsername } = req.body
  const updates = {}
  
  if (customUsername !== undefined) {
    const validation = validateUsername(customUsername)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }
    const allUsers = userService.getAllUsers()
    const existingUser = Object.values(allUsers).find(
      u => u.customUsername?.toLowerCase() === customUsername.toLowerCase() && u.id !== req.user.id
    )
    if (existingUser) {
      return res.status(400).json({ error: 'Username already taken' })
    }
    updates.customUsername = customUsername
  }
  
  if (displayName !== undefined) {
    const validation = validateDisplayName(displayName)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }
    updates.displayName = displayName
  }
  if (bio !== undefined) updates.bio = bio
  if (customStatus !== undefined) updates.customStatus = customStatus
  if (banner !== undefined) updates.banner = banner
  if (socialLinks !== undefined) {
    const allowed = ['github', 'twitter', 'youtube', 'twitch', 'website', 'steam', 'spotify']
    const sanitized = {}
    for (const [key, value] of Object.entries(socialLinks)) {
      if (allowed.includes(key) && typeof value === 'string') {
        sanitized[key] = value.slice(0, 256)
      }
    }
    updates.socialLinks = sanitized
  }
  
  const profile = userService.updateProfile(req.user.id, updates)
  console.log(`[API] Profile updated for ${req.user.username}`)
  res.json(profile)
})

// Update status
router.put('/status', async (req, res) => {
  const { status, customStatus } = req.body
  const validStatuses = ['online', 'idle', 'dnd', 'invisible']
  
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }
  
  const profile = userService.setStatus(req.user.id, status, customStatus)
  console.log(`[API] Status updated for ${req.user.username}: ${status}`)
  res.json(profile)
})

// Age verification status
router.get('/age-verification/status', async (req, res) => {
  const profile = userService.getUser(req.user.id)
  res.json({ ageVerification: profile?.ageVerification || null })
})

router.post('/age-verification', async (req, res) => {
  const { method, birthYear, proofSummary = {}, device, category, estimatedAge } = req.body || {}

  if (!method || !['face', 'id', 'hybrid'].includes(method)) {
    return res.status(400).json({ error: 'method must be "face", "id", or "hybrid"' })
  }

  const normalizedCategory = category === 'child' ? 'child' : 'adult'

  const age = computeAge(birthYear)
  const sanitizedProof = sanitizeProofSummary(proofSummary)
  const verificationRecord = userService.setAgeVerification(req.user.id, {
    method,
    birthYear: birthYear || null,
    age,
    proofSummary: sanitizedProof,
    device: device || null,
    category: normalizedCategory,
    estimatedAge: estimatedAge || age
  })

  console.log(`[API] Age verification stored for ${req.user.username} via ${method} - ${normalizedCategory}`)
  res.json({ ageVerification: verificationRecord.ageVerification })
})

// Search users
router.get('/search', async (req, res) => {
  const { q } = req.query
  if (!q || q.length < 2) {
    return res.json([])
  }
  
  const localHost = config.getHost()
  let searchUsername = q
  let searchHost = null
  
  if (q.includes('@')) {
    const parts = q.split('@')
    searchUsername = parts[0]
    searchHost = parts[1]
  }
  
  const allUsers = userService.getAllUsers()
  const results = Object.values(allUsers)
    .filter(u => {
      const usernameMatch = u.username?.toLowerCase().includes(searchUsername.toLowerCase()) || 
                           u.customUsername?.toLowerCase().includes(searchUsername.toLowerCase()) ||
                           u.displayName?.toLowerCase().includes(searchUsername.toLowerCase())
      
      if (!searchHost) {
        return usernameMatch
      }
      
      const userHost = u.host || localHost
      return usernameMatch && userHost.toLowerCase() === searchHost.toLowerCase()
    })
    .slice(0, 20)
    .map(u => ({
      id: u.id,
      username: u.customUsername || u.username,
      originalUsername: u.username,
      displayName: u.displayName,
      avatar: getAvatarUrl(u.id),
      host: u.host || localHost
    }))
  
  res.json(results)
})

// Get friends list - MUST be before /:userId
router.get('/friends', async (req, res) => {
  const friendIds = friendService.getFriends(req.user.id)
  const localHost = config.getHost()
  const friends = friendIds.map(friendId => {
    const profile = userService.getUser(friendId)
    const online = isUserOnline(friendId)
    const status = online ? (profile?.status === 'invisible' ? 'invisible' : (profile?.status || 'online')) : 'offline'
    return {
      id: friendId,
      username: profile?.customUsername || profile?.username || 'Unknown',
      originalUsername: profile?.username,
      displayName: profile?.displayName,
      avatar: getAvatarUrl(friendId),
      status,
      customStatus: profile?.customStatus,
      host: profile?.host || localHost
    }
  })
  
  console.log(`[API] Get friends for ${req.user.username} - ${friends.length} friends`)
  res.json(friends)
})

// Get friend requests - MUST be before /:userId
router.get('/friend-requests', async (req, res) => {
  const requests = friendRequestService.getRequests(req.user.id)
  console.log(`[API] Get friend requests for ${req.user.username} - ${requests.incoming.length} incoming, ${requests.outgoing.length} outgoing`)
  res.json(requests)
})

// Get blocked users - MUST be before /:userId
router.get('/blocked', async (req, res) => {
  const blockedIds = blockService.getBlocked(req.user.id)
  const blocked = blockedIds.map(id => {
    const profile = userService.getUser(id)
    return {
      id,
      username: profile?.username || 'Unknown',
      avatar: getAvatarUrl(id)
    }
  })
  res.json(blocked)
})

// Get user profile - This must come AFTER all specific GET routes
router.get('/:userId', async (req, res) => {
  const userId = req.params.userId
  const profile = userService.getUser(userId)
  
  if (!profile) {
    return res.json({
      id: userId,
      username: 'Unknown User',
      status: 'offline'
    })
  }
  
  const isFriend = friendService.areFriends(req.user.id, userId)
  const isBlocked = blockService.isBlocked(req.user.id, userId)
  const online = isUserOnline(userId)
  const liveStatus = online ? (profile.status === 'invisible' ? 'invisible' : (profile.status || 'online')) : 'offline'
  
  // Generate avatar URL dynamically to ensure correct server
  const avatarUrl = getAvatarUrl(userId)
  const bannerUrl = profile.banner ? `${config.getImageServerUrl()}/api/images/users/${userId}/banner` : null
  
  res.json({
    ...profile,
    host: profile.host || config.getHost(),
    avatarHost: profile.avatarHost || config.getImageServerUrl(),
    avatar: avatarUrl,
    banner: bannerUrl,
    status: liveStatus,
    isFriend,
    isBlocked
  })
})

// Send friend request
router.post('/friend-request', async (req, res) => {
  const { username, userId } = req.body
  
  if (!username && !userId) {
    return res.status(400).json({ error: 'Username or userId required' })
  }
  
  let targetUserId = userId
  let targetUsername = null
  
  if (username && !userId) {
    const allUsers = userService.getAllUsers()
    const targetUser = Object.values(allUsers).find(
      u => u.username?.toLowerCase() === username.toLowerCase()
    )
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }
    targetUserId = targetUser.id
    targetUsername = targetUser.username
  }
  
  if (targetUserId === req.user.id) {
    return res.status(400).json({ error: 'Cannot send friend request to yourself' })
  }
  
  if (friendService.areFriends(req.user.id, targetUserId)) {
    return res.status(400).json({ error: 'Already friends' })
  }
  
  if (blockService.isBlocked(req.user.id, targetUserId)) {
    return res.status(400).json({ error: 'User is blocked' })
  }
  
  const result = friendRequestService.sendRequest(req.user.id, targetUserId, req.user.username, targetUsername)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  console.log(`[API] Friend request sent from ${req.user.username} to ${targetUserId}`)
  res.json(result)
})

// Accept friend request
router.post('/friend-request/:id/accept', async (req, res) => {
  const result = friendRequestService.acceptRequest(req.user.id, req.params.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  userService.saveUser(req.user.id, {
    username: req.user.username
  })
  
  console.log(`[API] Friend request ${req.params.id} accepted by ${req.user.username}`)
  res.json(result)
})

// Reject friend request
router.post('/friend-request/:id/reject', async (req, res) => {
  const result = friendRequestService.rejectRequest(req.user.id, req.params.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  console.log(`[API] Friend request ${req.params.id} rejected by ${req.user.username}`)
  res.json(result)
})

// Cancel outgoing friend request
router.delete('/friend-request/:id', async (req, res) => {
  const result = friendRequestService.cancelRequest(req.user.id, req.params.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  console.log(`[API] Friend request ${req.params.id} cancelled by ${req.user.username}`)
  res.json(result)
})

// Cancel friend request by userId
router.delete('/friend-request/user/:userId', async (req, res) => {
  const targetUserId = req.params.userId
  const requests = friendRequestService.getRequests(req.user.id)
  const outgoingRequest = requests.outgoing?.find(r => r.from === targetUserId || r.to === targetUserId)
  
  if (!outgoingRequest) {
    return res.status(404).json({ error: 'No pending friend request found' })
  }
  
  const result = friendRequestService.cancelRequest(req.user.id, outgoingRequest.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  console.log(`[API] Friend request to ${targetUserId} cancelled by ${req.user.username}`)
  res.json(result)
})

// Remove friend
router.delete('/friends/:friendId', async (req, res) => {
  friendService.removeFriend(req.user.id, req.params.friendId)
  console.log(`[API] Friend ${req.params.friendId} removed by ${req.user.username}`)
  res.json({ success: true })
})

// Block user
router.post('/block/:userId', async (req, res) => {
  blockService.blockUser(req.user.id, req.params.userId)
  console.log(`[API] User ${req.params.userId} blocked by ${req.user.username}`)
  res.json({ success: true })
})

// Unblock user
router.delete('/block/:userId', async (req, res) => {
  blockService.unblockUser(req.user.id, req.params.userId)
  console.log(`[API] User ${req.params.userId} unblocked by ${req.user.username}`)
  res.json({ success: true })
})

// Get unread counts for all servers
router.get('/unread-counts', async (req, res) => {
  try {
    const userId = req.user.id
    const serversData = loadData(FILES.servers, [])
    const messagesData = loadData(FILES.messages, {})
    const usersData = loadData(FILES.users, {})
    
    const userServers = Object.values(usersData).find(u => u.id === userId)?.servers || []
    
    const counts = {}
    for (const serverEntry of userServers) {
      const serverId = typeof serverEntry === 'string' ? serverEntry : serverEntry.id
      const server = serversData.find(s => s.id === serverId)
      if (!server) continue
      
      let unread = 0
      for (const channel of server.channels || []) {
        const channelMessages = Object.values(messagesData).filter(m => m.channelId === channel.id)
        const lastRead = serverEntry.lastRead?.[channel.id] || 0
        const newMessages = channelMessages.filter(m => m.id > lastRead && m.senderId !== userId)
        unread += newMessages.length
      }
      
      if (unread > 0) {
        counts[serverId] = { unread }
      }
    }
    
    res.json(counts)
  } catch (err) {
    console.error('[API] Get unread counts error:', err)
    res.json({})
  }
})

// Update server mute setting
router.put('/settings/server-mute', async (req, res) => {
  const { serverId, muted } = req.body
  const userId = req.user.id
  
  const userData = userService.getUser(userId) || {}
  const serverMutes = userData.serverMutes || {}
  serverMutes[serverId] = muted
  
  userService.saveUser(userId, {
    ...userData,
    serverMutes
  })
  
  console.log(`[API] Server ${serverId} mute: ${muted} for user ${userId}`)
  res.json({ success: true })
})

// Get mutual friends with another user
router.get('/:userId/mutual-friends', async (req, res) => {
  const targetUserId = req.params.userId
  const currentUserId = req.user.id
  
  try {
    const currentUserFriends = friendService.getFriends(currentUserId)
    const targetUserFriends = friendService.getFriends(targetUserId)
    
    const mutualFriends = currentUserFriends.filter(friendId => 
      targetUserFriends.includes(friendId)
    )
    
    const friendsData = mutualFriends.map(friendId => {
      const profile = userService.getUser(friendId)
      return {
        id: friendId,
        username: profile?.username || 'Unknown',
        displayName: profile?.displayName,
        avatar: getAvatarUrl(friendId)
      }
    })
    
    res.json(friendsData)
  } catch (err) {
    console.error('[API] Get mutual friends error:', err)
    res.json([])
  }
})

// Get mutual servers with another user
router.get('/:userId/mutual-servers', async (req, res) => {
  const targetUserId = req.params.userId
  const currentUserId = req.user.id
  
  try {
    const currentUserData = userService.getUser(currentUserId)
    const targetUserData = userService.getUser(targetUserId)
    
    const currentUserServers = currentUserData?.servers || []
    const targetUserServers = targetUserData?.servers || []
    
    const mutualServerIds = currentUserServers
      .map(s => typeof s === 'string' ? s : s.id)
      .filter(serverId => 
        targetUserServers.some(s => (typeof s === 'string' ? s : s.id) === serverId)
      )
    
    const serversData = loadData(FILES.servers, [])
    const mutualServers = mutualServerIds
      .map(serverId => serversData.find(s => s.id === serverId))
      .filter(Boolean)
      .map(server => ({
        id: server.id,
        name: server.name,
        icon: server.icon,
        memberCount: server.members?.length || 0
      }))
    
    res.json(mutualServers)
  } catch (err) {
    console.error('[API] Get mutual servers error:', err)
    res.json([])
  }
})

export default router
