# API Reference

Complete API documentation for the VoltChat backend.

## Base URL

```
http://localhost:5000/api
```

## Authentication

All authenticated endpoints require a JWT token in the header:

```
Authorization: Bearer <token>
```

## Response Format

### Success

```json
{
  "data": { ... }
}
```

### Error

```json
{
  "error": "Error message"
}
```

---

## Auth Endpoints

### POST /auth/register

Register a new local user.

**Request:**
```json
{
  "username": "john",
  "email": "john@example.com",
  "password": "securepassword"
}
```

**Response:**
```json
{
  "user": {
    "id": "user_123",
    "username": "john",
    "email": "john@example.com",
    "avatar": "http://localhost:5000/api/images/users/user_123/profile"
  },
  "access_token": "eyJhbG...",
  "token_type": "Bearer",
  "expires_in": 604800
}
```

### POST /auth/login

Login with username and password.

**Request:**
```json
{
  "username": "john",
  "password": "securepassword"
}
```

**Response:** Same as register.

### GET /auth/me

Get current authenticated user.

**Response:**
```json
{
  "id": "user_123",
  "username": "john",
  "displayName": "John",
  "email": "john@example.com",
  "avatar": "http://localhost:5000/api/images/users/user_123/profile"
}
```

### GET /auth/config

Get public auth configuration.

**Response:**
```json
{
  "allowRegistration": true,
  "localAuthEnabled": true,
  "oauthEnabled": true,
  "serverName": "VoltChat"
}
```

---

## User Endpoints

### GET /user/me

Get current user's full profile.

**Response:**
```json
{
  "username": "john",
  "displayName": "John Doe",
  "avatar": "http://localhost:5000/api/images/users/user_123/profile",
  "email": "john@example.com",
  "bio": "Hello world!",
  "banner": null,
  "status": "online",
  "customStatus": "Working on something cool",
  "socialLinks": {
    "twitter": "johndoe",
    "github": "johndoe"
  },
  "ageVerification": {
    "verified": true,
    "category": "adult"
  }
}
```

### PUT /user/me

Update current user's profile.

**Request:**
```json
{
  "displayName": "John Doe",
  "bio": "Updated bio",
  "customStatus": "Coding",
  "socialLinks": {
    "twitter": "johndoe",
    "github": "johndoe"
  }
}
```

### GET /user/friends

Get list of friends.

**Response:**
```json
[
  {
    "id": "user_456",
    "username": "jane",
    "displayName": "Jane Doe",
    "avatar": "http://localhost:5000/api/images/users/user_456/profile",
    "status": "online"
  }
]
```

### GET /user/friend-requests

Get pending friend requests.

**Response:**
```json
{
  "incoming": [
    {
      "id": "req_123",
      "from": "user_789",
      "fromUsername": "bob"
    }
  ],
  "outgoing": [
    {
      "id": "req_456",
      "to": "user_999",
      "toUsername": "alice"
    }
  ]
}
```

### POST /user/friend-request

Send a friend request.

**Request:**
```json
{
  "username": "jane@other-server.com"
}
```

### POST /user/friend-request/:id/accept

Accept a friend request.

### POST /user/friend-request/:id/reject

Reject a friend request.

### DELETE /user/friends/:userId

Remove a friend.

### GET /user/blocked

Get blocked users.

### POST /user/block/:userId

Block a user.

### DELETE /user/block/:userId

Unblock a user.

### GET /user/:userId

Get another user's public profile.

**Response:**
```json
{
  "id": "user_456",
  "username": "jane",
  "displayName": "Jane",
  "avatar": "http://localhost:5000/api/images/users/user_456/profile",
  "bio": "Hello!",
  "status": "online",
  "customStatus": "Away",
  "isFriend": true,
  "isBlocked": false
}
```

### GET /user/:userId/mutual-friends

Get mutual friends with a user.

**Response:**
```json
[
  {
    "id": "user_789",
    "username": "bob",
    "displayName": "Bob",
    "avatar": "http://localhost:5000/api/images/users/user_789/profile"
  }
]
```

### GET /user/:userId/mutual-servers

Get mutual servers with a user.

**Response:**
```json
[
  {
    "id": "server_123",
    "name": "Gaming",
    "icon": "http://localhost:5000/api/uploads/icon.png"
  }
]
```

---

## Server Endpoints

### GET /servers

Get all servers the user is a member of.

**Response:**
```json
[
  {
    "id": "server_123",
    "name": "My Server",
    "icon": "http://localhost:5000/api/uploads/icon.png",
    "banner": null,
    "ownerId": "user_123",
    "memberCount": 10
  }
]
```

### POST /servers

Create a new server.

**Request:**
```json
{
  "name": "My New Server",
  "icon": "base64_or_url",
  "description": "A cool server"
}
```

### GET /servers/:serverId

Get server details.

**Response:**
```json
{
  "id": "server_123",
  "name": "My Server",
  "icon": "http://...",
  "banner": null,
  "description": "A cool server",
  "ownerId": "user_123",
  "members": [...],
  "channels": [...],
  "roles": [...]
}
```

### PUT /servers/:serverId

Update server.

### DELETE /servers/:serverId

Delete server (owner only).

### POST /servers/:serverId/join

Join a server.

### POST /servers/:serverId/leave

Leave a server.

### GET /servers/:serverId/members

Get server members.

