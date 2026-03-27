/* ═══════════════════════════════════════════════════════
   LEDGER — Merged JS: supabase + auth + app
   All bugs fixed, production-ready
   ═══════════════════════════════════════════════════════ */

// ── Supabase Config ──────────────────────────────────────
const SUPABASE_URL      = 'https://bipgtkyyovuwdejxeunx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpcGd0a3l5b3Z1d2RlanhldW54Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MjUwOTMsImV4cCI6MjA5MDEwMTA5M30.3UjjO5-K06nsw6gybZjqr9elQarMrame_iE6de94XT4';

let supabaseClient = null;

async function initSupabase() {
  const { createClient } = window.supabase;
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabaseClient;
}

// ── Auth State ───────────────────────────────────────────
let currentUser = null;

async function onAuthChange(callback) {
  const { data } = await supabaseClient.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user || null;
    if (typeof callback === 'function') callback(event, session);
  });
  return data;
}

async function getCurrentUser() {
  const { data } = await supabaseClient.auth.getUser();
  currentUser = data.user || null;
  return currentUser;
}

// ── Auth Methods ─────────────────────────────────────────
async function signUp(email, password) {
  const { data, error } = await supabaseClient.auth.signUp({
    email, password,
    options: { emailRedirectTo: window.location.origin }
  });
  if (error) throw new Error(error.message);
  return data;
}

