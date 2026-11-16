'use strict';
/*
 * ToolMaster — public version
 * Zero external dependencies: only Node.js built-ins.
 * Server is the single source of truth for all credit balances.
 * Database: JSON file (DATA_DIR/db.json), atomic writes (temp file + rename),
 * all mutations serialized in-process to prevent races / double-charging.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOW_CREDIT_MESSAGE =
  'Your free credits are running low. Continue using free tools or explore available credit options.';

const DEFAULT_TOOL_COSTS = [
  { tool: 'seo-title', label: 'SEO Title Generator', cost: 2 },
  { tool: 'hashtag', label: 'Hashtag Generator', cost: 2 },
  { tool: 'caption', label: 'Caption Generator', cost: 2 },
  { tool: 'youtube-description', label: 'YouTube Description Generator', cost: 3 },
  { tool: 'content-idea', label: 'Content Idea Generator', cost: 3 },
  { tool: 'ai-bio', label: 'AI Bio Generator', cost: 2 },
  { tool: 'meta-description', label: 'Meta Description Generator', cost: 2 },
];

/* ---------------- Database ---------------- */

function defaultDb() {
  return {
    users: [], // {id, fullName, email, passwordHash, salt, emailVerified, role, suspended, createdAt}
    credits: [], // {userId, balance, totalEarned, totalUsed, bonusGranted}
    creditTransactions: [], // {id, userId, type, amount, description, referenceId, createdAt}
    sessions: [], // {id, userId, tokenHash, createdAt, expiresAt}
    toolCosts: DEFAULT_TOOL_COSTS.map((t) => ({ ...t })),
    settings: [{ key: 'signupBonus', value: 100 }],
    authTokens: [], // {id, userId, email, purpose, codeHash, expiresAt, used}
  };
}

let db = null;

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      const fresh = defaultDb();
      for (const k of Object.keys(fresh)) if (!(k in parsed)) parsed[k] = fresh[k];
      db = parsed;
      return;
    } catch (e) {
      console.error('db.json unreadable, starting fresh:', e.message);
    }
  }
  db = defaultDb();
  saveDb();
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE); // atomic replace
}

// Serialized mutations: every write runs one-at-a-time through this chain.
let mutationChain = Promise.resolve();
function mutate(fn) {
  const run = mutationChain.then(() => {
    const result = fn(db);
    saveDb();
    return result;
  });
  // keep the chain alive even if one mutation throws
  mutationChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/* ---------------- Helpers ---------------- */

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newCode = () => String(crypto.randomInt(100000, 1000000)); // 6-digit

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passwordHash: hashPassword(password, salt) };
}
function checkPassword(password, user) {
  const a = Buffer.from(hashPassword(password, user.salt), 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getSetting(key, fallback) {
  const row = db.settings.find((s) => s.key === key);
  return row ? row.value : fallback;
}
function findUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return db.users.find((u) => u.email === e);
}
function creditsOf(userId) {
  return db.credits.find((c) => c.userId === userId);
}
function publicUser(user) {
  const c = creditsOf(user.id) || { balance: 0, totalEarned: 0, totalUsed: 0 };
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    suspended: !!user.suspended,
    createdAt: user.createdAt,
    balance: c.balance,
    totalEarned: c.totalEarned,
    totalUsed: c.totalUsed,
  };
}
function addTransaction(userId, type, amount, description, referenceId) {
  const tx = {
    id: uid(),
    userId,
    type,
    amount,
    description,
    referenceId,
    createdAt: nowIso(),
  };
  db.creditTransactions.push(tx);
  return tx;
}

