// Rupa Mine – tahap 1 (off-chain). Jalankan: npm i && BOT_TOKEN=xxx npm start
// Untuk tes lokal tanpa Telegram: npm run dev (DEV=1 melewati validasi initData)
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DEV = process.env.DEV === "1";
const DB_FILE = "./db.json"; // ganti ke SQLite/Postgres saat siap produksi
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : { users: {} };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));

// Aturan mining (semua dihitung di server)
const BASE_RATE = 10;                       // RPM per jam
const MAX_HOURS = 8;                        // batas penampung sebelum harus klaim
const LEVELS = [0, 100, 300, 800, 2000, 5000]; // total mining untuk Level 1..6
const REF_SHARE = 0.05;
const level = (t) => LEVELS.filter((x) => t >= x).length;
const boost = (lv) => 1 + (lv - 1) * 0.25;
const rate = (u) => BASE_RATE * boost(level(u.total));
const pending = (u, now) => rate(u) * Math.min(MAX_HOURS, (now - u.last) / 36e5);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function verify(initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash || !BOT_TOKEN) return null;
  p.delete("hash");
  const str = [...p.keys()].sort().map((k) => `${k}=${p.get(k)}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(str).digest("hex");
  if (calc !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  return JSON.parse(p.get("user"));
}

function getUser(id, ref) {
  let u = db.users[id];
  if (!u) {
    u = db.users[id] = { id, balance: 0, total: 0, last: Date.now(), streak: 0, day: "", invited: [], refIncome: 0, ref: null };
    const r = db.users[ref];
    if (r && r.id !== id) { u.ref = r.id; r.invited.push(id); }
    save();
  }
  return u;
}

const userState = (u) => {
  const lv = level(u.total), done = u.day === day(Date.now()), cont = u.day === day(Date.now() - 864e5);
  return {
    balance: u.balance, total: u.total, level: lv, prevAt: LEVELS[lv - 1], nextAt: LEVELS[lv] ?? null,
    boost: boost(lv), rate: rate(u), last: u.last, maxHours: MAX_HOURS,
    streak: done || cont ? u.streak : 0, canCheckin: !done,
    nextReward: 10 * Math.min((cont ? u.streak : 0) + 1, 7),
    invited: u.invited.length, refIncome: u.refIncome, userId: u.id, serverNow: Date.now(),
  };
};

const app = express();
app.use(express.static("public"));

app.use("/api", (req, res, next) => {
  const tg = verify(req.get("x-init-data") || "") ?? (DEV ? { id: 1 } : null);
  if (!tg) return res.status(401).json({ error: "Tidak sah. Buka lewat Telegram." });
  req.user = getUser(tg.id, req.get("x-ref"));
  next();
});

app.get("/api/me", (req, res) => res.json(userState(req.user)));

app.post("/api/claim", (req, res) => {
  const u = req.user, now = Date.now(), a = pending(u, now);
  u.balance += a; u.total += a; u.last = now;
  const rf = db.users[u.ref];
  if (rf) { rf.balance += a * REF_SHARE; rf.refIncome += a * REF_SHARE; }
  save();
  res.json(userState(u));
});

app.post("/api/checkin", (req, res) => {
  const u = req.user, today = day(Date.now());
  if (u.day === today) return res.status(400).json({ error: "Sudah check-in hari ini." });
  u.streak = u.day === day(Date.now() - 864e5) ? u.streak + 1 : 1;
  u.balance += 10 * Math.min(u.streak, 7);
  u.day = today;
  save();
  res.json(userState(u));
});

app.listen(process.env.PORT || 3000, () => console.log("Rupa Mine jalan di port", process.env.PORT || 3000));