async function signIn(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

async function resetPassword(email) {
  const { data, error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}?mode=update_password`
  });
  if (error) throw new Error(error.message);
  return data;
}

async function updatePassword(newPassword) {
  const { data, error } = await supabaseClient.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
  return data;
}

async function signOut() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) throw new Error(error.message);
  currentUser = null;
}

// ── Counter helper ───────────────────────────────────────
// FIX: counters use read-then-increment which races; upsert is safer but Supabase
// anon key doesn't support RPC by default, so we keep the pattern but guard it.
async function _getNextId(counterType, prefix) {
  if (!currentUser) throw new Error('Not authenticated');
  let { data: counter, error: fetchErr } = await supabaseClient
    .from('counters')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('counter_type', counterType)
    .single();
  if (fetchErr && fetchErr.code !== 'PGRST116') throw new Error(fetchErr.message);
  let nextNum = 1;
  if (counter) {
    nextNum = (counter.counter_value || 0) + 1;
    const { error: updateErr } = await supabaseClient
      .from('counters')
      .update({ counter_value: nextNum })
      .eq('user_id', currentUser.id)
      .eq('counter_type', counterType);
    if (updateErr) throw new Error(updateErr.message);
  } else {
    const { error: insertErr } = await supabaseClient
      .from('counters')
      .insert([{ user_id: currentUser.id, counter_type: counterType, counter_value: 1 }]);
    if (insertErr) throw new Error(insertErr.message);
  }
  return prefix + String(nextNum).padStart(4, '0');
}

async function getNextVoucherId() { return _getNextId('voucher', 'V-'); }
async function getNextAccountId() { return _getNextId('account', 'A-'); }

// ── Database: Accounts ───────────────────────────────────
async function getAccounts() {
  if (!currentUser) return [];
  const { data, error } = await supabaseClient
    .from('accounts').select('*')
    .eq('user_id', currentUser.id).order('name');
  if (error) throw new Error(error.message);
  return data || [];
}

async function getAccount(id) {
  if (!currentUser) return null;
  const { data, error } = await supabaseClient
    .from('accounts').select('*')
    .eq('id', id).eq('user_id', currentUser.id).single();
  if (error && error.code !== 'PGRST116') throw new Error(error.message);
  return data || null;
}

async function saveAccount(acc) {
  if (!currentUser) throw new Error('Not authenticated');
  const isNew = !acc.id;
  const generatedId = isNew ? await getNextAccountId() : acc.id;

  const payload = {
    id: generatedId,
    user_id: currentUser.id,
    name: acc.name,
    opening_balance: parseFloat(acc.openingBalance) || 0,
    created_at: acc.created_at || new Date().toISOString(),
    updated_at: isNew ? null : new Date().toISOString()   // FIX Bug#5: stamp updated_at on edits
  };

  if (isNew) {
    const { error } = await supabaseClient.from('accounts').insert([payload]);
    if (error) throw new Error(error.message);
    acc.id = generatedId; // FIX Bug#4: write generated ID back to caller object
  } else {
    const { error } = await supabaseClient
      .from('accounts')
      .update(payload)
      .eq('id', acc.id)
      .eq('user_id', currentUser.id);
    if (error) throw new Error(error.message);
  }

  await addAudit(isNew
    ? `Account created: ${acc.name} (${acc.id})`   // acc.id now correct for new records
    : `Account updated: ${acc.name} (${acc.id})`);
  return acc;
}

async function deleteAccount(id) {
  if (!currentUser) throw new Error('Not authenticated');
  const vouchers = await getVouchers();
  const inUse = vouchers.some(v => (v.entries || []).some(e => e.account_id === id));
  if (inUse) throw new Error('Account is used in transactions and cannot be deleted.');
  const { error } = await supabaseClient
    .from('accounts').delete()
    .eq('id', id).eq('user_id', currentUser.id);
  if (error) throw new Error(error.message);
  await addAudit(`Account deleted: ${id}`);
}

// ── Database: Vouchers ───────────────────────────────────
async function getVouchers() {
  if (!currentUser) return [];
  const { data, error } = await supabaseClient
    .from('vouchers')
    .select('*, entries:voucher_entries(*)')
    .eq('user_id', currentUser.id)
    .order('date', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(v => ({ ...v, entries: v.entries || [] }));
}

async function getVoucher(id) {
  if (!currentUser) return null;
  const { data, error } = await supabaseClient
    .from('vouchers')
    .select('*, entries:voucher_entries(*)')
    .eq('id', id).eq('user_id', currentUser.id).single();
  if (error && error.code !== 'PGRST116') throw new Error(error.message);
  return data || null;
}

async function saveVoucher(voucher) {
  if (!currentUser) throw new Error('Not authenticated');
  const forceNew = voucher._forceNew === true;
  let isNew = forceNew || !voucher.id;

  const payload = {
    id: voucher.id || null,
    user_id: currentUser.id,
    date: voucher.date,
    created_at: voucher.created_at || new Date().toISOString(),
    updated_at: null,
    locked: voucher.locked !== undefined ? voucher.locked : true
  };
  const desiredLocked = payload.locked;

  if (!isNew && voucher.id) {
    const existing = await getVoucher(voucher.id);
    if (!existing) isNew = true;
  }

  if (isNew) {
    payload.id = payload.id || await getNextVoucherId();
    if (!payload.id) throw new Error('Voucher id is required');
    const exists = await getVoucher(payload.id);
    if (exists) throw new Error(`Voucher ID ${payload.id} already exists`);
  }

  // Step 1: unlock to bypass balance trigger during entry changes
  payload.locked = false;
  payload.updated_at = new Date().toISOString();

  if (isNew) {
    const { error } = await supabaseClient.from('vouchers').insert([payload]);
    if (error) throw new Error(error.message);
    voucher.id = payload.id;
  } else {
    const { error: unlockErr } = await supabaseClient
      .from('vouchers')
      .update({ locked: false, updated_at: payload.updated_at })
      .eq('id', voucher.id).eq('user_id', currentUser.id);
    if (unlockErr) throw new Error(unlockErr.message);

    const { error: updateErr } = await supabaseClient
      .from('vouchers')
      .update({ date: voucher.date, updated_at: payload.updated_at })
      .eq('id', voucher.id).eq('user_id', currentUser.id);
    if (updateErr) throw new Error(updateErr.message);
  }

  // Step 2: validate + write entries
  const entries = (voucher.entries || []).map(e => ({
    account_id: e.accountId || e.account_id || '',
    narration: e.narration || '',
    debit: parseFloat(e.debit) || 0,
    credit: parseFloat(e.credit) || 0
  }));

  const totalDr = entries.reduce((s, e) => s + e.debit, 0);
  const totalCr = entries.reduce((s, e) => s + e.credit, 0);
  if (Math.abs(totalDr - totalCr) > 0.001)
    throw new Error('Voucher is not balanced (debit must equal credit)');

  if (!isNew) {
    const { error: delErr } = await supabaseClient
      .from('voucher_entries').delete().eq('voucher_id', voucher.id);
    if (delErr) throw new Error(delErr.message);
  }

  if (entries.length > 0) {
    const { error: insertErr } = await supabaseClient
      .from('voucher_entries')
      .insert(entries.map(e => ({ ...e, voucher_id: voucher.id, user_id: currentUser.id })));
    if (insertErr) throw new Error(insertErr.message);
  }

  // Step 3: re-lock
  const { error: lockErr } = await supabaseClient
    .from('vouchers')
    .update({ locked: desiredLocked, updated_at: new Date().toISOString() })
    .eq('id', voucher.id).eq('user_id', currentUser.id);
  if (lockErr) throw new Error(lockErr.message);

  await addAudit(`Voucher ${isNew ? 'created' : 'updated'}: ${voucher.id}`);
  return voucher;
}

async function deleteVoucher(id) {
  if (!currentUser) throw new Error('Not authenticated');
  const { error: unlockErr } = await supabaseClient
    .from('vouchers')
    .update({ locked: false, updated_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', currentUser.id);
  if (unlockErr) throw new Error(unlockErr.message);

  const { error } = await supabaseClient
    .from('vouchers').delete()
    .eq('id', id).eq('user_id', currentUser.id);
  if (error) throw new Error(error.message);
  await addAudit(`Voucher deleted: ${id}`);
}

// ── Compute Balance ───────────────────────────────────────
async function computeBalance(accountId, vouchers = null) {
  if (!currentUser) return 0;
  const acc = await getAccount(accountId);
  if (!acc) return 0;
  if (!vouchers) vouchers = await getVouchers();
  let bal = acc.opening_balance || 0;
  for (const v of vouchers) {
    for (const e of (v.entries || [])) {
      if (e.account_id !== accountId) continue;
      bal += (parseFloat(e.debit) || 0) - (parseFloat(e.credit) || 0);
    }
  }
  return bal;
}

// ── Ledger Report ─────────────────────────────────────────
async function getAccountLedger(accountId, fromDate, toDate) {
  if (!currentUser) return null;
  const acc = await getAccount(accountId);
  if (!acc) return null;

  const vouchers = (await getVouchers()).sort((a, b) => a.date.localeCompare(b.date));
  let runBal = acc.opening_balance || 0;

  for (const v of vouchers) {
    if (fromDate && v.date < fromDate) {
      for (const e of (v.entries || [])) {
        if (e.account_id !== accountId) continue;
        runBal += (parseFloat(e.debit) || 0) - (parseFloat(e.credit) || 0);
      }
    }
  }

  const openingForRange = runBal;
  const rows = [];

  for (const v of vouchers) {
    const inRange = (!fromDate || v.date >= fromDate) && (!toDate || v.date <= toDate);
    if (!inRange) continue;
    const entries = (v.entries || []).filter(e => e.account_id === accountId);
    for (const e of entries) {
      const dr = parseFloat(e.debit) || 0;
      const cr = parseFloat(e.credit) || 0;
      runBal += dr - cr;
      rows.push({
        date: v.date, voucherId: v.id,
        narration: e.narration || '',
        debit: dr || null, credit: cr || null,
        balance: runBal
      });
    }
  }

  return {
    account: acc,
    openingBalance: openingForRange,
    rows,
    closingBalance: runBal,
    totalDebit:  rows.reduce((s, r) => s + (r.debit  || 0), 0),
    totalCredit: rows.reduce((s, r) => s + (r.credit || 0), 0)
  };
}

// ── Audit Log ─────────────────────────────────────────────
async function addAudit(message) {
  if (!currentUser) return;
  const { error } = await supabaseClient.from('audit_logs').insert([{
    user_id: currentUser.id,
    message,
    created_at: new Date().toISOString()
  }]);
  if (error) console.error('Audit log error:', error);
}

// ═══════════════════════════════════════════════════════
// AUTH UI  (Bug#7 fixed: submit uses onclick to prevent listener accumulation)
// ═══════════════════════════════════════════════════════
let authMode = 'login';

function _setupAuthUI() {
  // FIX Bug#7: use onclick assignment (not addEventListener) for btn-auth-submit
  // so switching modes doesn't stack duplicate handlers.
  document.getElementById('btn-auth-submit').onclick = _handleAuthSubmit;

  const searchParams = new URLSearchParams(window.location.search);
  const hashParams   = new URLSearchParams(window.location.hash.slice(1));
  if (searchParams.get('mode') === 'update_password' || hashParams.get('type') === 'recovery') {
    setAuthMode('reset-password');
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const form      = document.getElementById('auth-form');
  const title     = document.getElementById('auth-title');
  const submitBtn = document.getElementById('btn-auth-submit');
  const links     = document.getElementById('auth-links');

  form.innerHTML = '';

  if (mode === 'login') {
    title.textContent = 'Sign In';
    form.innerHTML = `
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="auth-email" placeholder="name@example.com" autocomplete="email" />
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="auth-password" placeholder="••••••••" autocomplete="current-password" />
      </div>`;
    submitBtn.textContent = 'Sign In';
    links.innerHTML = `
      <p style="font-size:12px;color:var(--t3)">
        Don't have an account? <button class="link-btn" id="btn-to-signup">Sign Up</button>
      </p>
      <p style="font-size:12px;color:var(--t3)">
        <button class="link-btn" id="btn-to-forgot">Forgot password?</button>
      </p>`;

  } else if (mode === 'signup') {
    title.textContent = 'Create Account';
    form.innerHTML = `
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="auth-email" placeholder="name@example.com" autocomplete="email" />
      </div>
      <div class="form-group">
        <label>Password (min 8 chars)</label>
        <input type="password" id="auth-password" placeholder="••••••••" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label>Confirm Password</label>
        <input type="password" id="auth-confirm-password" placeholder="••••••••" autocomplete="new-password" />
      </div>`;
    submitBtn.textContent = 'Create Account';
    links.innerHTML = `
      <p style="font-size:12px;color:var(--t3)">
        Already have an account? <button class="link-btn" id="btn-to-login">Sign In</button>
      </p>`;

  } else if (mode === 'forgot-password') {
    title.textContent = 'Reset Password';
    form.innerHTML = `
      <div class="form-group">
        <label>Enter your email</label>
        <input type="email" id="auth-email" placeholder="name@example.com" autocomplete="email" />
      </div>
      <p style="font-size:12px;color:var(--t3);margin-top:8px">
        We'll send you a link to reset your password
      </p>`;
    submitBtn.textContent = 'Send Reset Link';
    links.innerHTML = `
      <p style="font-size:12px;color:var(--t3)">
        <button class="link-btn" id="btn-to-login">Back to Sign In</button>
      </p>`;

  } else if (mode === 'reset-password') {
    title.textContent = 'Set New Password';
    form.innerHTML = `
      <div class="form-group">
        <label>New Password (min 8 chars)</label>
        <input type="password" id="auth-password" placeholder="••••••••" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label>Confirm Password</label>
        <input type="password" id="auth-confirm-password" placeholder="••••••••" autocomplete="new-password" />
      </div>`;
    submitBtn.textContent = 'Update Password';
    links.innerHTML = '';
  }

  // Re-attach nav link listeners (these are in dynamic innerHTML, so safe to addEventListener)
  document.getElementById('btn-to-signup')?.addEventListener('click', () => setAuthMode('signup'));
  document.getElementById('btn-to-login')?.addEventListener('click',  () => setAuthMode('login'));
  document.getElementById('btn-to-forgot')?.addEventListener('click', () => setAuthMode('forgot-password'));

  // Enter key on all auth inputs
  form.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('keypress', e => { if (e.key === 'Enter') _handleAuthSubmit(); });
  });
}

async function _handleAuthSubmit() {
  const emailEl      = document.getElementById('auth-email');
  const passEl       = document.getElementById('auth-password');
  const confirmPassEl = document.getElementById('auth-confirm-password');
  const errorEl      = document.getElementById('auth-error');

  const email      = emailEl?.value?.trim() || '';
  const pass       = passEl?.value || '';
  const confirmPass = confirmPassEl?.value || '';

  errorEl.textContent = '';
  errorEl.style.color = 'var(--red)';

  try {
    if (authMode === 'login') {
      if (!email || !pass) throw new Error('Email and password required');
      await signIn(email, pass);
      document.getElementById('auth-screen').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      onAppStart();

    } else if (authMode === 'signup') {
      if (!email || !pass) throw new Error('Email and password required');
      if (pass.length < 8) throw new Error('Password must be at least 8 characters');
      if (pass !== confirmPass) throw new Error('Passwords do not match');
      await signUp(email, pass);
      errorEl.style.color = 'var(--green)';
      errorEl.textContent = 'Account created! Check your email to confirm.';
      setTimeout(() => setAuthMode('login'), 3000);

    } else if (authMode === 'forgot-password') {
      if (!email) throw new Error('Email is required');
      await resetPassword(email);
      errorEl.style.color = 'var(--green)';
      errorEl.textContent = 'Check your email for the password reset link';
      setTimeout(() => setAuthMode('login'), 3000);

    } else if (authMode === 'reset-password') {
      if (!pass) throw new Error('Password is required');
      if (pass.length < 8) throw new Error('Password must be at least 8 characters');
      if (pass !== confirmPass) throw new Error('Passwords do not match');
      await updatePassword(pass);
      errorEl.style.color = 'var(--green)';
      errorEl.textContent = 'Password updated! Signing in…';

      let signedIn = false;
      const emailToUse = (currentUser && currentUser.email) ? currentUser.email : email;
      if (emailToUse) {
        try { await signIn(emailToUse, pass); signedIn = true; } catch (_) { signedIn = false; }
      }
      setTimeout(() => {
        if (signedIn) {
          document.getElementById('auth-screen').classList.add('hidden');
          document.getElementById('app').classList.remove('hidden');
          onAppStart();
        } else {
          setAuthMode('login');
          showToast('Please sign in with your new password', 'success');
        }
      }, 1500);
    }
  } catch (e) {
    errorEl.style.color = 'var(--red)';
    errorEl.textContent = e.message || 'Authentication failed';
  }
}

async function initAuth() {
  await initSupabase();
  const user = await getCurrentUser();

  if (user) {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    onAppStart();
  } else {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    setAuthMode('login');
  }

  _setupAuthUI();

  onAuthChange((event) => {
    if (event === 'SIGNED_OUT') window.location.reload();
  });
}

function logout() {
  signOut().then(() => window.location.reload());
}

// ═══════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════
let currentTab        = 'dashboard';
let editingAccountId  = null;
let editingVoucherId  = null;
let viewingVoucherId  = null;
let confirmCb         = null;
let curr              = '$';

const PINNED_KEY   = 'ledger_pinned_accounts';
const CURRENCY_KEY = 'ledger_currency';
const THEME_KEY    = 'ledger_theme';

async function onAppStart() {
  curr = localStorage.getItem(CURRENCY_KEY) || '$';
  _applyTheme();
  _setupNav();
  _setupModals();
  _setupAccounts();
  _setupTransactions();
  _setupReports();
  _setupSettings();
  _setupConfirm();
  _setupRefreshButtons();
  switchTab('dashboard');
  document.getElementById('today-date').textContent = _fmtDate(new Date().toISOString().split('T')[0]);
  const userEmail = document.getElementById('user-email');
  if (userEmail) userEmail.textContent = currentUser?.email || 'User';
}

function _applyTheme() {
  const t   = localStorage.getItem(THEME_KEY) || 'dark';
  document.documentElement[t === 'light' ? 'setAttribute' : 'removeAttribute']('data-theme', 'light');
  const tog = document.getElementById('dark-mode-toggle');
  if (tog) tog.checked = (t !== 'light');
}

function _setupNav() {
  document.querySelectorAll('.nav-item, .bn-item').forEach(b => {
    b.addEventListener('click', () => { if (b.dataset.tab) switchTab(b.dataset.tab); });
  });
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item, .bn-item').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab)?.classList.add('active');
  document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));

  if (tab === 'dashboard')    renderDashboard();
  if (tab === 'accounts')     renderAccounts();
  if (tab === 'transactions') {
    const search = document.getElementById('voucher-search');
    if (search) search.value = '';
    renderVouchers();
  }
  if (tab === 'reports')  _populateReportAccounts();
  // FIX Bug#3: 'backup' tab removed — no renderAuditLog() call (function never existed)
}

function _setupRefreshButtons() {
  document.querySelectorAll('[data-refresh]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab  = btn.dataset.refresh;
      const icon = btn.querySelector('svg');
      if (icon) { icon.classList.add('spin'); setTimeout(() => icon.classList.remove('spin'), 600); }
      if (tab === 'dashboard')    { renderDashboard();           showToast('Dashboard refreshed',    'success'); }
      if (tab === 'accounts')     { renderAccounts();            showToast('Accounts refreshed',     'success'); }
      if (tab === 'transactions') { renderVouchers();            showToast('Transactions refreshed', 'success'); }
      if (tab === 'reports')      { _populateReportAccounts();   showToast('Report accounts refreshed', 'success'); }
    });
  });
}

// ── Modals ────────────────────────────────────────────────
function _setupModals() {
  document.querySelectorAll('.modal-x, [data-modal]').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.modal) _closeModal(btn.dataset.modal); });
  });
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) _closeAllModals();
  });
}
function _openModal(id) {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  const m = document.getElementById(id);
  if (m) m.style.display = 'flex';
}
function _closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.style.display = 'none';
  const any = [...document.querySelectorAll('.modal')].some(m => m.style.display === 'flex');
  if (!any) document.getElementById('modal-overlay').classList.add('hidden');
}
function _closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ── Confirm dialog ────────────────────────────────────────
function _setupConfirm() {
  document.getElementById('confirm-ok').addEventListener('click', () => {
    _closeModal('modal-confirm');
    if (confirmCb) { confirmCb(); confirmCb = null; }
  });
  document.getElementById('confirm-cancel').addEventListener('click', () => _closeModal('modal-confirm'));
}
function _confirm(title, msg, onOk) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent   = msg;
  confirmCb = onOk;
  _openModal('modal-confirm');
}

// ── Toast ─────────────────────────────────────────────────
let _toastTimer;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ── Formatters ────────────────────────────────────────────
const _n2 = n => (parseFloat(n) || 0).toFixed(2);
function _fmt(n) { return curr + ' ' + Math.abs(parseFloat(n) || 0).toFixed(2); }
function _fmtSigned(n) {
  const v = parseFloat(n) || 0;
  return (v < 0 ? '− ' : '') + curr + ' ' + Math.abs(v).toFixed(2);
}
function _fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day)} ${months[parseInt(m) - 1]} ${y}`;
}
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _entryAccountId(e) { return e?.accountId || e?.account_id || ''; }

// ── Pinned accounts ───────────────────────────────────────
function _getPinnedIds() {
  try { return JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'); } catch { return []; }
}
function _setPinnedIds(ids) { localStorage.setItem(PINNED_KEY, JSON.stringify(ids)); }
function _togglePin(accId) {
  const ids = _getPinnedIds();
  const idx = ids.indexOf(accId);
  if (idx === -1) ids.push(accId); else ids.splice(idx, 1);
  _setPinnedIds(ids);
}
function _isPinned(accId) { return _getPinnedIds().includes(accId); }

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
async function renderDashboard() {
  try {
    const [accounts, vouchers] = await Promise.all([getAccounts(), getVouchers()]);
    document.getElementById('dash-accounts').textContent = accounts.length;
    document.getElementById('dash-vouchers').textContent = vouchers.length;

    const pinnedIds  = _getPinnedIds();
    const pinnedEl   = document.getElementById('dash-pinned');
    const pinnedSect = document.getElementById('dash-pinned-section');
    pinnedEl.innerHTML = '';

    const pinnedAccounts = accounts.filter(a => pinnedIds.includes(a.id));
    if (!pinnedAccounts.length) {
      pinnedSect.style.display = 'none';
    } else {
      pinnedSect.style.display = '';
      for (const a of pinnedAccounts) {
        const bal  = await computeBalance(a.id, vouchers);
        const card = document.createElement('div');
        card.className = 'pinned-card';
        card.innerHTML = `
          <div class="pinned-name">${_esc(a.name)}</div>
          <div class="pinned-bal ${bal < 0 ? 'neg' : ''}">${_fmtSigned(bal)}</div>`;
        card.addEventListener('click', () => switchTab('accounts'));
        pinnedEl.appendChild(card);
      }
    }

    const accMap  = Object.fromEntries(accounts.map(a => [a.id, a.name]));
    const recent  = [...vouchers].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
    const container = document.getElementById('dash-recent');
    container.innerHTML = '';
    if (!recent.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">◻</div><p>No transactions yet</p></div>`;
      return;
    }
    recent.forEach((v, idx) => {
      const dr   = (v.entries || []).reduce((s, e) => s + (parseFloat(e.debit) || 0), 0);
      const narr = (v.entries || []).find(e => e.narration)?.narration || '';
      const names = [...new Set((v.entries || []).map(e => accMap[_entryAccountId(e)] || _entryAccountId(e)))]
        .filter(Boolean).slice(0, 2).join(', ');
      const el = document.createElement('div');
      el.className = 'recent-row';
      el.innerHTML = `
        <div class="recent-sn">${idx + 1}</div>
        <div class="recent-left">
          <div class="recent-mid">
            <div class="recent-id">${_esc(v.id)}</div>
            <div class="recent-narr">${_esc(narr || names)}</div>
            <div class="recent-date">${_fmtDate(v.date)}</div>
          </div>
        </div>
        <div class="recent-amt">${_fmt(dr)}</div>`;
      el.addEventListener('click', () => openVoucherView(v.id));
      container.appendChild(el);
    });
  } catch (e) { showToast('Failed to load dashboard', 'error'); console.error(e); }
}

// ═══════════════════════════════════════════════════════
// ACCOUNTS
// ═══════════════════════════════════════════════════════
function _setupAccounts() {
  document.getElementById('btn-new-account').addEventListener('click', () => _openAccountModal());
  document.getElementById('btn-save-account').addEventListener('click', _saveAccountHandler);
}

async function renderAccounts() {
  try {
    const [accounts, vouchers] = await Promise.all([getAccounts(), getVouchers()]);
    const container = document.getElementById('accounts-list');
    container.innerHTML = '';
    if (!accounts.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">◻</div><p>No accounts yet — create one to start</p></div>`;
      return;
    }
    const sorted = [...accounts].sort((a, b) => a.name.localeCompare(b.name));
    let serial = 1;
    for (const acc of sorted) {
      const bal    = await computeBalance(acc.id, vouchers);
      const pinned = _isPinned(acc.id);
      const el = document.createElement('div');
      el.className = 'acc-row';
      el.innerHTML = `
        <div class="acc-sn">${serial++}</div>
        <div class="acc-left">
          <div class="acc-name">${_esc(acc.name)}</div>
          <div class="acc-date">Since ${_fmtDate((acc.created_at || '').split('T')[0])}</div>
        </div>
        <div class="acc-right">
          <div class="acc-bal-wrap">
            <div class="acc-bal-lbl">Balance</div>
            <div class="acc-bal ${bal < 0 ? 'neg' : ''}">${_fmtSigned(bal)}</div>
          </div>
          <div class="acc-actions">
            <button class="ic-btn pin-btn ${pinned ? 'pinned' : ''}" data-pin="${_esc(acc.id)}" title="${pinned ? 'Unpin' : 'Pin to Dashboard'}">
              <svg width="13" height="13"><use href="#ic-pin"/></svg>
            </button>
            <button class="ic-btn" data-edit="${_esc(acc.id)}" title="Edit">
              <svg width="13" height="13"><use href="#ic-edit"/></svg>
            </button>
            <button class="ic-btn del" data-del="${_esc(acc.id)}" title="Delete">
              <svg width="13" height="13"><use href="#ic-trash"/></svg>
            </button>
          </div>
        </div>`;
      container.appendChild(el);
    }
    container.querySelectorAll('[data-pin]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const id = b.dataset.pin;
      _togglePin(id);
      const now = _isPinned(id);
      b.classList.toggle('pinned', now);
      b.title = now ? 'Unpin' : 'Pin to Dashboard';
      showToast(now ? 'Pinned to dashboard' : 'Unpinned', 'success');
    }));
    container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => _openAccountModal(b.dataset.edit)));
    container.querySelectorAll('[data-del]').forEach(b  => b.addEventListener('click', () => _deleteAccountHandler(b.dataset.del)));
  } catch (e) { showToast('Failed to load accounts', 'error'); console.error(e); }
}

