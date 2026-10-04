/* WriteOff MVP — static app. Deterministic math in code; the LLM categorizes and suggests only. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'writeoff_key';         // {provider, key, model}
const LS_EXPENSES = 'writeoff_expenses'; // array of expense objects
const LS_SESSIONS = 'writeoff_sessions'; // array of saved sessions
const LS_RATE = 'writeoff_rate';         // marginal tax rate %
const LS_SPEND = 'writeoff_spend';       // approx key spend, local only

function loadKey() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveKey(obj) { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadExpenses() {
  try { return JSON.parse(localStorage.getItem(LS_EXPENSES) || '[]'); } catch { return []; }
}
function saveExpenses(ex) { localStorage.setItem(LS_EXPENSES, JSON.stringify(ex)); }
function loadSessions() {
  try { return JSON.parse(localStorage.getItem(LS_SESSIONS) || '[]'); } catch { return []; }
}
function saveSessions(s) { localStorage.setItem(LS_SESSIONS, JSON.stringify(s)); }
function loadRate() {
  const r = parseFloat(localStorage.getItem(LS_RATE));
  return isFinite(r) && r >= 0 && r <= 60 ? r : 22;
}
function saveRate(r) { localStorage.setItem(LS_RATE, String(r)); }
function loadSpend() {
  const s = parseFloat(localStorage.getItem(LS_SPEND));
  return isFinite(s) && s >= 0 ? s : 0;
}
function bumpSpend(usd) {
  const s = loadSpend() + usd;
  localStorage.setItem(LS_SPEND, String(s));
  const el = document.getElementById('spend-counter');
  if (el) el.textContent = '$' + s.toFixed(2);
}

/* ================= Tax rules (2025, deterministic) ================= */
const TAX_YEAR = 2025;
const MILEAGE_RATE = 0.70;   // IRS 2025 standard mileage
const HOME_RATE = 5;         // $/sq ft simplified method
const HOME_MAX_SQFT = 300;   // = $1,500 max
const MEALS_RATE = 0.5;      // 50% limit
const SEC179_FLAG_AT = 2500; // de minimis safe harbor threshold

const CATEGORIES = {
  advertising: 'Advertising',
  vehicle: 'Car and truck expenses',
  contract_labor: 'Contract labor',
  insurance: 'Insurance (other than health)',
  interest: 'Interest',
  professional: 'Legal & professional services',
  office: 'Office expenses',
  rent: 'Rent / lease',
  repairs: 'Repairs & maintenance',
  supplies: 'Supplies',
  taxes_licenses: 'Taxes & licenses',
  travel: 'Travel',
  meals: 'Meals (50% limit)',
  utilities: 'Utilities',
  home_office: 'Home office (simplified)',
  depreciation: 'Depreciation / §179',
  other: 'Other expenses',
};
const catName = k => CATEGORIES[k] || CATEGORIES.other;
const validCat = k => (k && CATEGORIES[k]) ? k : 'other';

/* ================= Deterministic deduction engine ================= */
/* Every dollar figure comes from here. The LLM never does math. */
function engine(expenses, marginalRate) {
  const num = v => (isFinite(+v) ? +v : 0);
  const lines = expenses.map(e => {
    const kind = e.kind || 'money';
    const qty = num(e.qty), pct = num(e.pct), amount = num(e.amount);
    let gross, rule;
    if (kind === 'miles') {
      gross = qty * MILEAGE_RATE;
      rule = `${TAX_YEAR} IRS standard mileage: $${MILEAGE_RATE.toFixed(2)}/mi × ${fmtNum(qty)} mi`;
    } else if (kind === 'sqft') {
      const s = Math.min(qty, HOME_MAX_SQFT);
      gross = s * HOME_RATE;
      rule = `Simplified method: $5/sq ft × ${fmtNum(s)} sq ft (max 300)`;
    } else if (e.recurring === 'monthly') {
      gross = amount * 12;
      rule = 'Annualized: monthly × 12';
    } else {
      gross = amount;
      rule = 'One-time expense';
    }
    let deductible = gross;
    if (kind === 'meals') {
      deductible = gross * MEALS_RATE;
      rule += ' → IRS 50% limit on business meals';
    } else if (kind === 'pct') {
      deductible = gross * (pct / 100);
      rule += ` → ${pct}% business use`;
    }
    const flags = [];
    if (e.category === 'depreciation' && gross >= SEC179_FLAG_AT) {
      flags.push({ sev: 'watch', text: `${fmt$(gross)} is over the $2,500 de minimis safe harbor — discuss Section 179 vs. depreciation with your CPA before claiming.` });
    }
    if (kind === 'miles' && qty > 0 && !e.logKept) {
      flags.push({ sev: 'info', text: 'Mileage needs a log: dates, miles, business purpose.' });
    }
    return {
      id: e.id, desc: e.desc || 'Untitled', date: e.date || '',
      category: validCat(e.category), kind, qty, pct,
      gross: Math.round(gross * 100) / 100,
      deductible: Math.round(deductible * 100) / 100,
      rule, flags,
      confidence: e.confidence != null ? e.confidence : 'user',
      why: e.why || '',
      source: e.source || 'manual',
    };
  });
  const byCat = {};
  lines.forEach(l => {
    byCat[l.category] = byCat[l.category] || { name: catName(l.category), total: 0, lines: [] };
    byCat[l.category].total += l.deductible;
    byCat[l.category].lines.push(l);
  });
  const total = lines.reduce((s, l) => s + l.deductible, 0);
  const rate = num(marginalRate) / 100;
  const savings = total * rate;
  return { lines, byCat, totalDeductions: total, savings, rate: num(marginalRate) };
}

