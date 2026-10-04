/* DealLens MVP — static app. Deterministic math in code; the LLM narrates only. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'deallens_key';     // {provider, key, model}
const LS_DEALS = 'deallens_deals'; // array of deal objects

function loadKey() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveKey(obj) { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadDeals() {
  try { return JSON.parse(localStorage.getItem(LS_DEALS) || '[]'); } catch { return []; }
}
function saveDeals(deals) { localStorage.setItem(LS_DEALS, JSON.stringify(deals)); }
function getDeal(id) { return loadDeals().find(d => d.id === id); }
function upsertDeal(deal) {
  const deals = loadDeals();
  const i = deals.findIndex(d => d.id === deal.id);
  if (i >= 0) deals[i] = deal; else deals.unshift(deal);
  saveDeals(deals);
}
function deleteDeal(id) { saveDeals(loadDeals().filter(d => d.id !== id)); }

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'new', 'results', 'history', 'compare', 'pricing'];
let currentDealId = null;

function showView(name) {
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === name);
  });
  if (name === 'history') renderHistory();
  if (name === 'setup') syncSetupUI();
  if (name === 'new') syncNoKeyNotice();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) {
  if (name === 'results' && arg) currentDealId = arg;
  location.hash = '#/' + name + (arg ? '/' + arg : '');
}
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if (name === 'results' && parts[1]) { currentDealId = parts[1]; renderResults(currentDealId); }
  showView(name);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', route);
}

/* ================= Deterministic calculator ================= */
/* Every dollar figure comes from here. The LLM is never asked to do math. */
function calc(d) {
  const num = v => (isFinite(+v) ? +v : 0);
  const price = num(d.price), rent = num(d.rent);
  const downPct = num(d.downPct), ratePct = num(d.ratePct), termYears = num(d.termYears) || 30;
  const closingPct = num(d.closingPct);
  const taxA = num(d.taxA), insA = num(d.insA), hoaM = num(d.hoaM);
  const vacPct = num(d.vacPct), maintPct = num(d.maintPct), capexPct = num(d.capexPct), mgmtPct = num(d.mgmtPct);

  const down = price * downPct / 100;
  const closing = price * closingPct / 100;
  const loan = Math.max(0, price - down);
  const r = ratePct / 100 / 12, n = termYears * 12;
  const pi = loan > 0 ? (r > 0
    ? loan * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1)
    : loan / n) : 0;

  const taxM = taxA / 12, insM = insA / 12;
  const vacM = rent * vacPct / 100;
  const maintM = rent * maintPct / 100;
  const capexM = rent * capexPct / 100;
  const mgmtM = rent * mgmtPct / 100;
  const opexM = taxM + insM + hoaM + vacM + maintM + capexM + mgmtM; // excl. debt service
  const totalM = opexM + pi;
  const cfM = rent - totalM;
  const cfA = cfM * 12;
  const noiA = rent * 12 - opexM * 12;
  const capRate = price > 0 ? noiA / price : 0;
  const cashIn = down + closing;
  const coc = cashIn > 0 ? cfA / cashIn : 0;
  const annualDebt = pi * 12;
  const dscr = annualDebt > 0 ? noiA / annualDebt : (noiA > 0 ? 99 : 0);
  const rentToPrice = price > 0 ? rent / price : 0;
  const expenseRatio = rent > 0 ? opexM / rent : 0; // 50% rule check
  const breakEvenOcc = totalM > 0 ? Math.min(1, Math.max(0, 1 - cfM / rent)) : 1;

  return { down, closing, loan, pi, taxM, insM, hoaM, vacM, maintM, capexM, mgmtM,
           opexM, totalM, cfM, cfA, noiA, capRate, cashIn, coc, annualDebt, dscr,
           rentToPrice, expenseRatio, breakEvenOcc, price, rent };
}