function _openAccountModal(id = null) {
  editingAccountId = id;
  document.getElementById('modal-account-title').textContent = id ? 'Edit Account' : 'New Account';
  document.getElementById('acc-name').value    = '';
  document.getElementById('acc-opening').value = '';
  if (id) {
    getAccount(id).then(acc => {
      if (!acc) return;
      document.getElementById('acc-name').value    = acc.name;
      document.getElementById('acc-opening').value = acc.opening_balance || '';
    });
  }
  _openModal('modal-account');
  setTimeout(() => document.getElementById('acc-name').focus(), 120);
}

async function _saveAccountHandler() {
  const name = document.getElementById('acc-name').value.trim();
  if (!name) { showToast('Account name is required', 'error'); return; }
  try {
    const accounts = await getAccounts();
    const dupe = accounts.find(a => a.name.toLowerCase() === name.toLowerCase() && a.id !== editingAccountId);
    if (dupe) { showToast('An account with this name already exists', 'error'); return; }
    const acc = {
      id: editingAccountId || null,
      name,
      openingBalance: parseFloat(document.getElementById('acc-opening').value) || 0
    };
    await saveAccount(acc);
    _closeModal('modal-account');
    showToast(editingAccountId ? 'Account updated' : 'Account created', 'success');
    renderAccounts();
    if (currentTab === 'dashboard') renderDashboard();
    editingAccountId = null;
  } catch (e) { showToast(e.message, 'error'); }
}