/* Receipt checklist — deterministic, prioritized by dollar impact. */
function checklistFor(l) {
  if (l.category === 'vehicle' && l.kind === 'miles')
    return `Keep a mileage log for the ${fmtNum(l.qty)} business miles — dates, miles, business purpose.`;
  if (l.category === 'vehicle')
    return `Keep receipts + business purpose for ${fmt$(l.deductible)} in vehicle expenses.`;
  if (l.category === 'meals')
    return `Keep receipts for ${fmt$(l.gross)} in meals + note who you met and the business purpose (only 50% deductible).`;
  if (l.category === 'depreciation')
    return `Keep the purchase receipt for "${l.desc}" (${fmt$(l.gross)}).` + (l.flags.length ? ' ' + l.flags[0].text : '');
  if (l.category === 'home_office')
    return `Keep a simple sketch or photo of your ${fmtNum(l.qty)} sq ft workspace + proof it's used regularly and exclusively.`;
  if (l.category === 'contract_labor' && l.gross >= 600)
    return `You paid ${fmt$(l.gross)} — issue a 1099-NEC to anyone who got $600+.`;
  if (l.category === 'contract_labor')
    return `Keep payment records for ${fmt$(l.gross)} in contractor payments.`;
  return `Keep a receipt or bank record for "${l.desc}" (${fmt$(l.deductible)}).`;
}

/* ================= Formatting ================= */
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const fmtNum = v => Math.round(v).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const confBadge = c => {
  if (c === 'user') return '<span class="conf high">You confirmed</span>';
  const n = +c || 0;
  const cls = n >= 75 ? 'high' : n >= 50 ? 'med' : 'low';
  return `<span class="conf ${cls}">${n}% sure</span>`;
};

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { engine, checklistFor, CATEGORIES };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');
  const approx = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, msg + ': got ' + a + ', want ~' + b);

  const ex = [
    { id: 't1', desc: 'Camera', amount: 3000, category: 'depreciation', kind: 'money' },
    { id: 't2', desc: 'Miles', kind: 'miles', qty: 1000, category: 'vehicle' },
    { id: 't3', desc: 'Home office', kind: 'sqft', qty: 150, category: 'home_office' },
    { id: 't4', desc: 'Meals', amount: 200, kind: 'meals', category: 'meals' },
    { id: 't5', desc: 'Phone', amount: 100, kind: 'pct', pct: 60, recurring: 'monthly', category: 'utilities' },
    { id: 't6', desc: 'Software', amount: 50, recurring: 'monthly', category: 'office', kind: 'money' },
  ];
  const r = engine(ex, 22);
  approx(r.totalDeductions, 5870, 0.01, 'total deductions');
  approx(r.savings, 1291.40, 0.01, 'savings at 22%');
  const byId = id => r.lines.find(l => l.id === id);
  approx(byId('t1').deductible, 3000, 0.01, 'gear full amount');
  assert(byId('t1').flags.length === 1, 'gear >= $2500 flagged');
  approx(byId('t2').deductible, 700, 0.01, 'miles @ 0.70');
  approx(byId('t3').deductible, 750, 0.01, 'sqft 150*5');
  approx(byId('t4').deductible, 100, 0.01, 'meals 50%');
  approx(byId('t5').deductible, 720, 0.01, 'phone 100*12*0.6');
  approx(byId('t6').deductible, 600, 0.01, 'software annualized');
  // sqft cap
  const r2 = engine([{ id: 'c', desc: 'Big office', kind: 'sqft', qty: 500, category: 'home_office' }], 22);
  approx(r2.totalDeductions, 1500, 0.01, 'sqft capped at 300');
  // empty ledger
  const r3 = engine([], 22);
  assert(r3.totalDeductions === 0 && r3.savings === 0, 'empty ledger = zeros');
  // checklist sanity
  assert(checklistFor(byId('t2')).includes('mileage log'), 'miles checklist');
  assert(checklistFor(byId('t4')).includes('50%'), 'meals checklist');
  console.log('All WriteOff engine self-tests passed.');
}