/* Deterministic risk flags (code, not LLM). Each costs up to 5 score points. */
function codeFlags(d, m) {
  const flags = [];
  if (m.cfM < 0) flags.push({ sev: 'dealbreaker', text: 'Negative monthly cash flow (' + fmt$(-m.cfM) + '/mo). The property loses money from day one at these assumptions.' });
  if (m.dscr < 1 && m.annualDebt > 0) flags.push({ sev: 'dealbreaker', text: 'DSCR below 1.0 — net operating income does not cover the mortgage. Most lenders require 1.20–1.25.' });
  else if (m.dscr < 1.25 && m.annualDebt > 0) flags.push({ sev: 'watch', text: 'DSCR of ' + m.dscr.toFixed(2) + ' is under the 1.25 lenders typically want — financing may be harder or pricier.' });
  if (m.hoaM > m.rent * 0.25 && m.rent > 0) flags.push({ sev: 'watch', text: 'HOA is over 25% of rent. Check for rental caps and special assessments in the HOA docs.' });
  if (d.price > 0 && d.taxA / d.price > 0.025) flags.push({ sev: 'watch', text: 'Property tax above 2.5% of price — verify against county records; reassessment risk on sale.' });
  if (m.expenseRatio > 0.6 && m.rent > 0) flags.push({ sev: 'watch', text: 'Operating expenses are ' + Math.round(m.expenseRatio * 100) + '% of rent — well above the 50% rule of thumb.' });
  if (m.rentToPrice < 0.0075 && m.price > 0) flags.push({ sev: 'info', text: 'Rent is under 0.75% of price — fails the 1% rule; needs appreciation or value-add to make sense.' });
  return flags;
}

/* Deal score 0–100. Transparent weights, shown in UI. */
function dealScore(m, flags) {
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const cocS = clamp01(m.coc / 0.12) * 100;          // 12% cash-on-cash = 100
  const capS = clamp01(m.capRate / 0.08) * 100;      // 8% cap rate = 100
  const dscrS = clamp01((m.dscr - 1) / 0.25) * 100; // 1.25 DSCR = 100
  const rtpS = clamp01(m.rentToPrice / 0.01) * 100;  // 1% rule = 100
  const base = (0.30 * cocS + 0.20 * capS + 0.20 * dscrS + 0.15 * rtpS) / 0.85;
  const penalty = Math.min(15, flags.length * 5);
  return { score: Math.round(Math.max(0, base - penalty)), parts: { cocS, capS, dscrS, rtpS }, penalty };
}

/* ================= Formatting ================= */
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const fmtPct = v => (v * 100).toFixed(2) + '%';
const fmtPct1 = v => (v * 100).toFixed(1) + '%';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Node test hook: `node -e "require('./app.js')"` runs self-tests. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calc, codeFlags, dealScore };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');
  const approx = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, msg + ': got ' + a + ', want ~' + b);

  // Test 1: $200k / $1,800 rent / 20% down / 7% 30yr — hand-computed in spec review
  const t1 = calc({ price: 200000, rent: 1800, taxA: 2400, insA: 1200, hoaM: 0, downPct: 20, ratePct: 7, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 8 });
  approx(t1.pi, 1064.48, 0.05, 't1 P&I');
  approx(t1.cfM, 21.52, 0.10, 't1 cash flow');
  approx(t1.capRate, 0.06516, 0.0005, 't1 cap rate');
  approx(t1.coc, 0.00587, 0.0005, 't1 cash-on-cash');
  approx(t1.dscr, 1.020, 0.005, 't1 DSCR');
  const s1 = dealScore(t1, codeFlags({ price: 200000, taxA: 2400 }, t1));
  assert(s1.score >= 30 && s1.score <= 40, 't1 score in 30-40, got ' + s1.score);

  // Test 2: $150k / $1,600 rent / 25% down / 6.5% — strong deal
  const t2 = calc({ price: 150000, rent: 1600, taxA: 1800, insA: 900, hoaM: 0, downPct: 25, ratePct: 6.5, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 8 });
  approx(t2.pi, 711.1, 0.5, 't2 P&I');
  approx(t2.cfM, 295.9, 1.0, 't2 cash flow');
  approx(t2.capRate, 0.0806, 0.002, 't2 cap rate');
  const s2 = dealScore(t2, codeFlags({ price: 150000, taxA: 1800 }, t2));
  assert(s2.score >= 85, 't2 score >= 85, got ' + s2.score);

  // Test 3: all-cash purchase (no debt) — DSCR sentinel, no crash
  const t3 = calc({ price: 100000, rent: 1100, taxA: 1200, insA: 800, hoaM: 0, downPct: 100, ratePct: 0, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 0 });
  assert(t3.pi === 0, 't3 no mortgage payment');
  assert(t3.dscr === 99, 't3 DSCR sentinel for no debt');
  assert(t3.coc > 0.05, 't3 positive cash-on-cash');

  console.log('All calculator self-tests passed.');
}