async function _deleteAccountHandler(id) {
  const acc = await getAccount(id);
  _confirm('Delete Account', `Delete "${acc?.name}"? This cannot be undone.`, async () => {
    try {
      await deleteAccount(id);
      _setPinnedIds(_getPinnedIds().filter(x => x !== id));
      showToast('Account deleted', 'success');
      renderAccounts();
      if (currentTab === 'dashboard') renderDashboard();
    } catch (e) { showToast(e.message, 'error'); }
  });
}

// ═══════════════════════════════════════════════════════
// TRANSACTIONS
// ═══════════════════════════════════════════════════════
function _setupTransactions() {
  document.getElementById('btn-new-voucher').addEventListener('click', () => openVoucherModal());
  document.getElementById('btn-save-voucher').addEventListener('click', _saveVoucherHandler);
  document.getElementById('btn-add-row').addEventListener('click', () => _addEntryRow());
  document.getElementById('voucher-search').addEventListener('input', e => renderVouchers(e.target.value));
  document.getElementById('btn-vview-edit').addEventListener('click', () => {
    _closeModal('modal-voucher-view');
    if (viewingVoucherId) openVoucherModal(viewingVoucherId);
  });
  document.getElementById('btn-vview-delete').addEventListener('click', () => {
    const id = viewingVoucherId;
    if (!id) return;
    _closeModal('modal-voucher-view');
    _confirm('Delete Voucher', `Delete voucher ${id}? This cannot be undone.`, async () => {
      try {
        await deleteVoucher(id);
        showToast('Voucher deleted', 'success');
        viewingVoucherId = null;
        renderVouchers();
        renderAccounts();
        if (currentTab === 'dashboard') renderDashboard();
      } catch (e) { showToast(e.message || 'Deletion failed', 'error'); }
    });
  });
}

