#!/bin/bash
set -e

# ==============================================================================
# HolyClaude — Container Entrypoint
# Handles: UID/GID remapping, host config import, first-boot bootstrap, s6 handoff
# ==============================================================================

CLAUDE_USER="claude"
CLAUDE_HOME="/home/claude"
WORKSPACE_DIR="/workspace"

# ---------- UID/GID remapping ----------
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

CURRENT_UID=$(id -u "$CLAUDE_USER")
CURRENT_GID=$(id -g "$CLAUDE_USER")

if [ "$PGID" != "$CURRENT_GID" ]; then
    echo "[entrypoint] Changing claude GID from $CURRENT_GID to $PGID"
    groupmod -o -g "$PGID" claude
fi

if [ "$PUID" != "$CURRENT_UID" ]; then
    echo "[entrypoint] Changing claude UID from $CURRENT_UID to $PUID"
    usermod -o -u "$PUID" claude
fi

# ---------- Fix home directory ownership ----------
chown "$PUID:$PGID" "$CLAUDE_HOME"
chown "$PUID:$PGID" "$CLAUDE_HOME/.claude" 2>/dev/null || true

# ---------- Ensure /workspace is writable ----------
mkdir -p "$WORKSPACE_DIR"
if ! runuser -u "$CLAUDE_USER" -- test -w "$WORKSPACE_DIR"; then
    echo "[entrypoint] /workspace is not writable for $CLAUDE_USER — attempting ownership fix"
    chown "$PUID:$PGID" "$WORKSPACE_DIR" 2>/dev/null || true
fi
if ! runuser -u "$CLAUDE_USER" -- test -w "$WORKSPACE_DIR"; then
    echo "[entrypoint] WARNING: /workspace is still not writable; fix host ownership or PUID/PGID"
fi

# ==============================================================================
# Host config import — copy from read-only /mnt/host-* into writable locations
# Only copies when source exists. Container dirs are fully writable.
# ==============================================================================

# --- Claude Code auth ---
if [ -f /mnt/host-claude.json ]; then
    cp /mnt/host-claude.json "$CLAUDE_HOME/.claude.json"
    chown "$PUID:$PGID" "$CLAUDE_HOME/.claude.json"
    echo "[entrypoint] Copied Claude Code auth from host"
elif [ ! -f "$CLAUDE_HOME/.claude.json" ]; then
    echo '{"hasCompletedOnboarding":true,"installMethod":"native"}' > "$CLAUDE_HOME/.claude.json"
    chown "$PUID:$PGID" "$CLAUDE_HOME/.claude.json"
    echo "[entrypoint] Created default ~/.claude.json"
fi

# --- GSD config (skip projects/sessions — they contain host paths) ---
GSD_DIR="$CLAUDE_HOME/.gsd"
mkdir -p "$GSD_DIR"
if [ -d /mnt/host-gsd ]; then
    for f in .env preferences.md defaults.json; do
        [ -f "/mnt/host-gsd/$f" ] && cp "/mnt/host-gsd/$f" "$GSD_DIR/$f"
    done
    for d in standards skills; do
        [ -d "/mnt/host-gsd/$d" ] && cp -r "/mnt/host-gsd/$d" "$GSD_DIR/"
    done
    # Copy agent auth (login credentials)
    if [ -d /mnt/host-gsd/agent ]; then
        mkdir -p "$GSD_DIR/agent"
        [ -f /mnt/host-gsd/agent/auth.json ] && cp /mnt/host-gsd/agent/auth.json "$GSD_DIR/agent/auth.json"
    fi
    echo "[entrypoint] Copied GSD config from host"
fi
echo '{"devRoot":"/workspace"}' > "$GSD_DIR/web-preferences.json"
# Ensure GSD projects dir is writable (bind-mounted from host)
chown "$PUID:$PGID" "$GSD_DIR/projects" 2>/dev/null || true
chown -R "$PUID:$PGID" "$GSD_DIR"