/* ================= LLM (BYOK) ================= */
/* Single narrative call. The prompt embeds pre-computed numbers; the model is
   told explicitly to use them and never recompute. */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini', costHint: '~$0.01/analysis' },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-3-mini',  costHint: '~$0.01/analysis' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', costHint: '~$0.02/analysis', corsNote: true },
  gemini: { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', keyHeader: k => ({}), defaultModel: 'gemini-3.5-flash-lite', costHint: '~$0.01/analysis', gemini: true },
};

function buildAnalysisPrompt(deal, m, flags) {
  return {
    system: 'You are a conservative rental-property underwriter. Be direct and skeptical. ' +
      'Use ONLY the numbers provided below — do not recompute ratios, do not invent comps or market data. ' +
      'Label anything you estimate as ESTIMATE. Keep the whole response under 220 words.',
    user:
`Deal: ${deal.name || 'Untitled'} (${deal.beds || 'n/a'})
VERIFIED NUMBERS (computed in code — trust these):
- Price $${m.price.toLocaleString()}, rent $${m.rent}/mo, down ${deal.downPct}%, rate ${deal.ratePct}%/${deal.termYears}yr
- Monthly P&I ${fmt$(m.pi)}, operating expenses ${fmt$(m.opexM)}/mo, cash flow ${fmt$(m.cfM)}/mo
- Cap rate ${fmtPct(m.capRate)}, cash-on-cash ${fmtPct(m.coc)}, DSCR ${m.dscr === 99 ? 'n/a (cash)' : m.dscr.toFixed(2)}, rent-to-price ${fmtPct1(m.rentToPrice)}/mo
- Cash invested ${fmt$(m.cashIn)}
CODE FLAGS: ${flags.length ? flags.map(f => '[' + f.sev + '] ' + f.text).join(' | ') : 'none'}
Notes from user: ${deal.notes || 'none'}

Write:
1. VERDICT: 2-3 sentences on whether this deal works and why.
2. RISKS: 3-5 specific risk flags with severity (info/watch/dealbreaker) — go beyond the code flags above.
3. OFFER: a suggested offer price and a walk-away price, each tied to hitting at least 8% cash-on-cash. Show the target price numbers.`
  };
}


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
      body: JSON.stringify({ model, max_tokens: maxTokens || 700, system, messages: [{ role: 'user', content: user }] }),
    });
  } else {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 700, temperature: 0.4 }),
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
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per analysis: ' + PROVIDERS[provider].costHint + '.';
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
}

function syncNoKeyNotice() {
  document.getElementById('no-key-notice').hidden = !!loadKey();
}

function scoreClass(s) { return s >= 70 ? 'good' : s >= 45 ? 'mid' : 'bad'; }
function valClass(v, good, bad) { return v >= good ? 'good' : v <= bad ? 'bad' : 'warnv'; }

