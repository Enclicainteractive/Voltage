export const MESSAGE_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  FILE: 'file',
  VOICE: 'voice',
  VIDEO: 'video',
  BOT: 'bot',
  SYSTEM: 'system',
  ENCRYPTED: 'encrypted'
}

export const CHANNEL_TYPES = {
  TEXT: 'text',
  VOICE: 'voice',
  VIDEO: 'video'
}

export const USER_STATUS = {
  ONLINE: 'online',
  IDLE: 'idle',
  DND: 'dnd',
  OFFLINE: 'offline'
}

export const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MODERATOR: 'moderator',
  MEMBER: 'member'
}

export const BOT_PERMISSIONS = {
  MESSAGES_READ: 'messages:read',
  MESSAGES_SEND: 'messages:send',
  MESSAGES_DELETE: 'messages:delete',
  CHANNELS_READ: 'channels:read',
  CHANNELS_MANAGE: 'channels:manage',
  MEMBERS_READ: 'members:read',
  MEMBERS_MANAGE: 'members:manage',
  REACTIONS_ADD: 'reactions:add',
  VOICE_CONNECT: 'voice:connect',
  WEBHOOKS_MANAGE: 'webhooks:manage',
  SERVER_MANAGE: 'server:manage',
  ADMIN: '*'
}

export const BOT_INTENTS = {
  GUILD_MESSAGES: 'GUILD_MESSAGES',
  DIRECT_MESSAGES: 'DIRECT_MESSAGES',
  GUILD_MEMBERS: 'GUILD_MEMBERS',
  GUILD_VOICE: 'GUILD_VOICE',
  GUILD_REACTIONS: 'GUILD_REACTIONS',
  GUILD_CHANNELS: 'GUILD_CHANNELS',
  MESSAGE_CONTENT: 'MESSAGE_CONTENT'
}

export const FEDERATION_STATUS = {
  PENDING: 'pending',
  CONNECTED: 'connected',
  REJECTED: 'rejected',
  ERROR: 'error'
}
