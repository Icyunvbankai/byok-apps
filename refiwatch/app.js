/* RefiWatch MVP — static app. Deterministic break-even math in code; the LLM narrates only.
   Never predicts rates. Keys live in localStorage; calls go browser -> provider directly. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'refiwatch_key';         // {provider, key, model}
const LS_LOANS = 'refiwatch_loans';     // array of loan profiles
const LS_SPEND = 'refiwatch_spend';     // estimated USD spent on user's key
const LS_DEFAULTS = 'refiwatch_defaults'; // {thresholdMo}

function lsGet(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } }
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function loadKey() { return lsGet(LS_KEY, null); }
function saveKey(o) { lsSet(LS_KEY, o); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadLoans() { return lsGet(LS_LOANS, []); }
function saveLoans(l) { lsSet(LS_LOANS, l); }
function getLoan(id) { return loadLoans().find(l => l.id === id); }
function upsertLoan(loan) {
  const loans = loadLoans();
  const i = loans.findIndex(l => l.id === loan.id);
  if (i >= 0) loans[i] = loan; else loans.unshift(loan);
  saveLoans(loans);
}
function deleteLoan(id) { saveLoans(loadLoans().filter(l => l.id !== id)); }
function getSpend() { return lsGet(LS_SPEND, 0); }
function addSpend(usd) { lsSet(LS_SPEND, Math.round((getSpend() + usd) * 10000) / 10000); }
function getDefaults() { return Object.assign({ thresholdMo: 24 }, lsGet(LS_DEFAULTS, {})); }

/* ================= Deterministic break-even engine ================= */
/* Every dollar figure comes from here. The LLM is never asked to do math. */
function pmt(principal, annualRatePct, months) {
  if (!(principal > 0) || !(months > 0)) return 0;
  const r = annualRatePct / 100 / 12;
  if (r <= 0) return principal / months;
  const f = Math.pow(1 + r, months);
  return principal * r * f / (f - 1);
}

/* Rule-based closing-cost itemization. Every line is an estimate. */
function closingCosts(balance, taxA, insA, origPct) {
  const num = v => (isFinite(+v) ? +v : 0);
  const origination = num(balance) * num(origPct) / 100;
  const appraisal = 500;
  const title = 1500;
  const recording = 200;
  const prepaids = (num(taxA) + num(insA)) / 6; // ~2 months of escrow
  return { origination, appraisal, title, recording, prepaids, total: origination + appraisal + title + recording + prepaids };
}

/* Months to retire `balance` at `annualRatePct` paying `payment`/mo. */
function payoffMonths(balance, annualRatePct, payment) {
  if (!(balance > 0) || !(payment > 0)) return 0;
  const r = annualRatePct / 100 / 12;
  if (r <= 0) return Math.ceil(balance / payment);
  if (payment <= balance * r) return Infinity; // never amortizes
  return Math.ceil(-Math.log(1 - balance * r / payment) / Math.log(1 + r));
}

function analyze(loan, candRatePct, candTermYears) {
  const num = v => (isFinite(+v) ? +v : 0);
  const balance = num(loan.balance), ratePct = num(loan.ratePct), monthsLeft = Math.max(1, Math.round(num(loan.monthsLeft)));
  const homeValue = num(loan.homeValue), taxA = num(loan.taxA), insA = num(loan.insA), origPct = num(loan.origPct);
  const termMonths = (candTermYears === 15 ? 15 : 30) * 12;

  const curPmt = pmt(balance, ratePct, monthsLeft);
  const newPmt = pmt(balance, candRatePct, termMonths);
  const savings = curPmt - newPmt;
  const cc = closingCosts(balance, taxA, insA, origPct);
  const breakEven = savings > 0 ? Math.ceil(cc.total / savings) : Infinity;
  const fiveYr = savings * 60 - cc.total;
  const curInterest = curPmt * monthsLeft - balance;
  const newInterest = newPmt * termMonths - balance;
  const lifetime = curInterest - newInterest - cc.total; // accounts for term reset
  const keepMonths = savings > 0 ? payoffMonths(balance, candRatePct, curPmt) : Infinity;
  const keepInterest = isFinite(keepMonths) ? curPmt * keepMonths - balance : Infinity;
  const keepSave = isFinite(keepInterest) ? curInterest - keepInterest - cc.total : -Infinity;
  const ltv = homeValue > 0 ? balance / homeValue : 0;
  return { curPmt, newPmt, savings, cc, breakEven, fiveYr, lifetime, keepMonths, keepSave, ltv, curInterest, newInterest, termMonths, candRatePct, candTermYears };
}

