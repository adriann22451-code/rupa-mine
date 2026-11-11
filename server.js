// Rupa Mine – tahap 1 (off-chain). Jalankan: npm i && BOT_TOKEN=xxx npm start
// Untuk tes lokal tanpa Telegram: npm run dev (DEV=1 melewati validasi initData)
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DEV = process.env.DEV === "1";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, ""); // mis. https://rupa-mine.vercel.app
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, ""); // tanpa @
const APP_SHORT = process.env.APP_SHORT || "";   // opsional: short name dari /newapp
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // acak, huruf/angka/_/- saja
const DIR = path.dirname(fileURLToPath(import.meta.url));
// Di Vercel hanya /tmp yang bisa ditulis dan datanya TIDAK permanen. Ganti ke database sungguhan (Upstash/Supabase) sebelum dipakai user.
const DB_FILE = process.env.VERCEL ? "/tmp/db.json" : path.join(DIR, "db.json");
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : { users: {} };
db.withdrawals ||= [];
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));

// Aturan mining (semua dihitung di server)
const BASE_RATE = 10;                       // RPM per jam
const MAX_HOURS = 8;                        // batas penampung sebelum harus klaim
const LEVELS = [0, 100, 300, 800, 2000, 5000]; // total mining untuk Level 1..6
const REF_SHARE = 0.05;
const MIN_WITHDRAW = 100;                   // minimal tarik (RPM)
const ADMIN_KEY = process.env.ADMIN_KEY || "";
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
    u = db.users[id] = { id, balance: 0, total: 0, last: Date.now(), streak: 0, day: "", invited: [], refIncome: 0, ref: null, wallet: null, withdrawn: 0 };
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
    bot: BOT_USERNAME, appShort: APP_SHORT, wallet: u.wallet ?? null, withdrawn: u.withdrawn || 0, minWithdraw: MIN_WITHDRAW,
    pendingW: db.withdrawals.filter((w) => w.uid === u.id && w.status === "pending").reduce((a, w) => a + w.amount, 0),
  };
};

const app = express();
app.use(express.static(path.join(DIR, "public")));
app.use(express.json());
app.get("/", (req, res) => res.sendFile(path.join(DIR, "public", "index.html")));

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


// ---- Tahap 2: wallet & penarikan ----
const ADDR = /^([A-Za-z0-9_-]{48}|-?\d+:[0-9a-fA-F]{64})$/;
app.post("/api/wallet", (req, res) => {
  const a = req.body?.address ?? null;
  if (a !== null && !ADDR.test(a)) return res.status(400).json({ error: "Alamat wallet tidak valid." });
  req.user.wallet = a;
  save();
  res.json(userState(req.user));
});

app.post("/api/withdraw", (req, res) => {
  // Di Vercel data hanya di /tmp (tidak permanen): penarikan dimatikan kecuali sengaja untuk uji coba.
  if (process.env.VERCEL && process.env.ALLOW_EPHEMERAL !== "1")
    return res.status(503).json({ error: "Penarikan belum aktif: penyimpanan server belum permanen." });
  const u = req.user, amt = Math.floor(Number(req.body?.amount) * 100) / 100;
  if (!u.wallet) return res.status(400).json({ error: "Hubungkan wallet dulu." });
  if (!(amt >= MIN_WITHDRAW)) return res.status(400).json({ error: `Minimal penarikan ${MIN_WITHDRAW} RPM.` });
  if (amt > u.balance) return res.status(400).json({ error: "Saldo tidak cukup." });
  u.balance -= amt;
  db.withdrawals.push({ id: db.withdrawals.length + 1, uid: u.id, amount: amt, address: u.wallet, status: "pending", at: Date.now() });
  save();
  res.json(userState(u));
});

// ---- Admin (isi env ADMIN_KEY). Contoh: GET /admin/withdrawals?key=...  lalu POST /admin/withdrawals/1/done?key=... ----
const admin = (q, r, n) => (ADMIN_KEY && q.query.key === ADMIN_KEY ? n() : r.status(403).json({ error: "forbidden" }));
app.get("/admin/withdrawals", admin, (q, r) => r.json(db.withdrawals.filter((w) => w.status === "pending")));
app.post("/admin/withdrawals/:id/:act", admin, (q, r) => {
  const w = db.withdrawals.find((x) => x.id == q.params.id);
  if (!w || w.status !== "pending") return r.status(404).json({ error: "tidak ditemukan" });
  const u = db.users[w.uid];
  if (q.params.act === "done") { w.status = "done"; u.withdrawn = (u.withdrawn || 0) + w.amount; }
  else if (q.params.act === "reject") { w.status = "rejected"; u.balance += w.amount; }
  else return r.status(400).json({ error: "aksi: done atau reject" });
  save();
  r.json(w);
});

// ---- Bot Telegram (webhook) ----
const tgApi = (method, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());

app.post("/bot", async (req, res) => {
  if (!WEBHOOK_SECRET || req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return res.sendStatus(403);
  const m = req.body?.message;
  if (m?.text?.startsWith("/start")) {
    const ref = (m.text.split(" ")[1] || "").replace(/\D/g, ""); // /start <id teman>
    await tgApi("sendMessage", {
      chat_id: m.chat.id,
      text: "Selamat datang di Rupa Mine! Mining berjalan otomatis, klaim kapan saja, dan undang teman untuk bonus 5%.",
      reply_markup: { inline_keyboard: [[{ text: "Buka Rupa Mine", web_app: { url: APP_URL + (ref ? "?ref=" + ref : "") } }]] },
    }).catch(() => {});
  }
  res.sendStatus(200);
});

// Buka sekali di browser setelah deploy: https://DOMAIN/setup?key=ADMIN_KEY
app.get("/setup", admin, async (req, res) => {
  if (!BOT_TOKEN || !APP_URL || !WEBHOOK_SECRET) return res.status(400).json({ error: "Isi env BOT_TOKEN, APP_URL, dan WEBHOOK_SECRET." });
  res.json({
    webhook: await tgApi("setWebhook", { url: APP_URL + "/bot", secret_token: WEBHOOK_SECRET, allowed_updates: ["message"] }),
    menu: await tgApi("setChatMenuButton", { menu_button: { type: "web_app", text: "Buka Rupa Mine", web_app: { url: APP_URL } } }),
    commands: await tgApi("setMyCommands", { commands: [{ command: "start", description: "Buka Rupa Mine" }] }),
  });
});

if (!process.env.VERCEL) app.listen(process.env.PORT || 3000, () => console.log("Rupa Mine jalan di port", process.env.PORT || 3000));
export default app;
