# VoltChat Mainline Federation

Mainline federation allows independent VoltChat servers (mainlines) to communicate with each other, share invite codes, and relay messages across instances.

## Overview

```
┌─────────────────┐         ┌─────────────────┐
│  Mainline A      │ ◄─────►│  Mainline B      │
│  volt-a.com      │  peers  │  volt-b.com      │
│                  │         │                  │
│  Servers: 50     │         │  Servers: 30     │
│  Users: 1000     │         │  Users: 500      │
└─────────────────┘         └─────────────────┘
        │                           │
        └───────────┬───────────────┘
                    │
                    ▼
           Shared Invites
           Relay Messages
           User Discovery
```

## Enabling Federation

In your `config.json`:

```json
{
  "federation": {
    "enabled": true,
    "serverName": "My Volt Instance",
    "allowedServers": [],
    "maxHops": 3
  }
}
```

## Peering with Another Mainline

### Step 1: Request peering

```bash
curl -X POST https://volt-a.com/api/federation/peers \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Volt B",
    "url": "https://volt-b.com"
  }'
```

### Step 2: The other mainline receives the handshake

VoltChat automatically sends a handshake request to the target mainline's `/api/federation/handshake` endpoint.

### Step 3: Accept peering

On the receiving mainline:

```bash
curl -X POST https://volt-b.com/api/federation/peers/PEER_ID/accept \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

### Step 4: Verify connection

Both mainlines exchange periodic heartbeats via `/api/federation/ping`.

```bash
# Check peer status
curl https://volt-a.com/api/federation/peers \
  -H "Authorization: Bearer TOKEN"
```

## Sharing Invite Codes

Share server invites across mainlines so users on one instance can join servers on another:

```bash
# Share an invite with all peers
curl -X POST https://volt-a.com/api/federation/invites/share \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "ABC123",
    "serverId": "server_xyz",
    "serverName": "My Cool Server",
    "maxUses": 100,
    "expiresAt": "2025-12-31T23:59:59Z"
  }'

# Share with a specific peer only
curl -X POST https://volt-a.com/api/federation/invites/share \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "ABC123",
    "serverId": "server_xyz",
    "serverName": "My Cool Server",
    "targetPeerId": "peer_abc"
  }'
```

Users on the other mainline can browse shared invites:

```bash
curl https://volt-b.com/api/federation/invites/public?host=volt-a.com
```

## Relay Messages

Send messages between mainlines for cross-instance communication:

```bash
# Queue a message for a peer
curl -X POST https://volt-a.com/api/federation/relay/PEER_ID \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "announcement",
    "payload": {
      "title": "Server Maintenance",
      "message": "We will be down for 30 minutes tonight."
    }
  }'
```

The target mainline fetches queued messages:

```bash
curl -X POST https://volt-b.com/api/federation/relay/fetch \
  -H "Content-Type: application/json" \
  -d '{"host": "volt-a.com"}'
```

## Federation Info

Any mainline can query another's federation info (public endpoint):

```bash
curl https://volt-a.com/api/federation/info
```

Response:

```json
{
  "host": "volt-a.com",
  "name": "Volt A",
  "version": "1.0.0",
  "mode": "mainline",
  "federationEnabled": true,
  "features": {
    "discovery": true,
    "voiceChannels": true,
    "e2eEncryption": true,
    "bots": true
  },
  "peerCount": 3
}
```

## API Reference

### Peer Management

```
GET    /api/federation/peers                Get all peers
GET    /api/federation/peers/:peerId        Get peer details
POST   /api/federation/peers                Request peering
POST   /api/federation/peers/:peerId/accept Accept peer
POST   /api/federation/peers/:peerId/reject Reject peer
DELETE /api/federation/peers/:peerId        Remove peer
```

### Handshake & Heartbeat

```
POST   /api/federation/handshake            Incoming peering handshake
POST   /api/federation/ping                 Heartbeat from peer
GET    /api/federation/info                 Public federation info
```

### Shared Invites

```
POST   /api/federation/invites/share        Share an invite
GET    /api/federation/invites              List shared invites
GET    /api/federation/invites/public       Public shared invites (for peers)
POST   /api/federation/invites/:id/use      Use a shared invite
DELETE /api/federation/invites/:id          Remove shared invite
```

### Relay Messages

```
POST   /api/federation/relay/:peerId        Queue relay message
POST   /api/federation/relay/fetch          Fetch queued messages (peer)
```

## Security

- Peering uses HMAC-SHA256 signed handshake tokens with shared secrets.
- Tokens expire after 5 minutes to prevent replay attacks.
- Only explicitly accepted peers can exchange data.
- Relay messages are queued and delivered asynchronously.
- No private keys or encryption material is ever shared between mainlines.
- E2EE is preserved end-to-end even across federated mainlines; the server relay only handles ciphertext.
