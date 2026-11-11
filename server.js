// Rupa Mine – stage 1 (off-chain). Run: npm i && BOT_TOKEN=xxx npm start
// Local testing without Telegram: npm run dev (DEV=1 skips initData validation)
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DEV = process.env.DEV === "1";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, ""); // e.g. https://rupa-mine.vercel.app
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, ""); // without @
const APP_SHORT = process.env.APP_SHORT || "";   // optional: short name from /newapp
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // random; letters/digits/_/- only
const DIR = path.dirname(fileURLToPath(import.meta.url));
// On Vercel only /tmp is writable and its data is NOT persistent. Switch to a real database (Upstash/Supabase) before real users.
const DB_FILE = process.env.VERCEL ? "/tmp/db.json" : path.join(DIR, "db.json");
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : { users: {} };
db.withdrawals ||= [];
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));

// Mining rules (everything is computed on the server)
const BASE_RATE = 10;                       // RPM per hour
const MAX_HOURS = 8;                        // storage cap before you must claim
const LEVELS = [0, 100, 300, 800, 2000, 5000]; // total mined needed for Level 1..6
const REF_SHARE = 0.05;
const MIN_WITHDRAW = 100;                   // minimum withdrawal (RPM)
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const level = (t) => LEVELS.filter((x) => t >= x).length;
const boost = (lv) => 1 + (lv - 1) * 0.25;
const STAKE_PLANS = [{ days: 7, pct: 5 }, { days: 14, pct: 12 }, { days: 30, pct: 30 }]; // reward % at maturity
const MIN_STAKE = 100;
const AMB = [{ name: "Pioneer", need: 5, share: 0.07 }, { name: "Envoy", need: 15, share: 0.10 }, { name: "General", need: 50, share: 0.15 }]; // active friends needed
const CHANNEL = (process.env.CHANNEL || "").replace(/^@/, ""); // channel username without @ (the bot must be a channel admin)
const RIG_COST = [200, 600, 1500, 4000, 10000]; // Rig price for level 1..5 (RPM)
const rigBoost = (r) => 1 + r * 0.2;
const rate = (u) => BASE_RATE * boost(level(u.total)) * rigBoost(u.rig || 0);
const activeInv = (u) => u.invited.filter((i) => (db.users[i]?.total || 0) > 0).length;
const ambRank = (u) => AMB.reduce((r, x, i) => (activeInv(u) >= x.need ? i : r), -1);
const refShare = (u) => AMB[ambRank(u)]?.share ?? REF_SHARE;
const settle = (u, now = Date.now()) => {
  const a = pending(u, now); u.balance += a; u.total += a; u.last = now;
  const rf = db.users[u.ref];
  if (rf) { const sh = a * refShare(rf); rf.balance += sh; rf.refIncome += sh; }
};
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
    const r = /^\d{1,20}$/.test(ref || "") ? db.users[ref] : null; // numeric ids only
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
    invited: u.invited.length, refIncome: u.refIncome,
    rig: u.rig || 0, rigMax: RIG_COST.length, rigCost: RIG_COST[u.rig || 0] ?? null, rigBoost: rigBoost(u.rig || 0), nextRigBoost: rigBoost((u.rig || 0) + 1),
    activeInvited: activeInv(u), taskInvite: !!u.taskInvite, taskChannel: !!u.taskChannel, channel: CHANNEL || null,
    plans: STAKE_PLANS, minStake: MIN_STAKE, staked: (u.stakes || []).reduce((a, s) => a + s.amt, 0), stakes: u.stakes || [],
    amb: { rank: ambRank(u), share: refShare(u), active: activeInv(u), ranks: AMB }, userId: u.id, serverNow: Date.now(),
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
  if (!tg) return res.status(401).json({ error: "Unauthorized. Open via Telegram." });
  req.user = getUser(tg.id, req.get("x-ref"));
  next();
});

app.get("/api/me", (req, res) => res.json(userState(req.user)));

