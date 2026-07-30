# RMMX5 browser worker

Fetches record-site pages with real Chrome and returns the rendered HTML to the
CRM. Needed because the CRM's cloud host cannot run Chrome, while arrests.org
(and any future `needs_browser` site) blocks every non-browser TLS fingerprint.

The worker holds **no CRM credentials** — only a shared secret. The CRM sends it
URLs; it sends back HTML. Nothing else crosses the wire.

## VPS setup (Ubuntu 22.04/24.04, ~15 minutes)

A 2 GB RAM VPS is comfortable; 1 GB works with swap enabled.

```bash
# 1. Node (current LTS; the worker needs nothing newer than Node 18)
sudo apt update && sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Chrome (the official .deb pulls in every system library it needs)
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb

# 3. A non-root user to run it (keeps Chrome's sandbox on)
sudo useradd -r -m -s /usr/sbin/nologin rmmx-worker
sudo mkdir -p /opt/rmmx-browser-worker
sudo cp server.mjs /opt/rmmx-browser-worker/
cd /opt/rmmx-browser-worker
sudo npm init -y && sudo npm install puppeteer-core
sudo chown -R rmmx-worker:rmmx-worker /opt/rmmx-browser-worker

# 4. Generate the shared secret (save it — the CRM needs the same value)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create `/etc/systemd/system/rmmx-browser-worker.service`:

```ini
[Unit]
Description=RMMX5 browser worker
After=network.target

[Service]
User=rmmx-worker
WorkingDirectory=/opt/rmmx-browser-worker
Environment=WORKER_SECRET=PASTE_THE_SECRET_HERE
ExecStart=/usr/bin/node /opt/rmmx-browser-worker/server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rmmx-browser-worker
curl -s localhost:8787/healthz   # → {"ok":true,"chrome":true}
```

## HTTPS in front (required)

The worker binds to `127.0.0.1` on purpose — never expose it directly. Probe
URLs contain client names, so the hop from the CRM must be HTTPS. Caddy gives
you automatic certificates. It is not in Ubuntu's default repos, so add the
official one first:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Point a DNS A record (e.g. `browser.removemymugshot.org`) at the VPS IP **and
wait for it to resolve** (`getent hosts browser.removemymugshot.org` should
return the VPS IP) before reloading Caddy — the certificate is issued over
port 80, so the name must already point here. Then set `/etc/caddy/Caddyfile`
to:

```
browser.removemymugshot.org {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

If you use the `ufw` firewall, allow SSH **before** enabling it or you will lock
yourself out of the box, then open the web ports:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

## Point the CRM at it

Admin → Integrations → **Deep-search browser (headless Chrome)**:

- **Remote worker URL**: `https://browser.removemymugshot.org`
- **Remote worker secret**: the secret from step 4

Within a minute (the availability cache), deep searches resume fetching
browser-only sites — through the worker — with no other change: same budget,
same extraction, same candidate queue.

## Verify

Run a deep search on a contact with a confirmed county and check
Admin → Debug Log: the `browser-only … skipped` warning should be gone and
arrests.org probes should report success. On the VPS,
`journalctl -u rmmx-browser-worker -f` shows each fetch.
