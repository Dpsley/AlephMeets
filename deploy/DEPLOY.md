# AlephMeets production deployment

This deployment targets the Linux VPS `31.128.33.176`. Create two DNS A records
pointing to that address before starting the stack:

- `meets-api.alephtrade.com` for Fastify, uploads and Socket.IO
- `meets-livekit.alephtrade.com` for LiveKit signaling

Wait until both records resolve to `31.128.33.176`; Caddy cannot obtain the
expected public certificates before DNS propagation completes.

## 1. Prepare the host

Install Docker Engine with the Compose plugin, then allow the required ports:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp
sudo ufw enable
```

Ports `80/443` are used by Caddy. Port `7881/tcp` and UDP ports
`50000-50100` must reach LiveKit directly; do not proxy them through Caddy.

## 2. Configure secrets

```bash
git clone https://github.com/Dpsley/AlephMeets.git
cd AlephMeets
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Set both public domains and replace every `replace-with-*` value. Useful secret
generators:

```bash
openssl rand -hex 16  # LIVEKIT_API_KEY
openssl rand -hex 32  # LIVEKIT_API_SECRET and CREDENTIAL_ENCRYPTION_KEY
openssl rand -base64 36 | tr -dc 'A-Za-z0-9'  # PostgreSQL password
```

Keep `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` identical for the API and LiveKit.
Keep `CREDENTIAL_ENCRYPTION_KEY` stable: changing it makes saved Exchange
passwords unreadable. Put the IDP keys only in `.env.production`, never in Git.

## 3. Start the stack

```bash
docker compose --env-file .env.production \
  -f docker-compose.production.yml up -d --build

docker compose --env-file .env.production \
  -f docker-compose.production.yml ps

docker compose --env-file .env.production \
  -f docker-compose.production.yml logs -f api caddy livekit
```

The API container applies all PostgreSQL migrations before starting. Caddy
requests and renews TLS certificates automatically after DNS is correct and
ports 80/443 are reachable.

Verify the public endpoint:

```bash
curl https://meets-api.alephtrade.com/health
```

Expected response: `{"status":"ok"}`.

## 4. Build desktop clients for this server

`VITE_API_URL` is compiled into Electron. A package built without it uses
localhost and cannot connect to the VPS.

Windows PowerShell:

```powershell
$env:VITE_API_URL='https://meets-api.alephtrade.com'
npm ci
npm run dist:win -w @aleph/desktop
```

macOS:

```bash
VITE_API_URL=https://meets-api.alephtrade.com npm ci
VITE_API_URL=https://meets-api.alephtrade.com npm run dist:mac -w @aleph/desktop
```

The macOS package must be built on macOS. The repository's GitHub Actions
workflow already uses separate Windows and macOS runners; set the repository
Actions variable `VITE_API_URL` before using it for production artifacts.

## Updates and backups

Deploy an update:

```bash
git pull --ff-only
docker compose --env-file .env.production \
  -f docker-compose.production.yml up -d --build
```

Create a PostgreSQL backup:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T postgres pg_dump -U aleph_meets aleph_meets | gzip \
  > "aleph-meets-$(date +%F-%H%M).sql.gz"
```

Back up the Docker volumes for uploads and Caddy as part of the host backup.

## WebRTC limitation

This compose file exposes LiveKit UDP and ICE/TCP directly. For reliable calls
from restrictive corporate and mobile networks, add a TURN/TLS service or use
LiveKit Cloud. Without TURN, signaling can be healthy while some users still
cannot establish media transport.
