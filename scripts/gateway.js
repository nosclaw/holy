/**
 * HolyClaude Gateway — lightweight reverse proxy
 *
 * Routes:
 *   /gsd/*  →  GSD Web UI  (127.0.0.1:3002)
 *   /*      →  CloudCLI    (127.0.0.1:3003)
 *
 * Handles both HTTP and WebSocket upgrades.
 */

const http = require('node:http');
const net = require('node:net');

const LISTEN_PORT = 3001;
const CLOUDCLI = { host: '127.0.0.1', port: 3003 };
const GSD_WEB  = { host: '127.0.0.1', port: 3002 };

// ── Routing ───────────────────────────────────────────────────────────────────

// Route /_next/* to GSD based on Referer header.
// GSD is Next.js (uses /_next/), CloudCLI is Express+Vite (does not).
function pickTarget(url, referer) {
  if (url.startsWith('/gsd')) return GSD_WEB;
  if (url.startsWith('/_next/') && referer && referer.includes('/gsd')) return GSD_WEB;
  return CLOUDCLI;
}

function rewritePath(url, target) {
  if (target === GSD_WEB && url.startsWith('/gsd')) {
    const stripped = url.slice(4) || '/';
    return stripped.startsWith('/') ? stripped : '/' + stripped;
  }
  return url;
}

// ── HTTP proxy ────────────────────────────────────────────────────────────────

const server = http.createServer((clientReq, clientRes) => {
  const referer = clientReq.headers['referer'] || '';
  const target = pickTarget(clientReq.url, referer);
  const path = rewritePath(clientReq.url, target);

  const proxyReq = http.request(
    {
      hostname: target.host,
      port: target.port,
      path,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        host: `${target.host}:${target.port}`,
      },
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes, { end: true });
    },
  );

  proxyReq.on('error', () => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`Gateway: upstream not ready (${target.host}:${target.port})`);
    }
  });

  clientReq.pipe(proxyReq, { end: true });
});

// ── WebSocket (HTTP Upgrade) proxy ────────────────────────────────────────────

server.on('upgrade', (clientReq, clientSocket, head) => {
  const referer = clientReq.headers['referer'] || '';
  const target = pickTarget(clientReq.url, referer);
  const path = rewritePath(clientReq.url, target);

  const proxySocket = net.connect(target.port, target.host, () => {
    const reqLine = `${clientReq.method} ${path} HTTP/1.1\r\n`;
    const hdrs = Object.entries({ ...clientReq.headers, host: `${target.host}:${target.port}` })
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');

    proxySocket.write(reqLine + hdrs + '\r\n\r\n');
    if (head && head.length) proxySocket.write(head);

    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });

  proxySocket.on('error', () => clientSocket.end());
  clientSocket.on('error', () => proxySocket.end());
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[gateway] Listening on :${LISTEN_PORT}`);
  console.log(`[gateway]   /*     → CloudCLI :${CLOUDCLI.port}`);
  console.log(`[gateway]   /gsd/* → GSD Web  :${GSD_WEB.port}`);
});