# --- OpenAI Codex auth ---
CODEX_DIR="$CLAUDE_HOME/.codex"
mkdir -p "$CODEX_DIR"
if [ -f /mnt/host-codex/auth.json ]; then
    cp /mnt/host-codex/auth.json "$CODEX_DIR/auth.json"
    echo "[entrypoint] Copied Codex auth from host"
fi
chown -R "$PUID:$PGID" "$CODEX_DIR"

# --- Gemini auth ---
GEMINI_DIR="$CLAUDE_HOME/.gemini"
mkdir -p "$GEMINI_DIR"
if [ -f /mnt/host-gemini/google_accounts.json ]; then
    cp /mnt/host-gemini/google_accounts.json "$GEMINI_DIR/google_accounts.json"
    echo "[entrypoint] Copied Gemini auth from host"
fi
chown -R "$PUID:$PGID" "$GEMINI_DIR"

# --- GSD Web placeholder config (real token written by gsd-web.sh at startup) ---
cat > /tmp/gsd-web-config.json <<GEOF
{
  "token": "",
  "port": ${GSD_HOST_PORT:-3002},
  "domain": "${GSD_DOMAIN:-}"
}
GEOF
chown "$PUID:$PGID" /tmp/gsd-web-config.json
chmod 666 /tmp/gsd-web-config.json
echo "[entrypoint] Created GSD Web config placeholder"

# --- Skillshare (initialize inside container, not from host) ---
SKILLSHARE_DIR="$CLAUDE_HOME/.config/skillshare"
mkdir -p "$SKILLSHARE_DIR/skills" "$SKILLSHARE_DIR/extras"
cat > "$SKILLSHARE_DIR/config.yaml" <<SEOF
source: $CLAUDE_HOME/.config/skillshare/skills
extras_source: $CLAUDE_HOME/.config/skillshare/extras
mode: merge
targets:
  claude:
    path: $CLAUDE_HOME/.claude/skills
    mode: symlink
  pi:
    path: $CLAUDE_HOME/.agents/skills
    mode: symlink
  universal:
    path: $CLAUDE_HOME/.agents/skills
    mode: symlink
ignore:
  - '**/.DS_Store'
  - '**/.git/**'
audit:
  block_threshold: CRITICAL
SEOF
chown -R "$PUID:$PGID" "$SKILLSHARE_DIR"
echo "[entrypoint] Initialized skillshare config"

# ---------- CloudCLI: ensure plugins exist in persistent volume ----------
CLOUDCLI_DIR="$CLAUDE_HOME/.claude-code-ui"
CLOUDCLI_SRC="/usr/local/share/holyclaude/cloudcli-plugins"

# Ensure plugins directory exists
mkdir -p "$CLOUDCLI_DIR/plugins"

