#!/usr/bin/env bash
# Altare-compatible launcher: runs Hovod services without s6 needing PID 1.
set -Eeuo pipefail
log(){ printf '[hovod-altare] %s\n' "$*"; }
fail(){ log "FATAL: $*" >&2; exit 1; }
export HOVOD_CONTENV_DIR=/run/s6/container_environment
mkdir -p "$HOVOD_CONTENV_DIR"
bash /etc/s6-overlay/scripts/hovod-stage2-hook
for f in "$HOVOD_CONTENV_DIR"/*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  case "$name" in *[!A-Za-z0-9_]*) continue ;; esac
  export "$name=$(cat "$f")"
done
ROLE="${HOVOD_ROLE:-allinone}"
DATA_DIR="${HOVOD_DATA_DIR:-/data}"
MYSQL_DATA_DIR="${MYSQL_DATA_DIR:-$DATA_DIR/mysql}"
REDIS_DIR="${REDIS_DIR:-$DATA_DIR/redis}"
WORK_DIR="${WORK_DIR:-$DATA_DIR/tmp}"
MYSQL_SOCKET="${MYSQL_SOCKET:-/run/mysqld/mysqld.sock}"
start_bg(){ "$@" & LAST_PID=$!; }
WORKER_PID_FILE=/run/hovod-worker.pid
write_worker_pid(){
  if [ -n "${WORKER_PID:-}" ]; then
    printf '%s\n' "$WORKER_PID" > "$WORKER_PID_FILE"
  else
    rm -f "$WORKER_PID_FILE"
  fi
}
stop_all(){
  trap - TERM INT EXIT
  log 'Stopping child processes...'
  for name in API_PID WORKER_PID REDIS_PID DB_PID; do
    pid="${!name:-}"
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  for name in API_PID WORKER_PID REDIS_PID DB_PID; do
    pid="${!name:-}"
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
  rm -f "$WORKER_PID_FILE"
}
trap stop_all TERM INT EXIT
if [ "${HOVOD_EMBEDDED_MARIADB:-0}" = 1 ]; then
  log 'Initializing/verifying embedded MariaDB...'
  bash /usr/local/lib/hovod/mariadb-init.sh
  mkdir -p /run/mysqld; chown mysql:mysql /run/mysqld "$MYSQL_DATA_DIR"
  start_bg mysqld --user=mysql --datadir="$MYSQL_DATA_DIR" --socket="$MYSQL_SOCKET" --bind-address=127.0.0.1 --port=3306
  DB_PID="$LAST_PID"; ready=0
  for _ in $(seq 1 90); do
    if MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-}" mariadb-admin --protocol=socket --socket="$MYSQL_SOCKET" -u root ping --silent >/dev/null 2>&1; then ready=1; break; fi
    kill -0 "$DB_PID" 2>/dev/null || fail 'MariaDB exited during startup'; sleep 1
  done
  [ "$ready" = 1 ] || fail 'MariaDB did not become ready within 90 seconds'; log 'MariaDB ready.'
fi
if [ "${HOVOD_EMBEDDED_REDIS:-0}" = 1 ]; then
  mkdir -p "$REDIS_DIR"; chown -R redis:redis "$REDIS_DIR"
  start_bg runuser -u redis -- redis-server --daemonize no --dir "$REDIS_DIR" --save '60 1' --loglevel warning --bind 127.0.0.1 --port 6379 --maxmemory "${REDIS_MAXMEMORY:-256mb}" --maxmemory-policy noeviction
  REDIS_PID="$LAST_PID"; ready=0
  for _ in $(seq 1 30); do
    if redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then ready=1; break; fi
    kill -0 "$REDIS_PID" 2>/dev/null || fail 'Redis exited during startup'; sleep 1
  done
  [ "$ready" = 1 ] || fail 'Redis did not become ready within 30 seconds'; log 'Redis ready.'
fi
start_role(){
  case "$1" in
    api) log 'Starting API/dashboard...'; cd /app/apps/api; start_bg runuser -u hovod --preserve-environment -- node dist/index.js; API_PID="$LAST_PID" ;;
    worker) log 'Starting FFmpeg worker...'; cd /app/apps/worker; export TMPDIR="$WORK_DIR"; start_bg runuser -u hovod --preserve-environment -- node dist/index.js; WORKER_PID="$LAST_PID"; write_worker_pid ;;
    *) fail "Unsupported role: $1" ;;
  esac
}
case "$ROLE" in
  allinone) start_role api; start_role worker ;;
  api) start_role api ;;
  worker) start_role worker ;;
  *) fail "Invalid HOVOD_ROLE: $ROLE" ;;
esac
log "Launcher active (role=$ROLE, port=${PORT:-3000})."
while true; do
  sleep 2
  if [ -n "${API_PID:-}" ] && ! kill -0 "$API_PID" 2>/dev/null; then wait "$API_PID" 2>/dev/null || true; log 'API exited; restarting...'; start_role api; fi
  if [ -n "${WORKER_PID:-}" ] && ! kill -0 "$WORKER_PID" 2>/dev/null; then wait "$WORKER_PID" 2>/dev/null || true; log 'Worker exited; restarting...'; start_role worker; fi
  if [ -n "${DB_PID:-}" ] && ! kill -0 "$DB_PID" 2>/dev/null; then fail 'MariaDB stopped unexpectedly'; fi
  if [ -n "${REDIS_PID:-}" ] && ! kill -0 "$REDIS_PID" 2>/dev/null; then fail 'Redis stopped unexpectedly'; fi
done
