# VoltChat Backend Documentation

Welcome to the VoltChat backend. This document covers configuration, setup, and important information for running and developing the backend.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Configuration](#configuration)
3. [Environment Variables](#environment-variables)
4. [API Reference](#api-reference)
5. [Features](#features)
6. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn
- SQLite (default) or PostgreSQL/MySQL for production

### Installation

```bash
cd backend
npm install
```

### Running the Server

```bash
# Development
npm run dev

# Production
npm start
```

The server runs on `http://localhost:5000` by default.

---

## Configuration

### Config File Location

The backend loads configuration from (in order of priority):

1. `backend/config.json` - Your custom configuration
2. Environment variables
3. `backend/config.example.json` - Default values
4. Built-in defaults

### Basic Config Example

Create `backend/config.json`:

```json
{
  "server": {
    "name": "VoltChat",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "https://your-server.com",
    "imageServerUrl": "https://api.your-server.com",
    "port": 5000
  },
  "storage": {
    "type": "sqlite",
    "sqlite": {
      "dbPath": "./data/voltage.db"
    }
  },
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": true
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica",
      "enclica": {
        "clientId": "your_client_id",
        "authUrl": "https://your-oauth-server/oauth/authorize",
        "tokenUrl": "https://your-oauth-server/api/oauth/token",
        "userInfoUrl": "https://your-oauth-server/api/user/me"
      }
    }
  },
  "security": {
    "jwtSecret": "CHANGE_ME_IN_PRODUCTION",
    "jwtExpiry": "7d"
  }
}
```

---

## Environment Variables

You can also configure via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `5000` |
| `SERVER_URL` | Public server URL | `http://localhost:5000` |
| `IMAGE_SERVER_URL` | Image server URL (for avatars) | Same as SERVER_URL |
| `SERVER_NAME` | Server name | `Volt` |
| `STORAGE_TYPE` | Storage type: `sqlite`, `json` | `sqlite` |
| `JWT_SECRET` | JWT signing secret | Built-in default |
| `ALLOW_LOCAL_AUTH` | Enable local username/password auth | `true` |
| `ALLOW_REGISTRATION` | Allow new user registration | `true` |
| `FEDERATION_ENABLED` | Enable federation | `false` |

### Example with Environment Variables

```bash
SERVER_URL=https://voltchatapp.enclicainteractive.com \
IMAGE_SERVER_URL=https://api.enclicainteractive.com \
JWT_SECRET=your-secret-key \
npm start
```

---

## Configuration Options

### Server Section

```json
{
  "server": {
    "name": "Volt",           // Server display name
    "version": "1.0.0",       // Server version
    "mode": "mainline",       // Operation mode: mainline, self-volt
    "url": "https://volt.chat",     // Public URL
    "imageServerUrl": "https://api.your-server.com",  // Separate image server
    "port": 5000              // Port to listen on
  }
}
```

**Important:** `imageServerUrl` is used for user avatars. Set this to your image server URL (e.g., `https://api.enclicainteractive.com`) if different from the main server URL.

### Storage Section

```json
{
  "storage": {
    "type": "sqlite",        // sqlite, json, or postgres
    "sqlite": {
      "dbPath": "./data/voltage.db"
    },
    "postgres": {
      "host": "localhost",
      "port": 5432,
      "database": "voltchat",
      "user": "user",
      "password": "password"
    }
  }
}
```

### Auth Section

```json
{
  "auth": {
    "type": "all",           // all, local, oauth
    "local": {
      "enabled": true,
      "allowRegistration": true,
      "minPasswordLength": 8
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica", // enclica, discord, google
      "enclica": {
        "clientId": "your_client_id",
        "authUrl": "https://oauth-server/oauth/authorize",
        "tokenUrl": "https://oauth-server/api/oauth/token",
        "userInfoUrl": "https://oauth-server/api/user/me"
      }
    }
  }
}
```

### Security Section

```json
{
  "security": {
    "jwtSecret": "CHANGE_ME_IN_PRODUCTION",
    "jwtExpiry": "7d",
    "bcryptRounds": 12,
    "rateLimit": {
      "windowMs": 60000,
      "maxRequests": 100
    }
  }
}
```

### Features Section

```json
{
  "features": {
    "discovery": true,       // Server discovery
    "selfVolt": true,       // Self-hosted servers
    "voiceChannels": true,  // Voice chat
    "videoChannels": true,   // Video chat
    "e2eEncryption": true,   // End-to-end encryption
    "communities": true     // Community features
  }
}
```

### Limits Section

```json
{
  "limits": {
    "maxUploadSize": 10485760,  // 10MB default
    "maxServersPerUser": 100,
    "maxMessageLength": 4000
  }
}
```

### CDN Section (Optional)

```json
{
  "cdn": {
    "enabled": false,
    "provider": "local",     // local, s3, cloudflare
    "local": {
      "uploadDir": "./uploads",
      "baseUrl": "https://cdn.your-server.com"
    },
    "s3": {
      "bucket": "your-bucket",
      "region": "us-east-1",
      "accessKeyId": "YOUR_KEY",
      "secretAccessKey": "YOUR_SECRET",
      "endpoint": "https://s3.amazonaws.com",
      "publicUrl": "https://cdn.your-server.com"
    }
  }
}
```

---

## API Reference

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `POST /api/auth/refresh` - Refresh token

### Users

- `GET /api/user/me` - Get current user profile
- `PUT /api/user/me` - Update profile
- `GET /api/user/:userId` - Get user by ID
- `GET /api/user/friends` - Get friends list
- `GET /api/user/blocked` - Get blocked users
- `POST /api/user/friend-request` - Send friend request
- `POST /api/user/block/:userId` - Block user

### Servers

- `GET /api/servers` - List joined servers
- `POST /api/servers` - Create server
- `GET /api/servers/:serverId` - Get server
- `PUT /api/servers/:serverId` - Update server
- `DELETE /api/servers/:serverId` - Delete server
- `POST /api/servers/:serverId/join` - Join server
- `POST /api/servers/:serverId/leave` - Leave server

### Channels

- `GET /api/servers/:serverId/channels` - List channels
- `POST /api/servers/:serverId/channels` - Create channel
- `PUT /api/channels/:channelId` - Update channel
- `DELETE /api/channels/:channelId` - Delete channel

### Messages

- `GET /api/channels/:channelId/messages` - Get messages
- `POST /api/channels/:channelId/messages` - Send message
- `PUT /api/channels/:channelId/messages/:messageId` - Edit message
- `DELETE /api/channels/:channelId/messages/:messageId` - Delete message

### Direct Messages

- `GET /api/dms` - List DM conversations
- `POST /api/dms` - Create/start DM
- `GET /api/dms/:conversationId/messages` - Get DM messages
- `POST /api/dms/:conversationId/messages` - Send DM

### Invites

- `POST /api/invites` - Create invite
- `GET /api/invites/:code` - Get invite info
- `POST /api/invites/:code/join` - Join via invite

---

## Features

### Voice Channels

The backend supports WebRTC-based voice channels:

- Real-time audio streaming
- Screen sharing
- Video streaming
- Mute/deafen controls
- Multiple participants

Voice uses STUN servers for NAT traversal. Configure custom STUN/TURN servers in the code if needed.

### Federation

Enable federation for cross-server communication:

```json
{
  "federation": {
    "enabled": true,
    "serverName": "your-server.com",
    "maxHops": 3
  }
}
```

### Push Notifications

Push notifications require VAPID keys:

```
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_SUBJECT=mailto:admin@your-server.com
```

### Discovery

Server discovery allows servers to be publicly listed:

- Categories support
- Search functionality
- Featured servers

---

## Troubleshooting

### Avatar Images Not Loading

If avatar images aren't loading correctly, ensure:

1. `imageServerUrl` is set correctly in config
2. The image server is accessible
3. Check browser console for errors

```json
{
  "server": {
    "url": "https://voltchatapp.enclicainteractive.com",
    "imageServerUrl": "https://api.enclicainteractive.com"
  }
}
```

### Database Issues

```bash
# Reset SQLite database
rm data/voltage.db
npm start
```

### Token Issues

If authentication fails:

1. Check JWT_SECRET is consistent
2. Clear browser localStorage
3. Check token expiration settings

### CORS Issues

If frontend can't connect:

1. Ensure `SERVER_URL` matches your frontend's API URL
2. Check firewall rules for the port

### Port Already in Use

```bash
# Find process using port
lsof -i :5000

# Kill process
kill -9 <PID>
```

---

## Directory Structure

```
backend/
├── config/
│   ├── config.js          # Configuration loader
│   ├── config.example.json
│   └── constants.js
├── routes/
│   ├── authRoutes.js      # Authentication
│   ├── userRoutes.js     # User management
│   ├── serverRoutes.js   # Server management
│   ├── channelRoutes.js  # Channel management
│   ├── dmRoutes.js       # Direct messages
│   └── ...
├── services/
│   ├── dataService.js     # Data storage
│   ├── socketService.js   # WebSocket handling
│   └── ...
├── middleware/
│   ├── authMiddleware.js  # Authentication
│   └── ...
├── docs/
│   └── README.md          # This file
├── data/                   # SQLite database
├── uploads/                # File uploads
└── server.js              # Entry point
```

---

## Contributing

When contributing:

1. Follow existing code style
2. Add proper error handling
3. Document new API endpoints
4. Test thoroughly before submitting

---

## License

MIT License
