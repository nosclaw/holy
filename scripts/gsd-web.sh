#!/bin/bash
# ==============================================================================
# HolyClaude — GSD Web Launcher
# Starts `gsd --web` on 127.0.0.1:3002, then runs a proxy on 0.0.0.0:3003
# to make it accessible from outside the container via Docker port mapping.
# ==============================================================================

GSD_INTERNAL_PORT=3002
GSD_PROXY_PORT=3003
EXTERNAL_PORT="${GSD_HOST_PORT:-$GSD_PROXY_PORT}"
CONFIG_FILE="/tmp/gsd-web-config.json"

echo "[gsd-web] Starting gsd --web --port $GSD_INTERNAL_PORT in /workspace..."

# Load GSD env file (contains CONTEXT7_API_KEY etc.)
[ -f "$HOME/.gsd/.env" ] && set -a && . "$HOME/.gsd/.env" && set +a

# Allow external origins (browser accesses via host port or domain)
ORIGINS="http://localhost:${EXTERNAL_PORT},http://127.0.0.1:${EXTERNAL_PORT}"
[ -n "${GSD_DOMAIN:-}" ] && ORIGINS="$ORIGINS,https://${GSD_DOMAIN},http://${GSD_DOMAIN}"
export GSD_WEB_ALLOWED_ORIGINS="$ORIGINS"

# Run gsd --web (it starts server on 127.0.0.1 then exits)
OUTPUT=$(cd /workspace && gsd --web --port "$GSD_INTERNAL_PORT" 2>&1)
echo "$OUTPUT"

# Extract token
TOKEN=$(echo "$OUTPUT" | grep -oP '#token=\K[a-f0-9]+' | head -1)
if [ -n "$TOKEN" ]; then
    cat > "$CONFIG_FILE" <<EOF
{
  "token": "$TOKEN",
  "port": $EXTERNAL_PORT,
  "domain": "${GSD_DOMAIN:-}"
}
EOF
    echo "[gsd-web] Token captured (port=$EXTERNAL_PORT, domain=${GSD_DOMAIN:-none})"
else
    echo "[gsd-web] WARNING: Could not capture token"
fi

# Wait for GSD server
sleep 2
SERVER_PID=""
for i in $(seq 1 10); do
    SERVER_PID=$(ss -tlnp "sport = :$GSD_INTERNAL_PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    [ -n "$SERVER_PID" ] && break
    sleep 1
done

if [ -z "$SERVER_PID" ]; then
    echo "[gsd-web] ERROR: Server not found on port $GSD_INTERNAL_PORT"
    exit 1
fi

echo "[gsd-web] Server on 127.0.0.1:$GSD_INTERNAL_PORT (PID=$SERVER_PID)"
echo "[gsd-web] Starting proxy on 0.0.0.0:$GSD_PROXY_PORT..."

# Proxy: 0.0.0.0:3003 → 127.0.0.1:3002
export GSD_INTERNAL_PORT GSD_PROXY_PORT
exec node -e '
const http = require("http");
const net = require("net");
const INT_PORT = parseInt(process.env.GSD_INTERNAL_PORT);
const EXT_PORT = parseInt(process.env.GSD_PROXY_PORT);

let consecutiveErrors = 0;
const MAX_ERRORS = 5;

const server = http.createServer((req, res) => {
  const proxy = http.request({
    hostname: "127.0.0.1", port: INT_PORT,
    path: req.url, method: req.method, headers: req.headers
  }, proxyRes => {
    consecutiveErrors = 0;
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on("error", () => {
    consecutiveErrors++;
    if (!res.headersSent) { res.writeHead(502); res.end(); }
    if (consecutiveErrors >= MAX_ERRORS) {
      console.error("[gsd-web] Backend unreachable after " + MAX_ERRORS + " consecutive errors, exiting for s6 restart");
      process.exit(1);
    }
  });
  req.pipe(proxy);
});

// Periodic health check: verify backend is still alive
setInterval(() => {
  const check = http.get({ hostname: "127.0.0.1", port: INT_PORT, path: "/", timeout: 5000 }, (r) => {
    consecutiveErrors = 0;
    r.resume();
  });
  check.on("error", () => {
    consecutiveErrors++;
    console.error("[gsd-web] Health check failed (" + consecutiveErrors + "/" + MAX_ERRORS + ")");
    if (consecutiveErrors >= MAX_ERRORS) {
      console.error("[gsd-web] Backend dead, exiting for s6 restart");
      process.exit(1);
    }
  });
  check.on("timeout", () => { check.destroy(); });
}, 15000);

server.on("upgrade", (req, socket, head) => {
  const proxy = net.connect(INT_PORT, "127.0.0.1", () => {
    proxy.write(req.method + " " + req.url + " HTTP/1.1\r\n" +
      Object.entries(req.headers).map(([k,v]) => k+": "+v).join("\r\n") + "\r\n\r\n");
    if (head.length) proxy.write(head);
    proxy.pipe(socket); socket.pipe(proxy);
  });
  proxy.on("error", () => socket.end());
  socket.on("error", () => proxy.end());
});

server.listen(EXT_PORT, "0.0.0.0", () => {
  console.log("[gsd-web] Proxy 0.0.0.0:" + EXT_PORT + " → 127.0.0.1:" + INT_PORT);
});
'