/* ================= Q&A flows ================= */
/* MVP: creator track fully guided; other work types use the general track (spec: v2). */
const QA_FLOWS = {
  creator: [
    { id: 'gear', text: 'Did you buy gear over $200 this year?', sub: 'Cameras, lenses, mics, lights, computers, hard drives…', capture: { kind: 'money', label: 'Gear purchase', category: 'depreciation', repeat: true, rule: 'Big-ticket gear may need Section 179 / depreciation treatment — flagged on your report.' } },
    { id: 'home', text: 'Do you work from home?', sub: 'A space used regularly and exclusively for business.', capture: { kind: 'sqft', label: 'Home office', category: 'home_office', unit: 'sq ft of dedicated space', rule: 'Simplified method: $5/sq ft, max 300 sq ft ($1,500).' } },
    { id: 'miles', text: 'Did you drive for work?', sub: 'Shoots, client meetings, supply runs — not your commute.', capture: { kind: 'miles', label: 'Business miles', category: 'vehicle', unit: 'business miles driven', rule: '2025 IRS standard rate: $0.70/mile.' } },
    { id: 'software', text: 'Any software or app subscriptions?', sub: 'Editing tools, presets, stock assets, schedulers…', capture: { kind: 'money', label: 'Subscription', category: 'office', recurring: true, rule: 'Monthly amounts are annualized automatically.' } },
    { id: 'contractors', text: 'Did you pay editors, assistants, or collaborators?', sub: '$600+ to one person means you owe them a 1099-NEC.', capture: { kind: 'money', label: 'Contractor payment', category: 'contract_labor', repeat: true } },
    { id: 'education', text: 'Courses, coaching, or books for your craft?', sub: '', capture: { kind: 'money', label: 'Education', category: 'other' } },
    { id: 'meals', text: 'Business meals with clients or collaborators?', sub: 'Only 50% deductible — and keep the who/why.', capture: { kind: 'money', label: 'Business meals', category: 'meals', rule: '50% limit applied automatically.' } },
    { id: 'phone', text: 'Phone or internet used for business?', sub: '', capture: { kind: 'pct', label: 'Phone / internet', category: 'utilities', rule: 'Enter the monthly bill and your business-use %.' } },
  ],
  generic: [
    { id: 'home', text: 'Do you work from home?', sub: 'A space used regularly and exclusively for business.', capture: { kind: 'sqft', label: 'Home office', category: 'home_office', unit: 'sq ft of dedicated space', rule: 'Simplified method: $5/sq ft, max 300 sq ft ($1,500).' } },
    { id: 'miles', text: 'Did you drive for work?', sub: 'Client visits, job sites, supply runs — not commuting.', capture: { kind: 'miles', label: 'Business miles', category: 'vehicle', unit: 'business miles driven', rule: '2025 IRS standard rate: $0.70/mile.' } },
    { id: 'software', text: 'Any software or app subscriptions for work?', sub: '', capture: { kind: 'money', label: 'Subscription', category: 'office', recurring: true, rule: 'Monthly amounts are annualized automatically.' } },
    { id: 'contractors', text: 'Did you pay subcontractors or collaborators?', sub: '$600+ to one person means you owe them a 1099-NEC.', capture: { kind: 'money', label: 'Contractor payment', category: 'contract_labor', repeat: true } },
    { id: 'education', text: 'Courses, training, or books for your work?', sub: '', capture: { kind: 'money', label: 'Education', category: 'other' } },
    { id: 'meals', text: 'Business meals with clients?', sub: 'Only 50% deductible — and keep the who/why.', capture: { kind: 'money', label: 'Business meals', category: 'meals', rule: '50% limit applied automatically.' } },
    { id: 'phone', text: 'Phone or internet used for business?', sub: '', capture: { kind: 'pct', label: 'Phone / internet', category: 'utilities', rule: 'Enter the monthly bill and your business-use %.' } },
    { id: 'travel', text: 'Any business travel — flights, hotels, rideshares?', sub: '', capture: { kind: 'money', label: 'Business travel', category: 'travel' } },
  ],
};
const flowFor = wt => (wt === 'creator' ? QA_FLOWS.creator : QA_FLOWS.generic);

let qa = null; // {workType, idx}

function addExpense(e) {
  const ex = Object.assign({
    id: 'ex-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    createdAt: new Date().toISOString(), source: 'qa', confidence: 'user',
    kind: 'money', category: 'other', amount: 0,
  }, e);
  const all = loadExpenses();
  all.unshift(ex);
  saveExpenses(all);
  return ex;
}
function deleteExpense(id) { saveExpenses(loadExpenses().filter(x => x.id !== id)); }

function startQA(workType) {
  qa = { workType, idx: 0 };
  document.getElementById('qa-worktype').hidden = true;
  document.getElementById('qa-track-note').hidden = workType === 'creator';
  if (workType !== 'creator') document.getElementById('qa-track-name').textContent = workType;
  document.getElementById('qa-flow').hidden = false;
  renderQuestion();
}

function renderQuestion() {
  const flow = flowFor(qa.workType);
  const bar = document.getElementById('qa-progress-bar');
  const label = document.getElementById('qa-progress-label');
  const card = document.getElementById('qa-card');
  if (qa.idx >= flow.length) {
    bar.style.width = '100%';
    label.textContent = 'Done!';
    card.innerHTML = `
      <p class="qa-q">That's everything.</p>
      <p class="qa-sub">Your ledger is loaded. The report does the math and the AI hunts for what you missed.</p>
      <p><button class="btn" id="qa-finish-btn">See my report</button></p>`;
    document.getElementById('qa-finish-btn').addEventListener('click', () => go('ledger'));
    return;
  }
  const q = flow[qa.idx];
  bar.style.width = Math.round((qa.idx / flow.length) * 100) + '%';
  label.textContent = `Question ${qa.idx + 1} of ${flow.length}`;
  card.innerHTML = `
    <p class="qa-q">${esc(q.text)}</p>
    ${q.sub ? `<p class="qa-sub">${esc(q.sub)}</p>` : ''}
    ${q.capture && q.capture.rule ? `<p class="tip" style="margin-bottom:12px">${esc(q.capture.rule)}</p>` : ''}
    <div class="qa-yn">
      <button class="btn" id="qa-yes-btn">Yes</button>
      <button class="btn secondary" id="qa-no-btn">No</button>
    </div>
    <div id="qa-capture"></div>`;
  document.getElementById('qa-yes-btn').addEventListener('click', () => renderCapture(q));
  document.getElementById('qa-no-btn').addEventListener('click', () => { qa.idx++; renderQuestion(); });
}

