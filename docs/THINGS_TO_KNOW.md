# Things to Know

Important information, tips, and gotchas for working with the VoltChat backend.

## Architecture

### How It Works

1. **Express.js Server** - Handles HTTP API requests
2. **Socket.io** - Real-time WebSocket connections for live features
3. **JWT Authentication** - Token-based auth with refresh support
4. **SQLite/PostgreSQL** - Data persistence
5. **File-based Storage** - For uploads and media

### Request Flow

```
Client -> JWT Token -> Express Middleware -> Route Handler -> Service -> Database
                |
                v
         Socket.io -> Real-time events
```

---

## Authentication

### JWT Tokens

- Tokens expire after 7 days (configurable)
- Include user info: `userId`, `username`, `host`
- Stored in `Authorization` header: `Bearer <token>`

### Token Refresh

```javascript
// Client side - refresh token before expiry
const refreshToken = async () => {
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${currentToken}` }
  })
  const { access_token } = await response.json()
  localStorage.setItem('token', access_token)
}
```

### Cross-Server Auth

For federation, tokens include a `host` field:

```javascript
{
  "userId": "user_123",
  "username": "john",
  "host": "server1.example.com",
  "exp": 1234567890
}
```

---

## User Profiles

### Avatar URLs

**Important:** Avatar URLs are generated dynamically, not stored in the database.

```javascript
// Backend generates URL on-the-fly
const avatarUrl = `${config.getImageServerUrl()}/api/images/users/${userId}/profile`
```

This ensures avatars always point to the correct server, even if the main server URL changes.

**Configuration:** Set `imageServerUrl` in your config:

```json
{
  "server": {
    "url": "https://voltchatapp.example.com",
    "imageServerUrl": "https://api.example.com"
  }
}
```

### Profile Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique user ID |
| `username` | string | Original username (with host for federation) |
| `customUsername` | string | User-chosen display name |
| `displayName` | string | Shown name (customUsername or username) |
| `avatar` | string | Avatar URL (dynamically generated) |
| `banner` | string | Profile banner URL |
| `bio` | string | User bio |
| `status` | string | online, idle, dnd, invisible |
| `customStatus` | string | User's custom status message |

---

## Servers & Channels

### Server Structure

```javascript
{
  id: "server_123",
  name: "My Server",
  icon: "icon_url",
  banner: "banner_url",
  ownerId: "user_123",
  members: [
    {
      id: "user_123",
      username: "john",
      avatar: "url",
      roles: ["admin"],
      role: "admin",
      joinedAt: "2024-01-01"
    }
  ],
  channels: [
    { id: "ch_1", name: "general", type: "text" }
  ]
}
```

### Channel Types

- `text` - Text channels
- `voice` - Voice channels (with WebRTC)
- `announcement` - Announcement channels

### Roles & Permissions

Roles are stored per-server with permissions:

```javascript
{
  id: "role_1",
  name: "Moderator",
  color: "#ff0000",
  permissions: [
    "manage_messages",
    "kick_members",
    "ban_members"
  ]
}
```

---

## Messages

### Message Structure

```javascript
{
  id: "msg_123",
  channelId: "ch_1",
  userId: "user_123",
  username: "john",
  avatar: "url",
  content: "Hello world!",
  attachments: [
    { type: "image", url: "...", name: "image.png" }
  ],
  replyTo: "msg_122",
  pinned: false,
  timestamp: "2024-01-01T12:00:00Z",
  editedAt: null
}
```

### Rich Content

Messages support:
- Markdown formatting
- @mentions (user, role, everyone, here)
- Attachments (images, files, videos)
- Links and embeds

---

## Direct Messages (DMs)

### DM Structure

```javascript
{
  id: "dm_123",
  conversationId: "conv_abc",
  recipientId: "user_456",
  lastMessage: {
    content: "Hey!",
    timestamp: "2024-01-01"
  }
}
```

### DM vs Server Messages

| Feature | Server Messages | DMs |
|---------|-----------------|-----|
| Channels | Yes | No |
| Threads | Yes | No |
| Reactions | Yes | Yes |
| Reply | Yes | Yes |

---

## Real-time Features

### Socket Events

#### Client -> Server

```javascript
socket.emit('message:send', { channelId, content })
socket.emit('voice:join', { channelId })
socket.emit('typing:start', { channelId })
```

#### Server -> Client

```javascript
socket.on('message:new', handleNewMessage)
socket.on('message:edit', handleEditMessage)
socket.on('user:status', handleStatusUpdate)
socket.on('voice:user-joined', handleVoiceJoin)
```

### Voice Channels

Voice uses WebRTC with these signaling events:

```javascript
// Join voice
socket.emit('voice:join', { channelId })

