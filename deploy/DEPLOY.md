# AlephMeets production deployment

This deployment targets the Linux VPS `31.128.33.176`. Create two DNS A records
pointing to that address before starting the stack:

- `meets-api.alephtrade.com` for Fastify, uploads and Socket.IO
- `meets-livekit.alephtrade.com` for LiveKit signaling

Wait until both records resolve to `31.128.33.176`; Caddy cannot obtain the
expected public certificates before DNS propagation completes.

## 1. Prepare the host

Install Docker Engine with the Compose plugin from Docker's Ubuntu repository:

```bash
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"${UBUNTU_CODENAME:-$VERSION_CODENAME}\") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker version
docker compose version
```

Then allow the required ports:

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

### Existing Nginx already owns ports 80/443

Do not stop a shared web server blindly. Remove the failed Caddy container and
publish API/LiveKit signaling on loopback only:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml \
  rm -sf caddy

docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  -f deploy/docker-compose.nginx.yml \
  up -d --build postgres redis livekit api

cp deploy/alephmeets.nginx.conf /etc/nginx/sites-available/alephmeets
ln -sfn /etc/nginx/sites-available/alephmeets \
  /etc/nginx/sites-enabled/alephmeets
nginx -t
systemctl reload nginx
```

Issue certificates with the Nginx Certbot plugin:

```bash
apt-get update
apt-get install -y certbot python3-certbot-nginx
certbot --nginx \
  -d meets-api.alephtrade.com \
  -d meets-livekit.alephtrade.com
```

The override binds `4100` and `7880` to `127.0.0.1`, so they are available to
host Nginx but are not exposed directly to the internet.

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
