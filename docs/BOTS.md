# VoltChat Bots Guide

Custom bots for VoltChat work similarly to Discord bots. You can create bots that respond to messages, run commands, and interact with servers programmatically.

## Creating a Bot

### 1. Register your bot via the API

```bash
curl -X POST https://your-volt-server.com/api/bots \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyBot",
    "description": "A cool bot that does things",
    "prefix": "!",
    "permissions": ["messages:read", "messages:send", "reactions:add"],
    "intents": ["GUILD_MESSAGES", "MESSAGE_CONTENT"],
    "public": false
  }'
```

Response:

```json
{
  "id": "bot_1707000000_a1b2c3d4",
  "name": "MyBot",
  "token": "vbot_abc123...xyz789",
  "prefix": "!",
  "permissions": ["messages:read", "messages:send", "reactions:add"],
  "intents": ["GUILD_MESSAGES", "MESSAGE_CONTENT"]
}
```

**Save the token immediately.** It will not be shown again.

### 2. Add your bot to a server

Only the server owner can add bots:

```bash
curl -X POST https://your-volt-server.com/api/bots/BOT_ID/servers/SERVER_ID \
  -H "Authorization: Bearer SERVER_OWNER_TOKEN"
```

## Connecting Your Bot

### Option A: WebSocket (Real-time)

Connect via Socket.IO for real-time message handling:

```javascript
import { io } from 'socket.io-client'

const socket = io('https://your-volt-server.com', {
  auth: { token: 'YOUR_USER_TOKEN' }
})

socket.on('connect', () => {
  // Authenticate as a bot
  socket.emit('bot:connect', { botToken: 'vbot_abc123...xyz789' })
})

socket.on('bot:ready', (data) => {
  console.log(`Bot ${data.name} is ready! Servers: ${data.servers}`)
})

// Listen for messages in channels the bot has joined
socket.on('message:new', (message) => {
  // Ignore own messages
  if (message.bot) return

  // Check for command prefix
  if (message.content.startsWith('!')) {
    const command = message.content.slice(1).split(' ')[0]
    const args = message.content.slice(1 + command.length).trim()

    handleCommand(socket, message, command, args)
  }
})

function handleCommand(socket, message, command, args) {
  switch (command) {
    case 'ping':
      socket.emit('bot:send-message', {
        channelId: message.channelId,
        content: 'Pong! Latency: ' + Date.now() + 'ms'
      })
      break

    case 'hello':
      socket.emit('bot:send-message', {
        channelId: message.channelId,
        content: `Hello, ${message.username}!`
      })
      break

    case 'help':
      socket.emit('bot:send-message', {
        channelId: message.channelId,
        content: '**Available Commands:**\n- `!ping` - Check bot latency\n- `!hello` - Get a greeting\n- `!help` - Show this message'
      })
      break
  }
}
```

### Option B: Webhook (HTTP Callbacks)

Set a webhook URL when creating the bot, and VoltChat will POST events to your server:

```bash
curl -X POST https://your-volt-server.com/api/bots \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WebhookBot",
    "webhookUrl": "https://my-bot-server.com/webhook",
    "permissions": ["messages:read", "messages:send"],
    "intents": ["GUILD_MESSAGES"]
  }'
```

Your webhook server receives events like:

```json
{
  "event": "MESSAGE_CREATE",
  "data": {
    "message": {
      "id": "msg_123",
      "channelId": "channel_456",
      "userId": "user_789",
      "username": "SomeUser",
      "content": "!ping"
    },
    "serverId": "server_abc",
    "channelId": "channel_456"
  },
  "timestamp": "2025-02-17T12:00:00.000Z"
}
```

Headers sent with each webhook:

| Header | Description |
|--------|-------------|
| `X-Volt-Signature` | HMAC-SHA256 signature of the body using your webhook secret |
| `X-Volt-Bot-Id` | Your bot's ID |
| `X-Volt-Event` | Event type (e.g., `MESSAGE_CREATE`) |

Verify the signature:

```javascript
import crypto from 'crypto'

function verifySignature(body, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
```

### Option C: REST API Only

Use the Bot API to send messages without a persistent connection:

```bash
# Send a message
curl -X POST https://your-volt-server.com/api/bots/api/channels/CHANNEL_ID/messages \
  -H "Authorization: Bot vbot_abc123...xyz789" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello from my bot!"}'

# Register commands
curl -X PUT https://your-volt-server.com/api/bots/api/commands \
  -H "Authorization: Bot vbot_abc123...xyz789" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"name": "ping", "description": "Check bot latency"},
      {"name": "help", "description": "Show help message"}
    ]
  }'
```