/* ---------------- HTTP plumbing ---------------- */

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token, maxAgeSec) {
  const parts = [`tm_session=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}
function currentSession(req) {
  const token = parseCookies(req).tm_session;
  if (!token) return null;
  const tokenHash = sha256(token);
  const s = db.sessions.find((x) => x.tokenHash === tokenHash);
  if (!s) return null;
  if (new Date(s.expiresAt) < new Date()) return null;
  const user = db.users.find((u) => u.id === s.userId);
  if (!user) return null;
  return { session: s, user, token };
}
function requireAuth(req, res) {
  const ctx = currentSession(req);
  if (!ctx) {
    sendJson(res, 401, { error: 'Please log in first.' });
    return null;
  }
  if (ctx.user.suspended) {
    sendJson(res, 403, { error: 'This account has been suspended.' });
    return null;
  }
  return ctx;
}
function requireAdmin(req, res) {
  const ctx = requireAuth(req, res);
  if (!ctx) return null;
  if (ctx.user.role !== 'admin') {
    sendJson(res, 403, { error: 'Admin access only.' });
    return null;
  }
  return ctx;
}

/* ---------------- Generators (template-based, no external AI key) ---------------- */

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
const pick = (arr, i) => arr[i % arr.length];

function generate(tool, input) {
  const topic = String(input || '').trim();
  const T = cap(topic);
  switch (tool) {
    case 'seo-title':
      return [
        `${T}: The Complete Guide You Need in 2026`,
        `10 Proven ${T} Tips That Actually Work`,
        `${T} for Beginners — Start Here and Grow Fast`,
        `How to Master ${T} (Step-by-Step, No Fluff)`,
        `${T} Mistakes to Avoid: What Nobody Tells You`,
      ];
    case 'hashtag': {
      const base = topic.replace(/[^a-zA-Z0-9 ]/g, '').trim();
      const slug = base.replace(/\s+/g, '');
      const words = base.split(/\s+/).filter(Boolean);
      const tags = [
        '#' + slug,
        '#' + slug + 'Tips',
        ...words.map((w) => '#' + cap(w)),
        '#viral', '#trending', '#fyp', '#explore', '#daily',
        '#' + slug + 'Guide', '#' + slug + '2026',
      ];
      return [...new Set(tags)].slice(0, 15);
    }
    case 'caption':
      return [
        `${T} — small steps, big results. ✨`,
        `POV: you finally started with ${topic} and it changed everything.`,
        `Save this for later 📌 Your ${topic} journey starts today.`,
        `Day 1 of ${topic}. Follow along for the full story 👇`,
        `Nobody talks about this side of ${topic}… until now.`,
      ];
    case 'youtube-description':
      return (
        `🎬 ${T} — Full Guide\n\nIn this video we break down ${topic} step by step, ` +
        `so you can follow along and get real results.\n\n⏱️ Chapters:\n00:00 Intro\n01:15 What is ${topic}?\n` +
        `04:30 Step-by-step walkthrough\n09:45 Common mistakes\n12:20 Final tips\n\n` +
        `👍 Like the video if it helped you\n🔔 Subscribe for a new video every week\n` +
        `💬 Comment your biggest question about ${topic} below\n\n#${topic.replace(/\s+/g, '')} #guide #tutorial`
      );
    case 'content-idea':
      return [
        `I tried ${topic} for 30 days — honest results`,
        `${T}: beginner vs expert (side-by-side comparison)`,
        `5 ${topic} myths everyone believes (and the truth)`,
        `Answering your top 10 ${topic} questions`,
        `The cheapest way to start ${topic} in 2026`,
        `${T} mistakes I wish I knew before starting`,
      ];
    case 'ai-bio':
      return [
        `Helping you master ${topic} | Tips, guides & real results | New posts daily ✨`,
        `${T} enthusiast 📚 Sharing what actually works — no fluff, just value.`,
        `Your daily dose of ${topic}. Learn it. Apply it. Grow. 🚀`,
      ];
    case 'meta-description':
      return [
        `Discover ${topic} with our complete guide — practical tips, step-by-step help and expert advice. Start learning ${topic} today, free.`,
        `Everything you need to know about ${topic} in one place. Beginner-friendly guides, proven tips and updates for 2026. Click to start.`,
        `Learn ${topic} the easy way. Clear explanations, real examples and actionable steps — your ${topic} journey begins here.`,
      ];
    default:
      return null;
  }
}