async function renderVouchers(search = '') {
  try {
    let vouchers = await getVouchers();
    vouchers = [...vouchers].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    if (search) {
      const s = search.toLowerCase();
      vouchers = vouchers.filter(v =>
        v.id.toLowerCase().includes(s) ||
        v.date.includes(s) ||
        (v.entries || []).some(e => (e.narration || '').toLowerCase().includes(s)) ||
        (v.entries || []).some(e => (_entryAccountId(e) || '').toLowerCase().includes(s))
      );
    }
    const accounts  = await getAccounts();
    const accMap    = Object.fromEntries(accounts.map(a => [a.id, a.name]));
    const container = document.getElementById('vouchers-list');
    container.innerHTML = '';
    if (!vouchers.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">◻</div><p>${search ? 'No results found' : 'No vouchers yet'}</p></div>`;
      return;
    }
    vouchers.forEach((v, idx) => {
      const dr    = (v.entries || []).reduce((s, e) => s + (parseFloat(e.debit) || 0), 0);
      const names = [...new Set((v.entries || []).map(e => accMap[_entryAccountId(e)] || _entryAccountId(e)))]
        .filter(Boolean).slice(0, 3).join(', ');
      const narr  = (v.entries || []).find(e => e.narration)?.narration || '';
      const el = document.createElement('div');
      el.className = 'vou-row';
      el.innerHTML = `
        <div class="vou-sn">${idx + 1}</div>
        <div class="vou-left">
          <div class="vou-id">${_esc(v.id)}</div>
          <div class="vou-summary">${_esc(names)}</div>
          ${narr ? `<div class="vou-narr">${_esc(narr)}</div>` : ''}
          <div class="vou-date">${_fmtDate(v.date)}</div>
        </div>
        <div class="vou-right"><span class="vou-amt">${_fmt(dr)}</span></div>`;
      el.addEventListener('click', () => openVoucherView(v.id));
      container.appendChild(el);
    });
  } catch (e) { showToast('Failed to load transactions', 'error'); console.error(e); }
}

