import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────────────────

interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}

interface PtyModule {
  spawn(shell: string, args: string[], opts: any): PtyProcess;
}

interface WsModule {
  WebSocketServer: any;
  WebSocket: { OPEN: number };
}

interface SessionEntry {
  pty: PtyProcess;
  ws: any;
  command: string;
}

// ── Module finder (same pattern as web-terminal) ──────────────────────────────

function findModule(name: string): any {
  try { return require(name); } catch { /* continue */ }

  const roots = [
    path.join('/opt', 'claudecodeui', 'node_modules', name),
    path.join('/workspace', 'claudecodeui', 'node_modules', name),
    path.join('/app', 'node_modules', name),
    path.join(os.homedir(), 'claudecodeui', 'node_modules', name),
  ];

  for (const p of roots) {
    if (fs.existsSync(p)) {
      try { return require(p); } catch { /* continue */ }
    }
  }

  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(candidate)) {
      try { return require(candidate); } catch { /* continue */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`[gsd-agent] Cannot find module '${name}' - run npm install in ${__dirname}`);
}

// ── Dependencies ──────────────────────────────────────────────────────────────

const pty = findModule('node-pty') as PtyModule;
const { WebSocketServer, WebSocket } = findModule('ws') as WsModule;

// ── State ─────────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionEntry>();
let sessionCounter = 0;

function safeSend(ws: any, obj: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
}

function getShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

// ── Detect GSD availability ───────────────────────────────────────────────────

function isGsdAvailable(): boolean {
  const paths = (process.env.PATH || '').split(':');
  for (const p of paths) {
    if (fs.existsSync(path.join(p, 'gsd'))) return true;
  }
  return false;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && (req.url === '/info' || req.url === '/')) {
    // Read GSD Web config (written by entrypoint.sh)
    let gsdWebConfig = { token: '', port: 3002, domain: '' };
    try {
      gsdWebConfig = JSON.parse(fs.readFileSync('/tmp/gsd-web-config.json', 'utf8'));
    } catch { /* not available yet */ }

    res.end(JSON.stringify({
      name: 'gsd-agent',
      sessions: sessions.size,
      gsdAvailable: isGsdAvailable(),
      gsdWebPort: gsdWebConfig.port,
      gsdWebToken: gsdWebConfig.token,
      gsdDomain: gsdWebConfig.domain,
      platform: process.platform,
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: any, req: any) => {
  const sessionId = `gsd-${++sessionCounter}`;
  const cwd = '/workspace';
  const shell = getShell();

  // Parse command from query string: ?cmd=gsd+auto or default to interactive shell
  const url = new URL(req.url || '/', `http://localhost`);
  const cmd = url.searchParams.get('cmd') || '';

  let ptyProc: PtyProcess;
  try {
    if (cmd) {
      // Launch specific GSD command
      ptyProc = pty.spawn(shell, ['-c', cmd], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } else {
      // Launch interactive shell (user can type gsd commands)
      ptyProc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    }
  } catch (err) {
    safeSend(ws, JSON.stringify({ type: 'error', message: `Failed to spawn: ${(err as Error).message}` }));
    ws.close();
    return;
  }

  sessions.set(sessionId, { pty: ptyProc, ws, command: cmd });
  safeSend(ws, JSON.stringify({ type: 'ready', sessionId, command: cmd, cwd }));

  ptyProc.onData((chunk: string) => {
    ptyProc.pause();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, () => ptyProc.resume());
    } else {
      ptyProc.resume();
    }
  });

  ptyProc.onExit(({ exitCode, signal }) => {
    sessions.delete(sessionId);
    safeSend(ws, JSON.stringify({ type: 'exit', sessionId, exitCode, signal }));
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'process exited');
  });

  ws.on('message', (rawData: Buffer | string) => {
    const text = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    if (text.charCodeAt(0) === 123) {
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'input' && typeof msg.data === 'string') { ptyProc.write(msg.data); return; }
        if (msg.type === 'resize') { ptyProc.resize(Math.max(1, Math.min(Number(msg.cols) || 80, 500)), Math.max(1, Math.min(Number(msg.rows) || 24, 200))); return; }
        if (msg.type === 'ping') { safeSend(ws, JSON.stringify({ type: 'pong', sessionId })); return; }
      } catch { /* fall through */ }
    }
    ptyProc.write(text);
  });

  ws.on('close', () => { sessions.delete(sessionId); try { ptyProc.kill(); } catch { /* ignore */ } });
  ws.on('error', (err: Error) => { console.error(`[gsd-agent] ${sessionId} error:`, err.message); });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    process.stdout.write(JSON.stringify({ ready: true, port: addr.port }) + '\n');
  }
});

function shutdown(): void {
  for (const [, s] of sessions) {
    try { s.pty.kill(); } catch { /* ignore */ }
    try { s.ws.close(); } catch { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