function renderCapture(q) {
  const c = q.capture;
  const box = document.getElementById('qa-capture');
  const today = new Date().toISOString().slice(0, 10);
  let fields = '';
  if (c.kind === 'money') {
    fields = `
      <div class="grid2">
        <div class="field"><label for="qc-amount">Amount ($)</label><input id="qc-amount" type="number" min="0" step="0.01" placeholder="250"></div>
        <div class="field"><label for="qc-date">Date</label><input id="qc-date" type="date" value="${today}"></div>
      </div>
      <div class="field"><label for="qc-desc">Description</label><input id="qc-desc" placeholder="${esc(c.label)}"></div>
      ${c.recurring ? `<div class="field"><label>How often?</label><div class="seg" id="qc-recur"><button data-v="once" class="on">One-time</button><button data-v="monthly">Monthly</button></div></div>` : ''}`;
  } else if (c.kind === 'miles' || c.kind === 'sqft') {
    fields = `
      <div class="field"><label for="qc-qty">${esc(c.unit || 'Quantity')}</label><input id="qc-qty" type="number" min="0" step="1" placeholder="${c.kind === 'miles' ? '1200' : '120'}"></div>
      <div class="field"><label for="qc-desc">Description <span class="hint">(optional)</span></label><input id="qc-desc" placeholder="${esc(c.label)}"></div>`;
  } else if (c.kind === 'pct') {
    fields = `
      <div class="grid2">
        <div class="field"><label for="qc-amount">Monthly bill ($)</label><input id="qc-amount" type="number" min="0" step="0.01" placeholder="80"></div>
        <div class="field"><label for="qc-pct">Business use (%)</label><input id="qc-pct" type="number" min="1" max="100" value="50"></div>
      </div>
      <div class="field"><label for="qc-desc">Description <span class="hint">(optional)</span></label><input id="qc-desc" placeholder="${esc(c.label)}"></div>`;
  }
  box.innerHTML = `
    <div class="capture" role="group" aria-label="${esc(c.label)} details">
      <h4>${esc(c.label)}</h4>
      ${fields}
      <p class="error" id="qc-error" role="alert"></p>
      <p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
        <button class="btn" id="qc-save-btn">Save</button>
        ${c.repeat ? '<button class="btn secondary" id="qc-save-more-btn">Save &amp; add another</button>' : ''}
        <button class="btn secondary" id="qc-skip-btn">Skip</button>
      </p>
    </div>`;
  const recur = box.querySelector('#qc-recur');
  if (recur) recur.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    recur.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  });
  const readCapture = () => {
    const errEl = document.getElementById('qc-error');
    errEl.textContent = '';
    const exp = { category: c.category, kind: c.kind, qaQ: q.id, why: c.rule || '' };
    if (c.kind === 'money') {
      exp.amount = parseFloat(document.getElementById('qc-amount').value);
      exp.date = document.getElementById('qc-date').value || today;
      exp.desc = document.getElementById('qc-desc').value.trim() || c.label;
      if (c.recurring) exp.recurring = box.querySelector('#qc-recur .on').dataset.v;
      if (!isFinite(exp.amount) || exp.amount <= 0) { errEl.textContent = 'Enter an amount above $0.'; return null; }
    } else if (c.kind === 'miles' || c.kind === 'sqft') {
      exp.qty = parseFloat(document.getElementById('qc-qty').value);
      exp.desc = document.getElementById('qc-desc').value.trim() || c.label;
      exp.date = today;
      if (!isFinite(exp.qty) || exp.qty <= 0) { errEl.textContent = 'Enter a number above 0.'; return null; }
    } else if (c.kind === 'pct') {
      exp.amount = parseFloat(document.getElementById('qc-amount').value);
      exp.pct = parseFloat(document.getElementById('qc-pct').value);
      exp.recurring = 'monthly';
      exp.desc = document.getElementById('qc-desc').value.trim() || c.label;
      exp.date = today;
      if (!isFinite(exp.amount) || exp.amount <= 0) { errEl.textContent = 'Enter a bill amount above $0.'; return null; }
      if (!isFinite(exp.pct) || exp.pct < 1 || exp.pct > 100) { errEl.textContent = 'Business use must be 1–100%.'; return null; }
    }
    return exp;
  };
  document.getElementById('qc-save-btn').addEventListener('click', () => {
    const exp = readCapture(); if (!exp) return;
    addExpense(exp);
    qa.idx++; renderQuestion();
  });
  const moreBtn = document.getElementById('qc-save-more-btn');
  if (moreBtn) moreBtn.addEventListener('click', () => {
    const exp = readCapture(); if (!exp) return;
    addExpense(exp);
    renderCapture(q); // fresh form, same question
  });
  document.getElementById('qc-skip-btn').addEventListener('click', () => { qa.idx++; renderQuestion(); });
}

function qaBack() {
  if (!qa || qa.idx <= 0) return;
  const flow = flowFor(qa.workType);
  const curQ = flow[qa.idx] || flow[flow.length - 1];
  // Remove anything captured at the question we're leaving, then step back.
  if (curQ) saveExpenses(loadExpenses().filter(x => x.qaQ !== curQ.id));
  qa.idx = Math.max(0, qa.idx - (qa.idx >= flow.length ? 0 : 1));
  if (qa.idx >= flow.length) qa.idx = flow.length - 1;
  renderQuestion();
}

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'qa', 'import', 'ledger', 'results', 'history', 'pricing'];

function showView(name) {
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === name);
  });
  if (name === 'setup') syncSetupUI();
  if (name === 'import') syncImportNotice();
  if (name === 'ledger') renderLedger();
  if (name === 'results') renderResults();
  if (name === 'history') renderHistory();
  if (name === 'qa') resetQA();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name) { location.hash = '#/' + name; }
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  showView(name);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', route);
}

function resetQA() {
  qa = null;
  document.getElementById('qa-worktype').hidden = false;
  document.getElementById('qa-track-note').hidden = true;
  document.getElementById('qa-flow').hidden = true;
}

/* ================= LLM (BYOK) ================= */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini', costHint: '~$0.01–0.03/run' },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-3-mini',  costHint: '~$0.01–0.03/run' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', costHint: '~$0.02–0.04/run', corsNote: true },
  gemini: { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', keyHeader: k => ({}), defaultModel: 'gemini-3.5-flash-lite', costHint: '~$0.02–0.04/run', gemini: true },
};
const SPEND_PER_CALL = 0.02;