app.post("/api/claim", (req, res) => {
  settle(req.user);
  save();
  res.json(userState(req.user));
});

// Rig: +20% mining speed per level. Mining in progress is settled at the old speed first.
app.post("/api/rig", (req, res) => {
  const u = req.user, r = u.rig || 0, c = RIG_COST[r];
  if (c == null) return res.status(400).json({ error: "Rig is already at max level." });
  if (u.balance + pending(u, Date.now()) < c) return res.status(400).json({ error: "Insufficient balance." });
  settle(u);
  u.balance -= c; u.rig = r + 1;
  save();
  res.json(userState(u));
});

// Task: invite 3 friends who have started mining (one time, 50 RPM)
app.post("/api/task/invite", (req, res) => {
  const u = req.user;
  if (u.taskInvite) return res.status(400).json({ error: "Task already completed." });
  if (activeInv(u) < 3) return res.status(400).json({ error: "You need 3 friends who have claimed mining." });
  u.taskInvite = true; u.balance += 50;
  save();
  res.json(userState(u));
});

app.post("/api/checkin", (req, res) => {
  const u = req.user, today = day(Date.now());
  if (u.day === today) return res.status(400).json({ error: "Already checked in today." });
  u.streak = u.day === day(Date.now() - 864e5) ? u.streak + 1 : 1;
  u.balance += 10 * Math.min(u.streak, 7);
  u.day = today;
  save();
  res.json(userState(u));
});


// Staking: lock RPM for a reward. Cancelling before maturity returns the principal without the reward.
app.post("/api/stake", (req, res) => {
  const u = req.user, amt = Math.floor(Number(req.body?.amount) * 100) / 100, p = STAKE_PLANS.find((x) => x.days === Number(req.body?.days));
  if (!p) return res.status(400).json({ error: "Invalid staking plan." });
  if (!(amt >= MIN_STAKE)) return res.status(400).json({ error: `Minimum stake is ${MIN_STAKE} RPM.` });
  if (amt > u.balance) return res.status(400).json({ error: "Insufficient balance." });
  u.stakes ||= [];
  if (u.stakes.length >= 10) return res.status(400).json({ error: "Maximum of 10 active stakes." });
  u.balance -= amt;
  u.stakes.push({ id: (u.stakeSeq = (u.stakeSeq || 0) + 1), amt, days: p.days, reward: Math.floor(amt * p.pct) / 100, end: Date.now() + p.days * 864e5 });
  save();
  res.json(userState(u));
});
app.post("/api/unstake", (req, res) => {
  const u = req.user, i = (u.stakes || []).findIndex((s) => s.id === Number(req.body?.id));
  if (i < 0) return res.status(404).json({ error: "Stake not found." });
  const s = u.stakes.splice(i, 1)[0];
  u.balance += s.amt + (Date.now() >= s.end ? s.reward : 0);
  save();
  res.json(userState(u));
});

// Task: join the channel (verified via Bot API; set env CHANNEL, the bot must be a channel admin)
app.post("/api/task/channel", async (req, res) => {
  const u = req.user;
  if (!CHANNEL || !BOT_TOKEN) return res.status(503).json({ error: "Channel is not configured." });
  if (u.taskChannel) return res.status(400).json({ error: "Task already completed." });
  const r = await tgApi("getChatMember", { chat_id: "@" + CHANNEL, user_id: u.id }).catch(() => null);
  if (!["member", "administrator", "creator"].includes(r?.result?.status)) return res.status(400).json({ error: "You have not joined the channel yet." });
  if (u.taskChannel) return res.status(400).json({ error: "Task already completed." });
  u.taskChannel = true; u.balance += 30;
  save();
  res.json(userState(u));
});

// ---- Stage 2: wallet & withdrawals ----
const ADDR = /^([A-Za-z0-9_-]{48}|-?\d+:[0-9a-fA-F]{64})$/;
app.post("/api/wallet", (req, res) => {
  const a = req.body?.address ?? null;
  if (a !== null && !ADDR.test(a)) return res.status(400).json({ error: "Invalid wallet address." });
  req.user.wallet = a;
  save();
  res.json(userState(req.user));
});

