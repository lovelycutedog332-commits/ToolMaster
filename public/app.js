'use strict';
// ToolMaster frontend. NOTE: this file NEVER stores balances as truth —
// it only displays what the server returns. All credits live server-side.
let me = null;
let tools = [];
let selectedTool = null;
let signupEmail = '';
let resetEmail = '';
let adminSelectedUser = null;

const $ = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...(options || {}),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
function setMsg(id, text, ok) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg ' + (ok ? 'ok' : text ? 'error' : '');
}
function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('view-' + view);
  if (el) el.classList.remove('hidden');
  window.scrollTo(0, 0);
  if (view === 'dashboard') loadDashboard();
  if (view === 'admin') loadAdmin();
}
document.querySelectorAll('[data-nav]').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.nav); });
});

/* ---------- Nav / session ---------- */
function renderNav() {
  const loggedIn = !!me;
  $('nav-auth').classList.toggle('hidden', loggedIn);
  $('nav-user').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    $('nav-balance').textContent = me.balance;
    $('profile-btn').textContent = (me.fullName || 'Account') + ' ▾';
    $('admin-link').classList.toggle('hidden', me.role !== 'admin');
  }
}
$('profile-btn').addEventListener('click', () => $('profile-menu').classList.toggle('hidden'));
async function refreshMe() {
  const r = await api('/api/auth/me');
  me = r.status === 200 ? r.data.user : null;
  renderNav();
}
async function doLogout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  me = null; renderNav(); show('home');
}
$('logout-link').addEventListener('click', (e) => { e.preventDefault(); doLogout(); });
$('dash-logout').addEventListener('click', doLogout);

/* ---------- Paid tools ---------- */
async function loadTools() {
  const r = await api('/api/tools');
  if (r.status !== 200) return;
  tools = r.data.tools;
  if (r.data.signupBonus) {
    $('hero-bonus').textContent = r.data.signupBonus;
    $('hero-bonus-2').textContent = r.data.signupBonus;
  }
  const grid = $('paid-tools');
  grid.innerHTML = '';
  tools.forEach((t) => {
    const d = document.createElement('div');
    d.className = 'card tool-card';
    d.innerHTML = '<h3></h3><p class="cost"></p><p>Click to select, type a topic below, then Generate.</p>';
    d.querySelector('h3').textContent = t.label;
    d.querySelector('.cost').textContent = t.cost + ' credits';
    d.addEventListener('click', () => {
      selectedTool = t;
      document.querySelectorAll('.tool-card').forEach((c) => c.classList.remove('selected'));
      d.classList.add('selected');
      $('tool-input-label').textContent = t.label + ' — enter your keyword / topic (' + t.cost + ' credits)';
      setMsg('tool-msg', '');
    });
    grid.appendChild(d);
  });
  if (tools.length) { selectedTool = tools[0]; grid.firstChild.classList.add('selected'); }
}
function refId() {
  return 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}
$('run-tool-btn').addEventListener('click', async () => {
  if (!selectedTool) return;
  if (!me) { show('login'); setMsg('login-msg', 'Please log in to use paid generators.'); return; }
  const input = $('tool-input').value.trim();
  if (!input) { setMsg('tool-msg', 'Please enter a keyword or topic.'); return; }
  setMsg('tool-msg', 'Generating...');
  const r = await api('/api/tools/run', {
    method: 'POST',
    body: JSON.stringify({ tool: selectedTool.tool, input, referenceId: refId() }),
  });
  const out = $('tool-output');
  if (r.status === 200) {
    me.balance = r.data.balance; renderNav();
    out.classList.remove('hidden');
    if (Array.isArray(r.data.output)) {
      out.innerHTML = '';
      const ul = document.createElement('ul');
      r.data.output.forEach((line) => { const li = document.createElement('li'); li.textContent = line; ul.appendChild(li); });
      out.appendChild(ul);
    } else {
      out.textContent = r.data.output;
    }
    setMsg('tool-msg', 'Done! ' + r.data.cost + ' credits used. New balance: ' + r.data.balance, true);
  } else {
    out.classList.add('hidden');
    setMsg('tool-msg', r.data.error || 'Generation failed. No credits were deducted.');
    if (typeof r.data.balance === 'number') { me.balance = r.data.balance; renderNav(); }
  }
});

/* ---------- Free tools (client-side) ---------- */
$('wc-input').addEventListener('input', (e) => {
  const t = e.target.value;
  const words = t.trim() ? t.trim().split(/\s+/).length : 0;
  $('wc-result').textContent = 'Words: ' + words + ' · Characters: ' + t.length;
});
document.querySelectorAll('[data-case]').forEach((b) => b.addEventListener('click', () => {
  const t = $('cc-input').value;
  let out = t;
  if (b.dataset.case === 'upper') out = t.toUpperCase();
  if (b.dataset.case === 'lower') out = t.toLowerCase();
  if (b.dataset.case === 'title') out = t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  $('cc-result').textContent = out;
}));
$('pc-btn').addEventListener('click', () => {
  const a = parseFloat($('pc-a').value), b = parseFloat($('pc-b').value);
  $('pc-result').textContent = (!b) ? 'Enter a total other than 0.' : a + ' is ' + ((a / b) * 100).toFixed(2) + '% of ' + b;
});
$('pg-btn').addEventListener('click', () => {
  const len = Math.min(64, Math.max(6, parseInt($('pg-length').value, 10) || 14));
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*?';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  $('pg-result').textContent = [...arr].map((n) => chars[n % chars.length]).join('');
});