/* Gemini provider adapter: key goes in the URL query param, not a header. */
async function callGemini(key, model, system, text, maxTokens, images) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  const parts = [{ text: (system ? system + '\n\n' : '') + (text || '') }];
  (images || []).forEach(im => {
    const b64 = im.b64 || (im.dataUrl && im.dataUrl.split(',')[1]) || '';
    if (b64) parts.push({ inline_data: { mime_type: im.mediaType || 'image/jpeg', data: b64 } });
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: maxTokens || 700, temperature: 0.4 },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Provider error ' + res.status + ': ' + t.slice(0, 160));
  }
  const j = await res.json();
  return ((j.candidates || []).map(c =>
    ((c.content && c.content.parts) || []).map(pt => pt.text || '').join('')
  ).join('\n') || '');
}

async function callLLM(provider, key, model, system, user, maxTokens) {
  const p = PROVIDERS[provider];
  if (p.gemini) return callGemini(key, model, system, user, maxTokens);
  let res;
  if (provider === 'anthropic') {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, max_tokens: maxTokens || 1200, system, messages: [{ role: 'user', content: user }] }),
    });
  } else {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 1200, temperature: 0.3 }),
    });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Provider error ' + res.status + ': ' + t.slice(0, 160));
  }
  const j = await res.json();
  const text = provider === 'anthropic'
    ? (j.content || []).map(b => b.text || '').join('')
    : (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  bumpSpend(SPEND_PER_CALL);
  return text;
}

function parseJsonArray(text) {
  const clean = String(text).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('['), end = clean.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('No JSON array found in the AI response.');
  return JSON.parse(clean.slice(start, end + 1));
}

const CAT_KEYS = Object.keys(CATEGORIES).join(', ');

function buildCategorizePrompt(text) {
  return {
    system: 'You are a plain-spoken tax-organization helper for freelancers. Extract expense line items from the user\'s pasted text. ' +
      'Rules: take amounts exactly as stated — never compute, total, or annualize anything. Never invent expenses not in the text. ' +
      'For each item return: desc (short), amount (number as stated, 0 if not stated), date (as stated or null), ' +
      'category (exactly one of: ' + CAT_KEYS + '), kind ("money" normally; "miles" if the line is about miles driven — put the miles in qty; "sqft" if about home-office square footage — put sqft in qty), ' +
      'qty (number, only for miles/sqft), confidence (0-100), why (one line: why this is potentially deductible). ' +
      'Return ONLY a valid JSON array. No markdown fences, no commentary.',
    user: text.slice(0, 6000),
  };
}

function buildMissedPrompt(workType, expenses) {
  const lines = expenses.map(e => `- ${e.desc} | ${catName(e.category)} | $${Math.round(e.amount || 0)}`).join('\n');
  return {
    system: 'You are a plain-spoken tax-organization helper for freelancers. You never compute dollar figures; you explain, suggest records to keep, and flag what to discuss with a CPA. ' +
      'Suggest commonly-missed deductions only — never invent expenses the user already claimed. ' +
      'Label every suggestion as something to check, not a certainty. ' +
      'Return ONLY a valid JSON array of {title, category (exactly one of: ' + CAT_KEYS + '), why (one line), action (one line: what record to keep)}. No markdown fences, no commentary.',
    user: `Work type: ${workType || 'freelancer'}.\nCaptured expenses:\n${lines || '(none yet)'}\n\nSuggest 5-8 commonly-missed deductions for this profile NOT already covered above.`,
  };
}

async function testKey() {
  const errEl = document.getElementById('key-error'), okEl = document.getElementById('key-success');
  errEl.textContent = ''; okEl.textContent = '';
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const key = document.getElementById('api-key').value.trim();
  const model = document.getElementById('model').value.trim() || PROVIDERS[provider].defaultModel;
  if (!key) { errEl.textContent = 'Paste a key first.'; return; }
  const btn = document.getElementById('test-key-btn');
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    await callLLM(provider, key, model, 'Reply with exactly: ok', 'Reply with exactly: ok', 10);
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per Q&A run: ' + PROVIDERS[provider].costHint + '.';
  } catch (e) {
    errEl.textContent = 'Key test failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = false; btn.textContent = 'Test key'; }
}

/* ================= Views ================= */
function syncSetupUI() {
  const saved = loadKey();
  const provider = (saved && saved.provider) || 'openai';
  document.querySelectorAll('.provider').forEach(el => {
    const sel = el.dataset.provider === provider;
    el.classList.toggle('selected', sel);
    el.querySelector('input').checked = sel;
  });
  document.getElementById('anthropic-note').hidden = provider !== 'anthropic';
  if (saved) {
    document.getElementById('api-key').value = saved.key || '';
    document.getElementById('model').value = saved.model || PROVIDERS[provider].defaultModel;
  } else {
    document.getElementById('model').value = PROVIDERS[provider].defaultModel;
  }
  document.getElementById('model-hint').textContent =
    PROVIDERS[provider].name + ' default: ' + PROVIDERS[provider].defaultModel + ' (' + PROVIDERS[provider].costHint + '). You can type any model name.';
  document.getElementById('spend-counter').textContent = '$' + loadSpend().toFixed(2);
}

function syncImportNotice() {
  document.getElementById('import-no-key').hidden = !!loadKey();
}

