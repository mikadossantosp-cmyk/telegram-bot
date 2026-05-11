# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is a single-service Node.js monolith (`bot.js`, ~6 400 lines) that runs both:

- **Telegram Bot** (Telegraf) — community gamification bot for Instagram creators
- **Express HTTP API** (port 3000) — REST backend for the companion CreatorBoost web/mobile app

All state is stored in a flat JSON file (default `/data/daten.json`, override with `DATA_FILE` env var).

### Running the application

```bash
BOT_TOKEN=<token> DATA_FILE=/workspace/data/daten.json PORT=3000 node bot.js
```

- `BOT_TOKEN` is **required** — the process exits immediately without it.
- For local/CI testing without a real Telegram token, use a dummy value (e.g. `BOT_TOKEN=dummy:test`). The Express API will start and respond normally; only the Telegram bot connection will fail with a 404 error (safe to ignore).
- Create the data directory first: `mkdir -p /workspace/data`
- The `postinstall` script in `package.json` runs `patch-bot.cjs`, which injects `/addxp`, `/xpadd`, `/givexp`, and `/version` commands into `bot.js`. This modifies `bot.js` in place — keep this in mind when reviewing diffs.

### API authentication

Most API endpoints require the header `x-bridge-secret: geheimer-key` (the default value of `BRIDGE_SECRET`). Without it, endpoints return `{"error":"Forbidden"}`.

### No lint/test infrastructure

There are no ESLint, Prettier, or test framework configurations in this repository. There are no automated tests. Verification is done by starting the server and exercising the API endpoints manually.

### Key env vars

| Variable | Required | Default |
|---|---|---|
| `BOT_TOKEN` | Yes | — |
| `DATA_FILE` | No | `/data/daten.json` |
| `PORT` | No | `3000` |
| `BRIDGE_SECRET` | No | `geheimer-key` |
| `ADMIN_IDS` | No | (empty) |