/* ---------- Signup + verify ---------- */
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  const r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
  if (r.status === 201) {
    signupEmail = payload.email;
    $('verify-box').classList.remove('hidden');
    $('verify-code').textContent = r.data.verificationCode;
    setMsg('signup-msg', r.data.message, true);
  } else {
    setMsg('signup-msg', r.data.error || 'Signup failed.');
  }
});
$('verify-btn').addEventListener('click', async () => {
  const code = $('verify-input').value.trim();
  const email = signupEmail || document.querySelector('#signup-form [name=email]').value;
  const r = await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ email, code }) });
  if (r.status === 200) {
    setMsg('verify-msg', r.data.message + ' You can now log in.', true);
    setTimeout(() => show('login'), 1200);
  } else {
    setMsg('verify-msg', r.data.error || 'Verification failed.');
  }
});

/* ---------- Login / forgot / reset ---------- */
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
  if (r.status === 200) {
    me = r.data.user; renderNav(); show('dashboard');
  } else if (r.data.needsVerification) {
    signupEmail = r.data.email; show('signup');
    $('verify-box').classList.remove('hidden');
    setMsg('signup-msg', 'This account is not verified yet. Register again is not needed — ask for your code via signup with the same email is blocked; contact admin if you lost the code.');
  } else {
    setMsg('login-msg', r.data.error || 'Login failed.');
  }
});
$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  resetEmail = payload.email;
  const r = await api('/api/auth/forgot', { method: 'POST', body: JSON.stringify(payload) });
  if (r.data.resetCode) {
    $('reset-box').classList.remove('hidden');
    $('reset-code').textContent = r.data.resetCode;
  }
  setMsg('forgot-msg', r.data.message || 'Done.', r.status === 200);
});
$('reset-btn').addEventListener('click', async () => {
  const r = await api('/api/auth/reset', {
    method: 'POST',
    body: JSON.stringify({ email: resetEmail, code: $('reset-input').value.trim(), newPassword: $('reset-password').value }),
  });
  setMsg('reset-msg', r.data.message || r.data.error || '', r.status === 200);
  if (r.status === 200) setTimeout(() => show('login'), 1000);
});

/* ---------- Dashboard ---------- */
async function loadDashboard() {
  await refreshMe();
  if (!me) { show('login'); return; }
  $('dash-welcome').textContent = 'Welcome, ' + me.fullName;
  $('stat-balance').textContent = me.balance;
  $('stat-earned').textContent = me.totalEarned;
  $('stat-used').textContent = me.totalUsed;
  $('settings-name').value = me.fullName;
  const r = await api('/api/me/transactions');
  const list = $('tx-list');
  list.innerHTML = '';
  if (r.status === 200) {
    if (!r.data.transactions.length) list.innerHTML = '<p class="alt">No transactions yet.</p>';
    r.data.transactions.forEach((t) => list.appendChild(txRow(t)));
  }
}
function txRow(t) {
  const d = document.createElement('div');
  d.className = 'tx';
  const left = document.createElement('span');
  left.innerHTML = '<strong></strong><br><small></small>';
  left.querySelector('strong').textContent = t.description;
  left.querySelector('small').textContent = new Date(t.createdAt).toLocaleString() + ' · ' + t.type + ' · ref: ' + t.referenceId;
  const amt = document.createElement('span');
  amt.className = 'amt ' + (t.amount >= 0 ? 'pos' : 'neg');
  amt.textContent = (t.amount >= 0 ? '+' : '') + t.amount;
  d.appendChild(left); d.appendChild(amt);
  return d;
}
$('settings-save').addEventListener('click', async () => {
  const r = await api('/api/account/settings', { method: 'POST', body: JSON.stringify({ fullName: $('settings-name').value }) });
  setMsg('settings-msg', r.status === 200 ? 'Settings saved.' : (r.data.error || 'Failed.'), r.status === 200);
  if (r.status === 200) { me = r.data.user; renderNav(); $('dash-welcome').textContent = 'Welcome, ' + me.fullName; }
});
$('cp-btn').addEventListener('click', async () => {
  const r = await api('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: $('cp-current').value, newPassword: $('cp-new').value }),
  });
  setMsg('cp-msg', r.data.message || r.data.error || '', r.status === 200);
});

