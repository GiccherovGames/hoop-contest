/* ============================================================
   HOOP CONTEST — clone moderno arcade basket (modello Flash)
   - Muovi il mouse -> arco tratteggiato -> click -> tiro
   - Nessun drag, nessuna carica, nessuna power bar
   - Fisica 2D custom: gravita, pavimento, tabellone, ferro,
     sensore canestro valido solo dall'alto verso il basso
   ============================================================ */
(() => {
"use strict";

const W = 1280, H = 720;
const FLOOR_Y = H - 70;
const SLOW = 0.85; // fattore velocita di volo: tutto piu fluttuante e lento
const GRAVITY = 2100 * SLOW * SLOW; // scala al quadrato: le traiettorie restano identiche
const PHYS_DT = 1 / 120; // timestep fisso: fisica e anteprima integrano identico
const BALL_R = 11;
const MAX_POWER = 1750;
const MIN_APEX = 50;      // altezza minima del vertice sopra la palla (px)
const T_GROW = 0.0005;    // crescita tempo di volo per px sotto la soglia (s/px)
const CONTEST_LEN = 120; // 2 minuti

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const holder = document.getElementById("canvas-holder");
const floatLayer = document.getElementById("float-layer");

// Hoop compatto e proporzionato come un vero canestro: ferro 42px su palla
// da 22px (rapporto 1.91, come 45cm / 24cm reali). Struttura minimale.
// Il ferro e' completamente FISSO: nessun movimento all'impatto.
const hoop = { cx: W - 190, rimY: 265, rimW: 42, boardW: 10, boardH: 70 };
const rimL = () => hoop.cx - hoop.rimW / 2;
const rimR = () => hoop.cx + hoop.rimW / 2;
const boardX = () => hoop.cx + hoop.rimW / 2 + 12;

// Stato
let state = "menu"; // menu | play | over
let timeLeft = CONTEST_LEN;
let score = 0, shots = 0, makes = 0, cleanCount = 0, bestShot = 0;
let ball = null, nextSpawn = null, aim = { x: W / 2, y: H / 2, active: false };
let particles = [], trail = [];
let contestTimer = null, netTick = null;
let myId = "p_" + Math.random().toString(36).slice(2, 8);
let myName = "Arcade_" + Math.floor(1000 + Math.random() * 9000); // unico per scheda
// ---------- PIATTAFORMA ----------
const CFG = window.HOOP_CONFIG || {};
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const IS_TOUCH = IS_NATIVE || (window.matchMedia && window.matchMedia("(hover:none) and (pointer:coarse)").matches);

// Server multiplayer: ?ws= > config.js > stessa origine (PC).
// Su Android senza server configurato si evita un wss://localhost inutile.
function wsUrlFrom(base) {
  if (!base) return null;
  const b = String(base).trim().replace(/\/+$/, "");
  if (/^wss?:/i.test(b)) return b;
  return b.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}
const WS_URL = wsUrlFrom(new URLSearchParams(location.search).get("ws") || CFG.server) ||
  (IS_NATIVE ? null
    : ((location.protocol === "http:" || location.protocol === "https:")
      ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host : null));

// ---------- AUDIO (mini, WebAudio) ----------
let AC = null;
function beep(f, d = 0.12, type = "sine", v = 0.15) {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.value = v;
    o.connect(g); g.connect(AC.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + d);
    o.stop(AC.currentTime + d);
  } catch (e) {}
}
const sndShoot = () => beep(300, 0.1, "triangle", 0.1);
const sndRim = () => beep(180, 0.12, "square", 0.06);
const sndSwish = () => { beep(660, 0.12); setTimeout(() => beep(880, 0.18), 90); };
const sndBoard = () => beep(140, 0.1, "square", 0.08);

// ---------- PUNTEGGIO CONTINUO su distanza IN LINEA D'ARIA dal ferro ----------
// d minima -> 2 punti, d massima -> 15 punti, interpolazione lineare con
// decimali (es. 7.4). Clean basket -> raddoppio.
const D_MIN = 130, D_MAX = 1100;
function pointsFor(x, y) {
  const d = Math.min(D_MAX, Math.max(D_MIN, Math.hypot(hoop.cx - x, hoop.rimY - y)));
  const pts = 2 + (d - D_MIN) / (D_MAX - D_MIN) * 13;
  return { pts, label: `da ${(d / 45).toFixed(0)} m` };
}
function fmt(n) { return String(Math.round(n * 10) / 10); } // 1 decimale, niente zeri inutili

// ---------- SPAWN: tutta l'area giocabile, situazioni sempre varie ----------
function randomSpawn(exclude = null) {
  // Mai sopra il livello del ferro: y sempre sotto rimY + margine
  const yMin = hoop.rimY + 30, yMax = FLOOR_Y - BALL_R;
  for (let i = 0; i < 30; i++) {
    const x = 60 + Math.random() * (W - 340);
    const y = yMin + Math.random() * (yMax - yMin);
    // mai sopra/sotto il ferro, mai identico al precedente
    if (Math.hypot(x - hoop.cx, y - hoop.rimY) < 130) continue;
    if (exclude && Math.hypot(x - exclude.x, y - exclude.y) < 170) continue;
    return { x, y };
  }
  return { x: 120 + Math.random() * 600, y: 320 + Math.random() * 300 };
}
function spawnBall() {
  const s = nextSpawn || randomSpawn();
  const info = pointsFor(s.x, s.y);
  ball = { x: s.x, y: s.y, vx: 0, vy: 0, flying: false, dead: false, alpha: 0, clean: true, scored: false, rest: 0, settleT: 0, prevY: s.y, bounces: 0, value: info.pts, label: info.label };
  nextSpawn = randomSpawn(s);
  trail = [];
  // la mira riparte dal centro alto: il giocatore muove il mouse e vede subito l'arco
  aim.active = false;
  showShotInfo(info);
}
function showShotInfo(info) {
  const el = document.getElementById("shot-info");
  el.style.display = "block";
  el.innerHTML = `🎯 Tiro da <b style="color:#d62828">+${fmt(info.pts)}</b> · ${info.label}`;
  clearTimeout(showShotInfo._t);
  showShotInfo._t = setTimeout(() => el.style.display = "none", 2600);
}

// ---------- RETE verlet: corde realistiche spostate dalla palla ----------
const NET_COLS = 6, NET_ROWS = 3, NET_LEN = 12;
let net = [];
function buildNet() {
  net = [];
  for (let c = 0; c < NET_COLS; c++) {
    const tx = rimL() + 2 + (hoop.rimW - 4) * (c / (NET_COLS - 1));
    const col = [];
    for (let r = 0; r <= NET_ROWS; r++)
      col.push({ x: tx, y: hoop.rimY + r * NET_LEN, px: tx, py: hoop.rimY + r * NET_LEN, pin: r === 0 });
    net.push(col);
  }
}
function netSatisfy(a, b, rest) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 0.0001;
  const f = (d - rest) / d;
  if (a.pin) { b.x -= dx * f; b.y -= dy * f; }
  else if (b.pin) { a.x += dx * f; a.y += dy * f; }
  else { a.x += dx * f * 0.5; a.y += dy * f * 0.5; b.x -= dx * f * 0.5; b.y -= dy * f * 0.5; }
}
function stepNet(dt) {
  if (!net.length) return;
  const sub = 2, h = Math.min(dt, 0.033) / sub;
  for (let s = 0; s < sub; s++) {
    for (const col of net) for (const n of col) {
      if (n.pin) continue;
      const vx = (n.x - n.px) * 0.985, vy = (n.y - n.py) * 0.985;
      n.px = n.x; n.py = n.y;
      n.x += vx; n.y += vy + 1400 * h * h;
    }
    if (ball) { // la palla sposta le corde
      for (const col of net) for (const n of col) {
        if (n.pin) continue;
        const dx = n.x - ball.x, dy = n.y - ball.y;
        const d = Math.hypot(dx, dy), min = BALL_R + 3;
        if (d < min && d > 0.001) { n.x = ball.x + dx / d * min; n.y = ball.y + dy / d * min; }
      }
    }
    for (let it = 0; it < 3; it++) {
      for (const col of net) for (let r = 1; r <= NET_ROWS; r++) netSatisfy(col[r - 1], col[r], NET_LEN);
      for (let r = 1; r <= NET_ROWS; r++) {
        const rest = ((hoop.rimW - 4) / (NET_COLS - 1)) * (1 - r * 0.12); // rete affusolata
        for (let c = 0; c < NET_COLS - 1; c++) netSatisfy(net[c][r], net[c + 1][r], rest);
      }
    }
  }
}