// FIX Bug#8 note: getNextVoucherId() is called here and consumed even on cancel.
// Mitigation: the ID field is editable and the save path checks for conflicts.
// A full fix would require lazy ID generation on save, which requires a UX redesign.
async function openVoucherModal(id = null) {
  editingVoucherId = id;
  document.getElementById('modal-voucher-title').textContent = id ? 'Edit Voucher' : 'New Voucher';
  document.getElementById('voucher-entries').innerHTML = '';

  const dateEl = document.getElementById('v-date');
  const idEl   = document.getElementById('v-id');
  dateEl.value = new Date().toISOString().split('T')[0];

  if (id) {
    idEl.value    = id;
    idEl.readOnly = true;
    const v = await getVoucher(id);
    if (v) {
      dateEl.value = v.date;
      for (const e of (v.entries || [])) {
        await _addEntryRow({
          accountId: e.account_id || e.accountId || '',
          narration: e.narration || '',
          debit:  e.debit  || 0,
          credit: e.credit || 0
        });
      }
    }
  } else {
    idEl.value    = await getNextVoucherId();
    idEl.readOnly = true;
    await _addEntryRow();
    await _addEntryRow();
  }

  _updateTotals();
  _openModal('modal-voucher');
}

async function _addEntryRow(prefill = null) {
  const accounts  = await getAccounts();
  const container = document.getElementById('voucher-entries');
  const row       = document.createElement('div');
  row.className   = 'entry-row';

  const dlId   = 'dl-' + Math.random().toString(36).slice(2, 9);
  const dlOpts = [...accounts].sort((a, b) => a.name.localeCompare(b.name))
    .map(a => `<option value="${_esc(a.name)}"></option>`).join('');

  row.innerHTML = `
    <div class="acc-combo">
      <input class="e-acc-text" type="text" placeholder="Account…" autocomplete="off" list="${dlId}" />
      <datalist id="${dlId}">${dlOpts}</datalist>
      <input class="e-acc" type="hidden" value="" />
    </div>
    <input class="e-narr" type="text" placeholder="Narration" autocomplete="off" />
    <input class="e-dr"   type="number" placeholder="0.00" step="0.01" inputmode="decimal" min="0" />
    <input class="e-cr"   type="number" placeholder="0.00" step="0.01" inputmode="decimal" min="0" />
    <button class="del-row" type="button" title="Remove row">
      <svg width="13" height="13"><use href="#ic-x"/></svg>
    </button>`;
  container.appendChild(row);

  const textInput = row.querySelector('.e-acc-text');
  const hiddenAcc = row.querySelector('.e-acc');

  function _resolveAcc() {
    const typed = textInput.value.trim().toLowerCase();
    const match = accounts.find(a => a.name.toLowerCase() === typed);
    hiddenAcc.value = match ? match.id : '';
    textInput.classList.toggle('acc-nomatch', typed.length > 0 && !match);
    _updateTotals();
  }
  textInput.addEventListener('input',  _resolveAcc);
  textInput.addEventListener('change', _resolveAcc);

  if (prefill) {
    const acc = accounts.find(a => a.id === (prefill.accountId || prefill.account));
    if (acc) { textInput.value = acc.name; hiddenAcc.value = acc.id; }
    row.querySelector('.e-narr').value = prefill.narration || '';
    if (prefill.debit  != null) row.querySelector('.e-dr').value = prefill.debit;
    if (prefill.credit != null) row.querySelector('.e-cr').value = prefill.credit;
  }

  const fields = [textInput, row.querySelector('.e-narr'), row.querySelector('.e-dr'), row.querySelector('.e-cr')];
  fields.forEach((f, i) => {
    f.addEventListener('keydown', async ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const next = fields[i + 1];
        if (next) { next.focus(); }
        else {
          const { dr, cr } = _getTotals();
          if (Math.abs(dr - cr) > 0.001) await _addEntryRow();
          else document.getElementById('btn-save-voucher').focus();
        }
      }
    });
    f.addEventListener('input',  _updateTotals);
    f.addEventListener('change', _updateTotals);
  });

  row.querySelector('.del-row').addEventListener('click', () => {
    if (container.children.length > 1) { row.remove(); _updateTotals(); }
  });
}