/* Deterministic flags (code, not LLM). */
function codeFlags(loan, a) {
  const flags = [];
  if (a.ltv > 1) flags.push({ sev: 'dealbreaker', text: 'LTV is over 100% — you owe more than the home is worth. A standard refi is unlikely until value recovers or balance drops.' });
  else if (a.ltv > 0.8) flags.push({ sev: 'watch', text: 'LTV is above 80% (' + (a.ltv * 100).toFixed(1) + '%) — a refi may require PMI or price in a higher rate. Ask your lender how they treat it.' });
  if (!(a.savings > 0)) flags.push({ sev: 'dealbreaker', text: 'At this candidate rate your monthly payment would rise, not fall. Break-even never arrives — this rate is a non-starter.' });
  if (a.candTermYears === 30 && loan.monthsLeft < 330) flags.push({ sev: 'watch', text: 'You would reset to a fresh 30 years with only ' + loan.monthsLeft + ' months left now — that stretches interest out again. Compare the 15-year or keeping your old payment.' });
  if (loan.credit === 'fair') flags.push({ sev: 'watch', text: 'Credit tier is Fair — the candidate rate above may be optimistic for your tier. Get a real quote before trusting the math.' });
  else if (loan.credit === 'good') flags.push({ sev: 'info', text: 'Credit tier is Good — top-tier advertised rates usually need 740+. Treat the candidate rate as a target, not a promise.' });
  if (a.breakEven > (loan.thresholdMo || 24) && isFinite(a.breakEven)) flags.push({ sev: 'info', text: 'Break-even (' + a.breakEven + ' mo) is past your ' + (loan.thresholdMo || 24) + '-month threshold — the watchlist will tell you if quotes improve.' });
  return flags;
}

