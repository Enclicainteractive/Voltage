# VoltChat End-to-End Encryption (E2EE)

VoltChat implements true end-to-end encryption where the server **never** has access to encryption keys or plaintext message content. All key generation, distribution, and rotation happen on client devices.

## Architecture Overview

```
┌──────────────┐                    ┌──────────────┐
│   Client A   │   (ciphertext)     │   Client B   │
│  (has keys)  │ ──────────────────>│  (has keys)  │
└──────┬───────┘                    └──────┬───────┘
       │                                   │
       │  encrypted key bundles            │
       │  encrypted messages               │
       │                                   │
       ▼                                   ▼
┌─────────────────────────────────────────────────┐
│                  Volt Server                     │
│                                                  │
│  - Stores ONLY opaque ciphertext blobs           │
│  - Stores public key bundles (no private keys)   │
│  - Routes encrypted messages between devices     │
│  - Queues encrypted updates for offline devices  │
│  - Tracks epoch numbers (not key material)       │
│  - NEVER sees plaintext or symmetric keys        │
└─────────────────────────────────────────────────┘
```

## Key Model

### Per-Device Identity Keys

Each device generates its own key pair on first launch:

- **Identity Key Pair** (X25519/Ed25519): Long-term key for device authentication.
- **Signed Pre-Key**: Medium-term key signed by the identity key. Rotated periodically.
- **One-Time Pre-Keys**: Single-use keys consumed during session establishment.

The **public** parts are uploaded to the server. The **private** parts never leave the device.

```javascript
// Client-side key generation (Web Crypto API)
const identityKeyPair = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  true,
  ['deriveBits']
)

const signedPreKey = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  true,
  ['deriveBits']
)

// Upload public keys to server
await fetch('/api/e2e-true/devices/keys', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: myDeviceId,
    identityPublicKey: exportedPublicKey,
    signedPreKey: exportedSignedPreKey,
    signedPreKeySignature: signature,
    oneTimePreKeys: [preKey1, preKey2, preKey3]
  })
})
```

### Pairwise Sessions

Each pair of devices establishes a secure session using ECDH key agreement:

1. Alice fetches Bob's key bundle from the server.
2. Alice performs ECDH with Bob's public keys and her private keys.
3. Both derive a shared secret used for symmetric encryption.
4. This pairwise session is used to deliver **group key updates**, not for regular messages.

### Group Sender Keys

For group/server chats, a **sender key** is used:

- Each member generates a symmetric sender key.
- The sender key is encrypted separately for each member's device using their pairwise session.
- Messages are encrypted once with the sender key (efficient for groups).
- The server only stores opaque encrypted blobs.

## Epoch-Based Key Rotation

### What is an epoch?

An epoch is a version number for the group's cryptographic state. Each key rotation increments the epoch.

```
Epoch 1 → Initial group key
Epoch 2 → Key rotated (member joined)
Epoch 3 → Key rotated (member left)
Epoch 4 → Key rotated (periodic)
```

### When does the epoch advance?

| Event | Action |
|-------|--------|
| Member joins | New key generated, distributed to all members. New member does NOT get old keys (forward secrecy). |
| Member leaves | Key rotated immediately. Removed member does NOT get new key (post-compromise security). |
| Device added | New keys distributed to the new device. |
| Device removed | Key rotated to exclude the device. |
| Periodic rotation | Time-based rotation for extra security. |
| Suspected compromise | Manual rotation triggered by admin. |

### How it works

```
1. Client decides to rotate keys
2. Client generates new sender key
3. Client encrypts the new key for each member's device using pairwise sessions
4. Client uploads encrypted key blobs to server
5. Server stores blobs and notifies all members
6. Each member's device decrypts the new key using their private key
7. Epoch advances
```

### Message format

Every encrypted message includes the epoch number:

```json
{
  "id": "msg_123",
  "channelId": "ch_456",
  "content": "<base64 ciphertext>",
  "encrypted": true,
  "iv": "<base64 initialization vector>",
  "epoch": 3,
  "storage": {
    "cdn": "local",
    "storageNode": "volt.example.com",
    "serverUrl": "https://volt.example.com"
  }
}
```

If a client receives a message with an unknown epoch, it requests the key update from the server's queue.

## Offline Device Handling

### Queued key updates

When a device is offline during a key rotation:

1. The rotating client encrypts the new key for the offline device.
2. The server queues the encrypted key update.
3. When the device comes back online, it fetches all queued updates.
4. Updates are applied in epoch order.
5. Buffered messages are then decryptable.

```javascript
// Client: fetch queued updates on reconnect
socket.on('connect', () => {
  socket.emit('e2e-true:fetch-queued-updates', { deviceId: myDeviceId })
})

socket.on('e2e-true:queued-updates', ({ keyUpdates, messages }) => {
  // Apply key updates in epoch order
  keyUpdates.sort((a, b) => a.epoch - b.epoch)
  for (const update of keyUpdates) {
    const senderKey = await decryptWithPairwiseSession(update.encryptedKeyBlob)
    keyStore.set(update.groupId, update.epoch, senderKey)
  }

  // Decrypt buffered messages
  for (const msg of messages) {
    const key = keyStore.get(msg.groupId, msg.epoch)
    if (key) {
      const plaintext = await decrypt(msg.ciphertext, key)
      displayMessage(plaintext)
    }
  }
})
```