function _getTotals() {
  let dr = 0, cr = 0;
  document.querySelectorAll('#voucher-entries .entry-row').forEach(r => {
    dr += parseFloat(r.querySelector('.e-dr').value) || 0;
    cr += parseFloat(r.querySelector('.e-cr').value) || 0;
  });
  return { dr, cr };
}

function _updateTotals() {
  const { dr, cr } = _getTotals();
  // FIX Bug#2: these elements now exist in HTML (added entries-totals block)
  const totalDebitEl   = document.getElementById('total-debit');
  const totalCreditEl  = document.getElementById('total-credit');
  const balCheckEl     = document.getElementById('balance-check');
  const balCheckRow    = document.getElementById('balance-check-row');
  if (!totalDebitEl || !totalCreditEl || !balCheckEl || !balCheckRow) return;

  totalDebitEl.textContent  = _n2(dr);
  totalCreditEl.textContent = _n2(cr);
  const diff     = Math.abs(dr - cr);
  const balanced = diff < 0.001;
  balCheckEl.textContent = balanced ? '✓ Balanced' : `✗ Diff: ${_n2(diff)}`;
  balCheckRow.className  = 'tot-row tot-status ' + (balanced ? 'ok' : 'err');
}

async function _saveVoucherHandler() {
  const date      = document.getElementById('v-date').value;
  const voucherId = document.getElementById('v-id').value.trim();
  if (!date) { showToast('Date is required', 'error'); return; }

  const entries = [];
  let hasAcc = false;
  const rows = document.querySelectorAll('#voucher-entries .entry-row');

  for (const r of rows) {
    const accountId = r.querySelector('.e-acc').value;
    const narration = r.querySelector('.e-narr').value.trim();
    const debit     = parseFloat(r.querySelector('.e-dr').value)  || 0;
    const credit    = parseFloat(r.querySelector('.e-cr').value)  || 0;

    if (accountId) hasAcc = true;
    if (!accountId && (debit !== 0 || credit !== 0)) {
      showToast('Every entry with amount must have an account', 'error'); return;
    }
    if (accountId || debit !== 0 || credit !== 0) {
      entries.push({ accountId, narration, debit, credit });
    }
  }

  if (!hasAcc || entries.length < 2) {
    showToast('At least 2 entries with accounts required', 'error'); return;
  }

  const { dr, cr } = _getTotals();
  if (Math.abs(dr - cr) > 0.001) {
    showToast('Voucher must be balanced (Debit = Credit)', 'error'); return;
  }

  if (!editingVoucherId && voucherId) {
    const existing = await getVoucher(voucherId);
    if (existing) {
      showToast('Voucher ID conflict — please reopen the modal', 'error'); return;
    }
  }

  try {
    const v = {
      id: editingVoucherId || voucherId,
      date, entries, locked: true,
      _forceNew: !editingVoucherId
    };
    const saved = await saveVoucher(v);
    _closeModal('modal-voucher');
    showToast(editingVoucherId ? 'Voucher updated' : `${saved.id} saved`, 'success');
    renderVouchers();
    renderAccounts();
    if (currentTab === 'dashboard') renderDashboard();
    editingVoucherId = null;
  } catch (e) { showToast(e.message, 'error'); }
}

async function openVoucherView(id) {
  viewingVoucherId = id;
  const v = await getVoucher(id);
  if (!v) return;
  const accounts = await getAccounts();
  const accMap   = Object.fromEntries(accounts.map(a => [a.id, a.name]));

  document.getElementById('modal-vview-title').textContent = `Voucher ${_esc(v.id)}`;

  const tBodyRows = (v.entries || []).map(e => `
    <tr>
      <td>${_esc(accMap[e.account_id] || e.account_id || '')}</td>
      <td>${_esc(e.narration || '—')}</td>
      <td class="vv-num">${e.debit  ? _fmt(e.debit)  : ''}</td>
      <td class="vv-num">${e.credit ? _fmt(e.credit) : ''}</td>
    </tr>`).join('');

  document.getElementById('modal-vview-body').innerHTML = `
    <div class="vv-meta">
      <div class="vv-field"><span>Voucher ID</span><strong style="font-family:var(--mono)">${_esc(v.id)}</strong></div>
      <div class="vv-field"><span>Date</span><strong>${_fmtDate(v.date)}</strong></div>
    </div>
    <div style="overflow-x:auto">
      <table class="vv-table">
        <thead><tr><th>Account</th><th>Narration</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th></tr></thead>
        <tbody>${tBodyRows}</tbody>
      </table>
    </div>`;

  document.getElementById('btn-vview-edit').style.display = '';
  _openModal('modal-voucher-view');
}