/* ================= Formatting ================= */
const fmt$ = v => { if (!isFinite(v)) return '—'; return (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US'); };
const fmtPct = v => (v * 100).toFixed(2) + '%';
const fmtPct1 = v => (v * 100).toFixed(1) + '%';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => { try { return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return iso; } };

/* Node test hook: `node app.js` runs self-tests. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pmt, closingCosts, payoffMonths, analyze, codeFlags };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');
  const approx = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, msg + ': got ' + a + ', want ~' + b);

  // T1: canonical $350k @ 7% / 30yr payment
  approx(pmt(350000, 7, 360), 2328.56, 1.0, 'T1 payment');
  // T2: $350k @ 5.5% / 30yr
  approx(pmt(350000, 5.5, 360), 1987.26, 1.0, 'T2 payment');
  // T3: closing-cost itemization — hand-computed $5,050
  const cc = closingCosts(350000, 4800, 1800, 0.5);
  approx(cc.total, 5050, 0.01, 'T3 closing total');
  approx(cc.origination, 1750, 0.01, 'T3 origination');
  approx(cc.prepaids, 1100, 0.01, 'T3 prepaids');
  // T4: full break-even on the sample loan — hand-computed: 13 months, ~$19.3k 5-yr, ~$69k lifetime
  const sample = { balance: 350000, ratePct: 7, monthsLeft: 330, homeValue: 450000, taxA: 4800, insA: 1800, origPct: 0.5, thresholdMo: 24, credit: 'excellent' };
  const a = analyze(sample, 5.5, 30);
  assert(a.breakEven === 13, 'T4 break-even 13 months, got ' + a.breakEven);
  approx(a.savings, 405, 3, 'T4 monthly savings');
  approx(a.fiveYr, 19268, 300, 'T4 five-year savings');
  approx(a.lifetime, 69080, 800, 'T4 lifetime savings');
  approx(a.ltv, 0.7778, 0.001, 'T4 LTV');
  // T5: candidate rate above current rate -> savings <= 0, break-even never
  const b = analyze(sample, 8, 30);
  assert(!(b.savings > 0), 'T5 no savings at higher rate');
  assert(!isFinite(b.breakEven), 'T5 break-even is Infinity');
  // T6: keep-old-payment scenario — hand-computed ~243 months payoff
  const kp = payoffMonths(350000, 5.5, a.curPmt);
  assert(Math.abs(kp - 243) <= 3, 'T6 keep-payment payoff ~243 mo, got ' + kp);
  assert(a.keepSave > 150000, 'T6 keep-payment saves six figures, got ' + a.keepSave);
  // T7: flags — high LTV triggers PMI watch flag
  const hi = Object.assign({}, sample, { homeValue: 380000 });
  const fa = codeFlags(hi, analyze(hi, 5.5, 30));
  assert(fa.some(f => /PMI/.test(f.text)), 'T7 PMI flag on LTV > 80%');
  console.log('All RefiWatch self-tests passed.');
}

/* ================= LLM (BYOK) ================= */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini', costHint: '~$0.01/analysis' },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-3-mini',  costHint: '~$0.01/analysis' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', costHint: '~$0.02/analysis', corsNote: true },
};

/* No-prediction guardrail: banned phrases indicating rate forecasting. */
const BANNED = ['rates will', 'rates are expected', 'expect rates to', 'rates should fall', 'rates should rise', 'rates are likely to', 'rate prediction', 'forecast rates', 'rates to drop', 'rates to climb'];
function hasPrediction(text) {
  const t = String(text).toLowerCase();
  return BANNED.filter(p => t.includes(p));
}

function buildVerdictPrompt(loan, a, flags) {
  const ccLines = [
    'Origination (' + loan.origPct + '%): ' + fmt$(a.cc.origination),
    'Appraisal: ' + fmt$(a.cc.appraisal),
    'Title insurance/search: ' + fmt$(a.cc.title),
    'Recording: ' + fmt$(a.cc.recording),
    'Prepaid/escrow: ' + fmt$(a.cc.prepaids),
  ].join('; ');
  return {
    system: 'You are a fee-only-minded mortgage analyst. You explain amortization in plain English. ' +
      'You NEVER predict future interest rates or rate direction — not even softly. ' +
      'You never invent lender quotes. You always name the caveats: term reset, closing costs, and that break-even depends on how long they stay in the home. ' +
      'Use ONLY the numbers provided below — do not recompute them. Keep the whole response under 200 words.',
    user:
`Borrower: ${loan.name || 'Unnamed loan'} | Credit tier: ${loan.credit} | Alert threshold: ${loan.thresholdMo} months
CURRENT LOAN (verified, computed in code): balance ${fmt$(loan.balance)} at ${loan.ratePct}% with ${loan.monthsLeft} months left; current P&I ${fmt$(a.curPmt)}/mo; home value ${fmt$(loan.homeValue)} (LTV ${fmtPct1(a.ltv)}).
CANDIDATE REFI (verified, computed in code): ${a.candRatePct}% ${a.candTermYears}-year fixed -> new P&I ${fmt$(a.newPmt)}/mo; monthly savings ${fmt$(a.savings)}/mo.
CLOSING COSTS (estimates): ${ccLines}. TOTAL ${fmt$(a.cc.total)}.
BREAK-EVEN: ${isFinite(a.breakEven) ? a.breakEven + ' months' : 'never at this rate'} | 5-year net savings ${fmt$(a.fiveYr)} | lifetime interest savings ${fmt$(a.lifetime)}.
KEEP-PAYMENT SCENARIO: keep paying ${fmt$(a.curPmt)}/mo on the new loan -> payoff in ${isFinite(a.keepMonths) ? a.keepMonths + ' months' : 'n/a'}, total savings ${fmt$(a.keepSave)}.
CODE FLAGS: ${flags.length ? flags.map(f => '[' + f.sev + '] ' + f.text).join(' | ') : 'none'}

Write:
1. VERDICT (2-3 sentences): refinance now, wait for better, or not at these levels — grounded ONLY in the numbers above.
2. CAVEATS: the 2-3 biggest ones specific to THIS loan.
3. ASK YOUR LENDER: 3 sharp questions to ask before signing.`
  };
}

async function callLLM(provider, key, model, system, user, maxTokens) {
  const p = PROVIDERS[provider];
  let res;
  if (provider === 'anthropic') {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, max_tokens: maxTokens || 600, system, messages: [{ role: 'user', content: user }] }),
    });
  } else {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 600, temperature: 0.4 }),
    });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Provider error ' + res.status + ': ' + t.slice(0, 160));
  }
  const j = await res.json();
  if (provider === 'anthropic') return (j.content || []).map(b => b.text || '').join('');
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
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
    addSpend(0.001);
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per analysis: ' + PROVIDERS[provider].costHint + '.';
  } catch (e) {
    errEl.textContent = 'Key test failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = false; btn.textContent = 'Test key'; }
}

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'loan', 'dash', 'watch', 'verdict', 'history', 'pricing', 'settings'];
let currentLoanId = null;

function currentLoan() {
  return getLoan(currentLoanId) || loadLoans()[0] || null;
}

function showView(name) {
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'setup') syncSetupUI();
  if (name === 'loan') syncLoanUI();
  if (name === 'dash') renderDash();
  if (name === 'watch') renderWatch();
  if (name === 'verdict') renderVerdict();
  if (name === 'history') renderHistory();
  if (name === 'settings') syncSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) {
  if ((name === 'dash' || name === 'watch' || name === 'verdict') && arg) currentLoanId = arg;
  location.hash = '#/' + name + (arg ? '/' + arg : '');
}
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if (parts[1] && (name === 'dash' || name === 'watch' || name === 'verdict')) currentLoanId = parts[1];
  showView(name);
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', route);

/* ================= Setup / settings UI ================= */
function syncSetupUI() {
  const saved = loadKey();
  const provider = (saved && saved.provider) || 'openai';
  document.querySelectorAll('.provider').forEach(el => {
    const sel = el.dataset.provider === provider;
    el.classList.toggle('selected', sel);
    el.querySelector('input').checked = sel;
  });
  document.getElementById('anthropic-note').hidden = provider !== 'anthropic';
  document.getElementById('api-key').value = (saved && saved.key) || '';
  document.getElementById('model').value = (saved && saved.model) || PROVIDERS[provider].defaultModel;
  document.getElementById('model-hint').textContent =
    PROVIDERS[provider].name + ' default: ' + PROVIDERS[provider].defaultModel + ' (' + PROVIDERS[provider].costHint + '). You can type any model name.';
}

