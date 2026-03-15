import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { io } from '../server.js'
import { FILES, serverService, channelService } from '../services/dataService.js'

const router = express.Router()

const toServerArray = (data) => {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') return Object.values(data)
  return []
}

const toServerRecord = (servers) => {
  const record = {}
  for (const server of servers || []) {
    if (server?.id) record[server.id] = server
  }
  return record
}

const toGroupedItems = (value) => {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  if (value.serverId) return [value]
  return Object.values(value).filter(item => item && typeof item === 'object')
}

const toGroupedByServer = (data) => {
  if (!data || typeof data !== 'object') return {}

  const grouped = {}
  for (const value of Object.values(data)) {
    for (const item of toGroupedItems(value)) {
      if (!item?.serverId) continue
      if (!grouped[item.serverId]) grouped[item.serverId] = []
      grouped[item.serverId].push(item)
    }
  }

  const firstValue = Object.values(data)[0]
  if (Object.keys(grouped).length === 0 && Array.isArray(firstValue)) {
    return data
  }

  return grouped
}

const toFlatRecord = (grouped, idField = 'id') => {
  const flat = {}
  for (const items of Object.values(grouped || {})) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const id = item?.[idField]
      if (id) flat[id] = item
    }
  }
  return flat
}

const getServers = () => toServerArray(serverService.getAllServers())
const setServers = async (servers) => {
  for (const server of servers) {
    if (server?.id) await serverService.updateServer(server.id, server)
  }
}
const getAllChannels = () => toGroupedByServer(channelService.getAllChannels())
const setAllChannels = async (channels) => {
  for (const serverChannels of Object.values(channels || {})) {
    for (const channel of serverChannels) {
      if (channel?.id) await channelService.updateChannel(channel.id, channel)
    }
  }
}
const getAllCategories = () => toGroupedByServer(serverService.getAllCategories())
const setAllCategories = async (categories) => {
  for (const serverCategories of Object.values(categories || {})) {
    for (const category of serverCategories) {
      if (category?.id) await serverService.updateCategory(category.id, category)
    }
  }
}

const ensureBaseRoles = (roles = []) => {
  const existing = Array.isArray(roles) ? roles : []
  const byId = new Set(existing.map(role => role?.id).filter(Boolean))
  const next = [...existing]

  const baseRoles = [
    { id: 'member', name: '@member', color: '#99aab5', position: 0, permissions: ['view_channels', 'send_messages', 'connect', 'speak', 'use_voice_activity'] },
    { id: 'owner', name: '@owner', color: '#faa81a', position: 100, permissions: ['admin'] }
  ]

  for (const role of baseRoles) {
    if (!byId.has(role.id)) next.push(role)
  }

  return next
}

const mergeImportedRoles = (existingRoles = [], importedRoles = []) => {
  const merged = ensureBaseRoles(existingRoles)
  const seenNames = new Set(merged.map(role => String(role?.name || '').trim().toLowerCase()).filter(Boolean))

  for (const role of importedRoles) {
    const normalizedName = String(role?.name || '').trim().toLowerCase()
    if (!role?.id || !normalizedName) continue
    if (normalizedName === '@everyone') continue
    if (seenNames.has(normalizedName)) continue
    merged.push(role)
    seenNames.add(normalizedName)
  }

  return merged
}

const CHANNEL_TYPE_MAP = {
  0: 'text',
  1: 'text',
  2: 'voice',
  4: 'category',
  5: 'text',
  13: 'voice',
  15: 'forum',
  14: 'announcement'
}

