# Volt Activities Integration

This document describes the Discord-like Activities system added to Volt, powered by the standalone `VAS` library.

## What Is Included

- Activity catalog with 6 default activities (from `VAS`).
- Custom Activity Apps that any authenticated user can create.
- OAuth 2.0 authorization code flow for activity apps.
- Realtime sessions for:
  - Voice channels (`contextType = "voice"`)
  - DM/group calls (`contextType = "call"`)
- Session sync through socket events (does not replace or modify WebRTC media paths).
- Optional P2P state/event transport (WebRTC datachannels) with server fallback.

## Backend API

Base path: `/api/activities`

### Catalog and App Management

- `GET /catalog`
  - Returns merged default + custom activity catalog.
- `GET /apps/my`
  - Returns current user apps.
- `POST /apps`
  - Creates a new custom app and linked activity.
  - Returns one-time `clientSecret`.
- `POST /apps/:appId/rotate-secret`
  - Rotates app client secret.
- `POST /publish`
  - Publish a public activity directly (for fast dev onboarding, no app registration required).
- `GET /public`
  - Public custom activities listing.

### OAuth for Activity Apps

- `GET /oauth/authorize`
  - Required query:
    - `client_id`
    - `redirect_uri`
    - `response_type=code`
  - Optional:
    - `scope`
    - `state`
    - `context_type=voice|call`
    - `context_id=<channelId|callId>`
    - `session_id=<activitySessionId>`
    - `format=json` (returns JSON instead of HTTP redirect)

- `POST /oauth/token`
  - JSON body:
    - `grant_type=authorization_code`
    - `client_id`
    - `client_secret`
    - `code`
    - `redirect_uri`

- `GET /oauth/me`
  - Auth header: `Bearer <access_token>`
  - Returns user/app/context claims for the token.

## Socket Events

Client emits:

- `activity:list-catalog`
- `activity:get-sessions` `{ contextType, contextId }`
- `activity:create-session` `{ contextType, contextId, activityId, initialState? }`
- `activity:join-session` `{ sessionId }`
- `activity:leave-session` `{ sessionId }`
- `activity:update-state` `{ sessionId, patch }`
- `activity:emit-event` `{ sessionId, eventType, payload?, cue? }`
- `activity:set-role` `{ sessionId, targetUserId, role }`
- `activity:p2p-announce` `{ sessionId, peerId }`
- `activity:p2p-signal` `{ sessionId, toPeerId, fromPeerId, signal }`
- `activity:p2p-leave` `{ sessionId, peerId }`

Server emits:

- `activity:catalog` `{ items }`
- `activity:sessions` `{ contextType, contextId, sessions }`
- `activity:session-created` `{ contextType, contextId, session }`
- `activity:session-ended` `{ sessionId, contextType, contextId, reason }`
- `activity:state-updated` `{ sessionId, contextType, contextId, updatedBy, state }`
- `activity:event` `{ sessionId, eventType, payload, cue?, emittedBy, timestamp }`
- `activity:p2p-peers` `{ sessionId, peers }`
- `activity:p2p-signal` `{ sessionId, fromPeerId, signal }`
- `activity:error` `{ error }`

## Federation and P2P Notes

- Activities are metadata/state sync only, so existing P2P voice/video transport remains unchanged.
- Activity state can run on direct P2P channels as well; fallback stays server-relay for reliability.
- Activity ownership and OAuth credentials are local to each Volt node.
- Custom apps expose `originHost` and `federated` flags in catalog entries for policy enforcement by clients/bridges.

## Frontend Components

- `VoltApp/src/components/ActivitiesPanel.jsx`
  - Launcher UI used in voice channels and call view.
- `VoltApp/src/sdk/activities-sdk.js`
  - Thin wrapper around `VAS` client SDK.
- `VAS/src/client/vas-sdk.js`
  - Advanced SDK with events, sound cues, roles, P2P mesh.
- `VAS/examples/01-mouse-positions.js` + 9 more examples.