/* ---------------- Auth routes ---------------- */

async function handleRegister(req, res) {
  const body = await readBody(req);
  const fullName = String(body.fullName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const confirmPassword = String(body.confirmPassword || '');
  if (!fullName || !email || !password) return sendJson(res, 400, { error: 'Full name, email and password are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Please enter a valid email address.' });
  if (password.length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword) return sendJson(res, 400, { error: 'Passwords do not match.' });

  const result = await mutate(() => {
    if (findUserByEmail(email)) return { status: 409, body: { error: 'An account with this email already exists.' } };
    const pw = makePassword(password);
    const user = {
      id: uid(),
      fullName,
      email,
      passwordHash: pw.passwordHash,
      salt: pw.salt,
      emailVerified: false,
      role: 'user',
      suspended: false,
      createdAt: nowIso(),
    };
    db.users.push(user);
    db.credits.push({ userId: user.id, balance: 0, totalEarned: 0, totalUsed: 0, bonusGranted: false });
    const code = newCode();
    db.authTokens.push({
      id: uid(), userId: user.id, email, purpose: 'verify',
      codeHash: sha256(code), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), used: false,
    });
    return {
      status: 201,
      body: {
        ok: true,
        message: 'Account created. Enter the verification code to activate your account and claim your free credits.',
        email,
        // No mail provider is connected: the code is shown on-screen (simulated email delivery).
        simulatedEmailDelivery: true,
        verificationCode: code,
      },
    };
  });
  sendJson(res, result.status, result.body);
}

async function handleVerify(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const result = await mutate(() => {
    const user = findUserByEmail(email);
    if (!user) return { status: 404, body: { error: 'Account not found.' } };
    const credits = creditsOf(user.id);
    if (user.emailVerified) {
      return { status: 200, body: { ok: true, alreadyVerified: true, bonusGranted: 0, balance: credits.balance, message: 'This account is already verified. The signup bonus is given only once.' } };
    }
    const token = [...db.authTokens].reverse().find(
      (t) => t.email === email && t.purpose === 'verify' && !t.used
    );
    if (!token || token.codeHash !== sha256(code)) return { status: 400, body: { error: 'Invalid verification code.' } };
    if (new Date(token.expiresAt) < new Date()) return { status: 400, body: { error: 'Verification code has expired. Please register again or request a new code.' } };
    token.used = true;
    user.emailVerified = true;
    // First registered + verified user automatically becomes admin.
    if (!db.users.some((u) => u.role === 'admin')) user.role = 'admin';
    let bonus = 0;
    const bonusAmount = Number(getSetting('signupBonus', 100)) || 0;
    const alreadyHasBonusTx = db.creditTransactions.some(
      (t) => t.userId === user.id && t.type === 'signup_bonus'
    );
    if (!credits.bonusGranted && !alreadyHasBonusTx && bonusAmount > 0) {
      credits.balance += bonusAmount;
      credits.totalEarned += bonusAmount;
      credits.bonusGranted = true;
      bonus = bonusAmount;
      addTransaction(user.id, 'signup_bonus', bonusAmount, 'Free signup bonus', `signup-bonus-${user.id}`);
    }
    return { status: 200, body: { ok: true, bonusGranted: bonus, balance: credits.balance, role: user.role, message: bonus > 0 ? `Account verified. ${bonus} free credits added to your account.` : 'Account verified.' } };
  });
  sendJson(res, result.status, result.body);
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = findUserByEmail(email);
  if (!user || !checkPassword(password, user)) return sendJson(res, 401, { error: 'Invalid email or password.' });
  if (user.suspended) return sendJson(res, 403, { error: 'This account has been suspended. Please contact support.' });
  if (!user.emailVerified) return sendJson(res, 403, { error: 'Please verify your email first.', needsVerification: true, email });
  const token = crypto.randomBytes(32).toString('hex');
  await mutate(() => {
    db.sessions.push({
      id: uid(), userId: user.id, tokenHash: sha256(token),
      createdAt: nowIso(), expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    });
  });
  sendJson(res, 200, { ok: true, user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, 7 * 24 * 3600) });
}