// ---------- NET: WebSocket reale con fallback a simulazione bot ----------
const Net = {
  mode: "sim", ws: null, players: [], total: 248,
  serverBoard: null, serverTotal: 0, phase: null, admitted: true,
  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) { this.hello(); return; }
    if (!WS_URL) { this.mode = "sim"; this.seedBots(); return; }
    try {
      this.mode = "ws";
      this.ws = new WebSocket(WS_URL);
      this.ws.onopen = () => this.hello();
      this.ws.onmessage = (e) => { try { this.onServer(JSON.parse(e.data)); } catch (err) {} };
      this.ws.onclose = () => this.toSim();
      this.ws.onerror = () => { try { this.ws.close(); } catch (err) {} };
    } catch (err) { this.toSim(); }
  },
  hello() { const w = document.getElementById("wantPlay"); this.send({ t: "join", id: myId, name: myName, want: !w || w.checked }); },
  toSim() { this.ws = null; this.serverBoard = null; this.admitted = true; if (this.mode === "ws") { this.mode = "sim"; this.seedBots(); } },
  onServer(m) {
    if (!m) return;
    if (m.t === "status") {
      this.admitted = !!m.admitted; this.phase = m.phase;
      const w = document.getElementById("wantPlay");
      if (w && m.want !== undefined && state === "menu") w.checked = m.want !== false;
      return;
    }
    if (m.t !== "board") return;
    this.phase = m.phase;
    this.serverBoard = m.players; this.serverTotal = m.total; this.phase = m.phase;
    if (this.mode !== "ws") return;
    timeLeft = m.timeLeft; // timer autoritativo dal server
    updateTimer(); renderBoard();
    const btn = document.getElementById("btnStart");
    if (state === "menu") {
      if (m.phase === "play" && this.admitted) startContest();
      else if (m.phase === "play") { if (btn) { btn.disabled = true; btn.textContent = `CONTEST IN CORSO · ENTRI TRA ${m.timeLeft}s`; } }
      else if (btn) { btn.disabled = true; btn.textContent = `PROSSIMO CONTEST TRA ${m.timeLeft}s`; }
    } else if (state === "over") {
      if (m.phase === "play" && this.admitted) startContest();
      else {
        const li = document.getElementById("lobbyInfo");
        if (li) li.textContent = m.phase === "play" ? `Entrerai nel prossimo contest tra ${m.timeLeft}s` : `Prossimo contest tra ${m.timeLeft}s`;
        const again = document.getElementById("btnAgain");
        if (again) again.disabled = true;
      }
    } else if (state === "play" && m.phase !== "play") endContest();
  },
  names: ["Jordan_23","CurryFan","Axel","Bobo","SlamDunk","Kobe8","Miky","Lakers_Fan","AirBall","CoachP","DunkLord","TrePunti","Nico","FastBreak","Zo_2","BigMama","Swish","Rook1e","Buzzer","Gigi"],
  seedBots() {
    this.players = [];
    for (let i = 0; i < this.total - 1; i++) {
      const n = this.names[i % this.names.length] + (i >= this.names.length ? "_" + (Math.floor(i / this.names.length) + 1) : "");
      this.players.push({ id: "b" + i, name: n, score: 0, shots: 0, skill: 0.3 + Math.random() * 1.4 });
    }
  },
  // tick server-authoritative simulato: i bot segnano in modo realistico
  serverTick(dt) {
    if (this.mode !== "sim") return;
    for (const p of this.players) {
      if (Math.random() < 0.06 * p.skill * dt * 2) {
        const base = 2 + Math.random() * 13; // stesso range dei giocatori veri
        const clean = Math.random() < 0.15;
        p.score = Math.round((p.score + base * (clean ? 2 : 1)) * 10) / 10;
        p.shots += 1;
      } else if (Math.random() < 0.02 * dt * 2) p.shots++;
    }
  },
  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); },
  publish() { this.send({ t: "update", id: myId, score, shots, makes }); },
  board() {
    if (this.mode === "ws" && this.serverBoard) {
      // classifica autoritativa: record avversari dal server, mio punteggio live
      const map = new Map(this.serverBoard.map(p => [p.id, { ...p }]));
      map.set(myId, { id: myId, name: this.admitted ? myName : myName + " (attesa)", score, shots, me: true });
      const all = [...map.values()];
      all.sort((a, b) => b.score - a.score || a.shots - b.shots);
      all.forEach((p, i) => p.rank = i + 1);
      return all;
    }
    const all = [...this.players, { id: myId, name: myName, score, shots, me: true }];
    all.sort((a, b) => b.score - a.score || a.shots - b.shots);
    all.forEach((p, i) => p.rank = i + 1);
    return all;
  }
};