function renderLedger() {
  const expenses = loadExpenses();
  const r = engine(expenses, loadRate());
  document.getElementById('ledger-count').textContent = expenses.length;
  document.getElementById('ledger-total').textContent = fmt$(r.totalDeductions);
  const list = document.getElementById('ledger-list');
  if (!expenses.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">Nothing here yet. <a href="#/qa" data-nav="qa" style="color:var(--accent)">Run the Q&amp;A</a> or <a href="#/import" data-nav="import" style="color:var(--accent)">paste expenses</a> to start your ledger.</p></div>';
    return;
  }
  list.innerHTML = expenses.map(e => {
    const line = r.lines.find(l => l.id === e.id);
    const ded = line ? fmt$(line.deductible) : fmt$(e.amount || 0);
    return `
    <div class="exp-row">
      <div class="info">
        <strong>${esc(e.desc)}</strong>
        <small><span class="cat-tag">${esc(catName(e.category))}</span> &middot; ${e.date ? esc(e.date) + ' &middot; ' : ''}${e.source === 'qa' ? 'Q&A' : e.source === 'import' ? 'AI import' : 'manual'} &middot; ${confBadge(e.confidence)}</small>
        ${e.why ? `<div class="why">${esc(e.why)}</div>` : ''}
      </div>
      <div class="exp-amt">${ded}</div>
      <div class="row-actions no-print"><button data-del-exp="${e.id}" aria-label="Delete expense">Delete</button></div>
    </div>`;
  }).join('');
}

let missedCache = { hash: null, html: null };

function renderResults() {
  const expenses = loadExpenses();
  const rate = loadRate();
  const r = engine(expenses, rate);
  document.getElementById('rate-input').value = rate;
  document.getElementById('print-date').textContent = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const box = document.getElementById('results-content');

  if (!expenses.length) {
    box.innerHTML = '<div class="card"><h1>Your deduction report</h1><p style="color:var(--muted-fg)">No expenses yet — the report needs something to work with. <a href="#/qa" data-nav="qa" style="color:var(--accent)">Run the Q&amp;A</a> or <a href="#/import" data-nav="import" style="color:var(--accent)">paste expenses</a> first.</p></div>';
    return;
  }

  const catRows = Object.keys(r.byCat).sort((a, b) => r.byCat[b].total - r.byCat[a].total).map(k => {
    const c = r.byCat[k];
    return `<tr><td>${esc(c.name)} <span style="color:var(--muted-fg)">(${c.lines.length})</span></td><td class="pos">${fmt$(c.total)}</td></tr>`;
  }).join('');

  const lineRows = r.lines.map(l => `
    <tr><td>${esc(l.desc)}<br><small style="color:var(--muted-fg)">${esc(l.rule)}${l.why ? ' · ' + esc(l.why) : ''}</small></td>
    <td>${esc(catName(l.category))}</td><td class="pos">${fmt$(l.deductible)}</td></tr>`).join('');

  const flags = r.lines.flatMap(l => l.flags.map(f => ({ sev: f.sev, text: f.text })));

  const checks = [...r.lines].sort((a, b) => b.deductible - a.deductible).map((l, i) => `
    <label class="check"><input type="checkbox" data-check="${l.id}"><span class="txt"><strong>${fmt$(l.deductible)}</strong> — ${esc(checklistFor(l))}</span></label>`).join('');

  box.innerHTML = `
    <h1 class="no-print">Your deduction report</h1>
    <p class="lead no-print" style="margin-bottom:20px">${TAX_YEAR} tax-year rules &middot; savings at your ${rate}% marginal rate. Every number below is computed in code.</p>

    <div class="sample-strip">
      <div class="stat"><div class="v">${fmt$(r.totalDeductions)}</div><div class="l">total deductions</div></div>
      <div class="stat"><div class="v">${fmt$(r.savings)}</div><div class="l">est. tax savings</div></div>
      <div class="stat"><div class="v">${r.lines.length}</div><div class="l">expenses</div></div>
      <div class="stat"><div class="v">${Object.keys(r.byCat).length}</div><div class="l">Schedule C categories</div></div>
    </div>

    <h2>By Schedule C category</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Category</th><th>Deductible</th></tr>
      ${catRows}
      <tr class="total"><td>Total</td><td>${fmt$(r.totalDeductions)}</td></tr>
    </table>
    <div class="formula">Est. tax savings = ${fmt$(r.totalDeductions)} × ${rate}% = <strong>${fmt$(r.savings)}</strong></div></div>

    <h2>Line by line</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Expense</th><th>Category</th><th>Deductible</th></tr>
      ${lineRows}
    </table></div>

    ${flags.length ? `<h2>Heads up</h2><div class="card">${flags.map(f => `<div class="flag"><span class="sev ${f.sev}">${f.sev}</span><span>${esc(f.text)}</span></div>`).join('')}</div>` : ''}

    <h2 class="no-print">Missed deductions</h2>
    <div class="card no-print" id="missed-card">
      <div aria-live="polite" id="missed-content"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><p style="color:var(--muted-fg);font-size:.9rem">Asking the AI what you might have missed…</p></div>
    </div>

    <h2>Receipt checklist</h2>
    <div class="card"><p class="tip" style="margin-bottom:8px">Prioritized by dollar impact. Tick things off as you file them.</p>${checks}</div>`;

  // checklist strikethrough
  box.querySelectorAll('[data-check]').forEach(cb => {
    cb.addEventListener('change', () => cb.closest('.check').classList.toggle('done', cb.checked));
  });

  runMissedDeductions(r);
}