function renderResults(id) {
  const deal = getDeal(id);
  const box = document.getElementById('results-content');
  if (!deal) { box.innerHTML = '<div class="card"><p>Deal not found.</p></div>'; return; }
  const m = deal.metrics, s = deal.score, flags = deal.flags || [];
  const dialC = 2 * Math.PI * 54;
  const dialOff = dialC * (1 - s.score / 100);

  box.innerHTML = `
    <h1 class="no-print">${esc(deal.name || 'Untitled deal')}</h1>
    <div class="card">
      <div class="score-wrap">
        <div class="score-dial" role="img" aria-label="Deal score ${s.score} out of 100">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="54" fill="none" stroke="#1A1E2F" stroke-width="12"/>
            <circle cx="70" cy="70" r="54" fill="none" stroke="${s.score >= 70 ? '#22C55E' : s.score >= 45 ? '#F59E0B' : '#EF4444'}"
              stroke-width="12" stroke-linecap="round" stroke-dasharray="${dialC.toFixed(1)}" stroke-dashoffset="${dialOff.toFixed(1)}"/>
          </svg>
          <div class="num"><b>${s.score}</b><span>deal score</span></div>
        </div>
        <div style="flex:1;min-width:220px">
          <p style="color:var(--muted-fg);font-size:.92rem">Score blends cash-on-cash (30%), cap rate (20%), DSCR (20%) and rent-to-price (15%), minus up to 15 points for risk flags. Weights shown so you can sanity-check the machine.</p>
          <div class="formula">0.30&times;CoC + 0.20&times;Cap + 0.20&times;DSCR + 0.15&times;Rent/Price &minus; flags (max 15)</div>
        </div>
      </div>
    </div>

    <h2>Key metrics</h2>
    <div class="grid-metrics">
      <div class="metric"><div class="v ${m.cfM >= 0 ? 'good' : 'bad'}">${fmt$(m.cfM)}<span style="font-size:.8rem;color:var(--muted-fg)">/mo</span></div><div class="l">Cash flow</div></div>
      <div class="metric"><div class="v ${valClass(m.capRate, 0.07, 0.04)}">${fmtPct1(m.capRate)}</div><div class="l">Cap rate</div></div>
      <div class="metric"><div class="v ${valClass(m.coc, 0.08, 0.02)}">${fmtPct1(m.coc)}</div><div class="l">Cash-on-cash</div></div>
      <div class="metric"><div class="v ${m.dscr === 99 ? '' : valClass(m.dscr, 1.25, 1.0)}">${m.dscr === 99 ? 'Cash' : m.dscr.toFixed(2)}</div><div class="l">DSCR</div></div>
    </div>

    <h2>Monthly breakdown</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Line item</th><th>Amount</th></tr>
      <tr><td>Rental income</td><td class="pos">+${fmt$(m.rent)}</td></tr>
      <tr><td>Vacancy (${esc(String(deal.vacPct))}%)</td><td class="neg">−${fmt$(m.vacM)}</td></tr>
      <tr><td>Mortgage P&amp;I</td><td class="neg">−${fmt$(m.pi)}</td></tr>
      <tr><td>Property tax</td><td class="neg">−${fmt$(m.taxM)}</td></tr>
      <tr><td>Insurance</td><td class="neg">−${fmt$(m.insM)}</td></tr>
      <tr><td>HOA</td><td class="neg">−${fmt$(m.hoaM)}</td></tr>
      <tr><td>Maintenance</td><td class="neg">−${fmt$(m.maintM)}</td></tr>
      <tr><td>CapEx reserve</td><td class="neg">−${fmt$(m.capexM)}</td></tr>
      <tr><td>Management</td><td class="neg">−${fmt$(m.mgmtM)}</td></tr>
      <tr class="total"><td>Cash flow</td><td class="${m.cfM >= 0 ? 'pos' : 'neg'}">${fmt$(m.cfM)}</td></tr>
    </table></div>

    <h2>Risk flags <span style="color:var(--muted-fg);font-weight:400;font-size:.85rem">(${flags.length} from code)</span></h2>
    <div class="card">${flags.length ? flags.map(f =>
      `<div class="flag"><span class="sev ${f.sev}">${f.sev}</span><span>${esc(f.text)}</span></div>`).join('')
      : '<p style="color:var(--muted-fg)">No code flags. The AI pass below may add more.</p>'}</div>

    <h2>Underwriter's take</h2>
    <div class="card" id="llm-card">
      ${deal.llm ? `<div class="llm-body">${esc(deal.llm)}</div>`
        : `<div aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div><p style="color:var(--muted-fg);font-size:.9rem">Running the AI narrative on your key…</p></div>`}
    </div>

    <div class="card no-print">
      <h3>Cash invested</h3>
      <p>Down payment ${fmt$(m.down)} + closing ${fmt$(m.closing)} = <strong>${fmt$(m.cashIn)}</strong>. Annual cash flow ${fmt$(m.cfA)}.</p>
      <p class="tip" style="margin-top:8px">Analyzed ${new Date(deal.createdAt).toLocaleString()}. Educational estimates only — verify with your lender and CPA.</p>
    </div>`;
}

