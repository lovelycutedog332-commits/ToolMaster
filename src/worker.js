'use strict';
/*
 * ToolMaster — Cloudflare Workers + D1 version
 * Mirrors server.js endpoint-for-endpoint (same paths, JSON shapes, status
 * codes and messages) so public/app.js works unchanged.
 * Database: D1 (SQLite) via env.DB — persistent, so accounts/credits survive.
 * Passwords: PBKDF2-SHA256 via WebCrypto (no Node crypto available here).
 * Sessions: random token in an httpOnly cookie; only its SHA-256 is stored.
 */
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
const TOOL_LABELS = Object.fromEntries(DEFAULT_TOOL_COSTS.map((t) => [t.tool, t.label]));

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const CODE_TTL_MS = 30 * 60 * 1000;

/* ---------------- Schema (auto-create on first request) ---------------- */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     full_name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     email_verified INTEGER NOT NULL DEFAULT 0,
     role TEXT NOT NULL DEFAULT 'user',
     suspended INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS credits (
     user_id TEXT PRIMARY KEY,
     balance INTEGER NOT NULL DEFAULT 0,
     total_earned INTEGER NOT NULL DEFAULT 0,
     total_used INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS credit_transactions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     type TEXT NOT NULL,
     amount INTEGER NOT NULL,
     description TEXT NOT NULL,
     reference_id TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS auth_codes (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     purpose TEXT NOT NULL,
     code TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     used INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS tool_costs (
     tool TEXT PRIMARY KEY,
     cost INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

let schemaPromise = null;
function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const sql of SCHEMA_STATEMENTS) await env.DB.prepare(sql).run();
      for (const t of DEFAULT_TOOL_COSTS) {
        await env.DB.prepare('INSERT OR IGNORE INTO tool_costs (tool, cost) VALUES (?, ?)')
          .bind(t.tool, t.cost)
          .run();
      }
      await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
        .bind('signupBonus', '100')
        .run();
    })().catch((e) => {
      schemaPromise = null; // allow a retry on the next request
      throw e;
    });
  }
  return schemaPromise;
}

/* ---------------- WebCrypto helpers ---------------- */

const textEnc = new TextEncoder();
const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function randomHex(bytes) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900000;
  return String(100000 + n); // 6-digit
}
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', textEnc.encode(String(s)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64Encode(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}
function b64Decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', textEnc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64Encode(salt)}$${b64Encode(new Uint8Array(bits))}`;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function checkPassword(password, stored) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'pbkdf2') return false;
    const salt = b64Decode(saltB64);
    const expected = b64Decode(hashB64);
    const key = await crypto.subtle.importKey('raw', textEnc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: parseInt(iterStr, 10) || PBKDF2_ITERATIONS, hash: 'SHA-256' },
      key,
      expected.length * 8
    );
    return timingSafeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

/* ---------------- DB row mappers (DB is snake_case, API is camelCase) -------- */

function publicUser(user, credits) {
  const c = credits || { balance: 0, total_earned: 0, total_used: 0 };
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    emailVerified: !!user.email_verified,
    role: user.role,
    suspended: !!user.suspended,
    createdAt: user.created_at,
    balance: c.balance,
    totalEarned: c.total_earned,
    totalUsed: c.total_used,
  };
}
function txOut(t) {
  return {
    id: t.id,
    userId: t.user_id,
    type: t.type,
    amount: t.amount,
    description: t.description,
    referenceId: t.reference_id,
    createdAt: t.created_at,
  };
}
async function getUserByEmail(env, email) {
  const e = String(email || '').trim().toLowerCase();
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(e).first();
}
async function getUserById(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}
async function getCredits(env, userId) {
  return env.DB.prepare('SELECT * FROM credits WHERE user_id = ?').bind(userId).first();
}
async function publicUserById(env, id) {
  const user = await getUserById(env, id);
  if (!user) return null;
  return publicUser(user, await getCredits(env, id));
}
async function getSignupBonus(env) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('signupBonus').first();
  return Number(row ? row.value : 100) || 0;
}
async function listToolCosts(env) {
  const { results } = await env.DB.prepare('SELECT tool, cost FROM tool_costs').all();
  const byTool = new Map((results || []).map((r) => [r.tool, r.cost]));
  return DEFAULT_TOOL_COSTS.map((t) => ({
    tool: t.tool,
    label: t.label,
    cost: byTool.has(t.tool) ? byTool.get(t.tool) : t.cost,
  }));
}
async function addAuthCode(env, userId, purpose, code) {
  await env.DB.prepare('INSERT INTO auth_codes (id, user_id, purpose, code, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)')
    .bind(uid(), userId, purpose, await sha256Hex(code), new Date(Date.now() + CODE_TTL_MS).toISOString())
    .run();
}
async function latestAuthCode(env, userId, purpose) {
  // auth_codes has no created_at column in the spec schema; rowid gives insertion order.
  return env.DB.prepare(
    'SELECT * FROM auth_codes WHERE user_id = ? AND purpose = ? AND used = 0 ORDER BY rowid DESC LIMIT 1'
  )
    .bind(userId, purpose)
    .first();
}