function syncLoanUI() {
  document.getElementById('no-key-notice').hidden = !!loadKey();
  const d = getDefaults();
  if (!document.getElementById('l-threshold').value) document.getElementById('l-threshold').value = d.thresholdMo;
  updateLtvReadout();
}

function updateLtvReadout() {
  const b = +document.getElementById('l-balance').value || 0;
  const h = +document.getElementById('l-home').value || 0;
  const el = document.getElementById('ltv-readout');
  el.textContent = (b > 0 && h > 0) ? fmtPct1(b / h) + (b / h > 0.8 ? ' — above 80%, PMI may apply on refi' : '') : '—';
}

function syncSettings() {
  const saved = loadKey();
  document.getElementById('settings-key-status').innerHTML = saved
    ? 'Key saved for <strong style="color:var(--fg)">' + esc(PROVIDERS[saved.provider].name) + '</strong> (stored in this browser only).'
    : 'No key saved yet.';
  document.getElementById('settings-model-info').textContent = saved
    ? 'Model: ' + (saved.model || PROVIDERS[saved.provider].defaultModel) : '';
  const loan = currentLoan();
  document.getElementById('set-threshold').value = (loan && loan.thresholdMo) || getDefaults().thresholdMo;
  document.getElementById('spend-counter').textContent = '$' + getSpend().toFixed(2);
}

/* ================= Dashboard ================= */
function beClass(a) {
  if (!isFinite(a.breakEven)) return 'bad';
  if (a.breakEven <= 12) return 'good';
  if (a.breakEven <= 24) return 'warnv';
  return 'bad';
}

function renderDash() {
  const loan = currentLoan();
  const box = document.getElementById('dash-results');
  if (!loan) {
    document.getElementById('dash-title').textContent = 'Break-even dashboard';
    box.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No loan profile yet. <a href="#/loan" data-nav="loan" style="color:var(--secondary)">Add your current loan</a> — two minutes.</p></div>';
    return;
  }
  currentLoanId = loan.id;
  document.getElementById('dash-title').textContent = esc(loan.name || 'Break-even dashboard');
  const sc = loan.scenario || { rate: 5.5, term: 30 };
  document.getElementById('cand-rate').value = sc.rate;
  document.getElementById('cand-term').value = String(sc.term);
  document.getElementById('cand-rate-val').textContent = (+sc.rate).toFixed(3) + '%';
  renderDashResults();
}

