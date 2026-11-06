#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Nouride — Development Runner
#
#  Default mode runs a single container supervised by scripts/dev-watch.sh:
#    • Engine    — restarted on source changes
#    • Dashboard — rebuilt on source changes
#  The engine serves the built dashboard at /dashboard/.
#  Changes are detected by polling, because a bind mount from a macOS host does
#  not deliver filesystem events into the Linux VM.
#
#  Usage:
#    ./run-dev.sh              # start dev container
#    ./run-dev.sh native       # run on the host, no Docker
#    ./run-dev.sh down         # tear down container + volumes
#    ./run-dev.sh logs         # tail logs
#    ./run-dev.sh restart      # restart container
#    ./run-dev.sh status       # container status
#
#  `native` exists for the cases Docker makes awkward: pairing a WhatsApp QR
#  code with a phone, attaching a debugger, or working without a daemon running.
# ──────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.dev.yml"

# ── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Pre-flight ───────────────────────────────────────────
check_docker() {
  if ! command -v docker &>/dev/null; then
    log_error "Docker is not installed. Use './run-dev.sh native' to run on the host."
    exit 1
  fi
  if ! docker info &>/dev/null; then
    log_error "Docker daemon is not running."
    exit 1
  fi
  if ! docker compose version &>/dev/null; then
    log_error "Docker Compose v2 is required."
    exit 1
  fi
}

check_bun() {
  if ! command -v bun &>/dev/null; then
    log_error "Bun is not installed — see https://bun.sh"
    exit 1
  fi
}

# ── First-run scaffolding ────────────────────────────────
# The daemon boots on built-in defaults with no config file at all, so this is a
# convenience, not a requirement: it gives you a file to edit rather than a set of
# defaults to discover.
ensure_config() {
  # The whole install, including the shared workspace the prompt names as the working directory —
  # an agent told it is working somewhere that does not exist fails on its first relative path.
  mkdir -p "$SCRIPT_DIR/.nouride/data" "$SCRIPT_DIR/.nouride/agents" \
           "$SCRIPT_DIR/.nouride/workspace/shared" "$SCRIPT_DIR/.nouride/workspace/private"
  if [ ! -f "$SCRIPT_DIR/.nouride/config.toml" ]; then
    cp "$SCRIPT_DIR/config.example.toml" "$SCRIPT_DIR/.nouride/config.toml"
    log_ok "Created .nouride/config.toml from config.example.toml"
  fi
  if [ ! -f "$SCRIPT_DIR/.env" ] && [ -f "$SCRIPT_DIR/.env.example" ]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    log_warn "Created .env from .env.example — fill in your tokens"
  fi
}

ensure_deps() {
  if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    log_warn "node_modules not found. Installing..."
    (cd "$SCRIPT_DIR" && bun install)
  fi
}

banner() {
  echo -e "${BOLD}"
  echo "  ╔═══════════════════════════════════════╗"
  echo "  ║     🌌 Nouride Dev Environment         ║"
  echo "  ╚═══════════════════════════════════════╝"
  echo -e "${NC}"
}

cleanup() {
  echo ""
  log_info "Shutting down container..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans
  log_ok "Dev container stopped."
}

# ── Native mode ──────────────────────────────────────────
run_native() {
  check_bun
  banner
  ensure_config
  ensure_deps

  log_info "Building dashboard once..."
  (cd "$SCRIPT_DIR" && bun run build:dashboard)

  log_info "Engine    → http://localhost:${PORT:-18254}"
  log_info "Dashboard → http://localhost:${PORT:-18254}/dashboard/"
  log_info "Site      → http://localhost:${SITE_PORT:-4321}"
  echo ""
  log_warn "Dashboard is built once here. For HMR on the UI, run 'bun run dev:dashboard'"
  log_warn "in a second terminal (Vite on :18255, proxying /api to the engine)."
  echo ""

  (cd "$SCRIPT_DIR/apps/site" && bun run dev --port "${SITE_PORT:-4321}") &
  local docs_pid=$!
  trap "kill $docs_pid 2>/dev/null || true" EXIT INT TERM

  cd "$SCRIPT_DIR"
  exec bun run --watch apps/engine/src/index.ts
}

# ── Main ─────────────────────────────────────────────────
main() {
  local cmd="${1:-up}"

  case "$cmd" in
    up|start)
      check_docker
      banner
      ensure_config

      log_info "Starting dev container with file watching..."
      log_info "Engine    → http://localhost:${PORT:-18254}"
      log_info "Dashboard → http://localhost:${PORT:-18254}/dashboard/"
      log_info "Site      → http://localhost:${SITE_PORT:-4321}"
      log_info "Health    → http://localhost:${PORT:-18254}/health"
      echo ""
      log_info "Engine    restarts on source changes"
      log_info "Dashboard rebuilds on source changes"
      log_info "Docs      hot-reloads on content changes"
      echo ""

      trap cleanup EXIT INT TERM

      docker compose -f "$COMPOSE_FILE" up \
        --build \
        --remove-orphans \
        --force-recreate
      ;;

    native|host)
      run_native
      ;;

    down|stop)
      check_docker
      log_info "Tearing down dev container..."
      docker compose -f "$COMPOSE_FILE" down --remove-orphans --volumes
      log_ok "Dev container and volumes removed."
      ;;

    logs)
      check_docker
      docker compose -f "$COMPOSE_FILE" logs -f --tail=100
      ;;

    restart)
      check_docker
      log_info "Restarting dev container..."
      docker compose -f "$COMPOSE_FILE" restart
      log_ok "Restarted."
      ;;

    status|ps)
      check_docker
      docker compose -f "$COMPOSE_FILE" ps
      ;;

    *)
      echo -e "${BOLD}Usage:${NC} $0 {up|native|down|logs|restart|status}"
      echo ""
      echo "  up, start     Start dev container (default)"
      echo "  native, host  Run on the host without Docker"
      echo "  down, stop    Tear down container and volumes"
      echo "  logs          Tail container logs"
      echo "  restart       Restart container"
      echo "  status, ps    Show container status"
      exit 1
      ;;
  esac
}

main "$@"