/* ---------------- HTTP plumbing ---------------- */

function json(status, obj, extraHeaders) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(JSON.stringify(obj), { status, headers });
}
async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }
}
function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(request, token, maxAgeSec) {
  const parts = [`tm_session=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (new URL(request.url).protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}
async function currentSession(env, request) {
  const token = parseCookies(request).tm_session;
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(tokenHash).first();
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) return null;
  const user = await getUserById(env, s.user_id);
  if (!user) return null;
  return { session: s, user, token };
}
async function requireAuth(env, request) {
  const ctx = await currentSession(env, request);
  if (!ctx) return { error: json(401, { error: 'Please log in first.' }) };
  if (ctx.user.suspended) return { error: json(403, { error: 'This account has been suspended.' }) };
  return ctx;
}
async function requireAdmin(env, request) {
  const ctx = await requireAuth(env, request);
  if (ctx.error) return ctx;
  if (ctx.user.role !== 'admin') return { error: json(403, { error: 'Admin access only.' }) };
  return ctx;
}

/* ---------------- Generators (template-based, ported from server.js) ---------------- */

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

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

async function handleRegister(env, request) {
  const body = await readBody(request);
  const fullName = String(body.fullName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const confirmPassword = String(body.confirmPassword || '');
  if (!fullName || !email || !password) return json(400, { error: 'Full name, email and password are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Please enter a valid email address.' });
  if (password.length < 6) return json(400, { error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword) return json(400, { error: 'Passwords do not match.' });

  if (await getUserByEmail(env, email)) return json(409, { error: 'An account with this email already exists.' });
  const user = {
    id: uid(),
    full_name: fullName,
    email,
    password_hash: await hashPassword(password),
    email_verified: 0,
    role: 'user',
    suspended: 0,
    created_at: nowIso(),
  };
  try {
    await env.DB.prepare(
      'INSERT INTO users (id, full_name, email, password_hash, email_verified, role, suspended, created_at) VALUES (?, ?, ?, ?, 0, ?, 0, ?)'
    )
      .bind(user.id, user.full_name, user.email, user.password_hash, user.role, user.created_at)
      .run();
  } catch (e) {
    // UNIQUE(email) backstop for a registration race.
    if (await getUserByEmail(env, email)) return json(409, { error: 'An account with this email already exists.' });
    throw e;
  }
  await env.DB.prepare('INSERT INTO credits (user_id, balance, total_earned, total_used) VALUES (?, 0, 0, 0)')
    .bind(user.id)
    .run();
  const code = newCode();
  await addAuthCode(env, user.id, 'verify', code);
  return json(201, {
    ok: true,
    message: 'Account created. Enter the verification code to activate your account and claim your free credits.',
    email,
    // No mail provider is connected: the code is shown on-screen (simulated email delivery).
    simulatedEmailDelivery: true,
    verificationCode: code,
  });
}

async function handleVerify(env, request) {
  const body = await readBody(request);
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const user = await getUserByEmail(env, email);
  if (!user) return json(404, { error: 'Account not found.' });
  let credits = await getCredits(env, user.id);
  if (user.email_verified) {
    return json(200, {
      ok: true,
      alreadyVerified: true,
      bonusGranted: 0,
      balance: credits.balance,
      message: 'This account is already verified. The signup bonus is given only once.',
    });
  }
  const token = await latestAuthCode(env, user.id, 'verify');
  if (!token || token.code !== (await sha256Hex(code))) return json(400, { error: 'Invalid verification code.' });
  if (new Date(token.expires_at) < new Date())
    return json(400, { error: 'Verification code has expired. Please register again or request a new code.' });

  await env.DB.prepare('UPDATE auth_codes SET used = 1 WHERE id = ?').bind(token.id).run();
  await env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(user.id).run();
  // First registered + verified user automatically becomes admin. The guarded
  // UPDATE keeps this to exactly one admin even under concurrent verifies.
  await env.DB.prepare(
    "UPDATE users SET role = 'admin' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')"
  )
    .bind(user.id)
    .run();
  user.email_verified = 1;
  const freshUser = await getUserById(env, user.id);
  if (freshUser) user.role = freshUser.role;

  let bonus = 0;
  const bonusAmount = await getSignupBonus(env);
  const bonusRef = `signup-bonus-${user.id}`;
  const existingBonusTx = await env.DB.prepare('SELECT id FROM credit_transactions WHERE reference_id = ?')
    .bind(bonusRef)
    .first();
  if (!existingBonusTx && bonusAmount > 0) {
    try {
      // One batch: the UNIQUE reference_id transaction is the claim; the
      // credit update rides with it. If the claim insert fails, the whole
      // batch rolls back, so the bonus can never be granted twice.
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO credit_transactions (id, user_id, type, amount, description, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(uid(), user.id, 'signup_bonus', bonusAmount, 'Free signup bonus', bonusRef, nowIso()),
        env.DB.prepare('UPDATE credits SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?')
          .bind(bonusAmount, bonusAmount, user.id),
      ]);
      bonus = bonusAmount;
    } catch {
      // Lost a race: the UNIQUE reference says the bonus was already granted.
      const nowExists = await env.DB.prepare('SELECT id FROM credit_transactions WHERE reference_id = ?')
        .bind(bonusRef)
        .first();
      if (!nowExists) throw new Error('Failed to grant signup bonus.');
      bonus = 0;
    }
  }
  credits = await getCredits(env, user.id);
  return json(200, {
    ok: true,
    bonusGranted: bonus,
    balance: credits.balance,
    role: user.role,
    message: bonus > 0 ? `Account verified. ${bonus} free credits added to your account.` : 'Account verified.',
  });
}

async function handleLogin(env, request) {
  const body = await readBody(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = await getUserByEmail(env, email);
  if (!user || !(await checkPassword(password, user.password_hash)))
    return json(401, { error: 'Invalid email or password.' });
  if (user.suspended) return json(403, { error: 'This account has been suspended. Please contact support.' });
  if (!user.email_verified) return json(403, { error: 'Please verify your email first.', needsVerification: true, email });
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), user.id, nowIso(), new Date(Date.now() + SESSION_TTL_MS).toISOString())
    .run();
  return json(
    200,
    { ok: true, user: publicUser(user, await getCredits(env, user.id)) },
    { 'Set-Cookie': sessionCookie(request, token, 7 * 24 * 3600) }
  );
}

async function handleLogout(env, request) {
  const ctx = await currentSession(env, request);
  if (ctx) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(ctx.session.token).run();
  }
  return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) });
}

async function handleForgot(env, request) {
  const body = await readBody(request);
  const email = String(body.email || '').trim().toLowerCase();
  const user = await getUserByEmail(env, email);
  if (!user) return json(200, { ok: true, message: 'If an account exists for this email, a reset code has been sent.' });
  const code = newCode();
  await addAuthCode(env, user.id, 'reset', code);
  return json(200, { ok: true, message: 'Reset code generated.', simulatedEmailDelivery: true, resetCode: code });
}

async function handleReset(env, request) {
  const body = await readBody(request);
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) return json(400, { error: 'Password must be at least 6 characters.' });
  const user = await getUserByEmail(env, email);
  if (!user) return json(400, { error: 'Invalid reset code.' });
  const token = await latestAuthCode(env, user.id, 'reset');
  if (!token || token.code !== (await sha256Hex(code))) return json(400, { error: 'Invalid reset code.' });
  if (new Date(token.expires_at) < new Date()) return json(400, { error: 'Reset code has expired.' });
  await env.DB.prepare('UPDATE auth_codes SET used = 1 WHERE id = ?').bind(token.id).run();
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(newPassword), user.id)
    .run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  return json(200, { ok: true, message: 'Password reset successful. Please log in.' });
}

async function handleChangePassword(env, request) {
  const ctx = await requireAuth(env, request);
  if (ctx.error) return ctx.error;
  const body = await readBody(request);
  if (!(await checkPassword(String(body.currentPassword || ''), ctx.user.password_hash)))
    return json(400, { error: 'Current password is incorrect.' });
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) return json(400, { error: 'New password must be at least 6 characters.' });
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(newPassword), ctx.user.id)
    .run();
  return json(200, { ok: true, message: 'Password changed successfully.' });
}

async function handleUpdateSettingsAccount(env, request) {
  const ctx = await requireAuth(env, request);
  if (ctx.error) return ctx.error;
  const body = await readBody(request);
  const fullName = String(body.fullName || '').trim();
  if (!fullName) return json(400, { error: 'Full name cannot be empty.' });
  await env.DB.prepare('UPDATE users SET full_name = ? WHERE id = ?').bind(fullName, ctx.user.id).run();
  return json(200, { ok: true, user: await publicUserById(env, ctx.user.id) });
}

/* ---------------- Tools ---------------- */

async function handleRunTool(env, request) {
  const ctx = await requireAuth(env, request);
  if (ctx.error) return ctx.error;
  const body = await readBody(request);
  const tool = String(body.tool || '');
  const input = String(body.input || '').trim();
  const referenceId = String(body.referenceId || '').trim();
  if (!input) return json(400, { error: 'Please enter a keyword or topic.' });
  if (!referenceId) return json(400, { error: 'referenceId is required.' });

  const tools = await listToolCosts(env);
  const costRow = tools.find((t) => t.tool === tool);
  if (!costRow) return json(400, { error: 'Unknown tool.' });
  let credits = await getCredits(env, ctx.user.id);
  // Double-charge protection: same reference can never be charged twice.
  const duplicate = await env.DB.prepare(
    'SELECT id FROM credit_transactions WHERE user_id = ? AND reference_id = ?'
  )
    .bind(ctx.user.id, referenceId)
    .first();
  if (duplicate) return json(409, { error: 'This request was already processed and will not be charged twice.', balance: credits.balance });
  if (credits.balance < costRow.cost) {
    return json(402, { error: LOW_CREDIT_MESSAGE, balance: credits.balance, cost: costRow.cost });
  }
  const output = generate(tool, input);
  if (output === null) return json(400, { error: 'Generation failed. No credits were deducted.' });

  // Deduct only after successful generation. One batch: the transaction
  // insert (UNIQUE reference_id) comes first as the claim, then a guarded
  // credit update that only applies while the balance still covers the cost.
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO credit_transactions (id, user_id, type, amount, description, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(uid(), ctx.user.id, 'tool_run', -costRow.cost, `${costRow.label} generation`, referenceId, nowIso()),
      env.DB.prepare(
        'UPDATE credits SET balance = balance - ?, total_used = total_used + ? WHERE user_id = ? AND balance >= ?'
      ).bind(costRow.cost, costRow.cost, ctx.user.id, costRow.cost),
    ]);
  } catch {
    // The UNIQUE reference rejected the insert: a concurrent duplicate.
    credits = await getCredits(env, ctx.user.id);
    return json(409, { error: 'This request was already processed and will not be charged twice.', balance: credits.balance });
  }
  const charged = results && results[1] && results[1].meta ? results[1].meta.changes : 0;
  credits = await getCredits(env, ctx.user.id);
  if (!charged) {
    // Balance changed under us and no longer covers the cost: undo the claim.
    await env.DB.prepare('DELETE FROM credit_transactions WHERE user_id = ? AND reference_id = ?')
      .bind(ctx.user.id, referenceId)
      .run();
    return json(402, { error: LOW_CREDIT_MESSAGE, balance: credits.balance, cost: costRow.cost });
  }
  return json(200, { ok: true, tool, cost: costRow.cost, balance: credits.balance, output });
}

async function handleMyTransactions(env, request) {
  const ctx = await requireAuth(env, request);
  if (ctx.error) return ctx.error;
  const { results } = await env.DB.prepare(
    'SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC'
  )
    .bind(ctx.user.id)
    .all();
  return json(200, {
    transactions: (results || []).map(txOut),
    user: publicUser(ctx.user, await getCredits(env, ctx.user.id)),
  });
}

/* ---------------- Admin ---------------- */

async function adminUsersList(env) {
  const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY created_at ASC, rowid ASC').all();
  const users = [];
  for (const u of results || []) users.push(publicUser(u, await getCredits(env, u.id)));
  return users;
}

async function handleAdminAdjust(env, request, userId, mode) {
  const ctx = await requireAdmin(env, request);
  if (ctx.error) return ctx.error;
  const body = await readBody(request);
  const amount = Math.abs(parseInt(body.amount, 10) || 0);
  const reason = String(body.reason || '').trim() || (mode === 'add' ? 'Admin credit add' : 'Admin credit deduction');
  if (!amount) return json(400, { error: 'Enter a valid amount.' });
  const target = await getUserById(env, userId);
  if (!target) return json(404, { error: 'User not found.' });
  const credits = await getCredits(env, userId);
  if (mode === 'add') {
    await env.DB.batch([
      env.DB.prepare('UPDATE credits SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?')
        .bind(amount, amount, userId),
      env.DB.prepare(
        'INSERT INTO credit_transactions (id, user_id, type, amount, description, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(uid(), userId, 'admin_add', amount, reason, `admin-${uid()}`, nowIso()),
    ]);
  } else {
    const actual = Math.min(amount, credits.balance); // never go negative
    if (actual <= 0) return json(400, { error: 'User balance is already 0.' });
    const upd = await env.DB.prepare(
      'UPDATE credits SET balance = balance - ?, total_used = total_used + ? WHERE user_id = ? AND balance >= ?'
    )
      .bind(actual, actual, userId, actual)
      .run();
    if (!upd.meta || !upd.meta.changes) return json(400, { error: 'User balance is already 0.' });
    await env.DB.prepare(
      'INSERT INTO credit_transactions (id, user_id, type, amount, description, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(uid(), userId, 'admin_deduct', -actual, reason, `admin-${uid()}`, nowIso())
      .run();
  }
  return json(200, { ok: true, user: await publicUserById(env, userId) });
}

async function handleAdminSuspend(env, request, userId, suspended) {
  const ctx = await requireAdmin(env, request);
  if (ctx.error) return ctx.error;
  const target = await getUserById(env, userId);
  if (!target) return json(404, { error: 'User not found.' });
  if (target.id === ctx.user.id) return json(400, { error: 'You cannot suspend your own admin account.' });
  await env.DB.prepare('UPDATE users SET suspended = ? WHERE id = ?').bind(suspended ? 1 : 0, userId).run();
  if (suspended) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  return json(200, { ok: true, user: await publicUserById(env, userId) });
}

/* ---------------- Static assets (Workers Static Assets binding) ---------------- */

async function serveAssets(request, env, url) {
  if (!env.ASSETS) return new Response('Not found', { status: 404 });
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) {
    // SPA fallback for unknown non-file routes, like server.js.
    const indexRequest = new Request(new URL('/index.html', url.origin).toString(), { method: 'GET' });
    return env.ASSETS.fetch(indexRequest);
  }
  return res;
}

/* ---------------- Router ---------------- */

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const p = url.pathname;
      const m = request.method;

      if (p.startsWith('/api/')) {
        await ensureSchema(env);
        if (p === '/api/health' && m === 'GET') return json(200, { ok: true });
        if (p === '/api/tools' && m === 'GET')
          return json(200, { tools: await listToolCosts(env), signupBonus: await getSignupBonus(env) });
        if (p === '/api/auth/register' && m === 'POST') return await handleRegister(env, request);
        if (p === '/api/auth/verify' && m === 'POST') return await handleVerify(env, request);
        if (p === '/api/auth/login' && m === 'POST') return await handleLogin(env, request);
        if (p === '/api/auth/logout' && m === 'POST') return await handleLogout(env, request);
        if (p === '/api/auth/forgot' && m === 'POST') return await handleForgot(env, request);
        if (p === '/api/auth/reset' && m === 'POST') return await handleReset(env, request);
        if (p === '/api/auth/me' && m === 'GET') {
          const ctx = await requireAuth(env, request);
          if (ctx.error) return ctx.error;
          return json(200, { user: publicUser(ctx.user, await getCredits(env, ctx.user.id)) });
        }
        if (p === '/api/auth/change-password' && m === 'POST') return await handleChangePassword(env, request);
        if (p === '/api/account/settings' && m === 'POST') return await handleUpdateSettingsAccount(env, request);
        if (p === '/api/tools/run' && m === 'POST') return await handleRunTool(env, request);
        if (p === '/api/me/transactions' && m === 'GET') return await handleMyTransactions(env, request);

        // Admin
        if (p === '/api/admin/users' && m === 'GET') {
          const ctx = await requireAdmin(env, request);
          if (ctx.error) return ctx.error;
          return json(200, { users: await adminUsersList(env) });
        }
        const adminUserMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/(add-credits|deduct-credits|suspend|unsuspend|transactions)$/);
        if (adminUserMatch) {
          const [, userId, action] = adminUserMatch;
          if (action === 'transactions' && m === 'GET') {
            const ctx = await requireAdmin(env, request);
            if (ctx.error) return ctx.error;
            const { results } = await env.DB.prepare(
              'SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC'
            )
              .bind(userId)
              .all();
            return json(200, { transactions: (results || []).map(txOut) });
          }
          if (action === 'add-credits' && m === 'POST') return await handleAdminAdjust(env, request, userId, 'add');
          if (action === 'deduct-credits' && m === 'POST') return await handleAdminAdjust(env, request, userId, 'deduct');
          if (action === 'suspend' && m === 'POST') return await handleAdminSuspend(env, request, userId, true);
          if (action === 'unsuspend' && m === 'POST') return await handleAdminSuspend(env, request, userId, false);
        }
        if (p === '/api/admin/tool-costs' && m === 'POST') {
          const ctx = await requireAdmin(env, request);
          if (ctx.error) return ctx.error;
          const body = await readBody(request);
          const tools = await listToolCosts(env);
          const row = tools.find((t) => t.tool === String(body.tool || ''));
          if (!row) return json(404, { error: 'Tool not found.' });
          const cost = parseInt(body.cost, 10);
          if (isNaN(cost) || cost < 0) return json(400, { error: 'Cost must be a number 0 or higher.' });
          await env.DB.prepare('INSERT INTO tool_costs (tool, cost) VALUES (?, ?) ON CONFLICT(tool) DO UPDATE SET cost = excluded.cost')
            .bind(row.tool, cost)
            .run();
          return json(200, { ok: true, tools: await listToolCosts(env) });
        }
        if (p === '/api/admin/settings' && m === 'POST') {
          const ctx = await requireAdmin(env, request);
          if (ctx.error) return ctx.error;
          const body = await readBody(request);
          const bonus = parseInt(body.signupBonus, 10);
          if (isNaN(bonus) || bonus < 0) return json(400, { error: 'Signup bonus must be a number 0 or higher.' });
          await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .bind('signupBonus', String(bonus))
            .run();
          return json(200, { ok: true, signupBonus: bonus });
        }

        return json(404, { error: 'Not found.' });
      }

      if (m === 'GET' || m === 'HEAD') return serveAssets(request, env, url);
      return new Response('Method not allowed', { status: 405 });
    } catch (e) {
      return json(500, { error: 'Server error: ' + e.message });
    }
  },
};