async function handleLogout(req, res) {
  const ctx = currentSession(req);
  if (ctx) {
    await mutate(() => {
      db.sessions = db.sessions.filter((s) => s.id !== ctx.session.id);
    });
  }
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}

async function handleForgot(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const result = await mutate(() => {
    const user = findUserByEmail(email);
    if (!user) return { status: 200, body: { ok: true, message: 'If an account exists for this email, a reset code has been sent.' } };
    const code = newCode();
    db.authTokens.push({
      id: uid(), userId: user.id, email, purpose: 'reset',
      codeHash: sha256(code), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), used: false,
    });
    return { status: 200, body: { ok: true, message: 'Reset code generated.', simulatedEmailDelivery: true, resetCode: code } };
  });
  sendJson(res, result.status, result.body);
}

async function handleReset(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
  const result = await mutate(() => {
    const user = findUserByEmail(email);
    if (!user) return { status: 400, body: { error: 'Invalid reset code.' } };
    const token = [...db.authTokens].reverse().find((t) => t.email === email && t.purpose === 'reset' && !t.used);
    if (!token || token.codeHash !== sha256(code)) return { status: 400, body: { error: 'Invalid reset code.' } };
    if (new Date(token.expiresAt) < new Date()) return { status: 400, body: { error: 'Reset code has expired.' } };
    token.used = true;
    const pw = makePassword(newPassword);
    user.passwordHash = pw.passwordHash;
    user.salt = pw.salt;
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    return { status: 200, body: { ok: true, message: 'Password reset successful. Please log in.' } };
  });
  sendJson(res, result.status, result.body);
}

async function handleChangePassword(req, res) {
  const ctx = requireAuth(req, res);
  if (!ctx) return;
  const body = await readBody(req);
  if (!checkPassword(String(body.currentPassword || ''), ctx.user))
    return sendJson(res, 400, { error: 'Current password is incorrect.' });
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) return sendJson(res, 400, { error: 'New password must be at least 6 characters.' });
  await mutate(() => {
    const pw = makePassword(newPassword);
    ctx.user.passwordHash = pw.passwordHash;
    ctx.user.salt = pw.salt;
  });
  sendJson(res, 200, { ok: true, message: 'Password changed successfully.' });
}

async function handleUpdateSettingsAccount(req, res) {
  const ctx = requireAuth(req, res);
  if (!ctx) return;
  const body = await readBody(req);
  const fullName = String(body.fullName || '').trim();
  if (!fullName) return sendJson(res, 400, { error: 'Full name cannot be empty.' });
  await mutate(() => { ctx.user.fullName = fullName; });
  sendJson(res, 200, { ok: true, user: publicUser(ctx.user) });
}

/* ---------------- Tools ---------------- */