# Initialize official plugins if not present
if [ ! -f "$CLOUDCLI_DIR/plugins.json" ]; then
    echo "[entrypoint] Initializing official CloudCLI plugins..."
    if [ -d "$CLOUDCLI_SRC" ]; then
        cp -r "$CLOUDCLI_SRC/plugins"/* "$CLOUDCLI_DIR/plugins/"
        cp "$CLOUDCLI_SRC/plugins.json" "$CLOUDCLI_DIR/plugins.json"
    else
        echo '{"project-stats":{"name":"project-stats","source":"https://github.com/cloudcli-ai/cloudcli-plugin-starter","enabled":true},"web-terminal":{"name":"web-terminal","source":"https://github.com/cloudcli-ai/cloudcli-plugin-terminal","enabled":true}}' > "$CLOUDCLI_DIR/plugins.json"
    fi
    chown -R "$PUID:$PGID" "$CLOUDCLI_DIR"
fi

# --- gsd-pi dynamic update ---
if [ -n "$GSD_PI_VERSION" ] && [ "$GSD_PI_VERSION" != "none" ]; then
    CURRENT_V=$(gsd -v 2>/dev/null | grep -oP 'v\K[0-9.]+')
    if [ "$GSD_PI_VERSION" = "latest" ] || [ "$GSD_PI_VERSION" != "$CURRENT_V" ]; then
        echo "[entrypoint] Updating gsd-pi to $GSD_PI_VERSION (current: $CURRENT_V)..."
        npm install -g "gsd-pi@$GSD_PI_VERSION" --silent
        # Re-fix node-pty (it often needs a fresh build in its standalone dir)
        PI_WEB_DIR="/usr/local/lib/node_modules/gsd-pi/dist/web/standalone"
        if [ -d "$PI_WEB_DIR" ]; then
            cd "$PI_WEB_DIR" && npm install node-pty --silent
        fi
    fi
fi

# --- Fix permissions for terminal updates ---
# Allow claude user to manage global npm packages without EACCES
chown -R "$PUID:$PGID" /usr/local/lib/node_modules /usr/local/bin

# --- Dynamic GSD plugin integration ---
# Example: GSD_PLUGIN_REPO=https://github.com/nosclaw/holy.git
#          GSD_PLUGIN_SUBDIR=plugins/cloudcli-plugin-gsd
if [ -n "$GSD_PLUGIN_REPO" ]; then
    GSD_TARGET_DIR="$CLOUDCLI_DIR/plugins/gsd-agent"
    echo "[entrypoint] Dynamic GSD plugin requested from $GSD_PLUGIN_REPO"
    
    # Clone or update
    if [ ! -d "$GSD_TARGET_DIR/.git" ]; then
        rm -rf "$GSD_TARGET_DIR"
        echo "[entrypoint] Cloning GSD plugin..."
        runuser -u "$CLAUDE_USER" -- git clone --depth 1 "$GSD_PLUGIN_REPO" "$GSD_TARGET_DIR"
    else
        echo "[entrypoint] Updating GSD plugin..."
        cd "$GSD_TARGET_DIR" && runuser -u "$CLAUDE_USER" -- git pull --depth 1
    fi

    # Build if needed (only if package.json exists in target or subdir)
    cd "$GSD_TARGET_DIR"
    if [ -n "$GSD_PLUGIN_SUBDIR" ] && [ -d "$GSD_PLUGIN_SUBDIR" ]; then
        cd "$GSD_PLUGIN_SUBDIR"
    fi

    if [ -f "package.json" ]; then
        echo "[entrypoint] Building GSD plugin..."
        runuser -u "$CLAUDE_USER" -- npm install --silent
        runuser -u "$CLAUDE_USER" -- npm run build --silent
        
        # Ensure it's enabled in plugins.json
        if ! grep -q "gsd-agent" "$CLOUDCLI_DIR/plugins.json"; then
            jq '. + {"gsd-agent":{"name":"gsd-agent","source":"local","enabled":true}}' "$CLOUDCLI_DIR/plugins.json" > "$CLOUDCLI_DIR/plugins.json.tmp" && \
            mv "$CLOUDCLI_DIR/plugins.json.tmp" "$CLOUDCLI_DIR/plugins.json"
        fi
    fi
fi
chown -R "$PUID:$PGID" "$CLOUDCLI_DIR"

# ---------- Ensure DISPLAY is set ----------
export DISPLAY=:99

# ---------- First-boot bootstrap ----------
SENTINEL="$CLAUDE_HOME/.claude/.holyclaude-bootstrapped"
if [ ! -f "$SENTINEL" ]; then
    echo "[entrypoint] First boot detected — running bootstrap.sh"
    if ! /usr/local/bin/bootstrap.sh; then
        echo "[entrypoint] WARNING: bootstrap.sh failed — continuing anyway"
    fi
fi

# ---------- Hand off to s6-overlay ----------
echo "[entrypoint] Starting s6-overlay..."
exec /init "$@"