function renderDashResults() {
  const loan = currentLoan();
  if (!loan) return;
  const rate = parseFloat(document.getElementById('cand-rate').value);
  const term = parseInt(document.getElementById('cand-term').value, 10) === 15 ? 15 : 30;
  document.getElementById('cand-rate-val').textContent = rate.toFixed(3) + '%';
  loan.scenario = { rate, term };
  upsertLoan(loan);

  const a = analyze(loan, rate, term);
  const flags = codeFlags(loan, a);
  const beTxt = isFinite(a.breakEven) ? a.breakEven : '—';
  const beCap = isFinite(a.breakEven) ? 'months to break even' : 'never at this rate';

  document.getElementById('dash-results').innerHTML = `
    <div class="card">
      <div class="be-hero">
        <div class="months ${beClass(a)}">${beTxt}</div>
        <div class="cap">${beCap} &middot; at ${rate.toFixed(3)}% / ${term}-yr &middot; vs your ${loan.ratePct}%</div>
      </div>
      <p style="color:var(--muted-fg);font-size:.92rem">Decision tool, not a crystal ball — this is what the math says at the rate <em>you</em> entered. Nothing here predicts where rates go.</p>
    </div>

    <div class="grid-metrics">
      <div class="metric"><div class="v ${a.savings > 0 ? 'good' : 'bad'}">${fmt$(a.savings)}<span style="font-size:.8rem;color:var(--muted-fg)">/mo</span></div><div class="l">Monthly savings</div></div>
      <div class="metric"><div class="v ${a.fiveYr >= 0 ? 'good' : 'bad'}">${fmt$(a.fiveYr)}</div><div class="l">5-year net savings</div></div>
      <div class="metric"><div class="v ${a.lifetime >= 0 ? 'good' : 'bad'}">${fmt$(a.lifetime)}</div><div class="l">Lifetime interest saved</div></div>
      <div class="metric"><div class="v ${a.ltv <= 0.8 ? 'good' : 'warnv'}">${fmtPct1(a.ltv)}</div><div class="l">Loan-to-value</div></div>
    </div>

    <div class="card">
      <h3>Monthly payment</h3>
      <p>Now: <strong>${fmt$(a.curPmt)}/mo</strong> &nbsp;&rarr;&nbsp; at ${rate.toFixed(3)}%: <strong>${fmt$(a.newPmt)}/mo</strong></p>
      ${isFinite(a.keepMonths) && a.savings > 0 ? `<p class="tip" style="margin-top:8px">Power move: keep paying ${fmt$(a.curPmt)}/mo on the new loan and you'd pay it off in <strong style="color:var(--fg)">${a.keepMonths} months</strong>, saving <strong style="color:var(--fg)">${fmt$(a.keepSave)}</strong> total vs. today.</p>` : ''}
    </div>

    <div class="card">
      <h3>Closing costs <span class="hint">(estimates — your Loan Estimate is the source of truth)</span></h3>
      <table class="breakdown">
        <tr><th>Line item</th><th>Amount</th></tr>
        <tr><td>Origination (${esc(String(loan.origPct))}%)</td><td>${fmt$(a.cc.origination)}</td></tr>
        <tr><td>Appraisal</td><td>${fmt$(a.cc.appraisal)}</td></tr>
        <tr><td>Title insurance / search</td><td>${fmt$(a.cc.title)}</td></tr>
        <tr><td>Recording fees</td><td>${fmt$(a.cc.recording)}</td></tr>
        <tr><td>Prepaid / escrow (~2 mo)</td><td>${fmt$(a.cc.prepaids)}</td></tr>
        <tr class="total"><td>Estimated total</td><td>${fmt$(a.cc.total)}</td></tr>
      </table>
    </div>

    ${flags.length ? `<h2>Flags <span style="color:var(--muted-fg);font-weight:400;font-size:.85rem">(${flags.length} from code)</span></h2>
    <div class="card">${flags.map(f => `<div class="flag"><span class="sev ${f.sev}">${f.sev}</span><span>${esc(f.text)}</span></div>`).join('')}</div>` : ''}`;
}

/* ================= Watchlist ================= */
function latestQuote(loan) {
  if (!loan || !loan.quotes || !loan.quotes.length) return null;
  return loan.quotes.slice().sort((x, y) => x.date < y.date ? 1 : -1)[0];
}

function checkAlert(loan) {
  const q = latestQuote(loan);
  if (!q || !(q.r30 > 0)) return null;
  const a = analyze(loan, q.r30, 30);
  if (isFinite(a.breakEven) && a.breakEven <= (loan.thresholdMo || 24)) {
    return { quote: q, breakEven: a.breakEven, savings: a.savings };
  }
  return null;
}

function renderSparkline(quotes) {
  const qs = quotes.slice().sort((x, y) => x.date < y.date ? -1 : 1);
  if (qs.length < 2) return '<p style="color:var(--muted-fg)">Log at least 2 quotes to see the trend.</p>';
  const W = 600, H = 120, P = 28;
  const vals = qs.map(q => q.r30);
  const lo = Math.min(...vals) - 0.125, hi = Math.max(...vals) + 0.125;
  const X = i => P + (W - 2 * P) * (qs.length === 1 ? 0.5 : i / (qs.length - 1));
  const Y = v => H - P - (H - 2 * P) * ((v - lo) / (hi - lo || 1));
  const pts = qs.map((q, i) => X(i).toFixed(1) + ',' + Y(q.r30).toFixed(1)).join(' ');
  const dots = qs.map((q, i) => `<circle class="dot" cx="${X(i).toFixed(1)}" cy="${Y(q.r30).toFixed(1)}" r="4"><title>${esc(q.date)}: ${q.r30}%${q.lender ? ' — ' + esc(q.lender) : ''}</title></circle>`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="30-year quoted rate trend">
    <polyline class="line" points="${pts}"/>${dots}
    <text class="lbl" x="${P}" y="14">high ${hi.toFixed(3)}%</text>
    <text class="lbl" x="${P}" y="${H - 8}">low ${lo.toFixed(3)}%</text>
    <text class="lbl" x="${W - P}" y="14" text-anchor="end">latest ${qs[qs.length - 1].r30.toFixed(3)}%</text>
  </svg>`;
}

