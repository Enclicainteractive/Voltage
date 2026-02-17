# Volt Server

The backend server for the Volt decentralized chat platform.

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Or run production server
npm start
```

## Configuration

### config.json

Create a `config.json` in the backend directory or use environment variables.

#### Server Configuration

```json
{
  "server": {
    "name": "Volt",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "https://your-domain.com"
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `name` | string | Server name displayed to users |
| `version` | string | Server version |
| `mode` | string | `mainline` (official network) or `self-volt` (self-hosted) |
| `url` | string | Full URL where server is accessible (e.g., `https://chat.example.com`) |

### Storage Configuration

```json
{
  "storage": {
    "type": "json",
    "json": {
      "dataDir": "./data"
    },
    "sqlite": {
      "dbPath": "./data/voltage.db"
    }
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `type` | string | Storage backend: `json` or `sqlite` |
| `json.dataDir` | string | Directory for JSON data files |
| `sqlite.dbPath` | string | Path to SQLite database file |

**Recommended:**
- Development: `json` (simpler, easier to debug)
- Production: `sqlite` (better performance, concurrent access)

### Authentication Configuration

```json
{
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": true,
      "minPasswordLength": 8,
      "passwordRequirements": {
        "requireUppercase": false,
        "requireNumbers": true,
        "requireSymbols": false
      }
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica",
      "enclica": {
        "clientId": "your-client-id",
        "authUrl": "https://enclica.com/oauth/authorize",
        "tokenUrl": "https://api.enclica.com/api/oauth/token",
        "userInfoUrl": "https://api.enclica.com/api/user/me"
      }
    }
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `type` | string | Auth method: `local`, `oauth`, or `all` |
| `local.enabled` | boolean | Enable email/password login |
| `local.allowRegistration` | boolean | Allow new user registration |
| `local.minPasswordLength` | number | Minimum password length |
| `oauth.enabled` | boolean | Enable OAuth login |
| `oauth.provider` | string | OAuth provider name |

### CDN Configuration

```json
{
  "cdn": {
    "enabled": true,
    "provider": "s3",
    "s3": {
      "bucket": "my-bucket",
      "region": "us-east-1",
      "accessKeyId": "AKIA...",
      "secretAccessKey": "...",
      "publicUrl": "https://cdn.mydomain.com"
    },
    "cloudflare": {
      "accountId": "...",
      "bucket": "...",
      "accessKeyId": "...",
      "secretAccessKey": "...",
      "publicUrl": "https://cdn.mydomain.com"
    }
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Enable CDN for file uploads |
| `provider` | string | CDN provider: `local`, `s3`, or `cloudflare` |
| `s3.bucket` | string | AWS S3 bucket name |
| `s3.region` | string | AWS region |
| `s3.accessKeyId` | string | AWS access key |
| `s3.secretAccessKey` | string | AWS secret key |
| `cloudflare.*` | string | Cloudflare R2 configuration |

**Note:** If CDN upload fails, automatically falls back to local storage.

### Federation Configuration

```json
{
  "federation": {
    "enabled": true,
    "serverName": "my-federation-network",
    "allowedServers": ["server1.com", "server2.com"],
    "maxHops": 3
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Enable federation |
| `serverName` | string | Name for federation network |
| `allowedServers` | array | Whitelist of allowed federated servers |
| `maxHops` | number | Maximum federation hops |

### Feature Flags

```json
{
  "features": {
    "discovery": true,
    "selfVolt": true,
    "ageVerification": false,
    "voiceChannels": true,
    "videoChannels": true,
    "e2eEncryption": true,
    "communities": true,
    "threads": true
  }
}
```

### Rate Limiting

```json
{
  "security": {
    "jwtSecret": "your-super-secret-key",
    "jwtExpiry": "7d",
    "bcryptRounds": 12,
    "rateLimit": {
      "windowMs": 60000,
      "maxRequests": 100
    }
  }
}
```

## Environment Variables

All config options can be set via environment variables:

```bash
# Server
SERVER_URL=https://chat.example.com
SERVER_NAME=MyServer
VOLTAGE_MODE=self-volt
PORT=5000

# Storage
STORAGE_TYPE=sqlite

# Auth
ALLOW_LOCAL_AUTH=true
ALLOW_REGISTRATION=true
ENCLICA_CLIENT_ID=your-client-id

# Security
JWT_SECRET=your-secret-key

# Federation
FEDERATION_ENABLED=true
FEDERATION_SERVER_NAME=my-network
```

## Migration

### Migrate from JSON to SQLite

```bash
# First, backup your data
npm run migrate -- backup ./backups

# Then migrate
npm run migrate -- json-to-sqlite ./data ./data/voltage.db
```

### Migrate from SQLite to JSON

```bash
npm run migrate -- sqlite-to-json ./data/voltage.db ./data-json
```

### Restore from Backup

```bash
npm run migrate -- restore ./backups/backup-2024-01-15
```

### Check Migration Status

```bash
npm run migrate -- status
```

## Scaling

### Using the Scaling Helper

```bash
# Setup new production instance
npm run scale setup production mydomain.com --ssl

# Check server status
npm run scale status

# Generate production config
npm run scale config production

# Show scaling options
npm run scale scale
```

### Horizontal Scaling

1. **Load Balancer**: Use nginx, HAProxy, or cloud LB
2. **Redis**: Enable Redis in config for shared caching
3. **Database**: Use PostgreSQL for multi-server deployments
4. **CDN**: Configure CDN for media files

### Docker Deployment

```yaml
# docker-compose.yml
version: '3.8'
services:
  volt:
    image: voltage:latest
    ports:
      - "5000:5000"
    environment:
      - SERVER_URL=https://chat.example.com
      - JWT_SECRET=your-secret
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/forgot-password` - Request password reset
- `POST /api/auth/reset-password` - Reset password
- `GET /api/auth/config` - Get auth configuration

### OAuth Proxy
- `POST /api/auth/proxy/token` - Exchange OAuth code for token
- `POST /api/auth/proxy/revoke` - Revoke OAuth token

### Users
- `GET /api/user/me` - Get current user
- `PUT /api/user/profile` - Update profile
- `GET /api/user/search` - Search users
- `GET /api/user/friends` - Get friends list

### Servers
- `GET /api/servers` - List servers
- `POST /api/servers` - Create server
- `GET /api/servers/:id` - Get server details

### Channels
- `GET /api/servers/:serverId/channels` - List channels
- `POST /api/servers/:serverId/channels` - Create channel

### Messages
- `GET /api/channels/:channelId/messages` - Get messages
- `POST /api/channels/:channelId/messages` - Send message

### Self-Volt (Federation)
- `GET /api/self-volt` - List connected self-volt servers
- `POST /api/self-volt` - Add self-volt server
- `GET /api/self-volt/:id/servers` - Get servers from self-volt
- `POST /api/self-volt/:id/invite` - Create cross-host invite

### Cross-Host Invites
- `GET /api/invites/cross-host/:code` - Get cross-host invite info
- `POST /api/invites/cross-host/:code/join` - Join via cross-host invite

### File Upload
- `POST /api/upload` - Upload file(s)
- `DELETE /api/upload/:fileId` - Delete file
- `GET /api/upload/cdn/status` - Get CDN status

## Self-Volt (Self-Hosted Servers)

Self-Volt allows users to host their own Volt servers that can connect to the main network.

### Adding a Self-Volt Server

1. Host your own Volt server
2. Generate an API key from the main server
3. Register your server:

```bash
curl -X POST https://main-server.com/api/self-volt \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Server", "url": "https://chat.myserver.com"}'
```

### Cross-Host Invites

Create invites that work across different servers:

```bash
curl -X POST https://your-server.com/api/self-volt/SERVER_ID/invite \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serverId": "CHANNEL_ID"}'
```

This returns a compressed invite code that includes host information.

## Troubleshooting

### Data Not Loading

Make sure your data directory path is correct. Check the startup logs:
```
💾 Storage:
   Type:         json
   Data Dir:     /path/to/data
```

### OAuth Not Working

Verify OAuth URLs are correct:
```
🔐 Auth:
   OAuth:        ✓ Enabled
   Provider:     enclica
```

### Port Already in Use

Change the port:
```bash
PORT=3000 npm start
```

### JWT Secret Warning

In production, always set a secure JWT secret:
```bash
JWT_SECRET=$(openssl rand -hex 64)
```

## License

MIT