// ---------- UI LEADERBOARD ----------
function renderBoard() {
  const board = Net.board();
  const me = board.find(p => p.me);
  const total = liveTotal();
  document.getElementById("score").textContent = fmt(score);
  document.getElementById("shots").textContent = shots;
  document.getElementById("rank").textContent = "#" + me.rank;
  document.getElementById("playersCount").textContent = total + " giocatori";
  const pct = total <= 1 ? 100 : (1 - (me.rank - 1) / (total - 1)) * 100;
  document.getElementById("rankbar-marker").style.left = pct + "%";
  document.getElementById("rankbar-pos").textContent = "#" + me.rank + " / " + total;

  const list = document.getElementById("lbList");
  const top = board.slice(0, 4);
  let html = top.map(p => `<li class="${p.me ? "me" : ""}"><span class="pos">${p.rank}°</span>${esc(p.name)}<span class="pts">${fmt(p.score)}</span></li>`).join("");
  if (me.rank > 5) html += `<li style="text-align:center;opacity:.5">···</li><li class="me"><span class="pos">${me.rank}°</span>TU<span class="pts">${fmt(me.score)}</span></li>`;
  else if (!top.some(p => p.me)) html += `<li class="me"><span class="pos">${me.rank}°</span>TU<span class="pts">${fmt(me.score)}</span></li>`;
  list.innerHTML = html;
}
function esc(s) { return String(s).replace(/[<>"]/g, ""); }
function liveTotal() { return Net.mode === "ws" && Net.serverTotal ? Net.serverTotal : Net.total; }

function floatText(x, y, txt, color = "#d62828", size = 34) {
  const r = canvas.getBoundingClientRect();
  const sx = r.width / W, sy = r.height / H;
  const d = document.createElement("div");
  d.className = "float";
  d.textContent = txt;
  d.style.left = (x * sx) + "px"; d.style.top = (y * sy) + "px";
  d.style.color = color; d.style.fontSize = size + "px";
  floatLayer.appendChild(d);
  setTimeout(() => d.remove(), 1450);
}

// ---------- INPUT originale Flash: muovi -> vedi arco -> click -> tiro ----------
// La palla resta ferma. Solo il cursore si muove, l'arco si aggiorna in
// tempo reale, un singolo click lancia subito. Niente drag/hold/carica.
function toGame(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
}
// Mira unificata: l'anteprima va sempre dalla palla AL CURSORE e il
// cerchio e' sempre sul cursore; il volo reale prosegue oltre.
// - Cursore SOPRA la palla: il cursore E' il vertice (apice) della parabola.
// - Cursore A LIVELLO o SOTTO: targeting a tempo di volo (angolo anche
//   negativo, verso il basso), con continuita' esatta al confine: le due
//   formule coincidono per u = 0.
// Entrambe risolvono l'equazione discreta a passo fisso, quindi palla e
// cerchio cadono ESATTAMENTE sul mouse. Ritorna anche gli step da disegnare.
function aimVelocity() {
  if (!ball) return null;
  if (aim.y < ball.y - MIN_APEX) {
    const apexY = aim.y;
    let vy = -Math.sqrt(2 * GRAVITY * (ball.y - apexY));
    let n = 1;
    for (let k = 0; k < 4; k++) {
      n = Math.max(1, Math.floor(-vy / (GRAVITY * PHYS_DT)));
      vy = (apexY - ball.y) / (PHYS_DT * n) - GRAVITY * PHYS_DT * (n + 1) / 2;
    }
    n = Math.max(1, Math.floor(-vy / (GRAVITY * PHYS_DT)));
    let vx = (aim.x - ball.x) / (n * PHYS_DT);
    const sp = Math.hypot(vx, vy);
    if (sp > MAX_POWER) { const s = MAX_POWER / sp; vx *= s; vy *= s; }
    return { vx, vy, steps: n };
  }
  const u = aim.y - (ball.y - MIN_APEX); // profondita' sotto la soglia, >= 0
  const m = Math.max(2, Math.round((Math.sqrt(2 * MIN_APEX / GRAVITY) + T_GROW * u) / PHYS_DT));
  let vx = (aim.x - ball.x) / (m * PHYS_DT);
  let vy = (aim.y - ball.y) / (m * PHYS_DT) - GRAVITY * PHYS_DT * (m + 1) / 2;
  const sp = Math.hypot(vx, vy);
  if (sp < 80) return null; // cursore addosso alla palla: nessun tiro
  if (sp > MAX_POWER) { const s = MAX_POWER / sp; vx *= s; vy *= s; }
  return { vx, vy, steps: m };
}
function shoot() {
  if (state !== "play" || !ball || ball.flying || ball.dead) return;
  // su touch al primo tocco si mira soltanto, il tiro parte al tap successivo
  const v = aimVelocity();
  if (!v) return;
  ball.vx = v.vx; ball.vy = v.vy;
  ball.flying = true; ball.settleT = 0; ball.rest = 0; ball.bounces = 0;
  shots++;
  sndShoot();
  Net.publish(); renderBoard();
}
let touchAim = false; // dito giu' = si mira, al rilascio si tira
canvas.addEventListener("pointermove", (e) => {
  const p = toGame(e);
  aim.x = p.x; aim.y = p.y; aim.active = true;
});
canvas.addEventListener("pointerdown", (e) => {
  const p = toGame(e);
  aim.x = p.x; aim.y = p.y; aim.active = true;
  if (e.pointerType === "touch" || e.pointerType === "pen") {
    // touch: trascina per mirare (arco aggiornato in tempo reale), rilascia per tirare.
    // Coerente con il modello originale: prima si mira, poi si conferma il tiro.
    touchAim = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    return;
  }
  shoot(); // mouse: un click, tiro immediato
});
canvas.addEventListener("pointerup", (e) => {
  if (!touchAim) return;
  touchAim = false;
  const p = toGame(e);
  aim.x = p.x; aim.y = p.y; aim.active = true;
  shoot(); // rilascio del dito = tiro
});
canvas.addEventListener("pointercancel", () => { touchAim = false; });
canvas.addEventListener("pointerleave", () => { if (!touchAim) aim.active = false; });
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- FISICA ----------
function circleHit(bx, by, cx, cy, rr) {
  const dx = bx - cx, dy = by - cy, d = Math.hypot(dx, dy), min = BALL_R + rr;
  if (d < min && d > 0.01) {
    const nx = dx / d, ny = dy / d;
    return { nx, ny, depth: min - d };
  }
  return null;
}
let physAcc = 0;
function stepPhysics(dt) {
  if (!ball || !ball.flying) { physAcc = 0; return; }
  physAcc = Math.min(physAcc + dt, 0.12); // accumulatore a passo fisso
  let iter = 0;
  while (physAcc >= PHYS_DT && iter++ < 16 && ball.flying) {
    physAcc -= PHYS_DT;
    physStep();
  }
}
function physStep() {
  const dt = PHYS_DT; // identico al passo dell'anteprima: volo == preview
  ball.prevY = ball.y;
  ball.vy += GRAVITY * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const RIM_R = 4;

  // Ferro: due anelli (qualsiasi contatto invalida il clean basket)
  for (const cx of [rimL(), rimR()]) {
    const h = circleHit(ball.x, ball.y, cx, hoop.rimY, RIM_R);
    if (h) {
      ball.clean = false;
      ball.x += h.nx * h.depth; ball.y += h.ny * h.depth;
      const vn = ball.vx * h.nx + ball.vy * h.ny;
      if (vn < 0) {
        ball.vx -= 1.55 * vn * h.nx; ball.vy -= 1.55 * vn * h.ny;
        ball.vx *= 0.88; ball.vy *= 0.88;
        sndRim(); // solo audio: niente particelle, ferro fisso
      }
    }
  }
  // Tabellone (AABB)
  const bx = boardX(), by = hoop.rimY - hoop.boardH / 2;
  if (ball.x + BALL_R > bx && ball.x - BALL_R < bx + hoop.boardW &&
      ball.y + BALL_R > by && ball.y - BALL_R < by + hoop.boardH) {
    if (ball.vx > 0 && ball.x < bx) {
      ball.x = bx - BALL_R; ball.vy *= 0.85;
      ball.vx = -ball.vx * 0.62; ball.clean = false; sndBoard();
    }
  }
  // Pavimento (toccarlo invalida il clean basket)
  if (ball.y + BALL_R > FLOOR_Y) {
    ball.y = FLOOR_Y - BALL_R;
    if (Math.abs(ball.vy) > 120) beep(110, 0.06, "sine", 0.05);
    ball.clean = false;
    ball.vy = -ball.vy * 0.58;
    ball.vx *= 0.82;
    if (Math.abs(ball.vy) < 60) ball.vy = 0;
    ball.bounces++;
  }
  // Pareti
  if (ball.x - BALL_R < 0) { ball.x = BALL_R; ball.vx = -ball.vx * 0.6; }
  if (ball.x + BALL_R > W) { ball.x = W - BALL_R; ball.vx = -ball.vx * 0.6; }

  // La rete frena appena la palla che la attraversa
  if (ball.y > hoop.rimY && ball.y < hoop.rimY + 50 && Math.abs(ball.x - hoop.cx) < hoop.rimW / 2 + BALL_R)
    ball.vx *= 1 - 1.2 * dt;

  // Sensore canestro: attraversamento dall'alto verso il basso
  if (!ball.scored && ball.vy > 0 && ball.prevY < hoop.rimY - 4 && ball.y >= hoop.rimY - 4 &&
      ball.x > rimL() + 10 && ball.x < rimR() - 10) {
    onScore();
  }

  // Palla ferma / fuori gioco -> palla nuova SUBITO (ritmo arcade 2-4s a tiro)
  ball.settleT += dt;
  const slow = Math.hypot(ball.vx, ball.vy) < 50 && ball.y + BALL_R >= FLOOR_Y - 2;
  if (slow) ball.rest += dt; else ball.rest = 0;
  const out = ball.x < -60 || ball.x > W + 60 || ball.y > H + 60;
  if (ball.rest > 0.35 || ball.bounces >= 2 || ball.settleT > 2.8 || out) {
    ball.flying = false; ball.dead = true; ball.rest = -99; // in attesa della palla nuova: niente preview/tiro
    setTimeout(() => { if (state === "play") spawnBall(); }, ball.scored ? 550 : 220);
  }
}

function onScore() {
  ball.scored = true;
  const base = ball.value;
  const pts = ball.clean ? base * 2 : base; // CLEAN BASKET: punti raddoppiati
  score += pts; makes++; bestShot = Math.max(bestShot, pts);
  if (ball.clean) { cleanCount++; setTimeout(() => beep(1174, 0.22), 180); }
  sndSwish();
  burst(hoop.cx, hoop.rimY, pts >= 20 ? 26 : 14, ball.clean ? "#ffd166" : "#e9c46a");
  if (ball.clean) floatText(hoop.cx - 70, hoop.rimY - 130, "CLEAN!", "#2a9d8f", 30);
  floatText(hoop.cx - 40, hoop.rimY - 90, "+" + fmt(pts), ball.clean ? "#b45309" : "#d62828", ball.clean || pts >= 20 ? 52 : 38);
  const board = Net.board();
  const me = board.find(p => p.me);
  floatText(hoop.cx - 60, hoop.rimY - 40, `RANK #${me.rank} · ${liveTotal()} giocatori`, "#16395f", 15);
  Net.publish(); renderBoard();
  if (pts >= 30) confetti();
}

function burst(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 120 + Math.random() * 320;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 150, life: 0.7 + Math.random() * 0.4, t: 0, color });
  }
}
function confetti() {
  for (let i = 0; i < 70; i++) {
    particles.push({ x: Math.random() * W, y: -20, vx: (Math.random() - 0.5) * 200, vy: 200 + Math.random() * 300, life: 1.6, t: 0, color: ["#e76f51", "#2a9d8f", "#e9c46a", "#3a7bce"][i % 4] });
  }
}

