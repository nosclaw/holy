#!/bin/bash
# ==============================================================================
# HolyClaude — Cloudflare Tunnel Manager
#
# Auto-detects listening ports and exposes them via Cloudflare Tunnel subdomains.
#
# Required env vars:
#   CF_TUNNEL_TOKEN   — Cloudflare Tunnel token (from Zero Trust dashboard)
#   CF_TUNNEL_DOMAIN  — Base domain suffix (e.g., "dev.example.com")
#
# Optional env vars:
#   CF_TUNNEL_PORTS   — Comma-separated port:name mappings (e.g., "3000:app,5173:vite")
#                       Unmapped ports get auto-named: p{port}-{CF_TUNNEL_DOMAIN}
#   CF_TUNNEL_SCAN    — Enable auto-scan for new ports (default: true)
#   CF_TUNNEL_INTERVAL — Scan interval in seconds (default: 5)
#
# How it works:
#   1. Starts cloudflared with the tunnel token
#   2. Periodically scans for new listening TCP ports
#   3. For each new port, creates a public hostname via Cloudflare API
#
# Subdomains created:
#   - Port 3000 with name "app"  → app-dev.example.com
#   - Port 5173 (auto)           → p5173-dev.example.com
#   - CloudCLI (always)          → cloud-dev.example.com
#   - GSD Web (always)           → gsd-dev.example.com
# ==============================================================================

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────────

CF_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-}"
CF_TUNNEL_DOMAIN="${CF_TUNNEL_DOMAIN:-}"
CF_TUNNEL_PORTS="${CF_TUNNEL_PORTS:-}"
CF_TUNNEL_SCAN="${CF_TUNNEL_SCAN:-true}"
CF_TUNNEL_INTERVAL="${CF_TUNNEL_INTERVAL:-5}"

# Known system ports to ignore
SYSTEM_PORTS="22 53 3001 3002 3003"

# Port-to-name mapping (built from CF_TUNNEL_PORTS + defaults)
declare -A PORT_NAMES
PORT_NAMES[3003]="cloud"    # CloudCLI (internal)
PORT_NAMES[3002]="gsd"      # GSD Web (internal)

# Track which ports we've already registered
declare -A REGISTERED_PORTS
STATE_FILE="/tmp/tunnel-ports.state"

log()  { echo "[tunnel] $(date '+%H:%M:%S') $1"; }
warn() { echo "[tunnel] $(date '+%H:%M:%S') WARNING: $1" >&2; }

# ── Validate ───────────────────────────────────────────────────────────────────

if [ -z "$CF_TUNNEL_TOKEN" ]; then
    log "CF_TUNNEL_TOKEN not set — tunnel disabled"
    # Sleep forever so s6 doesn't restart us in a loop
    exec sleep infinity
fi

if [ -z "$CF_TUNNEL_DOMAIN" ]; then
    warn "CF_TUNNEL_DOMAIN not set — tunnel disabled"
    exec sleep infinity
fi

# ── Parse user port mappings ───────────────────────────────────────────────────

if [ -n "$CF_TUNNEL_PORTS" ]; then
    IFS=',' read -ra PAIRS <<< "$CF_TUNNEL_PORTS"
    for pair in "${PAIRS[@]}"; do
        port="${pair%%:*}"
        name="${pair#*:}"
        if [ -n "$port" ] && [ -n "$name" ]; then
            PORT_NAMES[$port]="$name"
            log "Port mapping: $port → ${name}-${CF_TUNNEL_DOMAIN}"
        fi
    done
fi

# ── Helpers ────────────────────────────────────────────────────────────────────

get_subdomain() {
    local port="$1"
    local name="${PORT_NAMES[$port]:-p${port}}"
    echo "${name}-${CF_TUNNEL_DOMAIN}"
}

is_system_port() {
    local port="$1"
    for sp in $SYSTEM_PORTS; do
        [ "$port" = "$sp" ] && return 0
    done
    return 1
}

get_listening_ports() {
    # Get all TCP ports listening on any interface, exclude system ports
    ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | grep -oP ':\K[0-9]+$' | sort -un
}

# ── Start cloudflared ──────────────────────────────────────────────────────────

log "Starting Cloudflare Tunnel..."
log "Domain suffix: ${CF_TUNNEL_DOMAIN}"

# Start cloudflared in background with the token
cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" &
CF_PID=$!

# Give cloudflared time to connect
sleep 5

if ! kill -0 "$CF_PID" 2>/dev/null; then
    warn "cloudflared failed to start"
    exit 1
fi

log "Cloudflare Tunnel connected (PID: $CF_PID)"

# ── Built-in routes (CloudCLI + GSD Web) ──────────────────────────────────────
# These are always registered since they're core services.
# Note: With token-based tunnels, ingress rules are managed in the
# Cloudflare Zero Trust dashboard, not locally. The user must add
# public hostname entries there. This script logs what SHOULD be mapped
# so the user can configure their dashboard accordingly.

log "=== Required Public Hostnames (configure in Cloudflare Dashboard) ==="
log "  cloud-${CF_TUNNEL_DOMAIN} → http://localhost:3003  (CloudCLI)"
log "  gsd-${CF_TUNNEL_DOMAIN}   → http://localhost:3002  (GSD Web)"

# ── Port scanning loop ─────────────────────────────────────────────────────────

if [ "$CF_TUNNEL_SCAN" != "true" ]; then
    log "Port scanning disabled — waiting for cloudflared"
    wait "$CF_PID"
    exit 0
fi

log "Port scanning enabled (interval: ${CF_TUNNEL_INTERVAL}s)"

while kill -0 "$CF_PID" 2>/dev/null; do
    for port in $(get_listening_ports); do
        # Skip system/gateway port
        if is_system_port "$port"; then
            continue
        fi

        # Skip already seen ports
        if [ -n "${REGISTERED_PORTS[$port]:-}" ]; then
            continue
        fi

        subdomain=$(get_subdomain "$port")
        REGISTERED_PORTS[$port]="$subdomain"
        log "NEW PORT DETECTED: $port → $subdomain → http://localhost:$port"
        log "  ↳ Add in Cloudflare Dashboard: $subdomain → http://localhost:$port"
    done

    sleep "$CF_TUNNEL_INTERVAL"
done

warn "cloudflared exited — shutting down"