const DISCORD_PERMISSION_MAP = {
  0x00000000001: 'create_invites',
  0x00000000002: 'kick_members',
  0x00000000004: 'ban_members',
  0x00000000008: 'admin',
  0x00000000010: 'manage_channels',
  0x00000000020: 'manage_server',
  0x00000000040: 'manage_roles',
  0x00000000080: 'manage_permissions',
  0x00000000100: 'manage_emojis',
  0x00000000200: 'view_channels',
  0x00000000400: 'send_messages',
  0x00000000800: 'send_tts_messages',
  0x00000001000: 'manage_messages',
  0x00000002000: 'embed_links',
  0x00000004000: 'attach_files',
  0x00000008000: 'read_message_history',
  0x00000010000: 'mention_everyone',
  0x00000020000: 'use_external_emojis',
  0x00000040000: 'add_reactions',
  0x00000080000: 'connect',
  0x00000100000: 'speak',
  0x00000200000: 'mute_members',
  0x00000400000: 'deafen_members',
  0x00000800000: 'move_members',
  0x00001000000: 'use_voice_activity',
  0x00002000000: 'priority_speaker',
  0x00004000000: 'stream',
  0x00008000000: 'manage_events',
  0x00010000000: 'manage_threads',
  0x00020000000: 'create_public_threads',
  0x00040000000: 'create_private_threads',
  0x00080000000: 'send_messages_in_threads',
  0x00100000000: 'use_external_stickers',
  0x00200000000: 'manage_webhooks',
  0x00400000000: 'use_application_commands',
  0x00800000000: 'request_to_speak',
  0x01000000000: 'manage_nicknames',
  0x02000000000: 'change_nickname',
  0x04000000000: 'use_embeddable_embeds',
  0x08000000000: 'use_external_sounds',
  0x10000000000: 'send_voice_messages',
  0x20000000000: 'use_canned_responses',
  0x40000000000: 'use Activities',
  0x80000000000: 'view_audit_log',
  0x100000000000: 'view_server_insights',
}

const discordPermissionsToVoltage = (discordPermInteger) => {
  const permissions = []
  const permNum = BigInt(discordPermInteger)
  
  for (const [discordPerm, voltagePerm] of Object.entries(DISCORD_PERMISSION_MAP)) {
    if ((permNum & BigInt(discordPerm)) === BigInt(discordPerm)) {
      permissions.push(voltagePerm)
    }
  }
  
  return permissions
}

const fetchDiscordTemplate = async (templateCode) => {
  const response = await fetch(`https://discord.com/api/v9/guilds/templates/${templateCode}`, {
    headers: {
      'Content-Type': 'application/json'
    }
  })
  
  if (!response.ok) {
    throw new Error(`Failed to fetch template: ${response.status}`)
  }
  
  return await response.json()
}

