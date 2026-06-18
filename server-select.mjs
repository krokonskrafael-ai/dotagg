const AG_PREFERRED_SERVER_KEY = 'kintara_ag_preferred_server';

function agGetPreferredServer() {
  try {
    const v = localStorage.getItem(AG_PREFERRED_SERVER_KEY) || null;
    return v;
  } catch(_) { return null; }
}

function agSetPreferredServer(id) {
  try {
    if (id == null || id === '') localStorage.removeItem(AG_PREFERRED_SERVER_KEY);
    else localStorage.setItem(AG_PREFERRED_SERVER_KEY, String(id));
  } catch(_) {}
}

/**
 * Server-selection & queue UX for the Kintara `/play` boot flow.
 *
 * Order of operations after wallet login + display-name + clicking Play:
 *   1. We fetch `/api/servers` for the live population labels (Low / Medium /
 *      High — never raw counts).
 *   2. The player picks Server 1 or Server 2.
 *   3. We open `/ws/queue/sN`. The server replies with either:
 *        - `queue_ready` (a slot was free; reservation now held for us)
 *        - `queue_pos`   (we are queued at position N)
 *      followed by further `queue_pos` updates as the queue advances.
 *   4. On `queue_ready` we resolve and the caller opens `/ws/presence/sN`.
 *
 * The modal lives directly on top of the boot overlay and uses the same
 * Cinzel + gold-on-deep-blue palette as `index.html` so it reads as part
 * of the Kintara boot sequence, not a generic browser popup.
 *
 * Caller contract:
 *   - `chooseServerAndConnect()` resolves with `{ shardId, presenceUrl }`
 *     once a shard is ready for the presence WS upgrade. The boot overlay
 *     phase label is driven through the supplied `setPhase(label, pct)`
 *     hook so every stage feels native to the existing loading screen.
 *   - The DOM is torn down automatically once a shard is ready or the user
 *     hits the retry button after an error.
 */

const SERVERS_API = '/api/servers';
const SERVERS_POLL_MS = 6000;
const QUEUE_PING_MS = 5000;
const QUEUE_CONNECT_TIMEOUT_MS = 15000;
/** Once queued, the server feeds queue_pos two ways: a reply to each q_ping
 *  (every QUEUE_PING_MS) AND a server-initiated keepalive every ~10s
 *  (QUEUE_HEARTBEAT_MS, queue-hub.js) — so a healthy gate is never silent this
 *  long even if a single ping round-trip is dropped. Used as a sliding
 *  "no message received" watchdog AFTER the first message, replacing the old
 *  fixed connect deadline that killed players legitimately waiting in queue.
 *  30s tolerates ~2 missed server keepalives before giving up. */
const QUEUE_STALL_TIMEOUT_MS = 30000;

function readFanoutOrigin() {
  try {
    const raw = typeof window !== 'undefined' ? String(window.KINTARA_READ_FANOUT_ORIGIN || '').trim() : '';
    if (!raw) return '';
    return new URL(raw, location.origin).origin;
  } catch (_) {
    return '';
  }
}

function apiUrl(path) {
  const origin = readFanoutOrigin();
  return origin ? `${origin}${path}` : path;
}

async function readFanoutFetch(path, options) {
  const fanoutUrl = apiUrl(path);
  if (fanoutUrl === path) return fetch(path, options);
  try {
    const r = await fetch(fanoutUrl, { ...(options || {}), credentials: 'omit' });
    if (r && r.ok) return r;
  } catch (_) {
    /* fall back to authoritative server */
  }
  return fetch(path, options);
}

/** Inject the CSS once per page load. The styles deliberately mirror the boot
 *  overlay frame so the selection card looks like a continuation of the boot
 *  sequence (parchment-gold on weave-textured deep blue), not a popup. */
function ensureServerSelectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('kintara-server-select-style')) return;
  const st = document.createElement('style');
  st.id = 'kintara-server-select-style';
  st.textContent = `
.kintara-server-select-root {
  position: fixed;
  inset: 0;
  z-index: 100000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  pointer-events: auto;
  font-family: 'Inter', system-ui, 'Segoe UI', Roboto, sans-serif;
  color: #d4c4a8;
  /* Solid backdrop so the game canvas / HUD never bleeds through behind
   * the card. Matches the boot overlay palette so this reads as a
   * continuation of the boot sequence rather than a popup. */
  background-color: #121a22;
  isolation: isolate;
}
/* Faint weave + radial bloom ornament identical to .kintara-load-skin, so
 * the selection screen visually matches the rest of the boot flow even
 * when the boot overlay underneath has already faded out. */
.kintara-server-select-root::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image:
    repeating-linear-gradient(
      -32deg,
      transparent 0,
      transparent 7px,
      rgba(255, 200, 120, 0.028) 7px,
      rgba(255, 200, 120, 0.028) 8px
    ),
    repeating-linear-gradient(
      58deg,
      transparent 0,
      transparent 11px,
      rgba(130, 180, 255, 0.022) 11px,
      rgba(130, 180, 255, 0.022) 12px
    ),
    radial-gradient(ellipse 55% 40% at 20% 15%, rgba(255, 150, 70, 0.07) 0%, transparent 55%),
    radial-gradient(ellipse 50% 45% at 85% 75%, rgba(80, 140, 200, 0.06) 0%, transparent 50%);
}
.kintara-server-select-root::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: repeating-linear-gradient(
    180deg,
    transparent 0 2px,
    rgba(0, 0, 0, 0.06) 2px 3px
  );
  opacity: 0.35;
  mix-blend-mode: multiply;
}
.kintara-server-select-root > * { position: relative; z-index: 1; }
.kintara-server-select-card {
  position: relative;
  width: min(520px, 100%);
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 30px 32px 28px;
  text-align: center;
  border: 2px solid rgba(100, 140, 180, 0.42);
  border-radius: 16px;
  background: linear-gradient(
    165deg,
    rgba(40, 58, 78, 0.97) 0%,
    rgba(24, 38, 54, 0.98) 45%,
    rgba(16, 24, 34, 0.99) 100%
  );
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    inset 0 -14px 36px rgba(0, 0, 0, 0.28),
    0 12px 42px rgba(8, 14, 24, 0.55),
    0 2px 0 rgba(255, 200, 140, 0.06);
}
.kintara-server-select-card::before,
.kintara-server-select-card::after {
  content: '◆';
  position: absolute;
  top: 14px;
  font-size: 12px;
  color: rgba(255, 190, 120, 0.5);
  text-shadow: 0 0 12px rgba(120, 190, 255, 0.2);
}
.kintara-server-select-card::before { left: 18px; }
.kintara-server-select-card::after { right: 18px; }
.kintara-server-select-sub {
  margin: 0 0 12px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: rgba(170, 195, 220, 0.6);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
.kintara-server-select-title {
  font-family: 'Cinzel', Georgia, 'Times New Roman', serif;
  font-size: clamp(24px, 4.5vw, 32px);
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  margin: 0 0 8px;
  background: linear-gradient(180deg, #fff8e4 0%, #ffd463 25%, #e88820 65%, #9a4a12 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 1px 0 rgba(55, 28, 8, 0.95)) drop-shadow(0 2px 6px rgba(0, 0, 0, 0.55));
}
.kintara-server-select-blurb {
  margin: 0 0 22px;
  font-size: 13px;
  font-weight: 600;
  color: rgba(200, 215, 235, 0.75);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6);
}
.kintara-server-select-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0 0 20px;
}
.kintara-server-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 22px;
  border-radius: 12px;
  cursor: pointer;
  border: 1px solid rgba(100, 140, 180, 0.32);
  background: linear-gradient(180deg, rgba(36, 52, 72, 0.92) 0%, rgba(20, 30, 44, 0.96) 100%);
  text-align: left;
  transition: transform 120ms ease, border-color 120ms ease, filter 120ms ease;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -3px 12px rgba(0, 0, 0, 0.32);
}
.kintara-server-card:hover,
.kintara-server-card:focus-visible {
  border-color: rgba(255, 190, 120, 0.55);
  filter: brightness(1.08);
  outline: none;
  transform: translateY(-1px);
}
.kintara-server-card[disabled] {
  cursor: not-allowed;
  filter: grayscale(0.4) brightness(0.78);
}
.kintara-server-card__name {
  font-family: 'Cinzel', Georgia, 'Times New Roman', serif;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #f0e1c0;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
}
.kintara-server-card__hint {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(170, 195, 220, 0.55);
  margin-top: 4px;
}
.kintara-server-card__pop {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  border: 1px solid currentColor;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6);
}
.kintara-server-card__pop::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}
.kintara-server-card__pop[data-bucket='Low'] { color: #7adf8f; }
.kintara-server-card__pop[data-bucket='Medium'] { color: #ffd56b; }
.kintara-server-card__pop[data-bucket='High'] { color: #ff9072; }
.kintara-server-card__pop[data-bucket='Full'] { color: #ff7280; }

/* ── Queue state ───────────────────────────────────────────────────────── */
.kintara-server-select-queue {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 4px 16px;
}
.kintara-server-select-queue__line1 {
  font-family: 'Cinzel', Georgia, 'Times New Roman', serif;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #f0e1c0;
}
.kintara-server-select-queue__line2 {
  font-size: 14px;
  font-weight: 700;
  color: rgba(220, 232, 250, 0.85);
}
.kintara-server-select-queue__pos {
  font-family: 'Cinzel', Georgia, 'Times New Roman', serif;
  font-size: 44px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: transparent;
  background: linear-gradient(180deg, #fff8e4 0%, #ffd463 28%, #e88820 70%, #9a4a12 100%);
  -webkit-background-clip: text;
  background-clip: text;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.6));
}
.kintara-server-select-queue__bar {
  margin: 6px auto 0;
  width: min(280px, 78%);
  height: 10px;
  border-radius: 999px;
  padding: 3px;
  background: linear-gradient(180deg, rgba(36, 48, 62, 0.95) 0%, rgba(14, 20, 30, 0.98) 100%);
  border: 1px solid rgba(100, 140, 180, 0.28);
  overflow: hidden;
}
.kintara-server-select-queue__barFill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(180deg, #fff0c8 0%, #ffb24a 35%, #d66a18 72%, #8f3d0c 100%);
  box-shadow: 0 0 10px rgba(255, 180, 80, 0.4);
  transition: width 0.35s ease;
  width: 8%;
}
.kintara-server-select-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 8px;
}
.kintara-server-select-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 120px;
  padding: 10px 22px;
  font-family: 'Inter', system-ui, 'Segoe UI', Roboto, sans-serif;
  font-weight: 800;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  border-radius: 10px;
  border: 1px solid rgba(100, 140, 180, 0.35);
  color: #d4c4a8;
  background: linear-gradient(180deg, rgba(48, 68, 90, 0.92) 0%, rgba(22, 34, 50, 0.96) 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  transition: transform 120ms ease, filter 120ms ease;
}
.kintara-server-select-btn:hover,
.kintara-server-select-btn:focus-visible {
  outline: none;
  filter: brightness(1.12);
  border-color: rgba(255, 190, 120, 0.55);
}
.kintara-server-select-btn--primary {
  color: #4f210a;
  border-color: #6e3010;
  background: linear-gradient(180deg, #ffaf5e 0%, #ff8a3a 48%, #ed6f1c 100%);
  text-shadow: 0 1px 0 rgba(255, 228, 170, 0.42);
  box-shadow:
    inset 0 2px 0 rgba(255, 236, 200, 0.55),
    inset 0 -3px 10px rgba(110, 42, 10, 0.38);
}
.kintara-server-select-btn[disabled] {
  cursor: progress;
  filter: grayscale(0.2) brightness(0.85);
}

/* ── Error state ───────────────────────────────────────────────────────── */
.kintara-server-select-error {
  padding: 16px 18px;
  border-radius: 10px;
  margin: 12px 0 14px;
  background: rgba(120, 28, 28, 0.32);
  border: 1px solid rgba(255, 140, 140, 0.32);
  color: #ffd0d0;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.45;
}
`;
  document.head.appendChild(st);
}