async function runLLMForDeal(deal) {
  const saved = loadKey();
  if (!saved || !saved.key) return;
  try {
    const { system, user } = buildAnalysisPrompt(deal, deal.metrics, deal.flags);
    const text = await callLLM(saved.provider, saved.key, saved.model || PROVIDERS[saved.provider].defaultModel, system, user, 700);
    deal.llm = text.trim();
    upsertDeal(deal);
    if (currentDealId === deal.id) {
      const card = document.getElementById('llm-card');
      if (card) card.innerHTML = `<div class="llm-body">${esc(deal.llm)}</div>`;
    }
  } catch (e) {
    const card = document.getElementById('llm-card');
    if (card && currentDealId === deal.id) {
      card.innerHTML = `<div class="notice warn">AI narrative failed: ${esc(e.message)}. The math above is unaffected — your numbers are complete without it.</div>`;
    }
  }
}

/* ================= History & compare ================= */
let compareSel = new Set();

function renderHistory() {
  const deals = loadDeals();
  const list = document.getElementById('history-list');
  compareSel = new Set([...compareSel].filter(id => deals.some(d => d.id === id)));
  document.getElementById('compare-btn').disabled = compareSel.size < 2;

  if (!deals.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No analyses yet. <a href="#/new" data-nav="new" style="color:var(--accent)">Analyze your first deal</a>.</p></div>';
    return;
  }
  list.innerHTML = deals.map(d => `
    <div class="deal-row" data-open="${d.id}" role="button" tabindex="0" aria-label="Open ${esc(d.name || 'deal')}">
      <div class="score-badge ${scoreClass(d.score.score)}">${d.score.score}</div>
      <div class="info"><strong>${esc(d.name || 'Untitled deal')}</strong>
        <small>${fmt$(d.price)} &middot; ${fmt$(d.metrics.cfM)}/mo &middot; ${fmtPct1(d.metrics.capRate)} cap</small></div>
      <div class="row-actions no-print">
        <label class="compare-check"><input type="checkbox" data-compare="${d.id}" ${compareSel.has(d.id) ? 'checked' : ''}> Compare</label>
        <button data-del="${d.id}" aria-label="Delete">Delete</button>
      </div>
    </div>`).join('');
}

