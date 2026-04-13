---
name: deploy-school
description: How to deploy themultiverse.school (Flask app) to Hetzner via Coolify. Covers branch strategy, deploy guard, Coolify API, secrets, monitoring, and rollback.
roles: [engineer, devops]
---

# Deploy theMultiverse.School (Flask)

## Infrastructure Overview

- **Server:** Hetzner CAX41 ARM, Helsinki — IP `37.27.36.108`
- **PaaS:** Coolify at `http://37.27.36.108:8000`
- **Reverse proxy:** Traefik (managed by Coolify, auto SSL via Let's Encrypt)
- **CDN/DNS:** Cloudflare (Full Strict SSL)
- **Domain:** `themultiverse.school`
- **App:** Python 3.11 / Flask / Gunicorn (2 workers, 2 threads, 120s timeout)
- **Port:** 8080
- **Dockerfile:** `Dockerfile` in repo root

## Coolify Application UUIDs

| Environment | UUID | Auto-deploy? |
|-------------|------|-------------|
| **Production** | `hw4cg4ow40c48os4kcw8wcs8` | No (manual) |
| **Staging** | `d84gg8gwowkgg884kwgwskso` | Yes (push to `production` branch) |

## Shared Services (same Hetzner host)

| Service | UUID |
|---------|------|
| PostgreSQL 16 | `r88oogo8w4k4ooow0ckog808` |
| Redis 7 | `rwwcoggg8k84g840ks0wg4wc` |

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `feature/*`, `fix/*`, `claude/*` | Dev/CI only — never deployed |
| `main` | Integration branch — no auto-deploy |
| `production` | Coolify auto-deploys to **staging**; manual trigger for **production** |

## Deploy Procedure

### 1. Arm the Deploy Guard (REQUIRED before production restart)

The deploy guard suppresses false monitoring alerts during container restart:

```bash
curl -sS -X POST "https://themultiverse.school/internal/monitoring/arm-deploy-guard" \
  -H "X-Deploy-Guard-Secret: $DEPLOY_GUARD_SECRET" \
  -d '{"ttl_seconds": 900}'
```

- Redis key: `monitoring:school_prod_deploy_guard_v1` (TTL ~15 min)
- The secret is in Coolify env vars and Vaultwarden
- Automation script: `scripts/coolify_set_deploy_guard_secret.sh`
- Docs: `docs/MONITORING_DEPLOY_GUARD.md`

### 2. Trigger Production Deploy via Coolify API

```bash
curl -X GET "http://37.27.36.108:8000/api/v1/applications/hw4cg4ow40c48os4kcw8wcs8/restart" \
  -H "Authorization: Bearer 5|myapitoken2026"
```

### 3. Verify Deployment

- **Liveness:** `GET https://themultiverse.school/healthz` (no DB hit)
- **Metrics:** `GET https://themultiverse.school/metrics` (Prometheus, IP-restricted)
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
curl -X POST "http://37.27.36.108:8000/api/v1/applications/hw4cg4ow40c48os4kcw8wcs8/envs" \
  -H "Authorization: Bearer 5|myapitoken2026" \
  -H "Content-Type: application/json" \
  -d '{"key": "ENV_VAR_NAME", "value": "value", "is_build_time": false}'
```

## Secrets Management

- **Vaultwarden** (self-hosted Bitwarden): `https://37.27.36.108:8443`
- User: `liz@themultiverse.school`
- All production secrets are stored as Coolify env vars — never committed to git
- Key secrets: Stripe Live Key, SENSITIVE_DATA_KEY, DEPLOY_GUARD_SECRET, Anthropic API Key, SendGrid, Google Service Account, NATS

## SSH Access

```bash
ssh hetzner          # Main server
ssh hetzner-db       # DB tunnel → localhost:5433
```

SSH config is in `~/.ssh/config`.

## Emergency Hotfix

1. Branch from `production`: `git checkout -b hotfix/description production`
2. Fix, commit, push
3. PR against `production`, get expedited review
4. Arm deploy guard, then deploy via Coolify API
5. Cherry-pick back to `main`

## Rollback

Coolify keeps previous container images. Roll back via the Coolify dashboard at `http://37.27.36.108:8000` — select the previous deployment and redeploy.

## Critical Warnings

- **PostgreSQL and Redis are shared** with Campus — migrations must be additive-only
- **Deploying restarts the container** — all active user sessions persist (Redis-backed) but in-flight requests will fail
- **Redis SSO:** Session key format `school:session:{session_id}`, cookie domain `.themultiverse.school` — if Redis goes down, ~3000 students lose sessions
- **Neon PostgreSQL is legacy** — do NOT use for School; only n8n still uses Neon
- The `app.yaml` file in repo root is a **deprecated GCP artifact** — do not use