function renderWatch() {
  const loan = currentLoan();
  const banner = document.getElementById('alert-banner');
  const status = document.getElementById('watch-status');
  const table = document.getElementById('quote-table');
  const trend = document.getElementById('trend-wrap');
  if (!loan) {
    banner.innerHTML = '';
    status.textContent = '';
    trend.innerHTML = '<p style="color:var(--muted-fg)">Add a loan profile first.</p>';
    table.innerHTML = '<p style="color:var(--muted-fg)"><a href="#/loan" data-nav="loan" style="color:var(--secondary)">Add your current loan</a> to start a watchlist.</p>';
    return;
  }
  currentLoanId = loan.id;
  document.getElementById('watch-threshold').value = loan.thresholdMo || 24;
  const quotes = (loan.quotes || []).slice().sort((x, y) => x.date < y.date ? 1 : -1);

  const alert = checkAlert(loan);
  banner.innerHTML = alert
    ? `<div class="notice good" role="alert"><strong>Threshold crossed.</strong> Your break-even at the logged ${alert.quote.r30}%${alert.quote.lender ? ' (' + esc(alert.quote.lender) + ')' : ''} is <strong>${alert.breakEven} months</strong> — under your ${loan.thresholdMo}-month threshold. Monthly savings would be ${fmt$(alert.savings)}/mo. This is math, not a forecast.</div>`
    : '';

  const n = quotes.length;
  status.textContent = n
    ? `${n} quote${n === 1 ? '' : 's'} tracked, watching for < ${loan.thresholdMo} mo break-even.` + (alert ? '' : ' No alert — nothing has crossed your threshold yet.')
    : 'No quotes logged yet. Log the first rate you see.';

  trend.innerHTML = renderSparkline(loan.quotes || []);

  table.innerHTML = quotes.length ? `<table class="quote-table">
    <tr><th>Date</th><th>Lender</th><th>30-yr</th><th>15-yr</th><th>Break-even</th><th></th></tr>
    ${quotes.map((q, i) => {
      const be = analyze(loan, q.r30, 30).breakEven;
      return `<tr><td>${esc(fmtDate(q.date))}</td><td>${esc(q.lender || '—')}</td><td>${(+q.r30).toFixed(3)}%</td>
        <td>${q.r15 ? (+q.r15).toFixed(3) + '%' : '—'}</td>
        <td class="${isFinite(be) && be <= loan.thresholdMo ? 'pos' : ''}">${isFinite(be) ? be + ' mo' : '—'}</td>
        <td><button data-qdel="${i}" aria-label="Delete quote">Delete</button></td></tr>`;
    }).join('')}</table>`
    : '<p style="color:var(--muted-fg)">No quotes yet.</p>';
}

/* ================= Verdict ================= */
function renderVerdict() {
  const loan = currentLoan();
  const nums = document.getElementById('verdict-nums');
  const llmBox = document.getElementById('verdict-llm');
  if (!loan) {
    nums.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">Add a loan profile first: <a href="#/loan" data-nav="loan" style="color:var(--secondary)">loan setup</a>.</p></div>';
    llmBox.innerHTML = '';
    return;
  }
  currentLoanId = loan.id;
  const sc = loan.scenario || { rate: 5.5, term: 30 };
  const a = analyze(loan, sc.rate, sc.term);
  nums.innerHTML = `<div class="card"><table class="breakdown">
    <tr><th>Figure</th><th>Value</th></tr>
    <tr><td>Current payment</td><td>${fmt$(a.curPmt)}/mo at ${loan.ratePct}%</td></tr>
    <tr><td>Candidate</td><td>${fmt$(a.newPmt)}/mo at ${sc.rate.toFixed(3)}% / ${sc.term}-yr</td></tr>
    <tr><td>Monthly savings</td><td class="${a.savings > 0 ? 'pos' : 'neg'}">${fmt$(a.savings)}/mo</td></tr>
    <tr><td>Closing costs (est.)</td><td>${fmt$(a.cc.total)}</td></tr>
    <tr class="total"><td>Break-even</td><td>${isFinite(a.breakEven) ? a.breakEven + ' months' : 'never at this rate'}</td></tr>
    <tr><td>5-year net savings</td><td>${fmt$(a.fiveYr)}</td></tr>
    <tr><td>Lifetime interest saved</td><td>${fmt$(a.lifetime)}</td></tr>
    <tr><td>LTV</td><td>${fmtPct1(a.ltv)}</td></tr>
  </table></div>`;

  if (loan.lastVerdict && loan.lastVerdict.scenarioKey === sc.rate + '/' + sc.term) {
    llmBox.innerHTML = `<div class="llm-body">${esc(loan.lastVerdict.text)}</div>
      <p class="tip" style="margin-top:8px">Verdict from ${new Date(loan.lastVerdict.at).toLocaleString()} for this scenario.</p>`;
  } else {
    runVerdict();
  }
}