## Bot Permissions

| Permission | Description |
|------------|-------------|
| `messages:read` | Read messages in channels |
| `messages:send` | Send messages to channels |
| `messages:delete` | Delete messages |
| `channels:read` | View channel list |
| `channels:manage` | Create/edit/delete channels |
| `members:read` | View member list |
| `members:manage` | Kick/ban members |
| `reactions:add` | Add reactions to messages |
| `voice:connect` | Connect to voice channels |
| `webhooks:manage` | Manage webhooks |
| `server:manage` | Manage server settings |
| `*` | All permissions (admin) |

## Bot Intents

Intents control which events your bot receives:

| Intent | Events |
|--------|--------|
| `GUILD_MESSAGES` | New messages in server channels |
| `DIRECT_MESSAGES` | Direct messages to the bot |
| `GUILD_MEMBERS` | Member join/leave/update |
| `GUILD_VOICE` | Voice channel events |
| `GUILD_REACTIONS` | Reaction add/remove |
| `GUILD_CHANNELS` | Channel create/update/delete |
| `MESSAGE_CONTENT` | Full message content (required for reading message text) |

## Full Example: Moderation Bot

```javascript
import { io } from 'socket.io-client'

const BOT_TOKEN = 'vbot_your_token_here'
const SERVER_URL = 'https://your-volt-server.com'

const socket = io(SERVER_URL, {
  auth: { token: 'YOUR_USER_AUTH_TOKEN' }
})

const warnings = new Map()

socket.on('connect', () => {
  socket.emit('bot:connect', { botToken: BOT_TOKEN })
})

socket.on('bot:ready', ({ name, servers }) => {
  console.log(`[${name}] Online in ${servers.length} servers`)

  // Join all server channels
  servers.forEach(serverId => {
    socket.emit('server:join', serverId)
  })
})

socket.on('message:new', (msg) => {
  if (msg.bot) return

  const content = msg.content.toLowerCase()

  // Auto-moderation: filter banned words
  const bannedWords = ['spam', 'scam']
  if (bannedWords.some(word => content.includes(word))) {
    socket.emit('bot:send-message', {
      channelId: msg.channelId,
      content: `Warning: @${msg.username}, your message was flagged for containing prohibited content.`
    })

    const count = (warnings.get(msg.userId) || 0) + 1
    warnings.set(msg.userId, count)

    if (count >= 3) {
      socket.emit('bot:send-message', {
        channelId: msg.channelId,
        content: `@${msg.username} has been warned ${count} times. Consider taking action.`
      })
    }
    return
  }

  // Commands
  if (!msg.content.startsWith('!')) return
  const [command, ...args] = msg.content.slice(1).split(' ')

  switch (command) {
    case 'warn':
      if (args[0]) {
        socket.emit('bot:send-message', {
          channelId: msg.channelId,
          content: `${args[0]} has been warned by ${msg.username}.`
        })
      }
      break

    case 'rules':
      socket.emit('bot:send-message', {
        channelId: msg.channelId,
        content: '**Server Rules:**\n1. Be respectful\n2. No spam\n3. No NSFW in general channels\n4. Follow the channel topics'
      })
      break

    case 'stats':
      socket.emit('bot:send-message', {
        channelId: msg.channelId,
        content: `**Moderation Stats:**\n- Warnings issued: ${Array.from(warnings.values()).reduce((a, b) => a + b, 0)}\n- Users warned: ${warnings.size}`
      })
      break
  }
})

socket.on('disconnect', () => {
  console.log('Bot disconnected, reconnecting...')
})
```

## Managing Your Bot

```bash
# List your bots
GET /api/bots/my

# Update bot settings
PUT /api/bots/:botId

# Regenerate token (invalidates old token)
POST /api/bots/:botId/regenerate-token

# Delete bot
DELETE /api/bots/:botId

# View bots in a server
GET /api/bots/server/:serverId

# Browse public bots
GET /api/bots/public/browse
```

## Security Notes

- Bot tokens have the `vbot_` prefix to distinguish them from user tokens.
- Tokens are hashed server-side; the plaintext is only shown once at creation.
- Webhook payloads are signed with HMAC-SHA256 using a per-bot secret.
- Bots can only access servers they have been explicitly added to.
- The server owner must add a bot; bots cannot self-join.
- Regenerate your token immediately if it is compromised.
