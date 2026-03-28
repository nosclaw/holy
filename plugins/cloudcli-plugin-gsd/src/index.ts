/**
 * GSD Agent plugin — dedicated tab for GSD (Get Shit Done) coding agent.
 *
 * Provides an xterm.js terminal pre-configured for GSD commands with
 * quick-action buttons for common operations.
 */

import type { PluginAPI } from './types.js';

// ── CDN version pins ──────────────────────────────────────────────────────────
const CDN = 'https://esm.sh';
const XTERM_VER = '5.5.0';
const FIT_VER = '0.10.0';
const WEBLINKS_VER = '0.11.0';

// ── Types ─────────────────────────────────────────────────────────────────────

interface XtermModules {
  Terminal: any;
  FitAddon: any;
  WebLinksAddon: any;
}

interface GlobalState {
  modules: XtermModules | null;
  terminal: any;
  fitAddon: any;
  ws: WebSocket | null;
  wsPort: number | null;
  connected: boolean;
  container: HTMLElement | null;
  api: PluginAPI | null;
  resizeObserver: ResizeObserver | null;
  unsubContext: (() => void) | null;
}

const state: GlobalState = {
  modules: null,
  terminal: null,
  fitAddon: null,
  ws: null,
  wsPort: null,
  connected: false,
  container: null,
  api: null,
  resizeObserver: null,
  unsubContext: null,
};

// ── GSD quick commands ────────────────────────────────────────────────────────

const GSD_COMMANDS = [
  { label: 'Interactive', cmd: 'gsd', desc: 'Start GSD interactive mode' },
  { label: 'Auto', cmd: 'gsd auto', desc: 'Run autonomous mode' },
  { label: 'Status', cmd: 'gsd status', desc: 'Show project status' },
  { label: 'Plan', cmd: 'gsd plan', desc: 'View/create project plan' },
  { label: 'Doctor', cmd: 'gsd doctor', desc: 'Health check' },
];

// ── Theme ─────────────────────────────────────────────────────────────────────

function getTheme(mode: 'dark' | 'light') {
  if (mode === 'light') {
    return {
      background: '#ffffff',
      foreground: '#1e1e1e',
      cursor: '#1e1e1e',
      cursorAccent: '#ffffff',
      selectionBackground: '#add6ff',
      black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800',
      blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
      brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14',
      brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc',
      brightCyan: '#0598bc', brightWhite: '#a5a5a5',
    };
  }
  return {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#ffffff',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
    blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
    brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
    brightCyan: '#29b8db', brightWhite: '#e5e5e5',
  };
}

// ── CSS ───────────────────────────────────────────────────────────────────────

function injectStyles(container: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = `
    .gsd-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .gsd-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-color, #333);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .gsd-toolbar .gsd-brand {
      font-weight: 700;
      font-size: 14px;
      margin-right: 8px;
      color: var(--fg-color, #0dbc79);
      letter-spacing: 0.5px;
    }
    .gsd-toolbar button {
      padding: 4px 10px;
      border: 1px solid var(--border-color, #555);
      border-radius: 4px;
      background: var(--btn-bg, #2d2d2d);
      color: var(--btn-fg, #ccc);
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .gsd-toolbar button:hover {
      background: var(--btn-hover-bg, #3d3d3d);
      border-color: var(--accent-color, #0dbc79);
    }
    .gsd-terminal-wrap {
      flex: 1;
      min-height: 0;
      padding: 4px;
    }
    .gsd-status {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-top: 1px solid var(--border-color, #333);
      font-size: 11px;
      color: var(--status-fg, #888);
      flex-shrink: 0;
    }
    .gsd-status .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #666;
    }
    .gsd-status .dot.connected { background: #0dbc79; }
    .gsd-status .dot.error { background: #cd3131; }

    /* Light theme overrides */
    .gsd-root.light {
      --border-color: #e0e0e0;
      --fg-color: #00874d;
      --btn-bg: #f5f5f5;
      --btn-fg: #333;
      --btn-hover-bg: #e8e8e8;
      --accent-color: #00874d;
      --status-fg: #999;
    }
    .gsd-root.dark {
      --border-color: #333;
      --fg-color: #0dbc79;
      --btn-bg: #2d2d2d;
      --btn-fg: #ccc;
      --btn-hover-bg: #3d3d3d;
      --accent-color: #0dbc79;
      --status-fg: #888;
    }
  `;
  container.appendChild(style);
}