async function runMissedDeductions(r) {
  const content = document.getElementById('missed-content');
  if (!content) return;
  const saved = loadKey();
  if (!saved || !saved.key) {
    content.innerHTML = '<div class="notice warn" style="margin-bottom:0">Save an API key to get AI missed-deduction suggestions. <a href="#/setup" data-nav="setup">Set it up</a> — the math above is complete without it.</div>';
    return;
  }
  const hash = JSON.stringify(loadExpenses().map(e => [e.id, e.amount, e.qty, e.desc]));
  if (missedCache.hash === hash && missedCache.html) {
    content.innerHTML = missedCache.html;
    wireSuggestAdds(content);
    return;
  }
  try {
    const { system, user } = buildMissedPrompt(qa && qa.workType, loadExpenses());
    const text = await callLLM(saved.provider, saved.key, saved.model || PROVIDERS[saved.provider].defaultModel, system, user, 900);
    const items = parseJsonArray(text).slice(0, 10);
    if (!items.length) throw new Error('The AI returned no suggestions.');
    const html = '<p class="tip" style="margin-bottom:12px">Commonly missed for your profile — <strong>check whether each applies to you</strong> before adding anything.</p>' +
      items.map((s, i) => `
      <div class="suggest-row">
        <strong>${esc(s.title || 'Suggestion')}</strong>
        <p><span class="cat-tag">${esc(catName(validCat(s.category)))}</span></p>
        <p style="margin-top:6px">${esc(s.why || '')}</p>
        <p class="tip">Keep: ${esc(s.action || 'a receipt or record')}</p>
        <button class="btn secondary add" data-suggest="${i}">Add to ledger</button>
      </div>`).join('');
    missedCache = { hash, html, items };
    const still = document.getElementById('missed-content');
    if (still) { still.innerHTML = html; wireSuggestAdds(still); }
  } catch (e) {
    const still = document.getElementById('missed-content');
    if (still) still.innerHTML = `<div class="notice warn" style="margin-bottom:0">Missed-deduction check failed: ${esc(e.message)}. Your report above is unaffected.</div>`;
  }
}

function wireSuggestAdds(scope) {
  const items = missedCache.items || [];
  scope.querySelectorAll('[data-suggest]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = items[+btn.dataset.suggest];
      if (!s) return;
      // Prefill the manual-add form on the ledger so the user sets the amount.
      go('ledger');
      setTimeout(() => {
        const det = document.querySelector('#view-ledger details.assume');
        if (det) det.open = true;
        document.getElementById('m-desc').value = s.title || '';
        document.getElementById('m-category').value = validCat(s.category);
        document.getElementById('m-amount').focus();
      }, 150);
    });
  });
}

async function runImport() {
  const errEl = document.getElementById('import-error');
  const box = document.getElementById('import-results');
  errEl.textContent = ''; box.innerHTML = '';
  const text = document.getElementById('import-text').value.trim();
  if (!text) { errEl.textContent = 'Paste some expenses first.'; return; }
  const saved = loadKey();
  if (!saved || !saved.key) { errEl.textContent = 'Save an API key first — categorization runs on your key.'; return; }
  const btn = document.getElementById('import-btn');
  btn.disabled = true; btn.textContent = 'Categorizing…';
  box.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="width:80%"></div><p style="color:var(--muted-fg);font-size:.9rem">Reading your expenses…</p>';
  try {
    const { system, user } = buildCategorizePrompt(text);
    const raw = await callLLM(saved.provider, saved.key, saved.model || PROVIDERS[saved.provider].defaultModel, system, user, 1500);
    const items = parseJsonArray(raw);
    if (!items.length) throw new Error('The AI found no expenses in that text.');
    const today = new Date().toISOString().slice(0, 10);
    const norm = items.map((it, i) => ({
      desc: String(it.desc || 'Expense ' + (i + 1)).slice(0, 120),
      amount: isFinite(+it.amount) ? +it.amount : 0,
      date: it.date || today,
      category: validCat(it.category),
      kind: it.kind === 'miles' || it.kind === 'sqft' ? it.kind : 'money',
      qty: isFinite(+it.qty) ? +it.qty : 0,
      confidence: Math.max(0, Math.min(100, Math.round(+it.confidence) || 50)),
      why: String(it.why || '').slice(0, 200),
    }));
    box.innerHTML = '<p class="tip" style="margin-bottom:12px">Amounts are taken as you wrote them — the AI doesn\'t do math. Uncheck anything that doesn\'t belong.</p>' +
      norm.map((it, i) => `
      <div class="exp-row">
        <div class="info">
          <strong>${esc(it.desc)}</strong>
          <small><span class="cat-tag">${esc(catName(it.category))}</span> &middot; ${confBadge(it.confidence)}</small>
          ${it.why ? `<div class="why">${esc(it.why)}</div>` : ''}
        </div>
        <div class="exp-amt">${it.kind === 'miles' ? fmtNum(it.qty) + ' mi' : it.kind === 'sqft' ? fmtNum(it.qty) + ' sq ft' : fmt$(it.amount)}</div>
        <div class="row-actions"><label class="compare-check"><input type="checkbox" data-import-pick="${i}" checked></label></div>
      </div>`).join('') +
      '<p style="margin-top:12px"><button class="btn" id="import-add-btn">Add selected to ledger</button></p>';
    document.getElementById('import-add-btn').addEventListener('click', () => {
      let n = 0;
      box.querySelectorAll('[data-import-pick]:checked').forEach(cb => {
        const it = norm[+cb.dataset.importPick];
        addExpense({ desc: it.desc, amount: it.amount, date: it.date, category: it.category, kind: it.kind, qty: it.qty, source: 'import', confidence: it.confidence, why: it.why });
        n++;
      });
      box.innerHTML = `<p class="success">${n} expense${n === 1 ? '' : 's'} added to your ledger.</p>`;
      document.getElementById('import-text').value = '';
    });
  } catch (e) {
    box.innerHTML = '';
    errEl.textContent = 'Categorization failed: ' + e.message;
  } finally { btn.disabled = false; btn.textContent = 'Categorize with AI'; }
}

/* ================= History ================= */
function renderHistory() {
  const sessions = loadSessions();
  const list = document.getElementById('history-list');
  if (!sessions.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No saved sessions yet. Run the Q&amp;A, then hit "Save this session" on your report.</p></div>';
    return;
  }
  list.innerHTML = sessions.map(s => `
    <div class="exp-row" role="button" tabindex="0" data-open-session="${s.id}" aria-label="Open session from ${esc(s.dateLabel)}" style="cursor:pointer">
      <div class="info"><strong>${esc(s.dateLabel)}</strong>
        <small>${s.expenseCount} expenses &middot; ${fmt$(s.totalDeductions)} deductions &middot; ${fmt$(s.savings)} est. savings &middot; ${esc(s.workType || 'general')}</small></div>
      <div class="row-actions no-print"><button data-del-session="${s.id}" aria-label="Delete session">Delete</button></div>
    </div>`).join('');
}