### PUT /servers/:serverId/members/:userId/roles

Update member roles.

### DELETE /servers/:serverId/members/:userId

Kick member.

### POST /servers/:serverId/bans/:userId

Ban member.

### DELETE /servers/:serverId/bans/:userId

Unban user.

---

## Channel Endpoints

### GET /servers/:serverId/channels

Get all channels in a server.

**Response:**
```json
[
  {
    "id": "ch_123",
    "serverId": "server_123",
    "name": "general",
    "type": "text",
    "position": 0,
    "nsfw": false
  },
  {
    "id": "ch_456",
    "serverId": "server_123",
    "name": "Voice",
    "type": "voice",
    "position": 1
  }
]
```

### POST /servers/:serverId/channels

Create a channel.

**Request:**
```json
{
  "name": "new-channel",
  "type": "text",
  "topic": "Channel topic",
  "nsfw": false
}
```

### PUT /channels/:channelId

Update a channel.

### DELETE /channels/:channelId

Delete a channel.

---

## Message Endpoints

### GET /channels/:channelId/messages

Get messages from a channel.

**Query Parameters:**
- `before` - Message ID to get messages before
- `limit` - Number of messages (default 50)

**Response:**
```json
[
  {
    "id": "msg_123",
    "channelId": "ch_123",
    "userId": "user_456",
    "username": "john",
    "avatar": "http://...",
    "content": "Hello!",
    "attachments": [],
    "replyTo": null,
    "pinned": false,
    "timestamp": "2024-01-01T12:00:00Z",
    "editedAt": null
  }
]
```

### POST /channels/:channelId/messages

Send a message.

**Request:**
```json
{
  "content": "Hello world!",
  "attachments": [],
  "replyTo": "msg_122"
}
```

### PUT /channels/:channelId/messages/:messageId

Edit a message.

**Request:**
```json
{
  "content": "Updated content"
}
```

### DELETE /channels/:channelId/messages/:messageId

Delete a message.

### GET /channels/:channelId/pins

Get pinned messages.

### POST /channels/:channelId/pins/:messageId

Pin a message.

### DELETE /channels/:channelId/pins/:messageId

Unpin a message.

---

## DM Endpoints

### GET /dms

Get all DM conversations.

**Response:**
```json
[
  {
    "id": "dm_123",
    "recipientId": "user_456",
    "recipient": {
      "id": "user_456",
      "username": "jane",
      "displayName": "Jane",
      "avatar": "http://...",
      "status": "online"
    },
    "lastMessage": {
      "content": "Hey!",
      "timestamp": "2024-01-01T12:00:00Z"
    }
  }
]
```

### POST /dms

Start a new DM conversation.

**Request:**
```json
{
  "userId": "user_456"
}
```

### GET /dms/:conversationId/messages

Get DM messages.

### POST /dms/:conversationId/messages

Send a DM message.

---

## Invite Endpoints

### POST /invites

Create an invite.

**Request:**
```json
{
  "serverId": "server_123",
  "maxAge": 86400,
  "maxUses": 100
}
```

**Response:**
```json
{
  "code": "abc123xyz",
  "serverId": "server_123",
  "inviterId": "user_123",
  "expiresAt": "2024-01-02T12:00:00Z",
  "maxUses": 100,
  "uses": 0
}
```

### GET /invites/:code

Get invite info.

### POST /invites/:code/join

Join a server via invite.

---

## Upload Endpoints

### POST /upload

Upload a file.

**Request:** `multipart/form-data`

**Response:**
```json
{
  "attachments": [
    {
      "id": "file_123",
      "filename": "image.png",
      "url": "http://localhost:5000/api/uploads/image.png",
      "type": "image",
      "size": 102400
    }
  ]
}
```

### DELETE /upload/:filename

Delete an uploaded file.

---

## Image Endpoints

### GET /images/users/:userId/profile

Get user's profile image.

### GET /images/users/:userId/banner

Get user's banner image.

### GET /images/servers/:serverId/icon

Get server's icon.

### GET /images/servers/:serverId/banner

Get server's banner.

---

## Socket Events

### Connection

```javascript
const socket = io('http://localhost:5000', {
  auth: { token: 'USER_TOKEN' }
})
```

### Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `message:send` | Client | `{ channelId, content }` |
| `message:new` | Server | Message object |
| `message:edit` | Server | `{ messageId, content }` |
| `message:delete` | Server | `{ messageId }` |
| `typing:start` | Client | `{ channelId }` |
| `typing:stop` | Client | `{ channelId }` |
| `typing` | Server | `{ channelId, userId, username }` |
| `user:status` | Server | `{ userId, status }` |
| `voice:join` | Client | `{ channelId }` |
| `voice:leave` | Client | `{ channelId }` |
| `voice:user-joined` | Server | User info |

---

## WebRTC Signaling (Voice)

| Event | Description |
|-------|-------------|
| `voice:join` | Join voice channel |
| `voice:leave` | Leave voice channel |
| `voice:offer` | Send WebRTC offer |
| `voice:answer` | Send WebRTC answer |
| `voice:ice-candidate` | Send ICE candidate |
| `voice:participants` | List of participants |
| `voice:mute` | Mute/unmute |
| `voice:deafen` | Deafen/undeafen |
| `voice:video` | Toggle video |
| `voice:screen-share` | Toggle screen share |