// WebRTC signaling
socket.emit('voice:offer', { to: userId, offer: RTCSessionDescription })
socket.emit('voice:answer', { to: userId, answer: RTCSessionDescription })
socket.emit('voice:ice-candidate', { to: userId, candidate: RTCIceCandidate })

// Controls
socket.emit('voice:mute', { channelId, muted: true })
socket.emit('voice:video', { channelId, enabled: true })
socket.emit('voice:screen-share', { enabled: true })
```

---

## File Uploads

### Upload Flow

1. Client sends file via `FormData`
2. Server validates file type/size
3. File saved to `./uploads/`
4. Return URL: `/api/uploads/filename`

### Constraints

```json
{
  "limits": {
    "maxUploadSize": 10485760  // 10MB default
  }
}
```

### Allowed Types

Images, videos, audio, documents (configurable in `uploadRoutes.js`)

---

## Federation (Cross-Server)

### How Federation Works

1. Servers share their public key
2. Users can join remote servers via invite
3. Messages can be federated to other servers
4. User profiles fetched from home server

### Federation Config

```json
{
  "federation": {
    "enabled": true,
    "serverName": "volt.example.com",
    "maxHops": 3
  }
}
```

### Cross-Server Identifiers

Federated users have the format: `username@host`

```javascript
// Local user
"john"

// Federated user
"john@other-server.com"
```

---

## Performance Tips

### Caching

Enable Redis for caching:

```json
{
  "cache": {
    "enabled": true,
    "provider": "redis",
    "redis": {
      "host": "localhost",
      "port": 6379
    }
  }
}
```

### Rate Limiting

Built-in rate limiting:

```json
{
  "security": {
    "rateLimit": {
      "windowMs": 60000,
      "maxRequests": 100
    }
  }
}
```

### Database Indexes

SQLite automatically indexes by ID. For large deployments, use PostgreSQL.

---

## Security

### XSS Prevention

- Messages are sanitized on display
- Use `DOMPurify` on frontend

### CSRF

- JWT tokens in headers (not cookies)
- Same-origin policy enforced

### Rate Limiting

- 100 requests per minute default
- Configurable per-endpoint

### Input Validation

All inputs validated in routes before processing.

---

## Common Patterns

### Error Handling

```javascript
try {
  const result = await riskyOperation()
  res.json(result)
} catch (error) {
  console.error('[Route] Error:', error.message)
  res.status(500).json({ error: 'Something went wrong' })
}
```

### Logging

```javascript
console.log('[Module] Action: details', { data: useful })
```

Logs are prefixed with:
- `[API]` - HTTP API calls
- `[Auth]` - Authentication
- `[Socket]` - WebSocket events
- `[DB]` - Database operations

### Service Pattern

```javascript
// routes/userRoutes.js
router.get('/friends', authenticateToken, async (req, res) => {
  const friends = friendService.getFriends(req.user.id)
  res.json(friends)
})

// services/dataService.js
const friendService = {
  getFriends(userId) {
    const user = userService.getUser(userId)
    return user.friends || []
  }
}
```

---

## Gotchas

### 1. Avatar URLs Not Loading

**Symptom:** Avatar images show broken links or wrong server

**Fix:** Set `imageServerUrl` in config:

```json
{
  "server": {
    "imageServerUrl": "https://api.your-server.com"
  }
}
```

### 2. CORS Errors

**Symptom:** Frontend can't connect to API

**Fix:** Ensure `SERVER_URL` in backend matches frontend config exactly (including https://)

### 3. Token Expiration

**Symptom:** Users logged out unexpectedly

**Fix:** Implement token refresh on client before expiry

### 4. Database Locked

**Symptom:** "Database is locked" errors

**Fix:** 
- Use PostgreSQL for production
- Or enable WAL mode for SQLite: `PRAGMA journal_mode=WAL;`

### 5. WebSocket Reconnection

**Symptom:** Voice/chats disconnect on network issues

**Fix:** Socket.io auto-reconnects by default. Check `socketService.js` for custom handling.

### 6. Large File Uploads Fail

**Symptom:** Uploads timeout or fail

**Fix:** 
- Increase `maxUploadSize` in config
- Check nginx timeout settings if using reverse proxy
- Consider using S3/CDN for large files

---

## Testing

### API Testing with curl

```bash
# Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"john","password":"pass"}'

# Get user (with token)
curl http://localhost:5000/api/user/me \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Health Check

```bash
curl http://localhost:5000/api/health
```

---

## Debugging

### Enable Debug Logs

Check console output for prefixed logs:
- `[API]` - API requests
- `[Auth]` - Auth events  
- `[Socket]` - Socket events
- `[WebRTC]` - Voice/Video

### Common Debug Commands

```bash
# List all processes using port
lsof -i :5000

# Watch logs in real-time
tail -f data/app.log

# Check database
sqlite3 data/voltage.db ".tables"
```