// ── Load xterm.js from CDN ────────────────────────────────────────────────────

async function loadModules(): Promise<XtermModules> {
  if (state.modules) return state.modules;

  const [xtermMod, fitMod, linksMod] = await Promise.all([
    import(/* @vite-ignore */ `${CDN}/@xterm/xterm@${XTERM_VER}`),
    import(/* @vite-ignore */ `${CDN}/@xterm/addon-fit@${FIT_VER}`),
    import(/* @vite-ignore */ `${CDN}/@xterm/addon-web-links@${WEBLINKS_VER}`),
  ]);

  // Load xterm CSS
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${CDN}/@xterm/xterm@${XTERM_VER}/css/xterm.css`;
  document.head.appendChild(link);

  state.modules = {
    Terminal: xtermMod.Terminal,
    FitAddon: fitMod.FitAddon,
    WebLinksAddon: linksMod.WebLinksAddon,
  };
  return state.modules;
}

// ── Get backend WebSocket port ────────────────────────────────────────────────

async function getServerPort(api: PluginAPI): Promise<number> {
  if (state.wsPort) return state.wsPort;
  const info = (await api.rpc('GET', '/info')) as { name: string; sessions: number };
  // The RPC proxy doesn't expose the port directly — we need to use the plugin RPC proxy
  // But for WebSocket we need the actual port. Let's get it from /info via rpc.
  // Actually, CloudCLI proxies RPC but not WebSocket. We need to find the port.
  // The server prints it to stdout, and CloudCLI stores it internally.
  // We can get it from the RPC endpoint by including port in the response.
  return 0; // Will be handled by the connect function
}

// ── WebSocket connection ──────────────────────────────────────────────────────

function connectWs(api: PluginAPI, cmd: string = ''): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    // Already connected, just send the command
    if (cmd) {
      state.ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
    }
    return;
  }

  // CloudCLI proxies plugin WebSocket at /plugin-ws/{plugin-name}
  api.rpc('GET', '/info').then((info: any) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = localStorage.getItem('auth-token') || '';
    let wsUrl = `${proto}//${location.host}/plugin-ws/gsd-agent`;
    const params: string[] = [];
    if (cmd) params.push(`cmd=${encodeURIComponent(cmd)}`);
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    if (params.length) wsUrl += '?' + params.join('&');

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    const decoder = new TextDecoder();

    ws.onopen = () => {
      state.connected = true;
      updateStatus('Connected', 'connected');
    };

    ws.onmessage = (ev: MessageEvent) => {
      // Decode binary frames to string
      const data: string = ev.data instanceof ArrayBuffer
        ? decoder.decode(ev.data)
        : String(ev.data);

      // Check if it's a JSON control message
      if (data.charCodeAt(0) === 123) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'ready') {
            updateStatus(`Connected — ${msg.cwd}`, 'connected');
            return;
          }
          if (msg.type === 'exit') {
            updateStatus(`Process exited (code ${msg.exitCode})`, 'error');
            state.connected = false;
            return;
          }
          if (msg.type === 'error') {
            updateStatus(`Error: ${msg.message}`, 'error');
            return;
          }
        } catch { /* not JSON, write to terminal */ }
      }
      if (state.terminal) {
        state.terminal.write(data);
      }
    };

    ws.onclose = () => {
      state.connected = false;
      updateStatus('Disconnected', 'error');
    };

    ws.onerror = () => {
      state.connected = false;
      updateStatus('Connection error', 'error');
    };
  }).catch((err: Error) => {
    updateStatus(`Server error: ${err.message}`, 'error');
  });
}

// ── Status bar update ─────────────────────────────────────────────────────────

function updateStatus(text: string, state_class: string): void {
  const dot = document.querySelector('.gsd-status .dot');
  const label = document.querySelector('.gsd-status .status-text');
  if (dot) {
    dot.className = `dot ${state_class}`;
  }
  if (label) {
    label.textContent = text;
  }
}

