# Estellebot

HIPAA deep-scan worker for Estelle Digital. A background Node.js service that
claims `hipaa_deep_scans` jobs from Supabase, runs a headless Chromium scan
via Playwright (cookie-consent click, network capture, TLS version, runtime
tracker detection), optionally runs an AI verification pass (Gemini / DeepSeek
/ Ollama), and writes results back to the row.

Horizontally safe — migration 012's atomic `claim_hipaa_deep_scan` RPC
guarantees two replicas will never process the same row.

## What it is

- **Input**: rows in `hipaa_deep_scans` with `status='pending'`
- **Output**: `status='complete'` (with `result` JSONB) or `status='failed'`
- **Transport**: Supabase Realtime wake-up + a 30s interval safety net
- **Failure model**: transient errors release the row; the reaper flips
  stuck rows (>3 min) back to `pending` or `failed` after 3 claim attempts

## Prereqs

- Node.js >= 18
- pnpm
- Supabase project with migration 012 applied (see
  `estelle-tools-platform/supabase/migrations/012_hipaa_deep_scans_claim.sql`)

## Local dev

```bash
cp .env.example .env
# fill in SUPABASE_URL + SUPABASE_SERVICE_KEY (service-role, not anon)
pnpm install
pnpm dev            # tsx watch mode
```

Or with Docker:

```bash
docker compose up --build
```

## Env vars

See `.env.example` for the full list. Minimum:

| Var | Required | Notes |
|-----|----------|-------|
| `SUPABASE_URL` | yes | same project as tools-platform |
| `SUPABASE_SERVICE_KEY` | yes | service-role key (bypasses RLS) |
| `WORKER_CONCURRENCY` | no | default `3` |
| `REAPER_INTERVAL_MS` | no | default `30000` |
| `REAPER_TIMEOUT_MS` | no | default `180000` |
| `GRACEFUL_SHUTDOWN_MS` | no | default `120000` |
| `PORT` | no | `/healthz` port, default `8080` |
| `HIPAA_DEEP_SCAN_ENABLED` | no | kill-switch — set `false` to idle |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` |
| `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` / `OLLAMA_HOST` | no | one enables AI verification; precedence is GEMINI > DEEPSEEK > OLLAMA |

## Deploy

See [`docs/deploy.md`](./docs/deploy.md) for the Fly.io runbook.
Alternative hosts (Railway, plain VPS) are documented there too — the
Dockerfile is fully portable.

## Tests

**Offline suite** — runs everywhere, no network, no DB:

```bash
pnpm test:run
pnpm lint     # = tsc --noEmit
```

**Integration suite** — exercises the real claim + reap RPCs against a
throwaway Supabase project. Skipped by default; opt in by setting env vars:

```bash
export SUPABASE_TEST_URL="https://<throwaway>.supabase.co"
export SUPABASE_TEST_SERVICE_KEY="..."
pnpm test:run
```

Full list of integration env vars is documented in
[`docs/deploy.md`](./docs/deploy.md#testing).

## Observability

- **`/healthz`** (internal, port 8080 by default) returns JSON:

  ```json
  {
    "status": "ok",
    "provider": "gemini-2.5-flash",
    "workerId": "estellebot-1a2b3c4d",
    "activeJobs": 1,
    "uptimeMs": 123456,
    "version": "1.0.0-beta.1",
    "shuttingDown": false
  }
  ```

  During graceful shutdown the endpoint flips to `503` with
  `shuttingDown: true` so Fly's probe stops routing traffic.

- **Structured events** (one JSON object per line on stdout):
  - `worker_boot` — on startup
  - `worker_shutdown` — on SIGTERM/SIGINT completion
  - `scan_started` — when a job is claimed
  - `scan_completed` — on success with duration + score
  - `scan_failed` — on error with `willRetry` flag
  - `scan_reaped` — emitted by the reaper when it releases >0 rows

  Filter in `fly logs`:

  ```bash
  fly logs --app estellebot-staging | grep '"event":"scan_failed"'
  ```

  Events never contain privacy-policy text, AI response text, or raw HTML —
  only IDs, counts, durations, and short error strings.

## User-Agent

Outbound requests identify as:

```
Estellebot/1.0 (+https://estelledigitaldesigns.com/bot)
```