// ---------- RENDER ----------
let dpr = 1; // densita' schermo: canvas nitido su telefoni e monitor hi-dpi
function isCompact() {
  return window.matchMedia && window.matchMedia("(orientation:landscape) and (max-height:600px)").matches;
}
function resize() {
  const r = holder.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2); // tappo a 2x: nitido senza sprecare memoria
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  let h;
  if (isCompact()) {
    // telefono/tablet in orizzontale: il campo entra tutto, niente scroll
    const bw = r.width || 1, bh = holder.clientHeight || r.width * (H / W);
    h = Math.max(140, Math.min(bw * (H / W), bh, 620));
    canvas.style.width = Math.round(h * (W / H)) + "px";
  } else {
    canvas.style.width = "";
    h = Math.max(420, Math.min(620, r.width * (H / W)));
  }
  canvas.style.height = h + "px";
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 120));
if (window.visualViewport) window.visualViewport.addEventListener("resize", resize);

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // coordinate logiche 1280x720, pixel reali = nitidi
  // cielo crema
  ctx.fillStyle = "#faf3df"; ctx.fillRect(0, 0, W, H);
  // fascia azzurra alta
  ctx.fillStyle = "#dce7f3"; ctx.fillRect(0, 0, W, 150);
  ctx.fillStyle = "#16395f";
  ctx.font = "900 22px Inter,sans-serif"; ctx.globalAlpha = 0.12;
  ctx.fillText("HOOP CONTEST · GLOBAL 2:00", 30, 46);
  ctx.globalAlpha = 1;

  // linee campo minimali
  ctx.strokeStyle = "rgba(22,57,95,.18)"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(W / 2, FLOOR_Y, 120, Math.PI, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W / 2, FLOOR_Y - 120); ctx.lineTo(W / 2, FLOOR_Y); ctx.stroke();

  // pavimento
  ctx.fillStyle = "#234e7f"; ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
  ctx.fillStyle = "#1a3c63"; ctx.fillRect(0, FLOOR_Y, W, 8);
  ctx.fillStyle = "rgba(255,255,255,.15)";
  for (let x = 20; x < W; x += 80) ctx.fillRect(x, FLOOR_Y + 28, 40, 6);

  drawHoop();
  drawNextGhost();
  drawBallWithAim();
  drawParticles();
}

