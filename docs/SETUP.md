# Setup Guide

This guide walks you through setting up the VoltChat backend from scratch.

## Prerequisites

### Required Software

| Software | Version | Notes |
|----------|---------|-------|
| Node.js | 18+ | LTS recommended |
| npm | 9+ | Comes with Node.js |
| Git | Any recent version | For cloning |

### Optional (Production)

- PostgreSQL (instead of SQLite)
- Redis (for caching)
- S3-compatible storage (for CDN)

---

## Step 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/your-repo/voltchat.git
cd voltchat

# Install backend dependencies
cd backend
npm install
```

---

## Step 2: Initial Configuration

### Copy Example Config

```bash
cp config.example.json config.json
```

### Edit config.json

```json
{
  "server": {
    "name": "VoltChat",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "http://localhost:5000",
    "imageServerUrl": "http://localhost:5000"
  },
  "storage": {
    "type": "sqlite"
  },
  "auth": {
    "type": "local",
    "local": {
      "enabled": true,
      "allowRegistration": true
    }
  },
  "security": {
    "jwtSecret": "generate-a-secure-random-string",
    "jwtExpiry": "7d"
  }
}
```

**Important:** Generate a secure JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Step 3: Start the Server

### Development Mode

```bash
npm run dev
```

This starts the server with hot-reload on port 5000.

### Production Mode

```bash
# Build if needed
npm run build

# Start production
npm start
```

---

## Step 4: Verify Installation

### Check Server is Running

```bash
curl http://localhost:5000/api/health
```

### Check Auth Config

```bash
curl http://localhost:5000/api/auth/config
```

---

## Step 5: Connect Frontend

### Update Frontend Server Config

In the frontend, update `src/services/serverConfig.js` or set in localStorage:

```javascript
{
  id: 'local',
  name: 'Local Dev',
  apiUrl: 'http://localhost:5000',
  imageApiUrl: 'http://localhost:5000'
}
```

---

## Production Setup

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start server.js --name voltchat

# Save PM2 state
pm2 save

# Setup startup script
pm2 startup
```

### Using Docker

Create `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 5000

CMD ["npm", "start"]
```

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  backend:
    build: .
    ports:
      - "5000:5000"
    environment:
      - NODE_ENV=production
      - SERVER_URL=https://your-domain.com
      - IMAGE_SERVER_URL=https://api.your-domain.com
      - JWT_SECRET=your-secret
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
    restart: unless-stopped
```

### PostgreSQL Setup

```json
{
  "storage": {
    "type": "postgres",
    "postgres": {
      "host": "localhost",
      "port": 5432,
      "database": "voltchat",
      "user": "postgres",
      "password": "your-password"
    }
  }
}
```

Create the database:

```bash
psql -U postgres -c "CREATE DATABASE voltchat;"
```

---

## SSL/HTTPS Setup

### Using Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name voltchatapp.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain/privkey.pem;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}

server {
    listen 80;
    server_name voltchatapp.your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

### Using Certbot

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot -d your-domain.com --nginx
```

---

## Environment-Specific Configs

### Development

```bash
export NODE_ENV=development
export SERVER_URL=http://localhost:5000
export IMAGE_SERVER_URL=http://localhost:5000
```

### Staging

```bash
export NODE_ENV=staging
export SERVER_URL=https://staging.voltchat.com
export IMAGE_SERVER_URL=https://api-staging.voltchat.com
export JWT_SECRET=staging-secret
```

### Production

```bash
export NODE_ENV=production
export SERVER_URL=https://voltchatapp.your-domain.com
export IMAGE_SERVER_URL=https://api.your-domain.com
export JWT_SECRET=production-secret-min-32-chars
```

---

## Common Setup Issues

### Port Already in Use

```bash
# Find process
lsof -i :5000

# Kill it
kill -9 <PID>
```

### Database Locked (SQLite)

```bash
# Remove lock file
rm -f data/voltage.db-journal
```

### Module Not Found

```bash
# Clear node_modules and reinstall
rm -rf node_modules
npm install
```

### CORS Errors

Ensure your `SERVER_URL` matches exactly what's in your frontend config:

```json
{
  "server": {
    "url": "https://voltchatapp.your-domain.com"
  }
}
```

---

## Next Steps

1. Set up OAuth providers (optional)
2. Configure CDN for file uploads
3. Set up Redis for caching (production)
4. Configure push notifications
5. Set up monitoring

See [README.md](./README.md) for feature documentation.
