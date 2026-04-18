# Lichess AI Bot

A bot that plays chess using a local OpenAI-compatible API endpoint.

## Setup

1. Set environment variables or create a `.env` file from `.env.example`:
   ```bash
   export LICHESS_TOKEN="your-lichess-access-token"
   export BOT_USERNAME="your-bot-username"
   export AI_ENDPOINT="http://localhost:1234/v1"  # default
   export AI_MODEL="qwen/qwen3-coder-next"  # optional
   export AUTO_ACCEPT_CHALLENGES="true"
   export GAME_BLOCKLIST="luPI1SBu"
   ```

2. Get a Lichess access token: https://lichess.org/account/oauth/token/create

3. Run:
   ```bash
   node index.cjs
   ```

## Docker Compose

This project runs in Docker Compose without a Dockerfile. The official Node image is used and the source directory is mounted into `/app`.

```bash
cp .env.example .env
# edit .env
docker compose up -d
docker compose logs -f lichess-bot
```

When running in Docker on Linux, `AI_ENDPOINT` should usually be `http://host.docker.internal:1234/v1` so the container can reach the host LM Studio or OpenAI-compatible server.

Use `GAME_BLOCKLIST` and `GAME_ALLOWLIST` to split games across bot instances. Both are comma-separated game IDs. A blocklist always wins; an allowlist means the bot watches only those games. The Compose default blocks `luPI1SBu` so the original bot can finish that game while the Docker bot handles new games.

AI runtime settings are locked per game in `.game-runtime-config.json` when a watcher starts. Active and resumed games keep their original model/settings; newly started games re-read `.env` and lock the current values.

At game start, the bot posts its locked model/settings and input format to player chat. After each model call, it posts the raw visible model output to chat before parsing the move, so any reasoning text emitted by the local model is visible.

## How it works

- Connects to Lichess event stream
- Auto-accepts incoming challenges when enabled
- Resumes ongoing games on startup, including after container restarts
- Listens for game start events
- Watches multiple games in parallel
- Skips games listed in `GAME_BLOCKLIST`, and can be restricted with `GAME_ALLOWLIST`
- Asks the local AI model for moves when it's your turn
- Makes moves automatically

## Requirements

- Node.js 18+
- Local OpenAI-compatible API server (e.g., LM Studio, Ollama with OpenAI endpoint)