function drawHoop() {
  const y = hoop.rimY;
  // palo sottile
  ctx.fillStyle = "#16395f";
  ctx.fillRect(boardX() + hoop.boardW + 2, y - hoop.boardH / 2 - 80, 6, 80 + hoop.boardH / 2);
  // tabellone compatto, niente riquadri interni
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#16395f"; ctx.lineWidth = 4;
  const bx = boardX();
  ctx.beginPath(); ctx.rect(bx, y - hoop.boardH / 2, hoop.boardW, hoop.boardH); ctx.fill(); ctx.stroke();

  // rete verlet: corde + anelli, mossa dalla palla
  ctx.strokeStyle = "#aeb9cc"; ctx.lineWidth = 2;
  ctx.beginPath();
  for (const col of net) {
    ctx.moveTo(col[0].x, col[0].y);
    for (let r = 1; r <= NET_ROWS; r++) ctx.lineTo(col[r].x, col[r].y);
  }
  for (let r = 1; r <= NET_ROWS; r++) {
    ctx.moveTo(net[0][r].x, net[0][r].y);
    for (let c = 1; c < NET_COLS; c++) ctx.lineTo(net[c][r].x, net[c][r].y);
  }
  ctx.stroke();

  // ferro proporzionato alla palla
  ctx.strokeStyle = "#d62828"; ctx.lineWidth = 5; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(rimL(), y); ctx.lineTo(rimR(), y); ctx.stroke();
  ctx.fillStyle = "#d62828";
  ctx.beginPath(); ctx.arc(rimL(), y, 4, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(rimR(), y, 4, 0, 7); ctx.fill();
}

function drawNextGhost() {
  if (!nextSpawn || state !== "play") return;
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#e76f51";
  ctx.beginPath(); ctx.arc(nextSpawn.x, nextSpawn.y, 8, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;
  document.getElementById("next-dot").style.left = "";
}

function drawBallWithAim() {
  if (!ball) return;
  const a = ball.alpha;
  // scia
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i];
    ctx.globalAlpha = (i / trail.length) * 0.3 * a;
    ctx.fillStyle = "#e76f51";
    ctx.beginPath(); ctx.arc(p.x, p.y, BALL_R * (i / trail.length), 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Arco tratteggiato di anteprima: segue il cursore in tempo reale.
  // Solo preview, niente frecce, niente power meter.
  // Mai sulla palla vecchia in attesa di respawn (dead).
  if (aim.active && !ball.flying && !ball.dead && state === "play") {
    const v = aimVelocity();
    if (v) {
      // Anteprima palla -> cursore con lo stesso integratore e passo della
      // fisica: l'arco mostrato e' bit-identico al volo reale e termina
      // ESATTAMENTE sul cursore, dove compare il cerchio marcatore.
      // Il volo reale prosegue oltre il cerchio (caduta nel ferro).
      let px = ball.x, py = ball.y, pvx = v.vx, pvy = v.vy;
      let ax = px, ay = py;
      ctx.save();
      ctx.strokeStyle = "rgba(22,57,95,.55)";
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 9]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      const total = Math.min(v.steps, 400);
      for (let i = 0; i < total; i++) {
        pvy += GRAVITY * PHYS_DT; px += pvx * PHYS_DT; py += pvy * PHYS_DT;
        ctx.lineTo(px, py);
        ax = px; ay = py;
        if (py > FLOOR_Y || px < 0 || px > W) break;
      }
      ctx.stroke();
      ctx.restore();
      // cerchio marcatore sul cursore (fine anteprima)
      const pr = 8 + Math.sin(Date.now() / 280) * 1.5;
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#16395f";
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(ax, ay, pr, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#16395f";
      ctx.beginPath(); ctx.arc(ax, ay, 2.5, 0, 7); ctx.fill();
      ctx.restore();
    }
  }

  // palla (flat con cuciture)
  const b = ball;
  if (a <= 0) return; // del tutto svanita: niente da disegnare
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(b.x, b.y);
  if (b.flying) ctx.rotate((b.x + b.y) / 40);
  ctx.fillStyle = "#e76f51";
  ctx.beginPath(); ctx.arc(0, 0, BALL_R, 0, 7); ctx.fill();
  ctx.strokeStyle = "#7c2d12"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, BALL_R, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-BALL_R, 0); ctx.lineTo(BALL_R, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -BALL_R); ctx.lineTo(0, BALL_R); ctx.stroke();
  ctx.beginPath(); ctx.arc(-BALL_R - 4, 0, BALL_R + 1, -0.7, 0.7); ctx.stroke();
  ctx.beginPath(); ctx.arc(BALL_R + 4, 0, BALL_R + 1, Math.PI - 0.7, Math.PI + 0.7); ctx.stroke();
  // valore sopra la palla ferma
  ctx.restore();
  if (!b.flying && !b.dead && state === "play") {
    ctx.globalAlpha = a;
    ctx.fillStyle = "#16395f"; ctx.font = "900 15px Inter,sans-serif"; ctx.textAlign = "center";
    ctx.fillText("+" + fmt(b.value), b.x, b.y - 26);
    // anello selezione
    ctx.strokeStyle = "rgba(22,57,95,.35)"; ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R + 10 + Math.sin(Date.now() / 300) * 2, 0, 7); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
  ctx.globalAlpha = 1;
}

// ---------- LOOP ----------
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  if (state === "play") {
    stepPhysics(dt);
    if (ball) { // dissolvenza: vecchia svanisce, nuova appare, in volo sempre opaca
      if (ball.flying) ball.alpha = 1;
      else if (ball.dead) ball.alpha = Math.max(0, ball.alpha - dt / 0.22);
      else if (ball.alpha < 1) ball.alpha = Math.min(1, ball.alpha + dt / 0.18);
    }
    if (ball && ball.flying) { trail.push({ x: ball.x, y: ball.y }); if (trail.length > 26) trail.shift(); }
    for (const p of particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; }
    particles = particles.filter(p => p.t < p.life);
  }
  stepNet(dt); // la rete si muove sempre, anche tra un tiro e l'altro
  draw();
  requestAnimationFrame(loop);
}