app.post("/api/withdraw", (req, res) => {
  // On Vercel data lives only in /tmp (not persistent): withdrawals are disabled unless enabled on purpose for testing.
  if (process.env.VERCEL && process.env.ALLOW_EPHEMERAL !== "1")
    return res.status(503).json({ error: "Withdrawals are not active yet: server storage is not persistent." });
  const u = req.user, amt = Math.floor(Number(req.body?.amount) * 100) / 100;
  if (!u.wallet) return res.status(400).json({ error: "Connect your wallet first." });
  if (!(amt >= MIN_WITHDRAW)) return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW} RPM.` });
  if (amt > u.balance) return res.status(400).json({ error: "Insufficient balance." });
  u.balance -= amt;
  db.withdrawals.push({ id: db.withdrawals.length + 1, uid: u.id, amount: amt, address: u.wallet, status: "pending", at: Date.now() });
  save();
  res.json(userState(u));
});

// ---- Admin (set env ADMIN_KEY). Example: GET /admin/withdrawals?key=...  then POST /admin/withdrawals/1/done?key=... ----
const admin = (q, r, n) => (ADMIN_KEY && q.query.key === ADMIN_KEY ? n() : r.status(403).json({ error: "forbidden" }));
app.get("/admin/withdrawals", admin, (q, r) => r.json(db.withdrawals.filter((w) => w.status === "pending")));
app.post("/admin/withdrawals/:id/:act", admin, (q, r) => {
  const w = db.withdrawals.find((x) => x.id == q.params.id);
  if (!w || w.status !== "pending") return r.status(404).json({ error: "not found" });
  const u = db.users[w.uid];
  if (q.params.act === "done") { w.status = "done"; u.withdrawn = (u.withdrawn || 0) + w.amount; }
  else if (q.params.act === "reject") { w.status = "rejected"; u.balance += w.amount; }
  else return r.status(400).json({ error: "action: done or reject" });
  save();
  r.json(w);
});

// ---- Telegram bot (webhook) ----
const tgApi = (method, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());

app.post("/bot", async (req, res) => {
  if (!WEBHOOK_SECRET || req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return res.sendStatus(403);
  const m = req.body?.message;
  if (m?.text?.startsWith("/start")) {
    const ref = (m.text.split(" ")[1] || "").replace(/\D/g, ""); // /start <friend id>
    await tgApi("sendMessage", {
      chat_id: m.chat.id,
      text: "Welcome to Rupa Mine! Mining runs automatically, claim anytime, and invite friends for a referral bonus.",
      reply_markup: { inline_keyboard: [[{ text: "Open Rupa Mine", web_app: { url: APP_URL + (ref ? "?ref=" + ref : "") } }]] },
    }).catch(() => {});
  }
  res.sendStatus(200);
});

// Open once in the browser after deploying: https://DOMAIN/setup?key=ADMIN_KEY
app.get("/setup", admin, async (req, res) => {
  if (!BOT_TOKEN || !APP_URL || !WEBHOOK_SECRET) return res.status(400).json({ error: "Set the env vars BOT_TOKEN, APP_URL, and WEBHOOK_SECRET." });
  res.json({
    webhook: await tgApi("setWebhook", { url: APP_URL + "/bot", secret_token: WEBHOOK_SECRET, allowed_updates: ["message"] }),
    menu: await tgApi("setChatMenuButton", { menu_button: { type: "web_app", text: "Open Rupa Mine", web_app: { url: APP_URL } } }),
    commands: await tgApi("setMyCommands", { commands: [{ command: "start", description: "Open Rupa Mine" }] }),
  });
});

if (!process.env.VERCEL) app.listen(process.env.PORT || 3000, () => console.log("Rupa Mine running on port", process.env.PORT || 3000));
export default app;
