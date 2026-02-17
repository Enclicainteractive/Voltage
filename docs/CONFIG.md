# Configuration Reference

Complete reference for all VoltChat backend configuration options.

## Table of Contents

1. [Config File Location](#config-file-location)
2. [Server Section](#server-section)
3. [Branding Section](#branding-section)
4. [Storage Section](#storage-section)
5. [CDN Section](#cdn-section)
6. [Cache Section](#cache-section)
7. [Queue Section](#queue-section)
8. [Auth Section](#auth-section)
9. [Security Section](#security-section)
10. [Federation Section](#federation-section)
11. [Features Section](#features-section)
12. [Limits Section](#limits-section)
13. [Logging Section](#logging-section)
14. [Monitoring Section](#monitoring-section)
15. [Environment Variables](#environment-variables)
16. [Config Loader API](#config-loader-api)

---

## Config File Location

The backend loads configuration from multiple sources in order of priority:

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `backend/config.json` | Your custom configuration file |
| 2 | Environment variables | OS-level configuration |
| 3 | `backend/config.example.json` | Example/template configuration |
| 4 | Built-in defaults | Hardcoded fallback values |

### Creating a Config File

```bash
# Copy the example config
cp backend/config.example.json backend/config.json

# Or use the self-volt template for self-hosted instances
cp backend/config.self-volt.example.json backend/config.json
```

### Config Loading Flow

```
Start
  ↓
Check config.json exists?
  ├── Yes → Load and merge with defaults
  └── No  → Check environment variables
            ├── Yes → Load and merge with defaults
            └── No  → Use built-in defaults
```

---

## Server Section

Configuration for the main server instance.

```json
{
  "server": {
    "name": "Volt",
    "version": "1.0.0",
    "mode": "mainline",
    "host": "localhost",
    "port": 5000,
    "url": "http://localhost:5000",
    "imageServerUrl": "http://localhost:5000",
    "description": "Volt - Decentralized Chat Platform"
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `name` | string | No | `"Volt"` | Display name for your server instance |
| `version` | string | No | `"1.0.0"` | Server version string (semver recommended) |
| `mode` | string | No | `"mainline"` | Operation mode: `mainline` or `self-volt` |
| `host` | string | No | `"localhost"` | Network interface to bind to |
| `port` | number | No | `5000` | TCP port to listen on |
| `url` | string | Yes | - | Public-facing URL of your server |
| `imageServerUrl` | string | No | Same as `url` | Separate server for serving images/avatars |
| `description` | string | No | - | Server description for discovery |

### mode Options

| Mode | Description | Use Case |
|------|-------------|----------|
| `mainline` | Full-featured VoltChat server with OAuth support | Production VoltChat instances |
| `self-volt` | Self-contained server with local auth only | Self-hosted deployments |

### Important Notes

- **`url`**: Must be a valid URL including protocol (http/https). This is used for:
  - OAuth redirect URIs
  - Email links
  - Cross-server federation
  - CORS headers

- **`imageServerUrl`**: Set this if your image server is different from the main API server. For example:
  ```json
  {
    "url": "https://voltchatapp.enclicainteractive.com",
    "imageServerUrl": "https://api.enclicainteractive.com"
  }
  ```

---

## Branding Section

Customize the visual appearance of your server instance.

```json
{
  "branding": {
    "logo": null,
    "primaryColor": "#5865f2",
    "accentColor": "#7289da"
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `logo` | string/null | No | `null` | URL to server logo image (recommend 256x256 PNG) |
| `primaryColor` | string | No | `"#5865f2"` | Primary brand color (hex format) |
| `accentColor` | string | No | `"#7289da"` | Secondary/accent color (hex format) |

### Color Usage

| Color | Usage |
|-------|-------|
| `primaryColor` | Buttons, links, highlights, server icons |
| `accentColor` | Secondary elements, hover states, notifications |

### Example

```json
{
  "branding": {
    "logo": "https://cdn.your-server.com/logo.png",
    "primaryColor": "#7289da",
    "accentColor": "#43b581"
  }
}
```

---

## Storage Section

Configure how data is persisted. VoltChat supports multiple storage backends.

```json
{
  "storage": {
    "type": "sqlite",
    "json": {
      "dataDir": "./data"
    },
    "sqlite": {
      "dbPath": "./data/voltage.db"
    },
    "mysql": {
      "host": "localhost",
      "port": 3306,
      "database": "voltchat",
      "user": "root",
      "password": "password",
      "connectionLimit": 10
    },
    "mariadb": {
      "host": "localhost",
      "port": 3306,
      "database": "voltchat",
      "user": "root",
      "password": "password"
    },
    "postgres": {
      "host": "localhost",
      "port": 5432,
      "database": "voltchat",
      "user": "postgres",
      "password": "password"
    },
    "cockroachdb": {
      "host": "localhost",
      "port": 26257,
      "database": "voltchat",
      "user": "root",
      "password": "password",
      "ssl": true
    },
    "mssql": {
      "host": "localhost",
      "port": 1433,
      "database": "voltchat",
      "user": "sa",
      "password": "password"
    },
    "mongodb": {
      "host": "localhost",
      "port": 27017,
      "database": "voltchat",
      "user": "",
      "password": ""
    },
    "redis": {
      "host": "localhost",
      "port": 6379,
      "password": "",
      "db": 0,
      "keyPrefix": "voltchat:"
    }
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `type` | string | Yes | `"json"` | Storage backend: `json`, `sqlite`, `mysql`, `mariadb`, `postgres`, `cockroachdb`, `mssql`, `mongodb`, `redis` |

### Storage Backend Comparison

| Feature | JSON | SQLite | MySQL | MariaDB | PostgreSQL | CockroachDB | MSSQL | MongoDB | Redis |
|---------|:----:|:------:|:-----:|:-------:|:----------:|:-----------:|:-----:|:-------:|:-----:|
| **Performance** | Slow | Fast | Fast | Fast | Fast | Fast | Fast | Fast | Fastest |
| **Scalability** | Limited | Medium | High | High | High | Very High | High | Very High | High |
| **Setup Complexity** | None | None | Medium | Medium | Medium | Medium | Medium | Medium | Low |
| **Data Integrity** | None | ACID | ACID | ACID | ACID | ACID | ACID | ACID | Partial |
| **Cluster Support** | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ Native | ✅ | ✅ Native | ✅ |
| **Cloud Managed** | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Memory Usage** | Low | Low | Medium | Medium | Medium | Medium | Medium | Medium | Low |
| **Backup** | File copy | File copy | SQL dump | SQL dump | SQL dump | Backup svc | Backup svc | Export | RDB/AOF |

### Use Case Recommendations

| Type | Best For | Not Recommended For |
|------|----------|-------------------|
| `json` | Development, testing, <1k users | Production, high traffic |
| `sqlite` | Small production, single server | Multi-server, high concurrency |
| `mysql` | Standard production, web apps | Extreme scale, geo-distributed |
| `mariadb` | MySQL compatibility, enhanced performance | - |
| `postgres` | Enterprise, complex queries | - |
| `cockroachdb` | Global distributed, high availability | - |
| `mssql` | Windows ecosystem, enterprise | - |
| `mongodb` | Document storage, flexible schema | Complex relational queries |
| `redis` | Cache layer, sessions only | Primary storage |

### Feature Support by Storage Type

| Feature | JSON | SQLite | MySQL | MariaDB | PostgreSQL | CockroachDB | MSSQL | MongoDB | Redis |
|---------|:----:|:------:|:-----:|:-------:|:----------:|:-----------:|:-----:|:-------:|:-----:|
| **User accounts** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Servers/Channels** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Messages** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Voice/Video** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Federation** | ⚠️ Limited | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Search** | ❌ | ⚠️ Basic | ✅ | ✅ | ✅ Full | ✅ | ✅ | ✅ Full | ❌ |
| **Real-time sync** | ⚠️ Limited | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Pub/Sub |
| **Relationships** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **File metadata** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Invites** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Supported Operations by Storage Type

| Operation | JSON | SQLite | MySQL | MariaDB | PostgreSQL | CockroachDB | MSSQL | MongoDB | Redis |
|-----------|:----:|:------:|:-----:|:-------:|:----------:|:-----------:|:-----:|:-------:|:-----:|
| **CRUD Queries** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Indexing** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Full-text Search** | ❌ | ⚠️ FTS5 | ✅ | ✅ | ✅ Full-text | ✅ | ✅ | ✅ | ❌ |
| **Transactions** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ Single doc | ⚠️ Lua |
| **Joins** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ Lookup | ❌ |
| **JSON Documents** | Native | ⚠️ JSON1 | ✅ JSON | ✅ JSON | ✅ JSONB | ✅ | ✅ JSON | ✅ Native | ✅ |
| **Geospatial** | ❌ | ⚠️ | ✅ | ✅ | ✅ PostGIS | ⚠️ | ✅ | ✅ | ❌ |
| **Replication** | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ Native | ✅ | ✅ | ✅ |
| **Sharding** | ❌ | ❌ | ⚠️ Manual | ⚠️ Manual | ⚠️ Manual | ✅ Native | ⚠️ Manual | ✅ | ⚠️ Cluster |

### Database-Specific Considerations

#### JSON Storage

Best for: Development, small instances, testing

```json
{
  "storage": {
    "type": "json",
    "json": {
      "dataDir": "./data"
    }
  }
}
```

Data is stored as JSON files in the specified directory:
- `users.json` - User accounts
- `servers.json` - Server data
- `channels.json` - Channel data
- `messages.json` - Messages
- `relationships.json` - Friends/blocked

**Pros**: Zero setup, easy to backup, portable
**Cons**: No indexing, slow with large data, no concurrent writes

#### SQLite Storage

Best for: Production, medium instances, single server

```json
{
  "storage": {
    "type": "sqlite",
    "sqlite": {
      "dbPath": "./data/voltage.db"
    }
  }
}
```

**Pros**: ACID, zero config, portable, good performance
**Cons**: Single file, limited concurrency, not for multi-server

#### MySQL Storage

Best for: Standard production, web applications

```json
{
  "storage": {
    "type": "mysql",
    "mysql": {
      "host": "localhost",
      "port": 3306,
      "database": "voltchat",
      "user": "root",
      "password": "your_password",
      "connectionLimit": 10,
      "charset": "utf8mb4"
    }
  }
}
```

**Pros**: Widely used, excellent tooling, mature
**Cons**: Can require tuning, licensing concerns

#### MariaDB Storage

Best for: MySQL compatibility, enhanced performance

```json
{
  "storage": {
    "type": "mariadb",
    "mariadb": {
      "host": "localhost",
      "port": 3306,
      "database": "voltchat",
      "user": "root",
      "password": "your_password",
      "connectionLimit": 10
    }
  }
}
```

**Pros**: MySQL compatible, better performance, open source
**Cons**: Less tooling than MySQL

#### PostgreSQL Storage

Best for: Enterprise, complex data needs

```json
{
  "storage": {
    "type": "postgres",
    "postgres": {
      "host": "localhost",
      "port": 5432,
      "database": "voltchat",
      "user": "postgres",
      "password": "your_password",
      "ssl": false
    }
  }
}
```

**Pros**: Most features, excellent performance, JSON support
**Cons**: Slightly higher resource usage

#### CockroachDB Storage

Best for: Global distributed deployments, high availability

```json
{
  "storage": {
    "type": "cockroachdb",
    "cockroachdb": {
      "host": "localhost",
      "port": 26257,
      "database": "voltchat",
      "user": "root",
      "password": "your_password",
      "ssl": true
    }
  }
}
```

**Pros**: Distributed by default, highly available, PostgreSQL compatible
**Cons**: Higher latency, more complex

#### MSSQL Storage

Best for: Windows ecosystem, enterprise environments

```json
{
  "storage": {
    "type": "mssql",
    "mssql": {
      "host": "localhost",
      "port": 1433,
      "database": "voltchat",
      "user": "sa",
      "password": "your_password",
      "encrypt": false,
      "trustServerCertificate": true
    }
  }
}
```

**Pros**: Enterprise features, Windows integration
**Cons**: Windows-only server, licensing

#### MongoDB Storage

Best for: Document-oriented data, flexible schema

```json
{
  "storage": {
    "type": "mongodb",
    "mongodb": {
      "host": "localhost",
      "port": 27017,
      "database": "voltchat",
      "user": "",
      "password": "",
      "authSource": "admin"
    }
  }
}
```

**Pros**: Flexible schema, excellent scaling, JSON native
**Cons**: No transactions across documents, different query model

#### Redis Storage

Best for: Cache, sessions, real-time features (NOT recommended as primary storage)

```json
{
  "storage": {
    "type": "redis",
    "redis": {
      "host": "localhost",
      "port": 6379,
      "password": "",
      "db": 0,
      "keyPrefix": "voltchat:"
    }
  }
}
```

**Pros**: Extremely fast, pub/sub support
**Cons**: Not persistent by default, limited data types, memory-bound

---

## CDN Section

Configure content delivery for uploaded files (avatars, attachments, images).

```json
{
  "cdn": {
    "enabled": false,
    "provider": "local",
    "local": {
      "uploadDir": "./uploads",
      "baseUrl": null
    },
    "s3": {
      "bucket": null,
      "region": "us-east-1",
      "accessKeyId": null,
      "secretAccessKey": null,
      "endpoint": null,
      "publicUrl": null
    },
    "cloudflare": {
      "accountId": null,
      "bucket": null,
      "accessKeyId": null,
      "secretAccessKey": null,
      "publicUrl": null
    }
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Enable CDN functionality |
| `provider` | string | If enabled | `"local"` | CDN provider: `local`, `s3`, `cloudflare` |

### Local Provider

Stores files on the local filesystem.

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `local.uploadDir` | string | If provider=local | `"./uploads"` | Directory for uploaded files |
| `local.baseUrl` | string | No | `null` | Public URL base (auto-detected if null) |

```json
{
  "cdn": {
    "enabled": true,
    "provider": "local",
    "local": {
      "uploadDir": "./uploads",
      "baseUrl": "https://your-server.com/uploads"
    }
  }
}
```

### S3 Provider

Amazon S3 or S3-compatible storage (MinIO, DigitalOcean Spaces, etc.)

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `s3.bucket` | string | If provider=s3 | - | S3 bucket name |
| `s3.region` | string | No | `"us-east-1"` | AWS region |
| `s3.accessKeyId` | string | If provider=s3 | - | AWS access key |
| `s3.secretAccessKey` | string | If provider=s3 | - | AWS secret key |
| `s3.endpoint` | string | No | `null` | Custom S3 endpoint (for MinIO, DO Spaces) |
| `s3.publicUrl` | string | No | `null` | Custom public URL (CDN domain) |

```json
{
  "cdn": {
    "enabled": true,
    "provider": "s3",
    "s3": {
      "bucket": "my-volt-media",
      "region": "us-east-1",
      "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
      "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "endpoint": "https://s3.amazonaws.com",
      "publicUrl": "https://cdn.mydomain.com"
    }
  }
}
```

### Cloudflare R2 Provider

Cloudflare R2 (zero egress fees).

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `cloudflare.accountId` | string | If provider=cloudflare | - | Cloudflare account ID |
| `cloudflare.bucket` | string | If provider=cloudflare | - | R2 bucket name |
| `cloudflare.accessKeyId` | string | If provider=cloudflare | - | R2 access key ID |
| `cloudflare.secretAccessKey` | string | If provider=cloudflare | - | R2 secret access key |
| `cloudflare.publicUrl` | string | No | `null` | Custom domain URL |

```json
{
  "cdn": {
    "enabled": true,
    "provider": "cloudflare",
    "cloudflare": {
      "accountId": "your-account-id",
      "bucket": "volt-media",
      "accessKeyId": "your-access-key",
      "secretAccessKey": "your-secret-key",
      "publicUrl": "https://media.your-domain.com"
    }
  }
}
```

### Feature Support by CDN Provider

| Feature | Local | S3 | Cloudflare R2 |
|---------|-------|-----|---------------|
| **File Upload** | ✅ | ✅ | ✅ |
| **File Download** | ✅ | ✅ | ✅ |
| **Avatars** | ✅ | ✅ | ✅ |
| **Attachments** | ✅ | ✅ | ✅ |
| **Streaming** | ❌ | ✅ | ✅ |
| **CDN/Cache** | ❌ | ✅* | ✅ |
| **Zero Egress** | N/A | ❌ | ✅ |
| **Custom Domain** | ✅ | ✅ | ✅ |
| **Signed URLs** | ❌ | ❌ | ❌ |
| **Webhooks** | N/A | ❌ | ❌ |

*With CloudFront distribution

### Recommended Setup

**Development**: Local provider
**Production**: S3 with CloudFront or Cloudflare R2

---

## Cache Section

Configure caching for improved performance.

```json
{
  "cache": {
    "enabled": true,
    "provider": "memory",
    "redis": {
      "host": "localhost",
      "port": 6379,
      "password": null,
      "db": 0
    }
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `enabled` | boolean | No | `true` | Enable caching |
| `provider` | string | If enabled | `"memory"` | Cache provider: `memory`, `redis` |

### Memory Provider

In-process memory cache. Fast but not shared across instances.

```json
{
  "cache": {
    "enabled": true,
    "provider": "memory"
  }
}
```

**Pros**: Zero setup, fastest for single instance
**Cons**: Not shared, cleared on restart, memory usage grows

### Redis Provider

Distributed cache using Redis. Required for multi-instance deployments.

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `redis.host` | string | If provider=redis | `"localhost"` | Redis server hostname |
| `redis.port` | number | No | `6379` | Redis server port |
| `redis.password` | string | No | `null` | Redis password (null for no auth) |
| `redis.db` | number | No | `0` | Redis database number |

```json
{
  "cache": {
    "enabled": true,
    "provider": "redis",
    "redis": {
      "host": "localhost",
      "port": 6379,
      "password": "your-redis-password",
      "db": 0
    }
  }
}
```

### Feature Support by Cache Provider

| Feature | Memory | Redis |
|---------|--------|-------|
| **Session Cache** | ✅ | ✅ |
| **User Cache** | ✅ | ✅ |
| **Server Cache** | ✅ | ✅ |
| **Rate Limiting** | ✅ | ✅ |
| **Multi-instance** | ❌ | ✅ |
| **Persistence** | ❌ | ✅ |
| **Cluster Support** | ❌ | ✅ |
| **Pub/Sub** | ❌ | ✅ |

---

## Queue Section

Configure background job processing.

```json
{
  "queue": {
    "enabled": false,
    "provider": "memory",
    "redis": {
      "host": "localhost",
      "port": 6379,
      "password": null,
      "db": 1
    }
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Enable background queue |
| `provider` | string | If enabled | `"memory"` | Queue provider: `memory`, `redis` |

### Memory Provider

In-process job queue. Jobs lost on restart.

```json
{
  "queue": {
    "enabled": false,
    "provider": "memory"
  }
}
```

### Redis Provider

Persistent job queue using Redis. Required for reliable job processing.

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `redis.host` | string | If provider=redis | `"localhost"` | Redis server hostname |
| `redis.port` | number | No | `6379` | Redis server port |
| `redis.password` | string | No | `null` | Redis password |
| `redis.db` | number | No | `1` | Redis database number |

```json
{
  "queue": {
    "enabled": true,
    "provider": "redis",
    "redis": {
      "host": "localhost",
      "port": 6379,
      "password": "your-redis-password",
      "db": 1
    }
  }
}
```

### Feature Support by Queue Provider

| Feature | Memory | Redis |
|---------|--------|-------|
| **Email Sending** | ✅ | ✅ |
| **Push Notifications** | ✅ | ✅ |
| **File Processing** | ✅ | ✅ |
| **Federation Sync** | ✅ | ✅ |
| **Reliability** | ❌ | ✅ |
| **Job Persistence** | ❌ | ✅ |
| **Scheduled Jobs** | ❌ | ✅ |
| **Retry Logic** | ❌ | ⚠️ Manual |

---

## Auth Section

Configure authentication methods.

```json
{
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": true,
      "requireEmailVerification": false,
      "minPasswordLength": 8,
      "maxPasswordLength": 128,
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
        "clientId": "app_xxx",
        "authUrl": "https://voltchatapp.enclicainteractive.com/oauth/authorize",
        "tokenUrl": "https://voltchatapp.enclicainteractive.com/api/oauth/token",
        "userInfoUrl": "https://voltchatapp.enclicainteractive.com/api/user/me",
        "revokeUrl": "https://voltchatapp.enclicainteractive.com/api/oauth/revoke"
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `type` | string | No | `"all"` | Auth mode: `all`, `local`, `oauth` |

### Local Authentication

Username/password authentication.

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `local.enabled` | boolean | No | `true` | Enable local auth |
| `local.allowRegistration` | boolean | No | `true` | Allow new user signup |
| `local.requireEmailVerification` | boolean | No | `false` | Require email verification |
| `local.minPasswordLength` | number | No | `8` | Minimum password length |
| `local.maxPasswordLength` | number | No | `128` | Maximum password length |
| `local.passwordRequirements.requireUppercase` | boolean | No | `false` | Require uppercase letter |
| `local.passwordRequirements.requireNumbers` | boolean | No | `true` | Require number |
| `local.passwordRequirements.requireSymbols` | boolean | No | `false` | Require special symbol |

### OAuth Authentication

OAuth 2.0 based authentication with external providers.

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `oauth.enabled` | boolean | No | `true` | Enable OAuth |
| `oauth.provider` | string | If enabled | `"enclica"` | OAuth provider: `enclica` |

### Enclica OAuth Provider

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `oauth.enclica.clientId` | string | If enclica | - | OAuth client ID |
| `oauth.enclica.authUrl` | string | No | Default | Authorization URL |
| `oauth.enclica.tokenUrl` | string | No | Default | Token exchange URL |
| `oauth.enclica.userInfoUrl` | string | No | Default | User info URL |
| `oauth.enclica.revokeUrl` | string | No | Default | Token revoke URL |

### Auth Type Options

| Type | Description | Use Case |
|------|-------------|----------|
| `all` | Both local and OAuth enabled | Mixed user base |
| `local` | Local auth only | Self-hosted, closed communities |
| `oauth` | OAuth only | Enterprise, centralized identity |

### Feature Support by Auth Type

| Feature | Local Only | OAuth Only | Both |
|---------|-----------|------------|------|
| **Username/Password** | ✅ | ❌ | ✅ |
| **Social Login** | ❌ | ✅ | ✅ |
| **Password Reset** | ✅ | ❌ | ✅ |
| **Email Verification** | ✅ | N/A | ✅ |
| **2FA** | ⚠️ Planned | ⚠️ Planned | ⚠️ Planned |
| **SSO** | ❌ | ✅ | ✅ |
| **User Migration** | ✅ | ❌ | ⚠️ Limited |

### Example: Self-Hosted (Local Only)

```json
{
  "auth": {
    "type": "local",
    "local": {
      "enabled": true,
      "allowRegistration": true,
      "minPasswordLength": 8,
      "passwordRequirements": {
        "requireUppercase": true,
        "requireNumbers": true,
        "requireSymbols": true
      }
    },
    "oauth": {
      "enabled": false
    }
  }
}
```

### Example: Mainline (OAuth Enabled)

```json
{
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": false
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica",
      "enclica": {
        "clientId": "app_your_client_id"
      }
    }
  }
}
```

---

## Security Section

Security and authentication settings.

```json
{
  "security": {
    "jwtSecret": "volt_super_secret_key_change_in_production",
    "jwtExpiry": "7d",
    "bcryptRounds": 12,
    "rateLimit": {
      "windowMs": 60000,
      "maxRequests": 100
    }
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `jwtSecret` | string | Yes | - | Secret key for JWT signing |
| `jwtExpiry` | string | No | `"7d"` | JWT token expiration |
| `bcryptRounds` | number | No | `12` | Password hashing cost |
| `rateLimit.windowMs` | number | No | `60000` | Rate limit window (ms) |
| `rateLimit.maxRequests` | number | No | `100` | Max requests per window |

### JWT Secret

**CRITICAL**: Change this in production!

```json
{
  "security": {
    "jwtSecret": "your-secure-random-secret-at-least-32-chars"
  }
}
```

Generate a secure secret:
```bash
# Linux/Mac
openssl rand -base64 32

# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### JWT Expiry Options

| Value | Description |
|-------|-------------|
| `"15m"` | 15 minutes - High security |
| `"1h"` | 1 hour - Balanced |
| `"7d"` | 7 days - Default, convenient |
| `"30d"` | 30 days - Low security, high convenience |

### Bcrypt Rounds

| Value | Speed | Security |
|-------|-------|----------|
| `8` | Fast (~100ms) | Lower |
| `10` | Normal (~250ms) | Good |
| `12` | Slower (~1s) | Better |
| `14` | Very slow (~4s) | Best |

**Recommendation**: Use `12` for production.

### Rate Limiting

| Setting | Default | Description |
|---------|---------|-------------|
| `windowMs` | 60000 | Time window in milliseconds (1 minute) |
| `maxRequests` | 100 | Maximum requests per window |

### Feature Support

| Feature | Supported | Notes |
|---------|-----------|-------|
| JWT Authentication | ✅ | HS256 |
| Password Hashing | ✅ | Bcrypt |
| Rate Limiting | ✅ | In-memory |
| Rate Limiting (Redis) | ⚠️ | Requires Redis config |
| IP Blocking | ❌ | Manual firewall |
| Captcha | ❌ | Planned |
| 2FA/TOTP | ⚠️ | Limited |

---

## Federation Section

Cross-server communication and interoperability.

```json
{
  "federation": {
    "enabled": false,
    "serverName": null,
    "allowedServers": [],
    "maxHops": 3
  }
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Enable federation |
| `serverName` | string | If enabled | - | Your server's federation name |
| `allowedServers` | array | No | `[]` | Whitelist of allowed federated servers |
| `maxHops` | number | No | `3` | Maximum federation hops |

### Federation Options

| Option | Description |
|--------|-------------|
| `serverName` | Your server's unique name in the federation (e.g., `my-server.com`) |
| `allowedServers` | Array of allowed server names. Empty = allow all (careful!) |
| `maxHops` | Maximum number of servers a message can travel through |

### Feature Support

| Feature | Supported | Notes |
|---------|-----------|-------|
| Cross-server Messages | ✅ | Via federation protocol |
| User Discovery | ✅ | Directory federation |
| Server Discovery | ⚠️ | Limited |
| Voice/Video Federation | ❌ | Not supported |
| File Sharing | ⚠️ | Limited by hops |
| E2E Encryption | ❌ | Not across servers |

### Example

```json
{
  "federation": {
    "enabled": true,
    "serverName": "volt.example.com",
    "allowedServers": ["friend.example.com", "matrix.org"],
    "maxHops": 2
  }
}
```

---

## Features Section

Enable/disable specific features.

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

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `discovery` | boolean | `true` | Public server discovery |
| `selfVolt` | boolean | `true` | Self-hosted server features |
| `ageVerification` | boolean | `false` | Age verification system |
| `voiceChannels` | boolean | `true` | Voice chat |
| `videoChannels` | boolean | `true` | Video chat |
| `e2eEncryption` | boolean | `true` | End-to-end encryption |
| `communities` | boolean | `true` | Community features |
| `threads` | boolean | `true` | Threaded messages |

### Feature Details

| Feature | Description |
|---------|-------------|
| `discovery` | Allows servers to appear in public discovery |
| `selfVolt` | Enables self-hosting capabilities |
| `ageVerification` | Age verification for age-gated content |
| `voiceChannels` | Real-time voice chat |
| `videoChannels` | Video streaming in channels |
| `e2eEncryption` | End-to-end encrypted DMs |
| `communities` | Large server organization (categories) |
| `threads` | Threaded message replies |

### Feature Dependencies

| Feature | Requires |
|---------|----------|
| `videoChannels` | `voiceChannels` |
| `communities` | Nothing |
| `threads` | Nothing |
| `e2eEncryption` | Nothing |
| `discovery` | Nothing |

---

## Limits Section

Resource and usage limits.

```json
{
  "limits": {
    "maxUploadSize": 10485760,
    "maxServersPerUser": 100,
    "maxChannelsPerServer": 500,
    "maxMembersPerServer": 100000,
    "maxMessageLength": 4000,
    "maxDmParticipants": 10
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxUploadSize` | number | `10485760` | Max upload size in bytes (10MB) |
| `maxServersPerUser` | number | `100` | Max servers a user can join |
| `maxChannelsPerServer` | number | `500` | Max channels per server |
| `maxMembersPerServer` | number | `100000` | Max members per server |
| `maxMessageLength` | number | `4000` | Max characters per message |
| `maxDmParticipants` | number | `10` | Max users in group DM |

### Limit Guidelines

| Limit | Recommended | Max |
|-------|-------------|-----|
| `maxUploadSize` | 10-25MB | 100MB |
| `maxServersPerUser` | 100-500 | 1000 |
| `maxChannelsPerServer` | 500-1000 | 5000 |
| `maxMembersPerServer` | 100k-1M | 10M |
| `maxMessageLength` | 4000-10000 | 50000 |
| `maxDmParticipants` | 10-50 | 100 |

### Storage Implications

| Limit | Affects |
|-------|---------|
| `maxUploadSize` | Database storage, CDN bandwidth |
| `maxMessageLength` | Database storage |
| `maxMembersPerServer` | Database size, memory usage |

---

## Logging Section

Configure logging output.

```json
{
  "logging": {
    "level": "info",
    "format": "json",
    "outputs": ["console"]
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `level` | string | `"info"` | Log level: `error`, `warn`, `info`, `debug` |
| `format` | string | `"json"` | Output format: `json`, `text` |
| `outputs` | array | `["console"]` | Output destinations |

### Log Levels

| Level | Description |
|-------|-------------|
| `error` | Errors only |
| `warn` | Warnings and errors |
| `info` | General information (default) |
| `debug` | Detailed debug information |

### Output Formats

| Format | Description | Use Case |
|--------|-------------|----------|
| `json` | JSON objects | Log aggregation (ELK, Loki) |
| `text` | Human-readable text | Development |

### Output Destinations

| Output | Description |
|--------|-------------|
| `"console"` | Standard output |
| `"file"` | File output (not implemented) |
| `"syslog"` | Syslog (not implemented) |

---

## Monitoring Section

Health checks and metrics.

```json
{
  "monitoring": {
    "enabled": false,
    "prometheus": false,
    "healthCheckPath": "/health"
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable monitoring |
| `prometheus` | boolean | `false` | Enable Prometheus metrics |
| `healthCheckPath` | string | `"/health"` | Health check endpoint |

### Health Check

When enabled, provides a health check endpoint:

```bash
curl https://your-server.com/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": 123456789,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Prometheus Metrics

When enabled, provides metrics at `/metrics`:

```bash
curl https://your-server.com/metrics
```

Returns Prometheus-format metrics:
```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200"} 12345
```

### Feature Support

| Feature | Supported | Notes |
|---------|-----------|-------|
| Health Check | ✅ | Basic |
| Prometheus Metrics | ✅ | HTTP requests |
| Custom Metrics | ❌ | Planned |
| Tracing | ❌ | Planned |
| APM | ❌ | External |

---

## Environment Variables

Environment variables can override config file settings.

### Server Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `5000` |
| `SERVER_URL` | Public server URL | `http://localhost:5000` |
| `IMAGE_SERVER_URL` | Image server URL | Same as SERVER_URL |
| `SERVER_NAME` | Server name | `Volt` |
| `VOLTAGE_MODE` | Server mode | - |

### Storage Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STORAGE_TYPE` | Storage type: `json`, `sqlite`, `mysql`, `mariadb`, `postgres`, `cockroachdb`, `mssql`, `mongodb`, `redis` | `json` |

### Database-Specific Environment Variables

#### MySQL/MariaDB
| Variable | Description |
|----------|-------------|
| `MYSQL_HOST` | MySQL/MariaDB host |
| `MYSQL_PORT` | MySQL/MariaDB port (default: 3306) |
| `MYSQL_DATABASE` | Database name |
| `MYSQL_USER` | Database user |
| `MYSQL_PASSWORD` | Database password |

#### PostgreSQL/CockroachDB
| Variable | Description |
|----------|-------------|
| `POSTGRES_HOST` | PostgreSQL/CockroachDB host |
| `POSTGRES_PORT` | PostgreSQL/CockroachDB port (default: 5432/26257) |
| `POSTGRES_DATABASE` | Database name |
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password |

#### MongoDB
| Variable | Description |
|----------|-------------|
| `MONGODB_HOST` | MongoDB host |
| `MONGODB_PORT` | MongoDB port (default: 27017) |
| `MONGODB_DATABASE` | Database name |
| `MONGODB_USER` | Database user |
| `MONGODB_PASSWORD` | Database password |

#### Redis
| Variable | Description |
|----------|-------------|
| `REDIS_HOST` | Redis host |
| `REDIS_PORT` | Redis port (default: 6379) |
| `REDIS_PASSWORD` | Redis password |
| `REDIS_DB` | Redis database number |

### Security Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | JWT secret key | Built-in default |

### Auth Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ALLOW_LOCAL_AUTH` | Enable local auth | `true` |
| `ALLOW_REGISTRATION` | Allow registration | `true` |
| `ENCLICA_CLIENT_ID` | OAuth client ID | - |
| `ENCLICA_AUTH_URL` | OAuth auth URL | - |
| `ENCLICA_TOKEN_URL` | OAuth token URL | - |
| `ENCLICA_USER_INFO_URL` | OAuth user info URL | - |

### Federation Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FEDERATION_ENABLED` | Enable federation | `false` |
| `FEDERATION_SERVER_NAME` | Federation server name | - |
| `FEDERATION_ALLOWED_SERVERS` | Allowed servers (comma-separated) | - |

### Example Usage

```bash
# Production with SQLite (default)
export PORT=443
export SERVER_URL=https://volt.your-domain.com
export IMAGE_SERVER_URL=https://cdn.your-domain.com
export JWT_SECRET=your-secure-secret-key
export STORAGE_TYPE=sqlite
export ALLOW_REGISTRATION=false
npm start
```

```bash
# Production with MySQL
export STORAGE_TYPE=mysql
export MYSQL_HOST=mysql.example.com
export MYSQL_DATABASE=voltchat
export MYSQL_USER=voltchat
export MYSQL_PASSWORD=your_password
npm start
```

```bash
# Production with PostgreSQL
export STORAGE_TYPE=postgres
export POSTGRES_HOST=postgres.example.com
export POSTGRES_DATABASE=voltchat
export POSTGRES_USER=voltchat
export POSTGRES_PASSWORD=your_password
npm start
```

```bash
# Production with MongoDB
export STORAGE_TYPE=mongodb
export MONGODB_HOST=mongodb.example.com
export MONGODB_DATABASE=voltchat
export MONGODB_USER=voltchat
export MONGODB_PASSWORD=your_password
npm start
```

```bash
# Production with CockroachDB (distributed)
export STORAGE_TYPE=cockroachdb
export POSTGRES_HOST=crdb.example.com
export POSTGRES_DATABASE=voltchat
export POSTGRES_USER=voltchat
export POSTGRES_PASSWORD=your_password
npm start
```

---

## Config Loader API

The config module provides programmatic access to configuration.

### Importing

```javascript
import { config } from './config/config.js'
```

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `config.get(key)` | any | Get config value by dot-notation key |
| `config.set(key, value)` | void | Set config value |
| `config.load()` | Config | Force reload config |
| `config.save()` | boolean | Save current config to file |
| `config.reset()` | void | Reset to defaults |

### Helper Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `config.isMainline()` | boolean | Check if mainline mode |
| `config.isSelfVolt()` | boolean | Check if self-volt mode |
| `config.isOAuthEnabled()` | boolean | Check if OAuth enabled |
| `config.isLocalAuthEnabled()` | boolean | Check if local auth enabled |
| `config.isRegistrationAllowed()` | boolean | Check if registration allowed |
| `config.getServerUrl()` | string | Get server URL |
| `config.getImageServerUrl()` | string | Get image server URL |
| `config.getStorageConfig()` | object | Get storage config |
| `config.isCdnEnabled()` | boolean | Check if CDN enabled |
| `config.getCdnConfig()` | object | Get CDN config |
| `config.isCacheEnabled()` | boolean | Check if cache enabled |
| `config.getCacheConfig()` | object | Get cache config |
| `config.isQueueEnabled()` | boolean | Check if queue enabled |
| `config.getQueueConfig()` | object | Get queue config |
| `config.getRateLimit()` | object | Get rate limit config |
| `config.getLimits()` | object | Get limits config |
| `config.getLoggingConfig()` | object | Get logging config |
| `config.getMonitoringConfig()` | object | Get monitoring config |

### Usage Examples

```javascript
// Get specific values
const serverUrl = config.get('server.url')
const storageType = config.get('storage.type')

// Check features
if (config.isVoiceEnabled()) {
  // Voice channels are enabled
}

// Get complex configs
const storage = config.getStorageConfig()
const cdn = config.getCdnConfig()
```

---

## Complete Config Example

### Mainline (Production)

```json
{
  "server": {
    "name": "VoltChat",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "https://voltchatapp.your-domain.com",
    "imageServerUrl": "https://cdn.your-domain.com",
    "port": 5000
  },
  "branding": {
    "logo": "https://cdn.your-domain.com/logo.png",
    "primaryColor": "#5865f2",
    "accentColor": "#7289da"
  },
  "storage": {
    "type": "sqlite",
    "sqlite": {
      "dbPath": "./data/voltage.db"
    }
  },
  "cdn": {
    "enabled": true,
    "provider": "s3",
    "s3": {
      "bucket": "volt-media",
      "region": "us-east-1",
      "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
      "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "publicUrl": "https://cdn.your-domain.com"
    }
  },
  "cache": {
    "enabled": true,
    "provider": "redis",
    "redis": {
      "host": "localhost",
      "port": 6379,
      "db": 0
    }
  },
  "queue": {
    "enabled": true,
    "provider": "redis",
    "redis": {
      "host": "localhost",
      "port": 6379,
      "db": 1
    }
  },
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": false,
      "minPasswordLength": 8
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica",
      "enclica": {
        "clientId": "app_your_client_id"
      }
    }
  },
  "security": {
    "jwtSecret": "CHANGE_ME_TO_SECURE_RANDOM_STRING",
    "jwtExpiry": "7d",
    "bcryptRounds": 12,
    "rateLimit": {
      "windowMs": 60000,
      "maxRequests": 100
    }
  },
  "federation": {
    "enabled": false
  },
  "features": {
    "discovery": true,
    "selfVolt": true,
    "voiceChannels": true,
    "videoChannels": true,
    "e2eEncryption": true,
    "communities": true,
    "threads": true
  },
  "limits": {
    "maxUploadSize": 10485760,
    "maxServersPerUser": 100,
    "maxMessageLength": 4000
  },
  "logging": {
    "level": "info",
    "format": "json",
    "outputs": ["console"]
  },
  "monitoring": {
    "enabled": true,
    "prometheus": true,
    "healthCheckPath": "/health"
  }
}
```

### Self-Volt (Self-Hosted)

```json
{
  "server": {
    "name": "My Volt Server",
    "version": "1.0.0",
    "mode": "self-volt",
    "url": "https://chat.mydomain.com",
    "port": 5000
  },
  "storage": {
    "type": "sqlite",
    "sqlite": {
      "dbPath": "./data/voltage.db"
    }
  },
  "auth": {
    "type": "local",
    "local": {
      "enabled": true,
      "allowRegistration": true,
      "minPasswordLength": 8,
      "passwordRequirements": {
        "requireUppercase": true,
        "requireNumbers": true,
        "requireSymbols": false
      }
    },
    "oauth": {
      "enabled": false
    }
  },
  "security": {
    "jwtSecret": "CHANGE_ME_TO_SECURE_RANDOM_STRING",
    "jwtExpiry": "7d",
    "bcryptRounds": 12
  },
  "features": {
    "discovery": false,
    "selfVolt": true,
    "voiceChannels": true,
    "videoChannels": true,
    "e2eEncryption": true
  }
}
```

### MySQL Production

```json
{
  "server": {
    "name": "VoltChat",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "https://voltchatapp.your-domain.com",
    "port": 5000
  },
  "storage": {
    "type": "mysql",
    "mysql": {
      "host": "mysql.example.com",
      "port": 3306,
      "database": "voltchat",
      "user": "voltchat",
      "password": "your_secure_password",
      "connectionLimit": 10,
      "charset": "utf8mb4"
    }
  },
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": false
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica",
      "enclica": {
        "clientId": "app_your_client_id"
      }
    }
  },
  "security": {
    "jwtSecret": "CHANGE_ME_TO_SECURE_RANDOM_STRING",
    "jwtExpiry": "7d",
    "bcryptRounds": 12
  },
  "features": {
    "discovery": true,
    "selfVolt": true,
    "voiceChannels": true,
    "videoChannels": true,
    "e2eEncryption": true
  }
}
```

### PostgreSQL Production

```json
{
  "server": {
    "name": "VoltChat",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "https://voltchatapp.your-domain.com",
    "port": 5000
  },
  "storage": {
    "type": "postgres",
    "postgres": {
      "host": "postgres.example.com",
      "port": 5432,
      "database": "voltchat",
      "user": "voltchat",
      "password": "your_secure_password",
      "ssl": true
    }
  },
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": false
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica"
    }
  },
  "security": {
    "jwtSecret": "CHANGE_ME_TO_SECURE_RANDOM_STRING",
    "jwtExpiry": "7d",
    "bcryptRounds": 12
  },
  "features": {
    "discovery": true,
    "selfVolt": true,
    "voiceChannels": true,
    "videoChannels": true,
    "e2eEncryption": true
  }
}
```

### MongoDB Production

```json
{
  "server": {
    "name": "VoltChat",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "https://voltchatapp.your-domain.com",
    "port": 5000
  },
  "storage": {
    "type": "mongodb",
    "mongodb": {
      "host": "mongodb.example.com",
      "port": 27017,
      "database": "voltchat",
      "user": "voltchat",
      "password": "your_secure_password",
      "authSource": "admin"
    }
  },
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": false
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica"
    }
  },
  "security": {
    "jwtSecret": "CHANGE_ME_TO_SECURE_RANDOM_STRING",
    "jwtExpiry": "7d",
    "bcryptRounds": 12
  },
  "features": {
    "discovery": true,
    "selfVolt": true,
    "voiceChannels": true,
    "videoChannels": true,
    "e2eEncryption": true
  }
}
```

### CockroachDB (Distributed)

```json
{
  "server": {
    "name": "VoltChat",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "https://voltchatapp.your-domain.com",
    "port": 5000
  },
  "storage": {
    "type": "cockroachdb",
    "cockroachdb": {
      "host": "crdb.example.com",
      "port": 26257,
      "database": "voltchat",
      "user": "voltchat",
      "password": "your_secure_password",
      "ssl": true
    }
  },
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": false
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica"
    }
  },
  "security": {
    "jwtSecret": "CHANGE_ME_TO_SECURE_RANDOM_STRING",
    "jwtExpiry": "7d",
    "bcryptRounds": 12
  },
  "features": {
    "discovery": true,
    "selfVolt": true,
    "voiceChannels": true,
    "videoChannels": true,
    "e2eEncryption": true
  }
}
```

### MariaDB Production

```json
{
  "server": {
    "name": "VoltChat",
    "version": "1.0.0",
    "mode": "mainline",
    "url": "https://voltchatapp.your-domain.com",
    "port": 5000
  },
  "storage": {
    "type": "mariadb",
    "mariadb": {
      "host": "mariadb.example.com",
      "port": 3306,
      "database": "voltchat",
      "user": "voltchat",
      "password": "your_secure_password",
      "connectionLimit": 10
    }
  },
  "auth": {
    "type": "all",
    "local": {
      "enabled": true,
      "allowRegistration": false
    },
    "oauth": {
      "enabled": true,
      "provider": "enclica"
    }
  },
  "security": {
    "jwtSecret": "CHANGE_ME_TO_SECURE_RANDOM_STRING",
    "jwtExpiry": "7d",
    "bcryptRounds": 12
  },
  "features": {
    "discovery": true,
    "selfVolt": true,
    "voiceChannels": true,
    "videoChannels": true,
    "e2eEncryption": true
  }
}
```

---

## Troubleshooting

### Config Not Loading

1. Check `backend/config.json` exists
2. Verify JSON syntax (no trailing commas)
3. Check file permissions

### Environment Variables Not Working

1. Ensure variables are exported before starting
2. Restart server after changes
3. Check for typos in variable names

### Redis Connection Failed

1. Verify Redis is running: `redis-cli ping`
2. Check firewall rules
3. Verify host/port in config

### CDN Not Working

1. Check provider is enabled
2. Verify credentials
3. Check bucket permissions

### Database Connection Issues

#### MySQL/MariaDB

1. Verify database exists: `mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS voltchat"`
2. Check user permissions: `GRANT ALL PRIVILEGES ON voltchat.* TO 'voltchat'@'localhost'`
3. Test connection: `mysql -u voltchat -p voltchat`

#### PostgreSQL

1. Verify database exists: `psql -U postgres -c "CREATE DATABASE voltchat"`
2. Check user: `psql -U postgres -c "CREATE USER voltchat WITH PASSWORD 'password'"`
3. Test connection: `psql -U voltchat -d voltchat`

#### MongoDB

1. Verify MongoDB is running: `mongosh --eval "db.version()"`
2. Check authentication
3. Test connection: `mongosh "mongodb://voltchat:password@localhost:27017/voltchat"`

#### CockroachDB

1. Verify cluster is running: `cockroach sql --host=localhost:26257 -e "SHOW DATABASES"`
2. Check SSL certificates if using SSL
3. Test connection: `cockroach sql --host=crdb.example.com:26257 -d voltchat`

### Migration Between Databases

Use the built-in migration scripts to migrate between storage types:

```bash
# JSON to SQLite
npm run migrate -- json-to-sqlite ./data ./data/voltage.db

# JSON to MySQL
# Export JSON, then import to MySQL manually
```