const createDiscordServer = async (templateData, userId, existingServerId = null) => {
  const serverId = existingServerId || uuidv4()
  const serverData = templateData.serialized_source_guild
  
  const isNewServer = !existingServerId
  const newServer = isNewServer ? {
    id: serverId,
    name: serverData.name,
    description: serverData.description || '',
    ownerId: userId,
    icon: null,
    banner: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    roles: [],
    members: {
      [userId]: {
        id: userId,
        username: 'Owner',
        roles: ['owner'],
        role: 'owner',
        joinedAt: new Date().toISOString()
      }
    },
    channels: {},
    invites: {},
    bots: [],
    mfaLevel: 0,
    contentFilter: 0,
    notifications: 1,
    verificationLevel: serverData.verification_level || 0
  } : null
  
  const roleIdMap = {}
  const categoryIdMap = {}
  const channelIdMap = {}
  let importedRoles = []
  
  if (serverData.roles && serverData.roles.length > 0) {
    const everyoneRole = serverData.roles.find(r => r.id === 0)
    const otherRoles = serverData.roles.filter(r => r.id !== 0).sort((a, b) => a.id - b.id)
    const sortedRoles = everyoneRole ? [everyoneRole, ...otherRoles] : otherRoles
    
    importedRoles = sortedRoles.map(role => {
      const newRoleId = uuidv4()
      roleIdMap[role.id] = newRoleId
      const rolePerms = role.permissions ? discordPermissionsToVoltage(role.permissions) : []
      return {
        id: newRoleId,
        name: role.name,
        color: role.colors?.primary_color ? `#${role.colors.primary_color.toString(16).padStart(6, '0')}` : '#99aab5',
        hoist: role.hoist || false,
        mentionable: role.mentionable || false,
        permissions: rolePerms,
        position: role.id
      }
    })
  }
  
  if (!importedRoles.find(r => r.name === '@everyone')) {
    const everyoneRoleId = uuidv4()
    roleIdMap[0] = everyoneRoleId
    importedRoles.unshift({
      id: everyoneRoleId,
      name: '@everyone',
      color: '#99aab5',
      hoist: false,
      mentionable: false,
      permissions: '0',
      position: 0
    })
  }

  if (newServer) {
    newServer.roles = mergeImportedRoles([], importedRoles)
  }
  
  const categories = []
  const textChannels = []
  const voiceChannels = []
  const forumChannels = []
  const announcementChannels = []
  const mediaChannels = []
  
  serverData.channels.forEach(channel => {
    const channelType = channel.type
    const mappedType = CHANNEL_TYPE_MAP[channelType] || 'text'
    const newChannelId = uuidv4()
    channelIdMap[channel.id] = newChannelId
    
    const channelData = {
      id: newChannelId,
      serverId,
      name: channel.name,
      type: mappedType,
      topic: channel.topic || '',
      position: channel.position || 0,
      categoryId: null,
      createdAt: new Date().toISOString(),
      nsfw: channel.nsfw || false,
      slowMode: channel.rate_limit_per_user || 0,
      permissions: channel.permission_overwrites ? {
        overrides: channel.permission_overwrites.reduce((acc, ow) => {
          const roleId = ow.id === 0 ? roleIdMap[0] : roleIdMap[ow.id]
          if (roleId) {
            acc[roleId] = {
              allow: ow.allow ? discordPermissionsToVoltage(ow.allow) : [],
              deny: ow.deny ? discordPermissionsToVoltage(ow.deny) : []
            }
          }
          return acc
        }, {})
      } : { overrides: {} }
    }
    
    if (channel.parent_id && channelType !== 4) {
      const parentChannel = serverData.channels.find(c => c.id === channel.parent_id && c.type === 4)
      if (parentChannel) {
        categoryIdMap[parentChannel.id] = categoryIdMap[parentChannel.id] || uuidv4()
        channelData.categoryId = categoryIdMap[parentChannel.id]
      }
    }
    
    if (mappedType === 'category') {
      categoryIdMap[channel.id] = newChannelId
      categories.push(channelData)
    } else if (mappedType === 'forum') {
      forumChannels.push(channelData)
    } else if (mappedType === 'text' && channel.name === 'announcements') {
      announcementChannels.push({ ...channelData, type: 'announcement' })
    } else if (mappedType === 'text' && (channel.name.includes('media') || channel.name.includes('gallery'))) {
      mediaChannels.push({ ...channelData, type: 'media' })
    } else if (mappedType === 'voice') {
      voiceChannels.push(channelData)
    } else {
      textChannels.push(channelData)
    }
  })
  
  const sortedCategories = categories.sort((a, b) => a.position - b.position)
  const allChannels = [...sortedCategories]
  
  const addChannelsToCategory = (channels, categoryId) => {
    return channels.map(ch => ({
      ...ch,
      categoryId: categoryId
    })).sort((a, b) => a.position - b.position)
  }
  
  sortedCategories.forEach(cat => {
    const catChannels = [
      ...addChannelsToCategory(textChannels.filter(ch => ch.categoryId === cat.id), cat.id),
      ...addChannelsToCategory(voiceChannels.filter(ch => ch.categoryId === cat.id), cat.id),
      ...addChannelsToCategory(forumChannels.filter(ch => ch.categoryId === cat.id), cat.id),
      ...addChannelsToCategory(announcementChannels.filter(ch => ch.categoryId === cat.id), cat.id),
      ...addChannelsToCategory(mediaChannels.filter(ch => ch.categoryId === cat.id), cat.id)
    ]
    allChannels.push(...catChannels)
  })
  
  const uncategorizedText = addChannelsToCategory(textChannels.filter(ch => !ch.categoryId), null)
  const uncategorizedVoice = addChannelsToCategory(voiceChannels.filter(ch => !ch.categoryId), null)
  const uncategorizedForum = addChannelsToCategory(forumChannels.filter(ch => !ch.categoryId), null)
  const uncategorizedAnnouncement = addChannelsToCategory(announcementChannels.filter(ch => !ch.categoryId), null)
  const uncategorizedMedia = addChannelsToCategory(mediaChannels.filter(ch => !ch.categoryId), null)
  
  allChannels.push(...uncategorizedText, ...uncategorizedVoice, ...uncategorizedForum, ...uncategorizedAnnouncement, ...uncategorizedMedia)
  
  const allCategories = getAllCategories()
  allCategories[serverId] = sortedCategories.map((c, idx) => ({
    id: c.id,
    serverId,
    name: c.name,
    position: idx,
    createdAt: c.createdAt
  }))
  await setAllCategories(allCategories)
  
  const allChannelsStore = getAllChannels()
  allChannelsStore[serverId] = allChannels
  await setAllChannels(allChannelsStore)
  
  const servers = getServers()
  const serverIndex = servers.findIndex(server => server?.id === serverId)
  if (newServer) {
    servers.push(newServer)
  } else {
    const existingServer = serverIndex >= 0 ? servers[serverIndex] : null
    if (existingServer) {
      servers[serverIndex] = {
        ...existingServer,
        name: serverData.name,
        description: serverData.description || existingServer.description || '',
        roles: mergeImportedRoles(existingServer.roles || [], importedRoles),
        updatedAt: new Date().toISOString()
      }
    } else {
      servers.push({
        id: serverId,
        name: serverData.name,
        description: serverData.description || '',
        ownerId: userId,
        roles: mergeImportedRoles([], importedRoles),
        members: {},
        channels: {},
        invites: {},
        bots: [],
        mfaLevel: 0,
        contentFilter: 0,
        notifications: 1,
        verificationLevel: serverData.verification_level || 0
      })
    }
  }
  await setServers(servers)

  const updatedServer = servers.find(server => server?.id === serverId)

  io.to(`server:${serverId}`).emit('server:updated', updatedServer)
  io.to(`server:${serverId}`).emit('category:order-updated', allCategories[serverId] || [])
  io.to(`server:${serverId}`).emit('channel:order-updated', allChannels)
  for (const role of importedRoles) {
    io.to(`server:${serverId}`).emit('role:created', { ...role, serverId })
  }
  
  return {
    server: updatedServer,
    channels: allChannels,
    roles: updatedServer?.roles || [],
    categories: allCategories[serverId]
  }
}

