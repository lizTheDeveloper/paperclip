---
name: umami-analytics
description: >
  Query Umami analytics for Multiverse Studios games. PMs get game-scoped views,
  leadership (CEO, CMO, CFO) gets full cross-game analytics. Use when asked about
  traffic, pageviews, events, conversions, or player engagement metrics.
roles: [ceo, cmo, cfo, pm]
---

# Umami Analytics — Multiverse Studios

Query analytics from the self-hosted Umami instance at `https://analytics.multiversestudios.xyz`.

## Authentication

Umami self-hosted uses session tokens. Authenticate at the start of each session:

```bash
# Get credentials from Bitwarden (vault is unlocked)
BW_ITEM=$(bw get item 8454c308-372a-4fe8-a066-116f16a65a9f)
UMAMI_USERNAME=$(echo "$BW_ITEM" | python3 -c "import json,sys; f={x['name']:x['value'] for x in json.load(sys.stdin)['fields']}; print(f['admin_username'])")
UMAMI_PASSWORD=$(echo "$BW_ITEM" | python3 -c "import json,sys; f={x['name']:x['value'] for x in json.load(sys.stdin)['fields']}; print(f['admin_password'])")

# Login and capture token
UMAMI_TOKEN=$(curl -s -X POST https://analytics.multiversestudios.xyz/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$UMAMI_USERNAME\",\"password\":\"$UMAMI_PASSWORD\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

BASE="https://analytics.multiversestudios.xyz"
WID="38d680a7-28d1-42fd-9fd5-a66702675b88"
```

All subsequent requests use `-H "Authorization: Bearer $UMAMI_TOKEN"`.

**Note:** The Umami instance is only accessible from inside the container (`http://localhost:3000` on the server) for API calls. Use `ssh -i ~/.ssh/hetzner_cto_tycoon root@37.27.36.108 "docker exec umami curl -s ..."` if the public API returns 504.

## Instance Details

| Field | Value |
|-------|-------|
| Public URL | `https://analytics.multiversestudios.xyz` |
| Internal URL | `http://localhost:3000` (via `docker exec umami curl ...` on server) |
| Website ID | `38d680a7-28d1-42fd-9fd5-a66702675b88` |
| Bitwarden Item | `Umami Analytics - Agent Credentials` (id: `8454c308-372a-4fe8-a066-116f16a65a9f`) |

## Agent Scope & Credentials

Your Umami account and analytics scope depends on your role:

### Leadership — Full Access

| Agent | Umami Username | Bitwarden Field |
|-------|---------------|-----------------|
| **Puck (CEO)** | `admin` | `admin_password` |
| **Morgan (CMO)** | `admin` | `admin_password` |
| **Brad (CFO)** | `brad-analytics` | `brad-analytics_password` |

### PMs — Game-Scoped Access

| PM Agent | Umami Username | Bitwarden Field | Games | URL filters |
|----------|---------------|-----------------|-------|-------------|
| **Ripley** | `ripley` | `ripley_password` | Never Ever Land | `/neverland/`, `/nevereverland`, `/play/neverland/` |
| **Equinox** | `mvee-pm` | `mvee-pm_password` | MVEE | `/mvee/`, `/play/mvee/` |
| **Bob** | `admin` | `admin_password` | CotB, Infiniclicker, Folkfork | `/cultures-of-the-belt/`, `/cotb/`, `/play/creatures/` |
| **Avrana Kern** | `research-pm` | `research-pm_password` | Precursors | `/precursors/` |
| **Scheherazade** | `lore` | `lore_password` | Lore / Wiki | `/wiki/` |

When game-scoped, add `&url=/your-path` filter to metrics queries.

## Date Helpers

```bash
NOW=$(python3 -c "import time; print(int(time.time()*1000))")
LAST_7D=$(python3 -c "import time; print(int((time.time()-7*86400)*1000))")
LAST_30D=$(python3 -c "import time; print(int((time.time()-30*86400)*1000))")
```

## Key API Endpoints

### Stats Summary

```bash
curl -s -H "Authorization: Bearer $UMAMI_TOKEN" \
  "$BASE/api/websites/$WID/stats?startAt=$LAST_7D&endAt=$NOW"
# Returns: pageviews, visitors, visits, bounces, totaltime
```

### Pageviews Time Series

```bash
curl -s -H "Authorization: Bearer $UMAMI_TOKEN" \
  "$BASE/api/websites/$WID/pageviews?startAt=$LAST_7D&endAt=$NOW&unit=day"
```

### Metrics (top URLs, referrers, events, etc.)

```bash
# type: url | referrer | browser | os | device | country | event | language | screen
curl -s -H "Authorization: Bearer $UMAMI_TOKEN" \
  "$BASE/api/websites/$WID/metrics?startAt=$LAST_7D&endAt=$NOW&type=url"

# Game-scoped (PM use): filter to your game's path
curl -s -H "Authorization: Bearer $UMAMI_TOKEN" \
  "$BASE/api/websites/$WID/metrics?startAt=$LAST_7D&endAt=$NOW&type=url&url=/mvee"
```

### Custom Events

```bash
curl -s -H "Authorization: Bearer $UMAMI_TOKEN" \
  "$BASE/api/websites/$WID/metrics?startAt=$LAST_7D&endAt=$NOW&type=event"
```

### Active Visitors

```bash
curl -s -H "Authorization: Bearer $UMAMI_TOKEN" "$BASE/api/websites/$WID/active"
```

## Key Custom Events

| Event | Meaning |
|-------|---------|
| `cta-play-nel`, `cta-read-nel` | NEL play/read clicks |
| `cta-play-mvee` | MVEE play clicks |
| `cta-play-cotb` | CotB play clicks |
| `cta-play-precursors` | Precursors play clicks |
| `click-buy-nel`, `click-buy-mvee`, `click-buy-cotb`, `click-buy-precursors` | Support/buy clicks per game |
| `cta-nav-beta-access` | Beta access nav click |

## Reporting Guidelines

1. **Always include the date range** in your report
2. **Compare to prior period** when possible
3. **Highlight notable changes** — traffic spikes, conversion drops, new referral sources
4. **PMs:** Focus on your game's play clicks, engagement, and support conversions
5. **Leadership:** Cross-game comparison and overall site health
6. **Use tables** for structured data; bold key numbers