function saveSession() {
  const expenses = loadExpenses();
  if (!expenses.length) return;
  const rate = loadRate();
  const r = engine(expenses, rate);
  const sessions = loadSessions();
  const id = 'sess-' + Date.now().toString(36);
  sessions.unshift({
    id,
    createdAt: new Date().toISOString(),
    dateLabel: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    workType: qa && qa.workType ? qa.workType : 'general',
    expenses, rate,
    expenseCount: expenses.length,
    totalDeductions: Math.round(r.totalDeductions * 100) / 100,
    savings: Math.round(r.savings * 100) / 100,
  });
  saveSessions(sessions.slice(0, 50));
  const btn = document.getElementById('save-session-btn');
  const orig = btn.textContent;
  btn.textContent = 'Saved!';
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

/* ================= Init ================= */
function init() {
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); go(el.dataset.nav); });
  });

  document.querySelectorAll('.provider').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.provider').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      el.querySelector('input').checked = true;
      const p = el.dataset.provider;
      document.getElementById('anthropic-note').hidden = p !== 'anthropic';
      const saved = loadKey();
      if (!saved || saved.provider !== p) document.getElementById('model').value = PROVIDERS[p].defaultModel;
      document.getElementById('model-hint').textContent =
        PROVIDERS[p].name + ' default: ' + PROVIDERS[p].defaultModel + ' (' + PROVIDERS[p].costHint + '). You can type any model name.';
    });
  });

  document.getElementById('test-key-btn').addEventListener('click', testKey);
  document.getElementById('save-key-btn').addEventListener('click', () => {
    const errEl = document.getElementById('key-error'), okEl = document.getElementById('key-success');
    errEl.textContent = ''; okEl.textContent = '';
    const provider = document.querySelector('input[name="provider"]:checked').value;
    const key = document.getElementById('api-key').value.trim();
    if (!key) { errEl.textContent = 'Paste a key first.'; return; }
    saveKey({ provider, key, model: document.getElementById('model').value.trim() || PROVIDERS[provider].defaultModel });
    okEl.textContent = 'Key saved in this browser only.';
  });
  document.getElementById('clear-key-btn').addEventListener('click', () => {
    clearKey();
    document.getElementById('api-key').value = '';
    document.getElementById('key-success').textContent = 'Key removed.';
    syncSetupUI();
  });

  // Q&A
  document.querySelectorAll('.worktype').forEach(el => {
    el.addEventListener('click', () => startQA(el.dataset.worktype));
  });
  document.getElementById('qa-back-btn').addEventListener('click', qaBack);
  document.getElementById('qa-quit-btn').addEventListener('click', () => go('ledger'));

  // Import
  document.getElementById('import-btn').addEventListener('click', runImport);

  // Ledger
  const mCat = document.getElementById('m-category');
  mCat.innerHTML = Object.keys(CATEGORIES).map(k => `<option value="${k}">${esc(CATEGORIES[k])}</option>`).join('');
  document.getElementById('m-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('m-add-btn').addEventListener('click', () => {
    const errEl = document.getElementById('m-error');
    errEl.textContent = '';
    const amount = parseFloat(document.getElementById('m-amount').value);
    const desc = document.getElementById('m-desc').value.trim();
    if (!desc) { errEl.textContent = 'Give it a description.'; return; }
    if (!isFinite(amount) || amount <= 0) { errEl.textContent = 'Enter an amount above $0.'; return; }
    addExpense({
      desc, amount,
      date: document.getElementById('m-date').value || new Date().toISOString().slice(0, 10),
      category: mCat.value, kind: 'money', source: 'manual', confidence: 'user',
    });
    document.getElementById('m-desc').value = '';
    document.getElementById('m-amount').value = '';
    errEl.textContent = '';
    renderLedger();
  });
  document.getElementById('ledger-clear-btn').addEventListener('click', () => {
    if (!loadExpenses().length) return;
    if (confirm('Delete all expenses in the ledger? This cannot be undone.')) {
      saveExpenses([]);
      renderLedger();
    }
  });
  document.getElementById('ledger-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del-exp]');
    if (del) { deleteExpense(del.dataset.delExp); renderLedger(); }
  });

  // Results
  document.getElementById('rate-input').addEventListener('input', e => {
    const r = parseFloat(e.target.value);
    if (isFinite(r) && r >= 0 && r <= 60) { saveRate(r); renderResults(); }
  });
  document.getElementById('print-btn').addEventListener('click', () => window.print());
  document.getElementById('save-session-btn').addEventListener('click', saveSession);

  // History
  document.getElementById('history-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del-session]');
    if (del) {
      e.stopPropagation();
      saveSessions(loadSessions().filter(s => s.id !== del.dataset.delSession));
      renderHistory();
      return;
    }
    const row = e.target.closest('[data-open-session]');
    if (row) {
      const s = loadSessions().find(x => x.id === row.dataset.openSession);
      if (!s) return;
      if (loadExpenses().length && !confirm('Load this session\'s expenses into your ledger? Your current ledger will be replaced.')) return;
      saveExpenses(s.expenses || []);
      saveRate(s.rate != null ? s.rate : 22);
      go('ledger');
    }
  });
  document.getElementById('history-list').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const row = e.target.closest('[data-open-session]'); if (row) row.click(); }
  });

  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
