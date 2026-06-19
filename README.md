# AlephMeets

Desktop collaboration app for Windows and macOS: video meetings, calendar,
contacts and team chat.

## Stack

- Electron + React + TypeScript desktop client
- Fastify + Socket.IO API
- PostgreSQL 14+
- LiveKit SFU for audio, video and screen sharing

## Development

1. Copy `.env.example` to `.env` and adjust local settings.
2. Create the PostgreSQL role/database and apply migrations:
   `powershell -ExecutionPolicy Bypass -File scripts/setup-database.ps1`
3. Install dependencies: `npm install`
4. Run the API and desktop app: `npm run dev`

LiveKit is optional for the shell UI, but required to actually join a meeting.
Run it with `docker compose up livekit redis` once Docker Desktop is available.

The local API must keep running while the packaged desktop client is used:
`npm run dev:server`. In production this API and LiveKit belong on shared servers,
not inside each desktop installation.

## Aleph ID authentication

The API uses `https://api.alephtrade.com/id` by default. Configure
`IDP_ENCODE_KEY`, `IDP_DECODE_KEY`, and `IDP_ACCESS_KEY` only in the server
environment. They must never be exposed through `VITE_*` variables or bundled
into Electron. SMS verification is performed by Aleph ID; AlephMeets then issues
opaque access/refresh tokens whose SHA-256 hashes are stored in PostgreSQL.

## Current features

- SMS sign-in through Aleph ID, with encrypted desktop token storage
- Scheduled and instant meetings with LiveKit video/audio/screen sharing
- Zoom-style pre-join screen and conference controls
- Meeting calendar with remote Exchange/OWA synchronization over EWS
- Contacts and presence
- Direct/group conversations over Socket.IO
- File attachments and recorded voice messages
- Windows NSIS and macOS DMG/ZIP build configuration

## Testing a call on one PC

1. Run `npm run dev`. On the sign-in screen, click **Open second window**.
2. Sign in with two different Aleph ID phone numbers. Each window has isolated
   encrypted token storage.
3. Start an instant meeting in the first window and call the second account.
4. Keep the microphone enabled only in the first window. Disable the second microphone before
   joining and listen in headphones to avoid an acoustic feedback loop.
5. Verify that both names appear in the participant grid, the speaking indicator
   reacts, and the second account receives the audio.

LiveKit participant identities must be different in the two windows. Signing in
with the same account twice is unsupported because LiveKit treats participant
identity as unique within a room.

## Exchange / Outlook calendar

Each user configures their own calendar under Settings by entering an OWA or EWS
URL, mailbox email, username, optional Windows domain, password, and Basic/NTLM
authentication mode. An OWA URL such as `https://mail.company.test/owa` is
normalized to `https://mail.company.test/EWS/Exchange.asmx`.

The connection is tested before it is saved. Passwords are encrypted with
AES-256-GCM using `CREDENTIAL_ENCRYPTION_KEY` and are never returned to the
desktop client. The current adapter targets on-premises Exchange with EWS and
Basic/NTLM. Exchange Online requires a future Microsoft OAuth/Graph adapter;
Basic authentication is not supported there.

## Packaging

- Windows: `npm run dist:win -w @aleph/desktop`
- macOS (run on macOS): `npm run dist:mac -w @aleph/desktop`

Unsigned packages are suitable for internal testing. Public distribution still
requires Windows code signing and Apple Developer ID signing/notarization.

## Server deployment

The production Docker stack and VPS instructions are in
[`deploy/DEPLOY.md`](deploy/DEPLOY.md). It includes PostgreSQL, Redis, LiveKit,
Caddy TLS, automatic migrations, persistent uploads and the required WebRTC
firewall ports.

## Workspace

- `apps/desktop` - Electron application
- `apps/server` - central API and real-time messaging service
- `database` - PostgreSQL migrations and development data
