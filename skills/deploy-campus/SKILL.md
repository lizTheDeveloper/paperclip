---
name: deploy-campus
description: How to deploy Multiverse Campus (Node.js/React) to Hetzner via Coolify. Covers branch strategy, Coolify API, smoke tests, secrets, monitoring, and rollback.
roles: [engineer, devops]
---

# Deploy Multiverse Campus (Node.js)

## Infrastructure Overview

- **Server:** Hetzner CAX41 ARM, Helsinki — IP `37.27.36.108`
- **PaaS:** Coolify at `http://37.27.36.108:8000`
- **Reverse proxy:** Traefik (managed by Coolify, auto SSL via Let's Encrypt)
- **CDN/DNS:** Cloudflare (Full Strict SSL)
- **Domain:** `campus.themultiverse.school`
- **App:** Node 20 / Express / Socket.IO / React+Vite (multi-stage Docker build)
- **Port:** 4000
- **Dockerfile:** `Dockerfile` in repo root

## Coolify Application UUIDs

| Environment | UUID | Auto-deploy? |
|-------------|------|-------------|
| **Production** | `n00ko8o4ocg4sogwsw4cs4c4` | No (manual) |
| **Staging** | `isgo0gsc0o8gkwkwoowwsw00` | Yes (push to `main` branch) |

## Shared Services (same Hetzner host — shared with School)

| Service | UUID |
|---------|------|
| PostgreSQL 16 | `r88oogo8w4k4ooow0ckog808` |
| Redis 7 | `rwwcoggg8k84g840ks0wg4wc` |

**Database:** Campus uses the `multiversecampus` database with user `campus` on the shared PostgreSQL container.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `feature/*`, `fix/*`, `claude/*` | Dev/CI only — never deployed |
| `main` | Coolify auto-deploys to **staging** |
| `production` | Manual Coolify trigger for **production** |

## Deploy Procedure

### 1. Trigger Production Deploy via Coolify API

```bash
curl -X GET "http://37.27.36.108:8000/api/v1/applications/n00ko8o4ocg4sogwsw4cs4c4/restart" \
  -H "Authorization: Bearer 5|myapitoken2026"
```

### 2. Run Smoke Tests

The campus repo includes smoke tests in `deploy/smoke-test.sh`. These check:
1. Server responds on port 4000
2. Matrix login returns JWT
3. Authenticated API calls work
4. Client assets serve correctly

```bash
# On the server:
cd /path/to/multiversecampus
bash deploy/smoke-test.sh
```

Smoke test credentials are in `deploy/smoke-test.env` (read-only `@smoke_test` Matrix user).

### 3. Verify Deployment

- **Health/Metrics:** `GET https://campus.themultiverse.school/api/metrics?key=<METRICS_API_KEY>` (returns JSON: DB health, Redis health, Groq stats, uptime)
- Check Coolify dashboard at `http://37.27.36.108:8000` for container status
- Check Dozzle logs at `http://37.27.36.108:9999`

### 4. Monitor

| Tool | URL | Purpose |
|------|-----|---------|
| Grafana | `http://37.27.36.108:3003` | Logs + dashboards (Loki) |
| Gatus | `http://37.27.36.108:3002` | Uptime monitoring |
| Dozzle | `http://37.27.36.108:9999` | Live container logs |

## Coolify API Tokens

- **GET operations:** `3|523550...`
- **POST operations (restart, env vars):** `5|myapitoken2026`

### Set Environment Variables via Coolify API

```bash
curl -X POST "http://37.27.36.108:8000/api/v1/applications/n00ko8o4ocg4sogwsw4cs4c4/envs" \
  -H "Authorization: Bearer 5|myapitoken2026" \
  -H "Content-Type: application/json" \
  -d '{"key": "ENV_VAR_NAME", "value": "value", "is_build_time": false}'
```

## Secrets Management

- **Vaultwarden** (self-hosted Bitwarden): `https://37.27.36.108:8443`
- User: `liz@themultiverse.school`
- All production secrets are stored as Coolify env vars — never committed to git
- Key secrets: Campus PostgreSQL, Campus Redis, Stripe Live Key, Stripe Webhook Secret, SendGrid, Anthropic API Key, OpenAI API Key, NATS Credentials

## SSH Access

```bash
ssh hetzner          # Main server
ssh hetzner-db       # DB tunnel → localhost:5433
```

SSH config is in `~/.ssh/config`.

## Alternative Deploy Path (PM2 — legacy/parallel)

The repo also contains a PM2-based deploy path in `deploy/`:

- `deploy-safe.sh` — Pull, build, migrate, PM2 reload with rollback on failure
- `deploy.sh` — Basic deploy without safety checks
- `ecosystem.config.js` — PM2 cluster config (max instances, 1GB memory limit)
- N8N webhook automation in `deploy/n8n-auto-deploy-workflow.json`

**Note:** Coolify (Docker) is the primary deployment mechanism. PM2 scripts are the older path.

## Rollback

Coolify keeps previous container images. Roll back via the Coolify dashboard at `http://37.27.36.108:8000` — select the previous deployment and redeploy.

For PM2 path: `deploy-safe.sh` snapshots pre-deploy state and auto-rolls back on smoke test failure.

## Critical Warnings

- **PostgreSQL and Redis are shared** with School — migrations must be additive-only
- **Deploying restarts the container** — WebSocket connections (Socket.IO) will drop and reconnect
- **LiveKit (WebRTC)** sessions will be interrupted during deploy
- **Campus uses a separate database** (`multiversecampus`) but the **same PostgreSQL container** as School
- Never run destructive migrations without coordinating with the School PM
