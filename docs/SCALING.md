# Horizontal Scaling Guide

Running Voltage across multiple VPS servers behind a load balancer (HAProxy, nginx, Cloudflare, etc.).

> **This is not federation.** Federation connects separate, independent Voltage instances. Scaling runs the *same* Voltage instance on multiple servers that all share the same database and behave as one logical service.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [File Storage: Choosing a Strategy](#file-storage-choosing-a-strategy)
4. [Method A — NFS Shared Folder (Recommended for self-hosted)](#method-a--nfs-shared-folder)
5. [Method B — Peer-Proxy (Software fallback, no extra infrastructure)](#method-b--peer-proxy)
6. [Method C — Object Storage CDN (Best for large deployments)](#method-c--object-storage-cdn)
7. [Shared Database Setup](#shared-database-setup)
8. [Socket.IO Cross-Node (Redis Adapter)](#socketio-cross-node-redis-adapter)
9. [HAProxy Configuration](#haproxy-configuration)
10. [Voltage config.json Setup](#voltage-configjson-setup)
11. [Admin Cluster Dashboard](#admin-cluster-dashboard)
12. [Firewall / Port Reference](#firewall--port-reference)
13. [Troubleshooting](#troubleshooting)

---

## Overview

```
                     ┌─────────────┐
   Users ──────────► │   HAProxy   │  (or nginx / Cloudflare)
                     └──────┬──────┘
               ┌────────────┼────────────┐
               ▼            ▼            ▼
          ┌─────────┐  ┌─────────┐  ┌─────────┐
          │  VPS-1  │  │  VPS-2  │  │  VPS-3  │
          │Voltage  │  │Voltage  │  │Voltage  │
          │(node-1) │  │(node-2) │  │(node-3) │
          └────┬────┘  └────┬────┘  └────┬────┘
               │            │            │
               └────────────┼────────────┘
                            │
               ┌────────────┼────────────┐
               ▼            ▼            ▼
          ┌─────────┐  ┌─────────┐  ┌─────────┐
          │ MariaDB │  │  Redis  │  │  NFS    │
          │ cluster │  │ (sockets│  │ share   │
          │(shared) │  │  cache) │  │ (files) │
          └─────────┘  └─────────┘  └─────────┘
```

All Voltage nodes:
- Connect to the **same database** (shared truth)
- Connect to the **same Redis** (shared sessions, Socket.IO cross-node events)
- Read/write files to the **same storage** (NFS, S3, or peer-proxy fallback)
- Use an **identical `config.json`** (only `nodeId` and `nodeUrl` differ)

---

## Prerequisites

- 2+ VPS servers running Ubuntu/Debian
- A shared database (MariaDB/MySQL cluster, or a single DB server all nodes point to)
- Redis (can run on the DB server or a dedicated instance)
- HAProxy or nginx as the front-end load balancer
- Private networking between nodes (strongly recommended — use internal IPs for NFS, Redis, and DB connections)

---

## File Storage: Choosing a Strategy

| Method | Effort | Works with SQLite? | Best for |
|--------|--------|--------------------|----------|
| **NFS shared folder** | Low | No (need shared DB) | 2–5 nodes, same datacenter |
| **Peer-proxy** | None (built in) | Yes | 2 nodes, no extra infra |
| **S3 / R2 / object storage** | Medium | No (need shared DB) | Any size, multi-region |

**If you have a CDN (S3, R2, etc.) configured, file routing is irrelevant** — files never touch local disk. The node registry and Socket.IO adapter still apply.

---

## Method A — NFS Shared Folder

All nodes mount a single directory from a Storage Master node. When any node writes a file to `./uploads`, it is immediately visible on every other node because they are all looking at the same physical disk.

**Node.js code does not change.** Voltage writes to `uploadDir` as always; NFS makes that directory the same across all machines.

### Step 1: Storage Master — Install and Export

Run these commands on the server that will host the files (usually your database server or a dedicated storage VPS):

```bash
# Install NFS server
sudo apt update && sudo apt install nfs-kernel-server -y

# Create the shared folder
sudo mkdir -p /www/shared_uploads

# Set ownership (UID 1000 is the default for most non-root users and 1Panel)
sudo chown -R 1000:1000 /www/shared_uploads
sudo chmod 755 /www/shared_uploads
```

Edit `/etc/exports` and add one line per worker node. Use **private/internal IPs** for security:

```
# /etc/exports
/www/shared_uploads  10.0.0.2(rw,sync,no_subtree_check,no_root_squash)
/www/shared_uploads  10.0.0.3(rw,sync,no_subtree_check,no_root_squash)
```

Replace `10.0.0.2` and `10.0.0.3` with your worker nodes' internal IPs.

Apply the changes:

```bash
sudo exportfs -ra
sudo systemctl restart nfs-kernel-server
sudo systemctl enable nfs-kernel-server

# Verify exports are active
sudo exportfs -v
```

### Step 2: Worker Nodes — Mount the Share

Run these commands on **every worker VPS** (not the Storage Master):

```bash
# Install NFS client
sudo apt update && sudo apt install nfs-common -y

# Create the mount point — this is where Voltage will read/write files
# Adjust the path to match your 1Panel site path
sudo mkdir -p /www/sites/volt.yourdomain.com/Voltage/uploads

# Mount the NFS share (replace 10.0.0.1 with your Storage Master's internal IP)
sudo mount 10.0.0.1:/www/shared_uploads /www/sites/volt.yourdomain.com/Voltage/uploads

# Test it: create a file on this node and check it appears on the master
touch /www/sites/volt.yourdomain.com/Voltage/uploads/test-$(hostname).txt
```

### Step 3: Make the Mount Permanent

Add this line to `/etc/fstab` on **each worker node** so the mount survives reboots:

```
# /etc/fstab — add this line
10.0.0.1:/www/shared_uploads  /www/sites/volt.yourdomain.com/Voltage/uploads  nfs  defaults,_netdev  0  0
```

The `_netdev` option tells the OS to wait for networking before mounting, which prevents boot failures.

Verify fstab is correct:

```bash
sudo mount -a
df -h | grep shared_uploads
```

### Step 4: Configure Voltage for NFS

In your `config.json` (same file on all nodes), set the CDN provider to `nfs`:

```json
{
  "cdn": {
    "enabled": true,
    "provider": "nfs",
    "nfs": {
      "uploadDir": "/www/sites/volt.yourdomain.com/Voltage/uploads",
      "baseUrl": null
    }
  }
}
```

> **Using the default `./uploads` path?** If you mounted NFS directly at the default Voltage uploads directory (`Voltage/uploads/`), you can leave `cdn.provider` as `"local"` — the mount makes it shared automatically. The `"nfs"` provider is for when you want to explicitly point at a custom path.

### NFS Permissions Checklist

```bash
# On Storage Master — check permissions
ls -la /www/shared_uploads
# Should show: drwxr-xr-x  owner:1000  group:1000

# On Worker — check mount is writable
touch /www/sites/volt.yourdomain.com/Voltage/uploads/.write_test && echo "Writable" && rm $_

# On Worker — check the Voltage process user can write
# Find the user running Voltage
ps aux | grep node
# If it's running as 'www-data' (UID 33), ownership may need adjusting on the master:
# sudo chown -R 33:33 /www/shared_uploads
```

### NFS Performance Tuning

For better performance under load, you can add mount options in `/etc/fstab`:

```
10.0.0.1:/www/shared_uploads  /path/to/uploads  nfs  rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,_netdev  0  0
```

| Option | Description |
|--------|-------------|
| `rsize=1048576` | Read block size (1 MB) — improves large file reads |
| `wsize=1048576` | Write block size (1 MB) — improves large file writes |
| `hard` | Retry indefinitely if server is temporarily unreachable |
| `timeo=600` | Timeout before retry (60 seconds) |
| `sync` (server-side) | Write to disk before acknowledging — safest, slightly slower |
| `async` (server-side) | Acknowledge before writing — faster, small risk of data loss on crash |

---

## Method B — Peer-Proxy

No extra infrastructure required. Built into Voltage. When a node receives a request for a file it doesn't have locally, it asks the other nodes and either proxies or redirects the client to the node that has it.

This method is **already active** when `scaling.enabled = true`. No additional setup beyond the config block described in [Voltage config.json Setup](#voltage-configjson-setup).

**When to use this:**
- You only have 2 nodes
- You don't want to set up NFS
- Files are small and infrequently accessed across nodes

**Limitations:**
- Every file request that hits the "wrong" node adds a round-trip to a peer
- If the peer node is down, the file is temporarily unavailable
- Not suitable as the sole strategy for high-traffic deployments

### File Resolution Modes

Set `scaling.fileResolutionMode` in `config.json`:

| Mode | Behavior | Best for |
|------|----------|----------|
| `"proxy"` | This node fetches the file from the peer and streams it to the client. The peer URL is never exposed. | Production, keep topology private |
| `"redirect"` | This node sends a 302 redirect to the peer node's direct URL. Faster (one fewer hop) but exposes peer URLs to clients. | Internal networks where peer URLs are reachable by clients |

---

## Method C — Object Storage CDN

Configure `cdn.provider` as `"s3"` or `"cloudflare"` in `config.json`. All nodes upload to and serve files from the same bucket. No local file routing is needed at all.

See the [CDN section in CONFIG.md](CONFIG.md#cdn-section) for full setup.

This is the **best option** for:
- Large-scale deployments
- Multi-region setups
- High-bandwidth file serving

---

## Shared Database Setup

All nodes must point to the **same database**. Do not use SQLite for multi-node — it is a single-file database and cannot be safely shared over NFS.

### Recommended: MariaDB with Galera Cluster

Galera provides synchronous multi-master replication. Any node can write to any DB node and it replicates in real time.

Basic Galera setup (3-node example):

```bash
# Install on all DB nodes
sudo apt install mariadb-server mariadb-backup galera-4 -y
```

`/etc/mysql/mariadb.conf.d/60-galera.cnf` (on each DB node):

```ini
[mysqld]
binlog_format=ROW
default-storage-engine=innodb
innodb_autoinc_lock_mode=2
bind-address=0.0.0.0

# Galera provider
wsrep_on=ON
wsrep_provider=/usr/lib/galera/libgalera_smm.so
wsrep_cluster_name="volt_cluster"
wsrep_cluster_address="gcomm://10.0.0.10,10.0.0.11,10.0.0.12"
wsrep_node_address="10.0.0.10"   # Change per node
wsrep_node_name="db-node-1"      # Change per node
wsrep_sst_method=rsync
```

### Alternative: Single DB + HAProxy DB Proxy

Simpler setup: one MariaDB/MySQL/PostgreSQL server, all Voltage nodes connect to it directly (use internal IP). Add ProxySQL or HAProxy in front of it for connection pooling.

```json
{
  "storage": {
    "type": "mariadb",
    "mariadb": {
      "host": "10.0.0.10",
      "port": 3306,
      "database": "voltchat",
      "user": "voltchat",
      "password": "your_secure_password",
      "connectionLimit": 10
    }
  }
}
```

---

## Socket.IO Cross-Node (Redis Adapter)

Socket.IO rooms only work within a single process by default. Without the Redis adapter, a message emitted on a socket connected to node-1 won't reach a socket connected to node-2.

Voltage automatically attaches the `@socket.io/redis-adapter` when Redis is available. No extra configuration is needed — just make sure Redis is configured and reachable:

```json
{
  "cache": {
    "enabled": true,
    "provider": "redis",
    "redis": {
      "host": "10.0.0.20",
      "port": 6379,
      "password": "your_redis_password",
      "db": 0
    }
  }
}
```

The server logs `[Socket.IO] Redis adapter attached` on startup when this is active.

**What this enables:**
- A user on node-1 receives a message sent by a user on node-2
- Typing indicators work across nodes
- Voice channel events propagate to all nodes
- User status (online/offline) is consistent cluster-wide

---

## HAProxy Configuration

HAProxy sits in front of all Voltage nodes and distributes incoming connections. Sticky sessions for WebSockets are critical.

```haproxy
# /etc/haproxy/haproxy.cfg

global
    log /dev/log local0
    maxconn 50000
    user haproxy
    group haproxy

defaults
    log     global
    mode    http
    option  httplog
    timeout connect 5s
    timeout client  60s
    timeout server  60s
    timeout tunnel  3600s   # Keep WebSocket tunnels alive

# ── Stats Dashboard ────────────────────────────────────────────────────────────
listen stats
    bind *:8404
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:CHANGE_ME_PASSWORD

# ── Frontend: All Traffic In ──────────────────────────────────────────────────
frontend volt_frontend
    bind *:80
    bind *:443 ssl crt /etc/ssl/certs/your_cert.pem

    # Redirect HTTP → HTTPS
    http-request redirect scheme https unless { ssl_fc }

    # Route Socket.IO to the WebSocket backend (sticky by cookie)
    acl is_websocket path_beg /socket.io
    use_backend volt_websocket if is_websocket

    # Everything else → API backend
    default_backend volt_api

# ── API Backend ───────────────────────────────────────────────────────────────
backend volt_api
    balance leastconn
    option httpchk GET /api/health/live
    http-check expect status 200

    server node1 10.0.0.1:5000 check inter 10s rise 2 fall 3
    server node2 10.0.0.2:5000 check inter 10s rise 2 fall 3
    server node3 10.0.0.3:5000 check inter 10s rise 2 fall 3

# ── WebSocket Backend (sticky sessions required) ──────────────────────────────
backend volt_websocket
    balance source          # Hash by client IP — same client always hits same node
    option http-server-close
    option forwardfor

    # Socket.IO requires sticky sessions. Source-IP hashing handles most cases.
    # For clients behind NAT/proxies, use cookie-based stickiness instead:
    # cookie VOLT_NODE insert indirect nocache
    # server node1 10.0.0.1:5000 check cookie node1
    # server node2 10.0.0.2:5000 check cookie node2

    timeout tunnel 3600s    # Keep WebSocket connections open for up to 1 hour

    server node1 10.0.0.1:5000 check inter 10s rise 2 fall 3
    server node2 10.0.0.2:5000 check inter 10s rise 2 fall 3
    server node3 10.0.0.3:5000 check inter 10s rise 2 fall 3
```

> **Why sticky sessions for WebSockets?**
> HTTP is stateless; HAProxy can send each request to any node. WebSocket connections are stateful — they hold an open TCP connection. If a WebSocket reconnects and lands on a different node, Socket.IO must re-establish the session. With the Redis adapter this still works, but sticky sessions reduce unnecessary reconnection churn.

### Health Check Endpoints

Voltage exposes these endpoints for HAProxy / other load balancers:

| Endpoint | Returns | Use |
|----------|---------|-----|
| `GET /api/health/live` | `200 {"alive":true}` | Liveness — is the process alive? |
| `GET /api/health/ready` | `200 {"ready":true}` | Readiness — is the process ready to serve traffic? |
| `GET /api/health` | Full status JSON | Detailed health + scaling info |

---

## Voltage config.json Setup

Every node gets an **identical `config.json`** with two exceptions: `scaling.nodeId` and `scaling.nodeUrl`. Everything else — database, Redis, JWT secret, features — must be the same.

### Minimal scaling block (add to your existing config.json):

```json
{
  "scaling": {
    "enabled": true,
    "nodeSecret": "CHANGE_ME_USE_OPENSSL_RAND_HEX_32",
    "nodeId": "node-1",
    "nodeUrl": "http://10.0.0.1:5000",
    "nodes": [
      { "id": "node-1", "url": "http://10.0.0.1:5000" },
      { "id": "node-2", "url": "http://10.0.0.2:5000" },
      { "id": "node-3", "url": "http://10.0.0.3:5000" }
    ],
    "heartbeatInterval": 30000,
    "heartbeatTimeout": 90000,
    "fileResolutionMode": "proxy"
  }
}
```

**What changes per node:**

| Field | node-1 | node-2 | node-3 |
|-------|--------|--------|--------|
| `scaling.nodeId` | `"node-1"` | `"node-2"` | `"node-3"` |
| `scaling.nodeUrl` | `"http://10.0.0.1:5000"` | `"http://10.0.0.2:5000"` | `"http://10.0.0.3:5000"` |

Use **internal IPs** for `nodeUrl` — node-to-node communication never needs to go through HAProxy or the public internet.

**Generate a nodeSecret:**

```bash
openssl rand -hex 32
```

All nodes must use the **same value** for `nodeSecret`.

### Full example config.json for a 2-node NFS setup:

```json
{
  "server": {
    "name": "VoltChat",
    "mode": "mainline",
    "url": "https://volt.yourdomain.com",
    "port": 5000
  },
  "storage": {
    "type": "mariadb",
    "mariadb": {
      "host": "10.0.0.10",
      "port": 3306,
      "database": "voltchat",
      "user": "voltchat",
      "password": "db_password_here",
      "connectionLimit": 10
    }
  },
  "cdn": {
    "enabled": true,
    "provider": "nfs",
    "nfs": {
      "uploadDir": "/www/shared_uploads",
      "baseUrl": null
    }
  },
  "cache": {
    "enabled": true,
    "provider": "redis",
    "redis": {
      "host": "10.0.0.20",
      "port": 6379,
      "password": "redis_password_here",
      "db": 0
    }
  },
  "security": {
    "jwtSecret": "same_jwt_secret_on_all_nodes",
    "jwtExpiry": "7d",
    "bcryptRounds": 12
  },
  "scaling": {
    "enabled": true,
    "nodeSecret": "same_node_secret_on_all_nodes",
    "nodeId": "node-1",
    "nodeUrl": "http://10.0.0.1:5000",
    "nodes": [
      { "id": "node-1", "url": "http://10.0.0.1:5000" },
      { "id": "node-2", "url": "http://10.0.0.2:5000" }
    ],
    "fileResolutionMode": "proxy"
  }
}
```

> Only `nodeId` and `nodeUrl` differ between node-1 and node-2's config files.

---

## Admin Cluster Dashboard

Server owners and admins can view the live cluster status via the API. A dashboard UI component can be built on top of these endpoints.

### Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/scale/ping` | None | Quick liveness check — returns node ID and version |
| `GET /api/scale/admin/status` | Admin | Full cluster status: all nodes, health, file resolution mode |
| `GET /api/scale/admin/nodes` | Admin | Node list with live vs. configured comparison |
| `POST /api/scale/admin/refresh` | Admin | Force an immediate heartbeat pass |

### Example: GET /api/scale/admin/status

```json
{
  "enabled": true,
  "selfNodeId": "node-1",
  "selfNodeUrl": "http://10.0.0.1:5000",
  "fileResolutionMode": "proxy",
  "nodes": [
    {
      "id": "node-1",
      "url": "http://10.0.0.1:5000",
      "label": "node-1",
      "status": "online",
      "last_seen": 1710000000000,
      "isSelf": true
    },
    {
      "id": "node-2",
      "url": "http://10.0.0.2:5000",
      "label": "node-2",
      "status": "online",
      "last_seen": 1710000000000,
      "isSelf": false
    }
  ],
  "summary": {
    "total": 2,
    "online": 2,
    "offline": 0,
    "degraded": 0
  }
}
```

Node statuses:

| Status | Meaning |
|--------|---------|
| `online` | Node responded to heartbeat within the last `heartbeatTimeout` ms |
| `degraded` | Node missed a heartbeat but hasn't yet exceeded `heartbeatTimeout` |
| `offline` | Node hasn't responded for longer than `heartbeatTimeout` ms |

---

## Firewall / Port Reference

### Between Voltage Nodes (internal)

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 5000 | TCP | node ↔ node | Voltage API (peer heartbeat + file-exists checks) |

### Voltage Nodes → Shared Services

| Port | Protocol | Destination | Purpose |
|------|----------|-------------|---------|
| 3306 | TCP | DB server | MariaDB / MySQL |
| 5432 | TCP | DB server | PostgreSQL |
| 6379 | TCP | Redis server | Redis (cache + Socket.IO adapter) |
| 2049 | TCP+UDP | NFS master | NFS file share |
| 111  | TCP+UDP | NFS master | RPC portmapper (required by NFS) |

### Public-Facing (HAProxy → Nodes)

| Port | Protocol | Purpose |
|------|----------|---------|
| 80   | TCP | HTTP (redirect to HTTPS) |
| 443  | TCP | HTTPS + WebSocket (TLS) |
| 8404 | TCP | HAProxy stats dashboard (restrict to admin IPs) |

### 1Panel Firewall Commands

If you're using 1Panel, add rules via the firewall panel or SSH:

```bash
# Allow NFS from worker nodes (run on Storage Master)
sudo ufw allow from 10.0.0.2 to any port 2049
sudo ufw allow from 10.0.0.2 to any port 111
sudo ufw allow from 10.0.0.3 to any port 2049
sudo ufw allow from 10.0.0.3 to any port 111

# Allow Redis from Voltage nodes (run on Redis server)
sudo ufw allow from 10.0.0.1 to any port 6379
sudo ufw allow from 10.0.0.2 to any port 6379
sudo ufw allow from 10.0.0.3 to any port 6379

# Allow MariaDB from Voltage nodes (run on DB server)
sudo ufw allow from 10.0.0.1 to any port 3306
sudo ufw allow from 10.0.0.2 to any port 3306
sudo ufw allow from 10.0.0.3 to any port 3306
```

---

## Troubleshooting

### NFS mount fails on reboot

Check that `_netdev` is in the fstab options and that `nfs-common` is installed:

```bash
sudo apt install nfs-common -y
# Verify fstab entry includes _netdev
grep nfs /etc/fstab
# Force remount
sudo mount -a && df -h
```

### Files still 404 after NFS setup

1. Verify the mount is active: `df -h | grep shared_uploads`
2. Verify Voltage is using the NFS path: `curl http://localhost:5000/api/upload/cdn/status`
3. Check the `uploadDir` in `config.json` matches the mount point exactly
4. Check file permissions: `ls -la /www/shared_uploads`

### Peer-proxy 502 errors

A peer node is being asked for a file but is returning an error. Check:

1. The node is actually online: `curl http://10.0.0.2:5000/api/scale/ping`
2. The `nodeSecret` matches on all nodes
3. The peer can access its own uploads directory

### Socket.IO: messages not reaching users on other nodes

The Redis adapter is not attached. Verify:

1. Redis is running and reachable: `redis-cli -h 10.0.0.20 ping`
2. Voltage logs show `[Socket.IO] Redis adapter attached` at startup
3. The `cache.redis` config points to the shared Redis instance (not localhost)

### Node shows as "offline" in admin dashboard but is running

1. The `nodeUrl` in that node's config may be unreachable from other nodes (check firewall, use internal IPs)
2. The `nodeSecret` may differ between nodes
3. Increase `heartbeatTimeout` if nodes are on slow connections

### "scaling.nodeId is not set" warning

Each node needs a unique `nodeId` in its config. Make sure the value is set and not null:

```json
{
  "scaling": {
    "enabled": true,
    "nodeId": "node-1"
  }
}
```

### NFS performance is slow

- Use internal (private) IPs, not public IPs, for NFS traffic
- Add `rsize=1048576,wsize=1048576` to the fstab mount options
- Consider object storage (S3/R2) for high-traffic file serving instead
