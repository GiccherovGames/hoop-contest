// Hoop Contest — server authoritative (Node + ws, nessuna framework).
// Avvio locale:  npm install && npm start   ->  http://localhost:3000
// Deploy: qualsiasi host Node (Render/Railway/Fly/VPS) con PORT d'ambiente.
// Il client apre ws(s)://stesso-host in automatico; fallback bot se offline.
//
// Protocollo:
//  client -> server: {t:"join", id, name} | {t:"update", id, score, shots, makes}
//  server -> tutti:   {t:"board", phase, timeLeft, total, players:[{id,name,score,shots}]}
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join, normalize } from "path";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const CONTEST_LEN = 120, LOBBY_LEN = 30, END_LEN = 8;
const BOT_COUNT = parseInt(process.env.BOTS || "0", 10); // 0 = solo giocatori veri (es. BOTS=200 per riempitivi)

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };
const players = new Map(); // id -> {id,name,score,shots,makes,ts,bot,skill}
let phase = "lobby", timeLeft = LOBBY_LEN;

const NAMES = ["Jordan_23", "CurryFan", "Axel", "DunkLord", "Swish", "TrePunti", "Buzzer", "Kobe8", "AirBall", "CoachP", "Nico", "Zo_2", "Rook1e", "Gigi", "Miky", "Bobo"];

function seedBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    const id = "bot" + i;
    if (!players.has(id))
      players.set(id, { id, name: NAMES[i % NAMES.length] + "_" + (i + 1), score: 0, shots: 0, makes: 0, ts: 0, bot: true, skill: 0.3 + Math.random() * 1.4, admitted: true });
  }
}
function resetScores() {
  for (const p of players.values()) { p.score = 0; p.shots = 0; p.makes = 0; }
}
function cleanName(n) {
  return String(n || "Ospite").replace(/[<>"&]/g, "").trim().slice(0, 16) || "Ospite";
}
function board() {
  return [...players.values()]
    .filter(p => p.admitted) // nel contest in corso solo gli ammessi (in attesa al via)
    .sort((a, b) => b.score - a.score || a.shots - b.shots)
    .map(({ id, name, score, shots }) => ({ id, name, score: Math.round(score * 10) / 10, shots }));
}
function broadcast(wss) {
  const msg = JSON.stringify({ t: "board", phase, timeLeft, total: players.size, players: board() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

function botTick() {
  for (const p of players.values()) {
    if (!p.bot) continue;
    if (Math.random() < 0.25 * p.skill) { // ~1 tiro ogni 4s a skill media
      const base = 2 + Math.random() * 13; // stesso range dei giocatori veri
      const clean = Math.random() < 0.15;
      p.score = Math.round((p.score + base * (clean ? 2 : 1)) * 10) / 10;
      p.shots++;
      if (clean || Math.random() < 0.45) p.makes++;
    } else if (Math.random() < 0.05) p.shots++;
  }
}

const server = createServer(async (req, res) => {
  try {
    const root = process.cwd();
    const file = normalize(join(root, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "")));
    if (!file.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "text/plain" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});

const wss = new WebSocketServer({ server });
const socks = new Map(); // ws -> id giocatore
function tell(ws, id) {
  const p = players.get(id);
  if (ws.readyState === 1)
    ws.send(JSON.stringify({ t: "status", admitted: !!(p && p.admitted), want: !p || p.want !== false, phase, timeLeft }));
}
wss.on("connection", (ws) => {
  socks.set(ws, null);
  ws.on("close", () => socks.delete(ws));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === "join" && typeof m.id === "string") {
      const id = m.id.slice(0, 32);
      const want = m.want !== false;
      const prev = players.get(id);
      const wasIn = prev && !prev.bot;
      players.set(id, { id, name: cleanName(m.name), score: 0, shots: 0, makes: 0, ts: Date.now(), bot: false, want,
        admitted: wasIn ? prev.admitted : (phase !== "play" && want) });
      if (wasIn) { players.get(id).score = prev.score; players.get(id).shots = prev.shots; }
      socks.set(ws, id);
      tell(ws, id);
      console.log(`join ${players.get(id).name} (ammesso: ${players.get(id).admitted}) — ${players.size} in sala`);
      broadcast(wss);
    } else if (m.t === "opt" && typeof m.id === "string") {
      // spunta partecipa / non partecipa dalla schermata di attesa
      const p = players.get(m.id);
      if (!p || p.bot) return;
      p.want = m.want !== false;
      p.ts = Date.now();
      if (phase !== "play") p.admitted = p.want; // a contest iniziato si resta fuori comunque
      tell(ws, m.id);
      broadcast(wss);
    } else if (m.t === "update" && typeof m.id === "string") {
      // validazione anti-cheat leggera: delta limitati, mai indietro, solo ammessi
      const p = players.get(m.id);
      if (!p || p.bot || !p.admitted) return;
      if (typeof m.score !== "number" || typeof m.shots !== "number") return;
      const dScore = m.score - p.score, dShots = m.shots - p.shots;
      if (!(dScore >= 0 && dScore <= 60)) return; // max 1 tiro eccezionale clean per messaggio
      if (!(dShots >= 0 && dShots <= 5)) return;
      p.score = Math.round(m.score * 10) / 10; p.shots = m.shots;
      const mk = Number.isFinite(+m.makes) ? Math.floor(+m.makes) : p.makes;
      if (mk >= p.makes && mk <= m.shots) p.makes = mk;
      p.ts = Date.now();
    }
  });
});

seedBots();
setInterval(() => {
  timeLeft--;
  if (timeLeft <= 0) {
    if (phase === "lobby") { phase = "play"; timeLeft = CONTEST_LEN; resetScores(); }
    else if (phase === "play") { phase = "end"; timeLeft = END_LEN; }
    else { phase = "lobby"; timeLeft = LOBBY_LEN; resetScores(); for (const p of players.values()) if (!p.bot) p.admitted = p.want !== false; }
    for (const [ws, id] of socks) if (id) tell(ws, id); // notifica stato personale
  }
  if (phase === "play") botTick();
  const now = Date.now();
  const live = new Set([...socks.values()]); // connessioni aperte: mai potare
  for (const [id, p] of players) if (!p.bot && now - p.ts > 25000 && !live.has(id)) players.delete(id);
  broadcast(wss);
}, 1000);

server.listen(PORT, () => console.log(`Hoop Contest su http://localhost:${PORT} (${BOT_COUNT} bot, fasi lobby/play/end)`));