### Multiple rotations while offline

If multiple key rotations happen while a device is offline:

1. All encrypted key updates are queued in order.
2. On reconnect, the device applies them sequentially.
3. Old keys are kept temporarily to decrypt delayed messages.
4. Old keys are discarded after a configurable retention period.

## Device Presence and E2EE

The server tracks device connectivity for routing purposes:

### What the server knows

- Which `(user_id, device_id)` pairs are currently connected (WebSocket session).
- Last-seen timestamps per device.
- Which encrypted payloads are queued per device.

### What the server does NOT know

- Message contents (only ciphertext).
- Encryption keys (only encrypted key blobs).
- Group key epochs contents (only epoch numbers).
- Who is communicating with whom inside encrypted payloads.

### Connection flow

```
1. Device opens WebSocket connection
2. Device authenticates with user token
3. Device registers its identity public key: socket.emit('e2e-true:register-device', {...})
4. Server marks device as online
5. Server delivers any queued encrypted key updates and messages
6. Device applies updates silently (no user interaction needed)
7. On disconnect, server queues future messages for later delivery
```

## Safety Numbers

Safety numbers allow users to verify they are communicating with the right person and not a man-in-the-middle:

```javascript
// Both users compute the same safety number
const safetyNumber = computeSafetyNumber(myIdentityKey, theirIdentityKey)
// Result: "12345 67890 11111 22222 33333 44444 55555 66666"
```

Compare safety numbers out-of-band (in person, phone call, etc.) to verify identity.

If a user's identity key changes (new device, reinstall), safety numbers change and the app shows a notification.

## API Reference

### Device Key Management

```
POST   /api/e2e-true/devices/keys                    Upload device key bundle
GET    /api/e2e-true/devices/keys/:userId/:deviceId   Get device key bundle
GET    /api/e2e-true/devices/:userId                  List user's devices
DELETE /api/e2e-true/devices/:deviceId                Remove device
```

### Group Epoch Management

```
GET    /api/e2e-true/groups/:groupId/epoch            Get current epoch
POST   /api/e2e-true/groups/:groupId/init             Initialize group E2EE
POST   /api/e2e-true/groups/:groupId/advance-epoch    Advance epoch
POST   /api/e2e-true/groups/:groupId/members          Add member
DELETE /api/e2e-true/groups/:groupId/members/:userId   Remove member
GET    /api/e2e-true/groups/:groupId/members          List members
```

### Sender Key Distribution

```
POST   /api/e2e-true/groups/:groupId/sender-keys              Store key for one device
POST   /api/e2e-true/groups/:groupId/sender-keys/distribute   Batch distribute keys
GET    /api/e2e-true/groups/:groupId/sender-keys/:epoch        Fetch keys for my device
```

### Queued Updates

```
GET    /api/e2e-true/queue/key-updates?deviceId=X     Fetch queued key updates
GET    /api/e2e-true/queue/messages?deviceId=X         Fetch queued encrypted messages
```

### Safety Numbers

```
POST   /api/e2e-true/safety-number                    Compute safety number
```

### Socket Events

```
Client → Server:
  e2e-true:register-device        Register device keys
  e2e-true:request-device-keys    Request another device's public keys
  e2e-true:distribute-sender-key  Send encrypted sender key to a device
  e2e-true:fetch-queued-updates   Fetch pending updates on reconnect
  e2e-true:advance-epoch          Request epoch advancement

Server → Client:
  e2e-true:device-registered      Confirmation of device registration
  e2e-true:device-keys            Requested device public keys
  e2e-true:sender-key-available   New sender key available for download
  e2e-true:queued-updates         Queued key updates and messages
  e2e-true:epoch-advanced         Epoch has been advanced
```

## Security Properties

| Property | Guarantee |
|----------|-----------|
| **Confidentiality** | Server never sees plaintext or keys |
| **Forward Secrecy** | Compromising current keys does not reveal past messages |
| **Post-Compromise Security** | Key rotation after compromise restores security |
| **Multi-Device** | Each device has independent keys; compromise of one device does not affect others |
| **Offline Support** | Encrypted updates queued for offline devices |
| **Verifiability** | Safety numbers allow out-of-band identity verification |

## Message Storage Field

Every message includes a `storage` field indicating where attachments and content are stored:

```json
{
  "storage": {
    "cdn": "s3",
    "storageNode": "volt.example.com",
    "serverUrl": "https://volt.example.com"
  }
}
```

This tells the client which CDN/storage backend to use when fetching attachments. For encrypted messages, attachments are encrypted client-side before upload and the `storage` field tells the client where to fetch the ciphertext blob.

## Migration from Legacy E2EE

VoltChat supports both the legacy E2EE system (`/api/e2e/*`) and the true E2EE system (`/api/e2e-true/*`). The legacy system is available for backward compatibility but stores symmetric keys on the server. New deployments should use the true E2EE system exclusively.

To migrate:

1. Enable `e2eTrueEncryption` in your config.
2. Clients register device key bundles via the true E2EE API.
3. Group encryption initializes with the new epoch-based system.
4. Legacy encryption continues to work for existing groups until they are migrated.
