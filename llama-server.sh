#!/bin/bash

PIDFILE=".llama-server.pid"
PORT=2345
HOST=0.0.0.0
LLAMA_SERVER="${HOME}/.local/bin/llama-server"
ENV_FILE="$(dirname "$0")/.env.llama-server"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "llama-server already running (pid $(cat "$PIDFILE"))"
    exit 1
  fi

  if [ -z "$MODEL" ]; then
    echo "Usage: MODEL=/path/to/model.gguf $0 start [extra llama-server args...]"
    exit 1
  fi

  echo "Starting llama-server on port $PORT with model: $MODEL"
  "$LLAMA_SERVER" \
    --model "$MODEL" \
    --port "$PORT" \
    --host "$HOST"\
    --reasoning-budget "${REASONING_BUDGET:-2048}" \
    --ctx-size "${CTX_SIZE:-8192}" \
    "${@}" \
    &

  echo $! > "$PIDFILE"
  echo "Started (pid $!)"
}

stop() {
  if [ ! -f "$PIDFILE" ]; then
    echo "No PID file found; llama-server may not be running"
    exit 1
  fi

  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping llama-server (pid $PID)..."
    kill "$PID"
    rm -f "$PIDFILE"
    echo "Stopped"
  else
    echo "Process $PID not found; removing stale PID file"
    rm -f "$PIDFILE"
  fi
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "llama-server running (pid $(cat "$PIDFILE"))"
  else
    echo "llama-server not running"
  fi
}

case "$1" in
  start)  shift; start "$@" ;;
  stop)   stop ;;
  status) status ;;
  restart) stop; sleep 1; shift; start "$@" ;;
  *)
    echo "Usage: MODEL=/path/to/model.gguf $0 {start|stop|status|restart} [extra args...]"
    exit 1
    ;;
esac