async function runVerdict() {
  const loan = currentLoan();
  const llmBox = document.getElementById('verdict-llm');
  if (!loan) return;
  const saved = loadKey();
  if (!saved || !saved.key) {
    llmBox.innerHTML = `<div class="notice warn">No API key saved — the math above is complete, but the AI verdict needs one. <a href="#/verdict" data-nav="setup">Set it up</a> (30 seconds).</div>`;
    return;
  }
  const sc = loan.scenario || { rate: 5.5, term: 30 };
  const a = analyze(loan, sc.rate, sc.term);
  const flags = codeFlags(loan, a);
  llmBox.innerHTML = `<div aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div><p style="color:var(--muted-fg);font-size:.9rem">Running the AI verdict on your key…</p></div>`;

  const { system, user } = buildVerdictPrompt(loan, a, flags);
  const model = saved.model || PROVIDERS[saved.provider].defaultModel;
  try {
    let text = (await callLLM(saved.provider, saved.key, model, system, user, 600)).trim();
    let flagged = hasPrediction(text);
    if (flagged.length) {
      // One guarded retry with a stronger instruction.
      const retry = await callLLM(saved.provider, saved.key, model,
        system + ' CRITICAL: your previous response contained forbidden rate predictions (' + flagged.join(', ') + '). Rewrite the verdict with ZERO statements about future rate direction.',
        user, 600);
      text = retry.trim();
      flagged = hasPrediction(text);
    }
    addSpend(0.02);
    loan.lastVerdict = { text, at: new Date().toISOString(), scenarioKey: sc.rate + '/' + sc.term };
    upsertLoan(loan);
    llmBox.innerHTML = (flagged.length
      ? `<div class="notice warn">Flagged for review: this response may contain rate speculation (${esc(flagged.join(', '))}) — treat that part as unverified. The numbers above are computed in code and unaffected.</div>`
      : '') + `<div class="llm-body">${esc(text)}</div>`;
  } catch (e) {
    llmBox.innerHTML = `<div class="notice warn">AI verdict failed: ${esc(e.message)}. The math above is unaffected — your numbers are complete without it.</div>`;
  }
}

/* ================= History ================= */
function renderHistory() {
  const loans = loadLoans();
  const list = document.getElementById('profile-list');
  if (!loans.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No loan profiles yet. <a href="#/loan" data-nav="loan" style="color:var(--secondary)">Add your current loan</a>.</p></div>';
    return;
  }
  list.innerHTML = loans.map(l => {
    const sc = l.scenario || { rate: 5.5, term: 30 };
    const be = analyze(l, sc.rate, sc.term).breakEven;
    const nq = (l.quotes || []).length;
    return `<div class="loan-row" data-open="${l.id}" role="button" tabindex="0" aria-label="Open ${esc(l.name || 'loan')}">
      <div class="be-badge ${isFinite(be) ? (be <= 12 ? 'good' : be <= 24 ? 'warnv' : '') : ''}">${isFinite(be) ? be + 'mo' : '—'}</div>
      <div class="info"><strong>${esc(l.name || 'Unnamed loan')}</strong>
        <small>${fmt$(l.balance)} at ${l.ratePct}% &middot; ${l.monthsLeft} mo left &middot; ${nq} quote${nq === 1 ? '' : 's'}</small></div>
      <div class="row-actions no-print"><button data-del="${l.id}" aria-label="Delete">Delete</button></div>
    </div>`;
  }).join('');
}

/* ================= Landing demo ================= */
const DEMO = { balance: 350000, ratePct: 7, monthsLeft: 330, homeValue: 450000, taxA: 4800, insA: 1800, origPct: 0.5, thresholdMo: 24, credit: 'excellent' };
function renderDemo() {
  const rate = parseFloat(document.getElementById('demo-rate').value);
  document.getElementById('demo-rate-val').textContent = rate.toFixed(3) + '%';
  const a = analyze(DEMO, rate, 30);
  document.getElementById('demo-be').textContent = isFinite(a.breakEven) ? a.breakEven : '—';
  document.getElementById('demo-save').textContent = a.savings > 0 ? fmt$(a.savings) : '—';
}