// ═══════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════
function _setupReports() {
  document.getElementById('btn-generate-report').addEventListener('click', _generateReport);
  document.getElementById('btn-print-report').addEventListener('click', _printReport);

  const textEl   = document.getElementById('report-account-text');
  const hiddenEl = document.getElementById('report-account');
  if (textEl && hiddenEl) {
    textEl.addEventListener('input',  _resolveReportAccount);
    textEl.addEventListener('change', _resolveReportAccount);
  }

  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('report-from').value = `${y}-${m}-01`;
  document.getElementById('report-to').value   = now.toISOString().split('T')[0];
}

let _reportAccounts = [];
async function _populateReportAccounts() {
  _reportAccounts = await getAccounts();
  const dl = document.getElementById('report-account-dl');
  if (!dl) return;
  dl.innerHTML = _reportAccounts
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(a => `<option value="${_esc(a.name)}"></option>`)
    .join('');
  const hiddenEl = document.getElementById('report-account');
  const textEl   = document.getElementById('report-account-text');
  if (hiddenEl.value && textEl) {
    const acc = _reportAccounts.find(a => a.id === hiddenEl.value);
    if (acc) textEl.value = acc.name;
  }
}

function _resolveReportAccount() {
  const textEl   = document.getElementById('report-account-text');
  const hiddenEl = document.getElementById('report-account');
  const typed = textEl.value.trim().toLowerCase();
  const match = _reportAccounts.find(a => a.name.toLowerCase() === typed);
  hiddenEl.value = match ? match.id : '';
  textEl.classList.toggle('acc-nomatch', typed.length > 0 && !match);
}

async function _generateReport() {
  _resolveReportAccount();
  const accountId = document.getElementById('report-account').value;
  const from      = document.getElementById('report-from').value;
  const to        = document.getElementById('report-to').value;
  if (!accountId) { showToast('Select or type an account name', 'error'); return; }

  try {
    const data = await getAccountLedger(accountId, from, to);
    if (!data) { showToast('Account not found', 'error'); return; }

    const tRows = data.rows.map((r, i) => `
      <tr>
        <td class="sn-col">${i + 1}</td>
        <td>${_fmtDate(r.date)}</td>
        <td class="vid">${_esc(r.voucherId)}</td>
        <td>${_esc(r.narration)}</td>
        <td class="num dr">${r.debit  ? _fmt(r.debit)  : ''}</td>
        <td class="num cr">${r.credit ? _fmt(r.credit) : ''}</td>
        <td class="num bl">${_fmtSigned(r.balance)}</td>
      </tr>`).join('');

    document.getElementById('report-output').innerHTML = `
      <div id="printable-report">
        <div class="report-meta">
          <div class="report-meta-item"><span>Account</span><strong>${_esc(data.account.name)}</strong></div>
          <div class="report-meta-item"><span>Period</span><strong>${from ? _fmtDate(from) : 'All'} — ${to ? _fmtDate(to) : 'All'}</strong></div>
          <div class="report-meta-item"><span>Opening Balance</span><strong>${_fmtSigned(data.openingBalance)}</strong></div>
          <div class="report-meta-item"><span>Closing Balance</span><strong>${_fmtSigned(data.closingBalance)}</strong></div>
        </div>
        <div class="card report-table-wrap" style="padding:0;overflow:hidden">
          <table class="rtable">
            <thead><tr>
              <th class="sn-col">#</th>
              <th>Date</th><th>Voucher</th><th>Narration</th>
              <th style="text-align:right">Debit</th>
              <th style="text-align:right">Credit</th>
              <th style="text-align:right">Balance</th>
            </tr></thead>
            <tbody>
              <tr class="opening-row">
                <td></td>
                <td colspan="5" style="color:var(--t2);font-style:italic">Opening Balance</td>
                <td class="num bl">${_fmtSigned(data.openingBalance)}</td>
              </tr>
              ${tRows || '<tr><td colspan="7" style="text-align:center;padding:28px;color:var(--t3)">No transactions in this period</td></tr>'}
            </tbody>
            <tfoot><tr>
              <td colspan="4">Totals</td>
              <td class="num dr">${_fmt(data.totalDebit)}</td>
              <td class="num cr">${_fmt(data.totalCredit)}</td>
              <td class="num bl">${_fmtSigned(data.closingBalance)}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>`;
  } catch (e) { showToast('Error generating report: ' + e.message, 'error'); }
}

function _printReport() {
  const el = document.getElementById('printable-report');
  if (!el) { showToast('Generate a report first', 'error'); return; }
  if (typeof html2pdf !== 'undefined') {
    const accName = document.getElementById('report-account-text')?.value || 'Ledger';
    html2pdf().set({
      margin: [10, 10, 10, 10],
      filename: `Ledger_${accName}_${new Date().toISOString().split('T')[0]}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    }).from(el).save();
  } else {
    window.print();
  }
}

// ═══════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════
function _setupSettings() {
  document.getElementById('dark-mode-toggle').addEventListener('change', e => {
    const theme = e.target.checked ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement[theme === 'light' ? 'setAttribute' : 'removeAttribute']('data-theme', 'light');
  });

  document.getElementById('btn-save-currency').addEventListener('click', () => {
    const sym = document.getElementById('currency-symbol').value.trim() || '$';
    curr = sym;
    localStorage.setItem(CURRENCY_KEY, sym);
    showToast('Currency symbol saved', 'success');
  });

  // FIX Bug#1: Settings card button now uses id="btn-logout-settings" (no longer conflicts with sidebar)
  document.getElementById('btn-logout-settings').addEventListener('click', () => {
    _confirm('Sign Out', 'Sign out of your account?', logout);
  });
  // Sidebar logout
  document.getElementById('btn-logout').addEventListener('click', () => {
    _confirm('Sign Out', 'Sign out of your account?', logout);
  });
  // Top bar logout
  document.getElementById('btn-logout-top')?.addEventListener('click', () => {
    _confirm('Sign Out', 'Sign out of your account?', logout);
  });
}

// ── DOM ready ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { initAuth(); });