router.post('/discord/template', authenticateToken, async (req, res) => {
  try {
    const { templateCode, serverId } = req.body
    
    if (!templateCode) {
      return res.status(400).json({ error: 'Template code is required' })
    }
    
    const templateCodeClean = templateCode.replace(/^https?:\/\/discord\.com\/template\//, '')
    
    console.log(`[Import] Fetching Discord template: ${templateCodeClean}`)
    
    const templateData = await fetchDiscordTemplate(templateCodeClean)
    
    if (!templateData || !templateData.serialized_source_guild) {
      return res.status(400).json({ error: 'Invalid template format' })
    }
    
    const result = await createDiscordServer(templateData, req.user.id, serverId || null)
    
    console.log(`[Import] Successfully imported ${serverId ? 'to existing' : 'new'} server: ${result.server.name}`)
    
    res.json({
      success: true,
      server: result.server,
      channels: result.channels,
      roles: result.roles,
      categories: result.categories,
      message: `Successfully imported "${result.server.name}" from Discord template`
    })
  } catch (error) {
    console.error('[Import] Error importing Discord template:', error)
    res.status(500).json({ error: error.message || 'Failed to import template' })
  }
})

router.post('/discord/import', authenticateToken, async (req, res) => {
  try {
    const { templateData, serverId } = req.body
    
    if (!templateData || !templateData.serialized_source_guild) {
      return res.status(400).json({ error: 'Invalid template data' })
    }
    
    const result = await createDiscordServer(templateData, req.user.id, serverId || null)
    
    console.log(`[Import] Successfully imported server: ${result.server.name}`)
    
    res.json({
      success: true,
      server: result.server,
      channels: result.channels,
      roles: result.roles,
      categories: result.categories,
      message: `Successfully imported "${result.server.name}"`
    })
  } catch (error) {
    console.error('[Import] Error importing Discord template:', error)
    res.status(500).json({ error: error.message || 'Failed to import template' })
  }
})

export default router