async function handleRunTool(req, res) {
  const ctx = requireAuth(req, res);
  if (!ctx) return;
  const body = await readBody(req);
  const tool = String(body.tool || '');
  const input = String(body.input || '').trim();
  const referenceId = String(body.referenceId || '').trim();
  if (!input) return sendJson(res, 400, { error: 'Please enter a keyword or topic.' });
  if (!referenceId) return sendJson(res, 400, { error: 'referenceId is required.' });

  const result = await mutate(() => {
    const costRow = db.toolCosts.find((t) => t.tool === tool);
    if (!costRow) return { status: 400, body: { error: 'Unknown tool.' } };
    const credits = creditsOf(ctx.user.id);
    // Double-charge protection: same reference can never be charged twice.
    const duplicate = db.creditTransactions.some(
      (t) => t.userId === ctx.user.id && t.referenceId === referenceId
    );
    if (duplicate) return { status: 409, body: { error: 'This request was already processed and will not be charged twice.', balance: credits.balance } };
    if (credits.balance < costRow.cost) {
      return { status: 402, body: { error: LOW_CREDIT_MESSAGE, balance: credits.balance, cost: costRow.cost } };
    }
    const output = generate(tool, input);
    if (output === null) return { status: 400, body: { error: 'Generation failed. No credits were deducted.' } };
    // Deduct only after successful generation, in the same serialized mutation.
    credits.balance -= costRow.cost;
    credits.totalUsed += costRow.cost;
    if (credits.balance < 0) credits.balance = 0; // safety net; balance check above prevents this
    addTransaction(ctx.user.id, 'tool_run', -costRow.cost, `${costRow.label} generation`, referenceId);
    return { status: 200, body: { ok: true, tool, cost: costRow.cost, balance: credits.balance, output } };
  });
  sendJson(res, result.status, result.body);
}

function handleMyTransactions(req, res) {
  const ctx = requireAuth(req, res);
  if (!ctx) return;
  const txs = db.creditTransactions
    .filter((t) => t.userId === ctx.user.id)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  sendJson(res, 200, { transactions: txs, user: publicUser(ctx.user) });
}

/* ---------------- Admin ---------------- */

function adminUsersList() {
  return db.users
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((u) => publicUser(u));
}

async function handleAdminAdjust(req, res, userId, mode) {
  const ctx = requireAdmin(req, res);
  if (!ctx) return;
  const body = await readBody(req);
  const amount = Math.abs(parseInt(body.amount, 10) || 0);
  const reason = String(body.reason || '').trim() || (mode === 'add' ? 'Admin credit add' : 'Admin credit deduction');
  if (!amount) return sendJson(res, 400, { error: 'Enter a valid amount.' });
  const result = await mutate(() => {
    const target = db.users.find((u) => u.id === userId);
    if (!target) return { status: 404, body: { error: 'User not found.' } };
    const credits = creditsOf(userId);
    if (mode === 'add') {
      credits.balance += amount;
      credits.totalEarned += amount;
      addTransaction(userId, 'admin_add', amount, reason, `admin-${uid()}`);
    } else {
      const actual = Math.min(amount, credits.balance); // never go negative
      if (actual <= 0) return { status: 400, body: { error: 'User balance is already 0.' } };
      credits.balance -= actual;
      credits.totalUsed += actual;
      addTransaction(userId, 'admin_deduct', -actual, reason, `admin-${uid()}`);
    }
    return { status: 200, body: { ok: true, user: publicUser(target) } };
  });
  sendJson(res, result.status, result.body);
}

async function handleAdminSuspend(req, res, userId, suspended) {
  const ctx = requireAdmin(req, res);
  if (!ctx) return;
  const result = await mutate(() => {
    const target = db.users.find((u) => u.id === userId);
    if (!target) return { status: 404, body: { error: 'User not found.' } };
    if (target.id === ctx.user.id) return { status: 400, body: { error: 'You cannot suspend your own admin account.' } };
    target.suspended = suspended;
    if (suspended) db.sessions = db.sessions.filter((s) => s.userId !== userId);
    return { status: 200, body: { ok: true, user: publicUser(target) } };
  });
  sendJson(res, result.status, result.body);
}

