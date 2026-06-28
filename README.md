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

Users whose Aleph ID profile has `department`, or whose email domain is
`alephtrade.com`, also receive contacts from the AD service through the same
Aleph ID service credentials. Configure `AD_CONTOL_SECRET` on the API server for
the AD control string.

## Current features

- SMS sign-in through Aleph ID, with encrypted desktop token storage
- Scheduled and instant meetings with LiveKit video/audio/screen sharing
- Zoom-style pre-join screen and conference controls
- Meeting calendar with remote Exchange/OWA synchronization over EWS
- Contacts and presence
- Direct/group conversations over Socket.IO
- File attachments and recorded voice messages
- Windows NSIS and macOS DMG/ZIP build configuration

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

The first two-way calendar sync starts immediately after the account is saved.
The API server then syncs every enabled Exchange account every five minutes,
including while the desktop client is closed. Connected clients receive a
WebSocket event after a successful sync and refresh their meeting list.

EWS requests originate from the AlephMeets API server, not from the desktop
client. The EWS host must therefore be reachable from the production VPS. A
working Outlook installation on a workstation does not prove server-side EWS
reachability because Outlook can use Autodiscover, MAPI/HTTP, OAuth, a local VPN,
or other network routes unavailable to the VPS.

## Packaging

- Windows: `npm run dist:win -w @aleph/desktop`
- macOS (run on macOS): `npm run dist:mac -w @aleph/desktop`

Unsigned packages are suitable for internal testing. Public distribution still
requires Windows code signing and Apple Developer ID signing/notarization.

## Desktop releases and mandatory updates

Packaged clients check the latest public GitHub Release before opening the main
window. A newer version is mandatory: the user can install it or close the app.
If GitHub cannot be reached, the gate only allows retrying or closing.

Create a release by pushing a semantic version tag from the commit to publish:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The `Build desktop` workflow takes the version from the tag, builds Windows x64
and macOS x64/arm64 packages, and creates the GitHub Release. Do not remove
`latest.yml`, `latest-mac.yml`, installers, ZIP files, or blockmaps from a
release: `electron-updater` needs them together. Tags must always increase the
desktop semantic version.

Production macOS updates require the Apple signing/notarization secrets described
in `.github/workflows/build-desktop.yml`; ad-hoc signatures are only suitable for
internal testing.

## Server deployment

The production Docker stack and VPS instructions are in
[`deploy/DEPLOY.md`](deploy/DEPLOY.md). It includes PostgreSQL, Redis, LiveKit,
Caddy TLS, automatic migrations, persistent uploads and the required WebRTC
firewall ports.

## Workspace

- `apps/desktop` - Electron application
- `apps/server` - central API and real-time messaging service
- `database` - PostgreSQL migrations and development data