// ---------- CONTEST FLOW ----------
function startContest() {
  if (Net.mode === "ws" && (Net.phase !== "play" || !Net.admitted)) return; // fuori contest: si attende
  pickName(); // applica il nome digitato anche all'avvio automatico
  state = "play"; score = 0; shots = 0; makes = 0; cleanCount = 0; bestShot = 0;
  timeLeft = CONTEST_LEN; particles = [];
  Net.connect();
  document.getElementById("overlay-start").classList.add("hidden");
  document.getElementById("overlay-end").classList.add("hidden");
  const again = document.getElementById("btnAgain");
  if (again) again.disabled = false;
  spawnBall(); renderBoard(); updateTimer();
  clearInterval(contestTimer); clearInterval(netTick);
  contestTimer = setInterval(() => {
    timeLeft -= 1;
    Net.serverTick(1);
    if (Net.mode === "ws" && timeLeft % 5 === 0) Net.publish(); // heartbeat anti-timeout
    updateTimer(); renderBoard();
    if (timeLeft <= 0) endContest();
  }, 1000);
  netTick = setInterval(() => { Net.serverTick(0.5); if (state === "play") renderBoard(); }, 500);
  Net.publish();
}
function updateTimer() {
  const m = Math.floor(Math.max(0, timeLeft) / 60), s = Math.max(0, timeLeft) % 60;
  const el = document.getElementById("timer");
  el.textContent = `${m}:${String(s).padStart(2, "0")}`;
  el.classList.toggle("urgent", timeLeft <= 15);
}
function endContest() {
  if (state !== "play") return;
  state = "over";
  clearInterval(contestTimer); clearInterval(netTick);
  const board = Net.board();
  const me = board.find(p => p.me);
  const total = liveTotal();
  const acc = shots ? Math.round((makes / shots) * 100) : 0;
  document.getElementById("finalStats").innerHTML =
    `Punti: <b>${fmt(score)}</b> · Rank <b>#${me.rank}</b> / ${total}<br>` +
    `Canestri: <b>${makes}</b> / ${shots} (${acc}%) · Clean: <b>${cleanCount}</b> · Miglior tiro: <b>+${fmt(bestShot)}</b><br>` +
    `<span style="opacity:.6">Vincitore: ${esc(board[0].name)} con ${fmt(board[0].score)} pt</span>`;
  const li = document.getElementById("lobbyInfo");
  if (li) li.textContent = "";
  document.getElementById("overlay-end").classList.remove("hidden");
  if (me.rank <= 3) confetti();
  beep(520, 0.3, "triangle", 0.12);
}