/** Tiny helper around the shared boot-overlay phase setter exposed by `index.html`. */
function setBootPhase(label, pct) {
  try {
    if (typeof window !== 'undefined' && typeof window.__kintaraLoadingPhase === 'function') {
      window.__kintaraLoadingPhase(label, pct);
    }
  } catch (_) { /* ignore */ }
}

function setBootConnectingMode(label) {
  try {
    if (typeof window !== 'undefined' && typeof window.__kintaraLoadingShowConnecting === 'function') {
      window.__kintaraLoadingShowConnecting(label);
    }
  } catch (_) { /* ignore */ }
}

/** Fetch the live server list. Network failures are swallowed and surfaced via the UI. */
async function fetchServers() {
  const r = await readFanoutFetch(SERVERS_API, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  if (!j || j.ok !== true || !Array.isArray(j.servers)) throw new Error('invalid_response');
  return { servers: j.servers, adminBypass: j.adminBypass === true };
}

/** Compose `wss://...` or `ws://...` URL for a given relative path. */
function wsUrl(path) {
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : 'localhost';
  return `${proto}//${host}${path}`;
}

/**
 * Public entry point. Returns a promise resolving to `{ shardId, presenceUrl }`
 * once the player has both picked a server and reached the front of its queue
 * (or walked straight in if the shard had capacity). On any unrecoverable
 * error the promise rejects.
 *
 * The function takes ownership of the boot overlay phase label and renders
 * its own card on top of the existing overlay. The card and any open queue
 * WebSocket are cleaned up before the promise settles.
 */
export function chooseServerAndConnect() {
  return new Promise((resolve, reject) => {
    ensureServerSelectStyles();

    /** Root DOM. The selection card is appended directly to body so the boot
     *  overlay (still visible underneath) provides the background ornament. */
    const root = document.createElement('div');
    root.className = 'kintara-server-select-root';
    /** aria-modal: the game's window-level click-to-move handler treats
     *  `[aria-modal="true"]` ancestors as HUD — without it, clicks on the
     *  server buttons fell through to the world raycast and walked the
     *  player (works even after settle() detaches the root: closest()
     *  traverses the detached subtree). */
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    const card = document.createElement('div');
    card.className = 'kintara-server-select-card';
    root.appendChild(card);
    document.body.appendChild(root);

    /** Returned to caller after successful shard pick. */
    let activeQueueWs = null;
    let pollTimer = null;
    let pingTimer = null;
    let settled = false;
    let adminBypassQueue = false;
    /** Viewer's average skill level — fetched once so level-gated special servers
     *  (minLevel > 0) can be greyed out before the player clicks. null = unknown
     *  (fetch failed); we then DON'T pre-lock and let the server gate decide. */
    let viewerAvgLevel = null;
    async function fetchViewerLevel() {
      try {
        // Player-specific → authoritative server, never the read-fanout cache.
        const r = await fetch('/api/auth/viewer-level', { credentials: 'include', cache: 'no-store' });
        const j = await r.json().catch(() => null);
        viewerAvgLevel = j && j.ok && Number.isFinite(Number(j.avgLevel)) ? Number(j.avgLevel) | 0 : null;
      } catch (_) {
        viewerAvgLevel = null;
      }
    }

    function tearDown() {
      try { if (pollTimer != null) clearInterval(pollTimer); } catch (_) { /* ignore */ }
      try { if (pingTimer != null) clearInterval(pingTimer); } catch (_) { /* ignore */ }
      pollTimer = null;
      pingTimer = null;
      if (activeQueueWs) {
        try { activeQueueWs.onmessage = null; activeQueueWs.onclose = null; activeQueueWs.onerror = null; } catch (_) { /* ignore */ }
        try { activeQueueWs.close(); } catch (_) { /* ignore */ }
        activeQueueWs = null;
      }
      try { if (root && root.parentNode) root.parentNode.removeChild(root); } catch (_) { /* ignore */ }
    }

    function fail(err, hint) {
      if (settled) return;
      const message = hint || (err && err.message) || 'Connection failed.';
      renderError(message);
    }

    function settle(shardId) {
      if (settled) return;
      settled = true;
      tearDown();
      const presenceUrl = wsUrl(`/ws/presence/s${shardId}`);
      resolve({ shardId, presenceUrl });
    }

    function abort(reasonErr) {
      if (settled) return;
      settled = true;
      tearDown();
      reject(reasonErr || new Error('server_select_aborted'));
    }

    if (
      typeof window !== 'undefined' &&
      window.__KINTARA_E2E__ === true &&
      Number(window.__KINTARA_E2E_AUTO_SERVER_ID__) > 0
    ) {
      const shardId = Math.max(1, Number(window.__KINTARA_E2E_AUTO_SERVER_ID__) | 0);
      setBootPhase('Joining test server...', 90);
      setTimeout(() => settle(shardId), 0);
      return;
    }

    function renderError(message) {
      if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
      if (pingTimer != null) { clearInterval(pingTimer); pingTimer = null; }
      if (activeQueueWs) {
        try { activeQueueWs.onmessage = null; activeQueueWs.onclose = null; activeQueueWs.onerror = null; } catch (_) { /* ignore */ }
        try { activeQueueWs.close(); } catch (_) { /* ignore */ }
        activeQueueWs = null;
      }
      card.innerHTML = '';
      const sub = document.createElement('p');
      sub.className = 'kintara-server-select-sub';
      sub.textContent = '— Connection error —';
      const title = document.createElement('div');
      title.className = 'kintara-server-select-title';
      title.textContent = 'Something went wrong';
      const blurb = document.createElement('p');
      blurb.className = 'kintara-server-select-blurb';
      blurb.textContent = 'We could not reach the realm gate.';
      const errBox = document.createElement('div');
      errBox.className = 'kintara-server-select-error';
      errBox.textContent = String(message || 'Network error');
      const actions = document.createElement('div');
      actions.className = 'kintara-server-select-actions';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'kintara-server-select-btn kintara-server-select-btn--primary';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => { void renderSelection(); });
      actions.appendChild(retryBtn);
      card.append(sub, title, blurb, errBox, actions);
      setBootPhase('Connection error', 92);
    }

    function renderQueue(shardId, info) {
      card.innerHTML = '';
      const sub = document.createElement('p');
      sub.className = 'kintara-server-select-sub';
      sub.textContent = `— Server ${shardId} —`;
      const title = document.createElement('div');
      title.className = 'kintara-server-select-title';
      title.textContent = 'You are in queue';
      const body = document.createElement('div');
      body.className = 'kintara-server-select-queue';
      const aheadLabel = document.createElement('div');
      aheadLabel.className = 'kintara-server-select-queue__line2';
      const aheadCount = document.createElement('div');
      aheadCount.className = 'kintara-server-select-queue__pos';
      const followUp = document.createElement('div');
      followUp.className = 'kintara-server-select-queue__line2';
      followUp.textContent = 'Hold tight — you’ll enter automatically as soon as a slot opens.';
      const bar = document.createElement('div');
      bar.className = 'kintara-server-select-queue__bar';
      const fill = document.createElement('div');
      fill.className = 'kintara-server-select-queue__barFill';
      bar.appendChild(fill);
      body.append(aheadLabel, aheadCount, followUp, bar);
      const actions = document.createElement('div');
      actions.className = 'kintara-server-select-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'kintara-server-select-btn';
      cancelBtn.textContent = 'Leave queue';
      cancelBtn.addEventListener('click', () => {
        if (activeQueueWs && activeQueueWs.readyState === WebSocket.OPEN) {
          try { activeQueueWs.send(JSON.stringify({ t: 'q_leave' })); } catch (_) { /* ignore */ }
        }
        if (activeQueueWs) {
          try { activeQueueWs.onmessage = null; activeQueueWs.onclose = null; activeQueueWs.onerror = null; } catch (_) { /* ignore */ }
          try { activeQueueWs.close(); } catch (_) { /* ignore */ }
          activeQueueWs = null;
        }
        void renderSelection();
      });
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'kintara-server-select-btn';
      switchBtn.textContent = 'Pick a different server';
      switchBtn.addEventListener('click', () => {
        if (activeQueueWs) {
          try { activeQueueWs.send(JSON.stringify({ t: 'q_leave' })); } catch (_) { /* ignore */ }
          try { activeQueueWs.onmessage = null; activeQueueWs.onclose = null; activeQueueWs.onerror = null; } catch (_) { /* ignore */ }
          try { activeQueueWs.close(); } catch (_) { /* ignore */ }
          activeQueueWs = null;
        }
        void renderSelection();
      });
      actions.append(cancelBtn, switchBtn);
      card.append(sub, title, body, actions);

      const updatePos = (pos, ahead) => {
        const a = Math.max(0, Number(ahead) || 0);
        aheadLabel.textContent = 'players ahead of you';
        aheadCount.textContent = String(a);
        const totalShown = Math.max(1, a + 1);
        const pct = Math.max(6, Math.min(100, Math.round(((totalShown - a) / totalShown) * 100)));
        fill.style.width = pct + '%';
        setBootPhase(`In queue · ${a} ahead`, 92);
      };
      if (info && typeof info.ahead === 'number') updatePos(info.pos, info.ahead);
      else updatePos(null, 0);

      return { updatePos };
    }

    /** A rejected WS *upgrade* (stale session, failed $KINS gate, ban) closes the
     *  socket before `onopen` fires, and the browser exposes neither the HTTP
     *  status nor the X-Kintara-Reason header for a failed handshake — every
     *  cause collapses to the same opaque "closed before established". When we
     *  never connected, probe /api/auth/gate-check, which re-runs the SAME entry
     *  gate the queue upgrade uses and returns the REAL verdict, so we tell the
     *  player what's actually wrong instead of guessing.
     *
     *  We must NOT assume "signed in -> must be a $KINS problem": a paying player
     *  with thousands of $KINS gets a rejected upgrade whenever the gate's Solana
     *  balance check times out under load (gate: balance_check_failed), or when
     *  the rejection was capacity / handoff / transient (gate: ok). The probe
     *  separates those so we never tell a funded player they're broke.
     *  Returns a specific message, or null if we couldn't even reach the probe
     *  (genuine network / reachability problem -> caller uses the generic text). */
    async function classifyGateConnectFailure(shardId) {
      try {
        const shardQ = Number(shardId) > 0 ? `?shard=${Number(shardId) | 0}` : '';
        const r = await fetch(`/api/auth/gate-check${shardQ}`, { credentials: 'include', cache: 'no-store' });
        let body = null;
        try { body = await r.json(); } catch (_) { /* non-JSON / empty */ }
        const gate = body && typeof body.gate === 'string' ? body.gate : '';
        if (gate === 'session' || r.status === 401) {
          return 'Your session has expired. Reload the page and sign in again.';
        }
        if (gate === 'level_required') {
          /** This shard is level-gated (e.g. "Server 1 (Level 20+)") and the
           *  player's average skill level is below the floor. */
          const need = body && Number(body.minLevel) > 0 ? Number(body.minLevel) | 0 : 20;
          const have = body && Number.isFinite(Number(body.avgLevel)) ? Number(body.avgLevel) | 0 : null;
          return have != null
            ? `This server needs an average skill level of ${need}+. You're level ${have} — keep training and come back, or pick another server.`
            : `This server needs an average skill level of ${need}+. Pick another server, or keep training to unlock it.`;
        }
        if (gate === 'kins_required') {
          /** Genuinely under the 1,000 $KINS minimum. */
          return 'You need at least 1,000 $KINS in your wallet to enter this realm. If you just topped up, wait a moment and retry.';
        }
        if (gate === 'balance_check_failed' || gate === 'balance_check_timeout') {
          /** We could NOT verify the balance (RPC slow/down) — the player may
           *  well hold plenty. Do NOT claim they're broke; ask them to retry. */
          return 'We couldn’t verify your $KINS balance just now — the network is busy. Please wait a moment and retry.';
        }
        if (gate === 'ok' || (r && r.ok)) {
          /** Gate passes: the upgrade was rejected for some other reason
           *  (server at capacity / handoff hiccup / transient). Generic retry —
           *  never a $KINS message for a player who clearly qualifies. */
          return 'The realm gate is busy right now. Please retry in a moment.';
        }
        /** Unknown shape — fall back to the generic caller text. */
        return null;
      } catch (_) {
        return null;
      }
    }

    async function startQueueFor(shardId) {
      setBootPhase('Joining the world…', 90);
      if (adminBypassQueue) {
        settle(shardId);
        return;
      }
      let queueCtl = null;
      /** True once the WS handshake completed (onopen). Distinguishes an
       *  upgrade-level rejection (never connected -> probe for the real reason)
       *  from a genuine mid-queue disconnect (connected then dropped). */
      let everConnected = false;
      try {
        await new Promise((res, rej) => {
          let ws;
          let done = false;
          let queueTimeout = null;
          const clearQueueTimeout = () => {
            if (queueTimeout != null) {
              clearTimeout(queueTimeout);
              queueTimeout = null;
            }
          };
          const resolveOnce = () => {
            if (done) return;
            done = true;
            clearQueueTimeout();
            res();
          };
          const rejectOnce = err => {
            if (done) return;
            done = true;
            clearQueueTimeout();
            rej(err);
          };
          try {
            ws = new WebSocket(wsUrl(`/ws/queue/s${shardId}`));
          } catch (e) {
            rejectOnce(e);
            return;
          }
          activeQueueWs = ws;
          let connected = false;
          const onQueueTimeout = () => {
            rejectOnce(new Error(connected ? 'queue_no_response_timeout' : 'queue_connect_timeout'));
            try { ws.close(); } catch (_) { /* ignore */ }
          };
          /** Pre-connect: fixed connect deadline. After the first server message
           *  we re-arm this on EVERY message (see onmessage) as a sliding silence
           *  watchdog — so a player actively waiting in the queue (receiving
           *  queue_pos every ~5s) is never killed by a fixed deadline. Only a
           *  genuinely unresponsive gate (silent > QUEUE_STALL_TIMEOUT_MS) fails. */
          const armQueueTimeout = ms => {
            clearQueueTimeout();
            queueTimeout = setTimeout(onQueueTimeout, ms);
          };
          armQueueTimeout(QUEUE_CONNECT_TIMEOUT_MS);
          ws.onopen = () => {
            connected = true;
            everConnected = true;
            if (pingTimer == null) {
              pingTimer = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) return;
                try { ws.send(JSON.stringify({ t: 'q_ping' })); } catch (_) { /* ignore */ }
              }, QUEUE_PING_MS);
            }
          };
          ws.onmessage = ev => {
            let msg;
            try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
            catch (_) { return; }
            if (!msg || typeof msg !== 'object') return;
            /** Any valid server message proves the gate is alive — slide the
             *  silence watchdog forward. Queued players receive queue_pos every
             *  ~5s, so this keeps them connected indefinitely while waiting. */
            armQueueTimeout(QUEUE_STALL_TIMEOUT_MS);
            if (msg.t === 'queue_ready') {
              resolveOnce();
              settle(shardId);
              return;
            }
            if (msg.t === 'queue_pos') {
              if (!queueCtl) queueCtl = renderQueue(shardId, { pos: msg.pos, ahead: msg.ahead });
              else queueCtl.updatePos(msg.pos, msg.ahead);
              return;
            }
            if (msg.t === 'queue_error') {
              rejectOnce(new Error(`queue_error:${msg.reason || 'unknown'}`));
            }
            if (msg.t === 'queue_evicted') {
              rejectOnce(new Error(`queue_evicted:${msg.reason || 'unknown'}`));
            }
          };
          ws.onerror = () => {
            if (!connected) rejectOnce(new Error('queue_ws_failed'));
          };
          ws.onclose = ev => {
            if (pingTimer != null) { clearInterval(pingTimer); pingTimer = null; }
            if (done) return;
            if (settled) return;
            const code = ev && typeof ev.code === 'number' ? ev.code : 0;
            if (code === 1000) {
              rejectOnce(new Error('queue_closed_before_ready'));
              return;
            }
            if (code === 4000) {
              rejectOnce(new Error('queue_replaced'));
              return;
            }
            if (code === 4001) {
              rejectOnce(new Error('queue_auth'));
              return;
            }
            rejectOnce(new Error(`queue_closed:${code || 'unknown'}`));
          };
        });
      } catch (e) {
        if (settled) return;
        const msg = (e && e.message) || 'queue_error';
        if (msg.includes('queue_auth')) { fail(e, 'You are not signed in. Reload the page and sign in again.'); return; }
        if (msg.includes('queue_evicted:idle')) { fail(e, 'Your queue spot timed out. Please try again.'); return; }
        if (msg.includes('queue_evicted:replaced')) { fail(e, 'You joined the queue from another tab.'); return; }
        /** Handshake never completed: the upgrade was rejected (stale session /
         *  $KINS gate / ban) or the gate was unreachable. The browser hides the
         *  reason, so probe to recover it. If we DID connect and then dropped,
         *  it's a genuine mid-queue disconnect — keep the connection-lost text. */
        if (!everConnected) {
          const refined = await classifyGateConnectFailure(shardId);
          if (settled) return;
          if (refined) { fail(e, refined); return; }
        }
        if (msg.includes('queue_connect_timeout') || msg.includes('queue_no_response_timeout')) fail(e, 'The realm gate did not answer in time. Please retry.');
        else fail(e, 'We lost the connection to the realm gate while you were queued.');
      }
    }

    async function renderSelection() {
      card.innerHTML = '';
      const sub = document.createElement('p');
      sub.className = 'kintara-server-select-sub';
      sub.textContent = '— Choose your realm —';
      const title = document.createElement('div');
      title.className = 'kintara-server-select-title';
      title.textContent = 'Select a Server';
      const blurb = document.createElement('p');
      blurb.className = 'kintara-server-select-blurb';
      blurb.textContent = 'Each server is a separate world. Friends should pick the same one.';
      const list = document.createElement('div');
      list.className = 'kintara-server-select-list';
      card.append(sub, title, blurb, list);
      setBootConnectingMode('Choose a server…');
      setBootPhase('Choose a server…', 85);

      function paintServers(servers) {
        list.innerHTML = '';
        if (!servers || !servers.length) {
          const msg = document.createElement('div');
          msg.className = 'kintara-server-select-error';
          msg.textContent = 'No servers are currently reachable. Retrying…';
          list.appendChild(msg);
          return;
        }
        for (const s of servers) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'kintara-server-card';
          const isFull = !adminBypassQueue && !!s.full;
          if (isFull && s.queueLength > 80) btn.disabled = true;
          /** Level-gated special server the viewer can't enter yet → grey it out
           *  (the WS upgrade still enforces it server-side; this is just so they
           *  don't click into a bounce). Only when we actually know their level. */
          const needLvl = Number(s.minLevel) > 0 ? Number(s.minLevel) | 0 : 0;
          const levelLocked =
            !adminBypassQueue && needLvl > 0 && viewerAvgLevel != null && viewerAvgLevel < needLvl;
          if (levelLocked) btn.disabled = true;
          const left = document.createElement('div');
          const name = document.createElement('div');
          name.className = 'kintara-server-card__name';
          name.textContent = s.name || `Server ${s.id}`;
          const hint = document.createElement('div');
          hint.className = 'kintara-server-card__hint';
          if (levelLocked) {
            hint.textContent = `🔒 Requires Level ${needLvl} — you're Level ${viewerAvgLevel}`;
          } else if (adminBypassQueue) {
            hint.textContent = s.full
              ? 'Admin · join anytime (over capacity ok)'
              : 'Admin · join instantly';
          } else if (needLvl > 0) {
            hint.textContent = isFull
              ? (s.queueLength > 0 ? `Level ${needLvl}+ · Full · ${s.queueLength} in queue` : `Level ${needLvl}+ · Full`)
              : `Level ${needLvl}+ · join instantly`;
          } else {
            hint.textContent = isFull
              ? (s.queueLength > 0 ? `Full · ${s.queueLength} in queue` : 'Full · queue opens')
              : 'Open · join instantly';
          }
          left.append(name, hint);
          const pop = document.createElement('span');
          pop.className = 'kintara-server-card__pop';
          const bucket = adminBypassQueue ? (s.populationLabel || 'Low') : (isFull ? 'Full' : (s.populationLabel || 'Low'));
          pop.dataset.bucket = bucket;
          pop.textContent = bucket;
          btn.append(left, pop);
          btn.addEventListener('click', () => {
            if (btn.disabled) return;
            if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
            void startQueueFor(s.id);
          });
          list.appendChild(btn);
        }
      }

      async function refresh() {
        try {
          const payload = await fetchServers();
          adminBypassQueue = payload.adminBypass === true;
          paintServers(payload.servers);
        } catch (e) {
          if (!list.children.length) paintServers(null);
        }
      }
      await fetchViewerLevel();
      await refresh();
      if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
      pollTimer = setInterval(refresh, SERVERS_POLL_MS);
    }

    (async function autoJoinBestServer() {
      try {
        const payload = await fetchServers();
        const servers = payload && payload.servers;
        if (!servers || !servers.length) { void renderSelection(); return; }

        let playerLevel = null;
        try {
          const lr = await fetch('/api/auth/viewer-level', {credentials:'include', cache:'no-store'});
          const lj = await lr.json().catch(()=>null);
          playerLevel = lj && lj.ok && Number.isFinite(Number(lj.avgLevel)) ? Number(lj.avgLevel)|0 : null;
        } catch(_) {}

        const preferred = agGetPreferredServer();
        let target = null;

        if (preferred) {
          const found = servers.find(s => String(s.id) === String(preferred));
          if (found) {
            const needLvl = Number(found.minLevel) > 0 ? Number(found.minLevel)|0 : 0;
            if (needLvl > 0 && playerLevel !== null && playerLevel < needLvl) {
              console.warn('[AutoGather] Servidor preferido', preferred, 'requer nivel', needLvl, '(jogador nivel', playerLevel, ') — usando auto');
            } else {
              target = found;
              console.info('[AutoGather] Servidor preferido', preferred, target.full ? '(cheio — na fila)' : '(livre)');
            }
          }
        }

        if (!target) {
          const eligible = servers.filter(s => {
            const needLvl = Number(s.minLevel) > 0 ? Number(s.minLevel)|0 : 0;
            if (needLvl > 0 && playerLevel !== null && playerLevel < needLvl) return false;
            return true;
          });
          const pool = eligible.length ? eligible : servers;
          const sorted = [...pool].sort((a, b) => {
            const aF = (!payload.adminBypass && !!a.full) ? 1 : 0;
            const bF = (!payload.adminBypass && !!b.full) ? 1 : 0;
            if (aF !== bF) return aF - bF;
            return (a.queueLength||0) - (b.queueLength||0);
          });
          target = sorted[0];
          console.info('[AutoGather] Auto-selecionado servidor:', target.id, '| fila:', target.queueLength||0);
        }

        void startQueueFor(target.id);
      } catch (err) {
        console.error('[AutoGather] autoJoinBestServer erro:', err);
        void renderSelection();
      }
    })();

    /** Surface a public abort handle so the game can cancel selection if e.g.
     *  the user navigates away or the auth-gate suddenly loses the session. */
    if (typeof window !== 'undefined') {
      window.__kintaraServerSelectAbort = () => abort(new Error('server_select_aborted'));
    }
  });
}

/**
 * Helper for the game-side reconnect path. Once a player has already entered
 * a shard and is then briefly disconnected (Wi-Fi blip, laptop lid), we
 * should reconnect to the SAME shard without re-showing the selection
 * screen. This helper exposes the cached presence URL for the shard that
 * was last successfully entered.
 */
let _lastShardId = null;
let _lastPresenceUrl = null;
export function shardIdFromPresenceUrl(url) {
  const s = String(url || '');
  const m = s.match(/\/ws\/presence\/s(\d+)/i);
  if (m) return Math.max(1, Number(m[1]) | 0 || 1);
  if (/\/ws\/presence(?:\/|\?|$)/i.test(s)) return 1;
  return null;
}
export function recordLastShard(shardId) {
  const sid = Math.max(1, Number(shardId) | 0 || 0);
  if (!sid) return;
  _lastShardId = sid;
  _lastPresenceUrl = wsUrl(`/ws/presence/s${sid}`);
}
export function getLastShardId() { return _lastShardId; }
export function getLastPresenceUrl() { return _lastPresenceUrl; }
export function clearLastShardCache() {
  _lastShardId = null;
  _lastPresenceUrl = null;
}