/* ---------- Admin ---------- */
async function loadAdmin() {
  if (!me || me.role !== 'admin') { show('home'); return; }
  const r = await api('/api/admin/users');
  const box = $('admin-users');
  box.innerHTML = '';
  if (r.status !== 200) { box.textContent = r.data.error || 'Failed.'; return; }
  r.data.users.forEach((u) => {
    const d = document.createElement('div');
    d.className = 'tx';
    const left = document.createElement('span');
    left.innerHTML = '<strong></strong><br><small></small>';
    left.querySelector('strong').textContent = u.fullName + ' (' + u.email + ')';
    left.querySelector('small').textContent = 'Role: ' + u.role + ' · Verified: ' + (u.emailVerified ? 'yes' : 'no') + ' · Suspended: ' + (u.suspended ? 'yes' : 'no');
    const right = document.createElement('span');
    right.innerHTML = '<span class="amt"></span> ';
    right.querySelector('.amt').textContent = u.balance + ' credits';
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline'; btn.type = 'button'; btn.textContent = 'Manage';
    btn.addEventListener('click', () => selectAdminUser(u));
    right.appendChild(btn);
    d.appendChild(left); d.appendChild(right);
    box.appendChild(d);
  });
  const t = await api('/api/tools');
  if (t.status === 200) {
    $('admin-bonus').value = t.data.signupBonus;
    const cbox = $('admin-costs');
    cbox.innerHTML = '';
    t.data.tools.forEach((tool) => {
      const row = document.createElement('div');
      row.className = 'tx';
      const name = document.createElement('span'); name.textContent = tool.label;
      const wrap = document.createElement('span');
      const inp = document.createElement('input');
      inp.type = 'number'; inp.value = tool.cost; inp.style.width = '80px'; inp.style.display = 'inline-block';
      const save = document.createElement('button');
      save.className = 'btn btn-primary'; save.type = 'button'; save.textContent = 'Save';
      save.addEventListener('click', async () => {
        const rr = await api('/api/admin/tool-costs', { method: 'POST', body: JSON.stringify({ tool: tool.tool, cost: parseInt(inp.value, 10) }) });
        setMsg('admin-settings-msg', rr.status === 200 ? 'Cost saved for ' + tool.label : (rr.data.error || 'Failed.'), rr.status === 200);
        loadTools();
      });
      wrap.appendChild(inp); wrap.appendChild(save);
      row.appendChild(name); row.appendChild(wrap);
      cbox.appendChild(row);
    });
  }
}
async function selectAdminUser(u) {
  adminSelectedUser = u;
  $('admin-selected').textContent = 'Selected: ' + u.fullName + ' (' + u.email + ') — balance: ' + u.balance + ' credits' + (u.suspended ? ' — SUSPENDED' : '');
  const r = await api('/api/admin/users/' + u.id + '/transactions');
  const box = $('admin-txs');
  box.innerHTML = '';
  if (r.status === 200) {
    if (!r.data.transactions.length) box.innerHTML = '<p class="alt">No transactions.</p>';
    r.data.transactions.forEach((t) => box.appendChild(txRow(t)));
  }
}
async function adminAdjust(mode) {
  if (!adminSelectedUser) { setMsg('admin-msg', 'Select a user first.'); return; }
  const r = await api('/api/admin/users/' + adminSelectedUser.id + '/' + (mode === 'add' ? 'add-credits' : 'deduct-credits'), {
    method: 'POST',
    body: JSON.stringify({ amount: parseInt($('admin-amount').value, 10), reason: $('admin-reason').value }),
  });
  setMsg('admin-msg', r.status === 200 ? 'Done. New balance: ' + r.data.user.balance : (r.data.error || 'Failed.'), r.status === 200);
  if (r.status === 200) { adminSelectedUser = r.data.user; loadAdmin(); selectAdminUser(r.data.user); refreshMe(); }
}
$('admin-add').addEventListener('click', () => adminAdjust('add'));
$('admin-deduct').addEventListener('click', () => adminAdjust('deduct'));
$('admin-suspend').addEventListener('click', async () => {
  if (!adminSelectedUser) { setMsg('admin-msg', 'Select a user first.'); return; }
  const action = adminSelectedUser.suspended ? 'unsuspend' : 'suspend';
  const r = await api('/api/admin/users/' + adminSelectedUser.id + '/' + action, { method: 'POST', body: '{}' });
  setMsg('admin-msg', r.status === 200 ? 'Account ' + action + 'ed.' : (r.data.error || 'Failed.'), r.status === 200);
  if (r.status === 200) { adminSelectedUser = r.data.user; loadAdmin(); selectAdminUser(r.data.user); }
});
$('admin-bonus-save').addEventListener('click', async () => {
  const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ signupBonus: parseInt($('admin-bonus').value, 10) }) });
  setMsg('admin-settings-msg', r.status === 200 ? 'Signup bonus saved: ' + r.data.signupBonus : (r.data.error || 'Failed.'), r.status === 200);
  loadTools();
});

/* ---------- Init ---------- */
loadTools();
refreshMe();