function pickName() {
  const v = document.getElementById("playerName").value.trim().replace(/[<>"&]/g, "").slice(0, 16);
  if (v) myName = v; // vuoto = tengo il nome automatico unico
}
document.getElementById("playerName").addEventListener("input", (e) => {
  const v = e.target.value.trim().replace(/[<>"&]/g, "").slice(0, 16);
  if (!v) return;
  myName = v;
  if (Net.mode === "ws") Net.hello(); // aggiorna il nome in classifica in tempo reale
});
document.getElementById("wantPlay").addEventListener("change", (e) => {
  if (Net.mode === "ws") Net.send({ t: "opt", id: myId, want: e.target.checked });
});
document.getElementById("btnStart").addEventListener("click", () => {
  AC = null; beep(440, 0.08); pickName(); Net.connect();
  if (Net.mode === "sim") startContest();
  else if (Net.phase === "play" && Net.admitted) startContest();
  // in ws+lobby o non ammesso l'avvio e' automatico al via del server
});
document.getElementById("btnAgain").addEventListener("click", () => {
  pickName(); Net.connect();
  if (Net.mode === "sim") startContest();
  else if (Net.phase === "play" && Net.admitted) startContest();
});

// ---------- CICLO DI VITA (Android/desktop): pausa, ripresa, focus, audio ----------
function resumeAudio() {
  try { if (AC && AC.state === "suspended") AC.resume(); } catch (err) {}
}
function onForeground() {
  resumeAudio();
  resize();
  last = performance.now(); // evita un dt enorme al ritorno in primo piano
  if (state === "play") { updateTimer(); renderBoard(); }
  else if (state === "menu" && Net.mode === "ws") Net.hello(); // riallinea fase/stato al server
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") onForeground();
});
window.addEventListener("focus", onForeground);
window.addEventListener("blur", () => { touchAim = false; }); // nessun tiro involontario al ritorno
document.addEventListener("pointerdown", resumeAudio, { passive: true }); // sblocca l'audio al primo tocco

// Istruzioni coerenti con il dispositivo: mouse su PC, dito su Android
if (IS_TOUCH) {
  const how = document.querySelectorAll(".how div");
  if (how.length === 3) {
    how[0].innerHTML = "<b>1.</b> Trascina il dito";
    how[1].innerHTML = "<b>2.</b> Segui l'arco tratteggiato";
    how[2].innerHTML = "<b>3.</b> Rilascia per tirare";
  }
  const tinyEl = document.querySelector(".tiny");
  if (tinyEl) tinyEl.textContent = "Nessun tasto · Solo tocco";
}

// init
resize(); Net.connect(); buildNet(); renderBoard();
requestAnimationFrame(loop);
setTimeout(resize, 100);
})();
