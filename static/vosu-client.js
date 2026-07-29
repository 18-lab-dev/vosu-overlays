const DEFAULT_SERVER = "http://127.0.0.1:24050";
const MAX_BACKOFF = 10000;

export function serverFromQuery() {
  const requested = new URLSearchParams(location.search).get("server");
  try {
    const url = new URL(requested || DEFAULT_SERVER);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return DEFAULT_SERVER;
  }
}

export class VosuClient extends EventTarget {
  constructor(base = serverFromQuery()) {
    super();
    this.base = base;
    this.wsBase = base.replace(/^http/, 'ws');
    this.stopped = false;
    this.sockets = new Map();
    this.attempts = new Map();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    this.emit('connection', { state: 'connecting', detail: `Connecting to ${this.base}` });
    await Promise.allSettled([
      this.fetchSnapshot('/json/v2', 'snapshot'),
      this.fetchSnapshot('/json/v2/precise', 'precise')
    ]);
    this.connect('snapshot', '/websocket/v2');
    this.connect('precise', '/websocket/v2/precise');
  }

  async fetchSnapshot(path, event) {
    const response = await fetch(`${this.base}${path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} returned malformed JSON`);
    this.emit(event, value);
  }

  connect(kind, path) {
    if (this.stopped) return;
    const socket = new WebSocket(`${this.wsBase}${path}`);
    this.sockets.set(kind, socket);
    this.emit('connection', { state: 'connecting', detail: `Connecting ${kind} telemetry` });
    socket.onmessage = (message) => {
      try {
        const value = JSON.parse(message.data);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid frame');
        this.attempts.set(kind, 0);
        this.emit(kind, value);
        this.emit('connection', { state: 'live', detail: `Live · ${this.base}` });
      } catch (_) {
        this.emit('connection', { state: 'error', detail: `Malformed ${kind} telemetry` });
        socket.close(1002, 'Malformed JSON');
      }
    };
    socket.onerror = () => this.emit('connection', { state: 'error', detail: `${kind} telemetry error` });
    socket.onclose = () => {
      if (this.sockets.get(kind) === socket) this.sockets.delete(kind);
      if (this.stopped) return;
      const attempt = (this.attempts.get(kind) || 0) + 1;
      this.attempts.set(kind, attempt);
      const delay = Math.min(MAX_BACKOFF, 400 * 2 ** Math.min(attempt, 5));
      this.emit('connection', { state: 'error', detail: `${kind} disconnected · retrying` });
      setTimeout(() => this.connect(kind, path), delay + Math.random() * 250);
    };
  }

  stop() {
    this.stopped = true;
    for (const socket of this.sockets.values()) socket.close(1000, 'Page closed');
    this.sockets.clear();
  }
}