// ── Send command to terminal ──────────────────────────────────────────────────

function sendCommand(cmd: string): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
    if (state.terminal) state.terminal.focus();
  } else if (state.api) {
    // Not connected yet, connect with this command
    connectWs(state.api);
    // Wait a moment then send the command
    setTimeout(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
      }
    }, 500);
  }
}

// ── Build UI ──────────────────────────────────────────────────────────────────

function buildUI(container: HTMLElement, api: PluginAPI): HTMLElement {
  const theme = api.context.theme || 'dark';
  const root = document.createElement('div');
  root.className = `gsd-root ${theme}`;

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'gsd-toolbar';

  const brand = document.createElement('span');
  brand.className = 'gsd-brand';
  brand.textContent = 'GSD';
  toolbar.appendChild(brand);

  for (const item of GSD_COMMANDS) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.title = item.desc;
    btn.addEventListener('click', () => sendCommand(item.cmd));
    toolbar.appendChild(btn);
  }

  // "Web UI" button — opens GSD Web in new tab with auth token
  const webBtn = document.createElement('button');
  webBtn.textContent = 'Web UI ↗';
  webBtn.title = 'Open GSD Web UI in new tab';
  webBtn.style.marginLeft = 'auto';
  webBtn.addEventListener('click', async () => {
    try {
      const info = (await api.rpc('GET', '/info')) as any;
      const domain = info.gsdDomain || '';
      const port = info.gsdWebPort || 3002;
      const token = info.gsdWebToken || '';
      // Prefer domain (via Cloudflare Tunnel), fallback to localhost:port
      const base = domain
        ? `${location.protocol}//${domain}`
        : `${location.protocol}//${location.hostname}:${port}`;
      const url = token ? `${base}/#token=${token}` : `${base}/`;
      window.open(url, '_blank');
    } catch {
      window.open(`${location.protocol}//${location.hostname}:3002/`, '_blank');
    }
  });
  toolbar.appendChild(webBtn);

  root.appendChild(toolbar);

  // Terminal container
  const termWrap = document.createElement('div');
  termWrap.className = 'gsd-terminal-wrap';
  root.appendChild(termWrap);

  // Status bar
  const statusBar = document.createElement('div');
  statusBar.className = 'gsd-status';
  statusBar.innerHTML = `
    <span class="dot"></span>
    <span class="status-text">Connecting...</span>
  `;
  root.appendChild(statusBar);

  container.appendChild(root);
  return termWrap;
}

// ── Mount ─────────────────────────────────────────────────────────────────────

export async function mount(container: HTMLElement, api: PluginAPI): Promise<void> {
  state.container = container;
  state.api = api;

  injectStyles(container);
  const termWrap = buildUI(container, api);

  // Load xterm.js
  const { Terminal, FitAddon, WebLinksAddon } = await loadModules();

  const theme = api.context.theme || 'dark';
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: getTheme(theme),
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());

  term.open(termWrap);

  // Small delay to ensure container is laid out before fitting
  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch { /* ignore */ }
  });

  state.terminal = term;
  state.fitAddon = fitAddon;

  // Handle terminal input → send to PTY via WebSocket
  term.onData((data: string) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Resize handling
  term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  const ro = new ResizeObserver(() => {
    try { fitAddon.fit(); } catch { /* ignore */ }
  });
  ro.observe(termWrap);
  state.resizeObserver = ro;

  // Theme changes
  state.unsubContext = api.onContextChange((ctx) => {
    const root = container.querySelector('.gsd-root');
    if (root) {
      root.className = `gsd-root ${ctx.theme}`;
    }
    term.options.theme = getTheme(ctx.theme);
  });

  // Connect WebSocket to backend
  connectWs(api);
}

// ── Unmount ───────────────────────────────────────────────────────────────────

export function unmount(container: HTMLElement): void {
  if (state.unsubContext) { state.unsubContext(); state.unsubContext = null; }
  if (state.resizeObserver) { state.resizeObserver.disconnect(); state.resizeObserver = null; }
  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.terminal) { state.terminal.dispose(); state.terminal = null; }
  state.connected = false;
  state.container = null;
  state.api = null;
  container.innerHTML = '';
}