function renderCompare() {
  const deals = compareSel.size >= 2 ? [...compareSel].map(getDeal).filter(Boolean)
    : loadDeals().slice(0, 4);
  const box = document.getElementById('compare-content');
  if (deals.length < 2) { box.innerHTML = '<p style="color:var(--muted-fg)">Select at least 2 deals in History to compare.</p>'; return; }
  const rows = [
    ['Deal score', d => d.score.score, 'max'],
    ['Price', d => fmt$(d.price), 'min'],
    ['Monthly cash flow', d => fmt$(d.metrics.cfM), 'max'],
    ['Cap rate', d => fmtPct1(d.metrics.capRate), 'max'],
    ['Cash-on-cash', d => fmtPct1(d.metrics.coc), 'max'],
    ['DSCR', d => d.metrics.dscr === 99 ? 'Cash' : d.metrics.dscr.toFixed(2), 'maxnum'],
    ['Cash invested', d => fmt$(d.metrics.cashIn), 'min'],
  ];
  const numOf = (d, fn) => { const v = fn(d); return typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, '')); };
  let html = '<table class="compare"><tr><th></th>' + deals.map(d => `<th>${esc(d.name || 'Deal')}</th>`).join('') + '</tr>';
  rows.forEach(([label, fn, dir]) => {
    const vals = deals.map(d => dir === 'maxnum' ? (d.metrics.dscr === 99 ? 99 : d.metrics.dscr) : numOf(d, fn));
    const best = dir.startsWith('max') ? Math.max(...vals) : Math.min(...vals);
    html += `<tr><th>${label}</th>` + deals.map((d, i) =>
      `<td class="${vals[i] === best ? 'winner' : ''}">${esc(String(fn(d)))}</td>`).join('') + '</tr>';
  });
  box.innerHTML = html + '</table>';
}

/* ================= Form & init ================= */
function readForm() {
  const v = id => document.getElementById(id).value.trim();
  return {
    id: 'deal-' + Date.now().toString(36),
    name: v('f-name'), price: +v('f-price'), rent: +v('f-rent'), beds: v('f-beds'),
    downPct: +v('f-down'), ratePct: +v('f-rate'), termYears: +v('f-term'), closingPct: +v('f-closing'),
    taxA: +v('f-tax'), insA: +v('f-ins'), hoaM: +v('f-hoa'),
    vacPct: +v('f-vac'), maintPct: +v('f-maint'), capexPct: +v('f-capex'), mgmtPct: +v('f-mgmt'),
    notes: v('f-notes'), createdAt: new Date().toISOString(),
  };
}

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

  document.getElementById('deal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('form-error');
    errEl.textContent = '';
    const deal = readForm();
    if (!deal.price || deal.price <= 0) { errEl.textContent = 'Enter a purchase price.'; return; }
    if (deal.rent < 0) { errEl.textContent = 'Rent can\'t be negative.'; return; }
    const btn = document.getElementById('analyze-btn');
    btn.disabled = true; btn.textContent = ' crunching numbers…';

    deal.metrics = calc(deal);
    deal.flags = codeFlags(deal, deal.metrics);
    deal.score = dealScore(deal.metrics, deal.flags);
    upsertDeal(deal);
    btn.disabled = false; btn.textContent = 'Run analysis';
    go('results', deal.id);
    runLLMForDeal(deal); // async; renders into the card when done
  });

  document.getElementById('print-btn').addEventListener('click', () => window.print());

  document.getElementById('history-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteDeal(del.dataset.del); renderHistory(); return; }
    const cmp = e.target.closest('[data-compare]');
    if (cmp) {
      const id = cmp.dataset.compare;
      if (cmp.checked) { if (compareSel.size >= 4) { cmp.checked = false; return; } compareSel.add(id); }
      else compareSel.delete(id);
      document.getElementById('compare-btn').disabled = compareSel.size < 2;
      return;
    }
    const row = e.target.closest('[data-open]');
    if (row) go('results', row.dataset.open);
  });
  document.getElementById('history-list').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const row = e.target.closest('[data-open]'); if (row) go('results', row.dataset.open); }
  });
  document.getElementById('compare-btn').addEventListener('click', () => { renderCompare(); go('compare'); });

  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