/* ---------------- Static files ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.resolve(PUBLIC_DIR, '.' + filePath);
  // Path traversal protection
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && resolved !== path.resolve(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // SPA fallback for unknown non-file routes
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- Router ---------------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    const m = req.method;

    if (p === '/api/health') return sendJson(res, 200, { ok: true });
    if (p === '/api/tools' && m === 'GET')
      return sendJson(res, 200, { tools: db.toolCosts, signupBonus: Number(getSetting('signupBonus', 100)) || 0 });
    if (p === '/api/auth/register' && m === 'POST') return await handleRegister(req, res);
    if (p === '/api/auth/verify' && m === 'POST') return await handleVerify(req, res);
    if (p === '/api/auth/login' && m === 'POST') return await handleLogin(req, res);
    if (p === '/api/auth/logout' && m === 'POST') return await handleLogout(req, res);
    if (p === '/api/auth/forgot' && m === 'POST') return await handleForgot(req, res);
    if (p === '/api/auth/reset' && m === 'POST') return await handleReset(req, res);
    if (p === '/api/auth/me' && m === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return sendJson(res, 200, { user: publicUser(ctx.user) });
    }
    if (p === '/api/auth/change-password' && m === 'POST') return await handleChangePassword(req, res);
    if (p === '/api/account/settings' && m === 'POST') return await handleUpdateSettingsAccount(req, res);
    if (p === '/api/tools/run' && m === 'POST') return await handleRunTool(req, res);
    if (p === '/api/me/transactions' && m === 'GET') return handleMyTransactions(req, res);

    // Admin
    if (p === '/api/admin/users' && m === 'GET') {
      const ctx = requireAdmin(req, res);
      if (!ctx) return;
      return sendJson(res, 200, { users: adminUsersList() });
    }
    const adminUserMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/(add-credits|deduct-credits|suspend|unsuspend|transactions)$/);
    if (adminUserMatch) {
      const [, userId, action] = adminUserMatch;
      if (action === 'transactions' && m === 'GET') {
        const ctx = requireAdmin(req, res);
        if (!ctx) return;
        const txs = db.creditTransactions.filter((t) => t.userId === userId)
          .slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return sendJson(res, 200, { transactions: txs });
      }
      if (action === 'add-credits' && m === 'POST') return await handleAdminAdjust(req, res, userId, 'add');
      if (action === 'deduct-credits' && m === 'POST') return await handleAdminAdjust(req, res, userId, 'deduct');
      if (action === 'suspend' && m === 'POST') return await handleAdminSuspend(req, res, userId, true);
      if (action === 'unsuspend' && m === 'POST') return await handleAdminSuspend(req, res, userId, false);
    }
    if (p === '/api/admin/tool-costs' && m === 'POST') {
      const ctx = requireAdmin(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const result = await mutate(() => {
        const row = db.toolCosts.find((t) => t.tool === String(body.tool || ''));
        if (!row) return { status: 404, body: { error: 'Tool not found.' } };
        const cost = parseInt(body.cost, 10);
        if (isNaN(cost) || cost < 0) return { status: 400, body: { error: 'Cost must be a number 0 or higher.' } };
        row.cost = cost;
        return { status: 200, body: { ok: true, tools: db.toolCosts } };
      });
      return sendJson(res, result.status, result.body);
    }
    if (p === '/api/admin/settings' && m === 'POST') {
      const ctx = requireAdmin(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const result = await mutate(() => {
        const bonus = parseInt(body.signupBonus, 10);
        if (isNaN(bonus) || bonus < 0) return { status: 400, body: { error: 'Signup bonus must be a number 0 or higher.' } };
        const row = db.settings.find((s) => s.key === 'signupBonus');
        if (row) row.value = bonus; else db.settings.push({ key: 'signupBonus', value: bonus });
        return { status: 200, body: { ok: true, signupBonus: bonus } };
      });
      return sendJson(res, result.status, result.body);
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
    if (m === 'GET') return serveStatic(req, res, p);
    res.writeHead(405); res.end('Method not allowed');
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'Server error: ' + e.message });
  }
});

loadDb();
server.listen(PORT, () => {
  console.log(`ToolMaster running at http://localhost:${PORT} (data: ${DB_FILE})`);
});