/* ================= Form & init ================= */
function readLoanForm() {
  const v = id => document.getElementById(id).value.trim();
  return {
    id: 'loan-' + Date.now().toString(36),
    name: v('l-name'),
    balance: +v('l-balance'), ratePct: +v('l-rate'), monthsLeft: +v('l-months'),
    homeValue: +v('l-home'), taxA: +v('l-tax'), insA: +v('l-ins'),
    credit: document.getElementById('l-credit').value,
    origPct: +v('l-orig'), thresholdMo: +v('l-threshold') || 24,
    scenario: { rate: 5.5, term: 30 }, quotes: [], createdAt: new Date().toISOString(),
  };
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function init() {
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); go(el.dataset.nav); });
  });

  /* --- setup --- */
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

  /* --- landing demo --- */
  document.getElementById('demo-rate').addEventListener('input', renderDemo);
  renderDemo();

  /* --- loan form --- */
  ['l-balance', 'l-home'].forEach(id => document.getElementById(id).addEventListener('input', updateLtvReadout));
  document.getElementById('loan-form').addEventListener('submit', e => {
    e.preventDefault();
    const errEl = document.getElementById('loan-error');
    errEl.textContent = '';
    const loan = readLoanForm();
    if (!(loan.balance > 0)) { errEl.textContent = 'Enter your remaining balance.'; return; }
    if (!(loan.ratePct >= 0)) { errEl.textContent = 'Enter your current rate.'; return; }
    if (!(loan.monthsLeft >= 1 && loan.monthsLeft <= 360)) { errEl.textContent = 'Months remaining must be 1–360.'; return; }
    if (!(loan.homeValue > 0)) { errEl.textContent = 'Enter your home value (for LTV).'; return; }
    const d = getDefaults();
    d.thresholdMo = loan.thresholdMo; lsSet(LS_DEFAULTS, d);
    upsertLoan(loan);
    go('dash', loan.id);
  });

  /* --- dashboard controls --- */
  document.getElementById('cand-rate').addEventListener('input', renderDashResults);
  document.getElementById('cand-term').addEventListener('change', renderDashResults);

  /* --- watchlist --- */
  document.getElementById('q-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('quote-form').addEventListener('submit', e => {
    e.preventDefault();
    const errEl = document.getElementById('quote-error');
    errEl.textContent = '';
    const loan = currentLoan();
    if (!loan) { errEl.textContent = 'Add a loan profile first.'; return; }
    const date = document.getElementById('q-date').value;
    const r30 = parseFloat(document.getElementById('q-rate30').value);
    const r15v = document.getElementById('q-rate15').value.trim();
    const r15 = r15v === '' ? null : parseFloat(r15v);
    const lender = document.getElementById('q-lender').value.trim();
    if (!date) { errEl.textContent = 'Pick a date.'; return; }
    if (!(r30 > 0)) { errEl.textContent = 'Enter the quoted 30-yr rate.'; return; }
    loan.quotes = loan.quotes || [];
    loan.quotes.push({ date, r30, r15, lender });
    upsertLoan(loan);
    document.getElementById('q-rate30').value = '';
    document.getElementById('q-rate15').value = '';
    document.getElementById('q-lender').value = '';
    renderWatch();
  });
  document.getElementById('quote-table').addEventListener('click', e => {
    const btn = e.target.closest('[data-qdel]');
    if (!btn) return;
    const loan = currentLoan();
    if (!loan) return;
    const quotes = (loan.quotes || []).slice().sort((x, y) => x.date < y.date ? 1 : -1);
    const target = quotes[+btn.dataset.qdel];
    loan.quotes = (loan.quotes || []).filter(q => q !== target);
    upsertLoan(loan);
    renderWatch();
  });
  document.getElementById('save-threshold-btn').addEventListener('click', () => {
    const v = Math.max(1, Math.min(120, +document.getElementById('watch-threshold').value || 24));
    const loan = currentLoan();
    if (loan) { loan.thresholdMo = v; upsertLoan(loan); }
    const d = getDefaults(); d.thresholdMo = v; lsSet(LS_DEFAULTS, d);
    document.getElementById('threshold-saved').textContent = 'Threshold saved: alert under ' + v + ' months.';
    renderWatch();
  });

  /* --- verdict --- */
  document.getElementById('rerun-verdict-btn').addEventListener('click', () => {
    const loan = currentLoan();
    if (loan) { delete loan.lastVerdict; upsertLoan(loan); }
    runVerdict();
  });

  /* --- history --- */
  const list = document.getElementById('profile-list');
  list.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      deleteLoan(del.dataset.del);
      if (currentLoanId === del.dataset.del) currentLoanId = null;
      renderHistory(); return;
    }
    const row = e.target.closest('[data-open]');
    if (row) go('dash', row.dataset.open);
  });
  list.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const row = e.target.closest('[data-open]'); if (row) go('dash', row.dataset.open); }
  });

  /* --- settings --- */
  document.getElementById('save-settings-btn').addEventListener('click', () => {
    const v = Math.max(1, Math.min(120, +document.getElementById('set-threshold').value || 24));
    const loan = currentLoan();
    if (loan) { loan.thresholdMo = v; upsertLoan(loan); }
    const d = getDefaults(); d.thresholdMo = v; lsSet(LS_DEFAULTS, d);
    document.getElementById('settings-saved').textContent = 'Saved.';
  });
  document.getElementById('reset-spend-btn').addEventListener('click', () => {
    lsSet(LS_SPEND, 0);
    document.getElementById('spend-counter').textContent = '$0.00';
  });
  document.getElementById('export-btn').addEventListener('click', () => {
    download('refiwatch-export-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify({ app: 'refiwatch', exportedAt: new Date().toISOString(), loans: loadLoans() }, null, 2));
  });
  document.getElementById('import-file').addEventListener('change', e => {
    const errEl = document.getElementById('settings-error');
    errEl.textContent = '';
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(rd.result);
        const loans = Array.isArray(j) ? j : j.loans;
        if (!Array.isArray(loans) || !loans.every(l => l && l.id && l.balance > 0)) throw new Error('bad format');
        if (!window.confirm('Replace all ' + loadLoans().length + ' profiles with ' + loans.length + ' imported?')) return;
        saveLoans(loans);
        currentLoanId = null;
        errEl.textContent = '';
        alert('Imported ' + loans.length + ' profiles.');
        renderHistory();
      } catch (err) { errEl.textContent = 'Import failed: not a RefiWatch export.'; }
      e.target.value = '';
    };
    rd.readAsText(f);
  });

  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
