/* CounterOffer MVP — static BYOK app. Deterministic comp math in code; the LLM extracts, positions, and drafts only.
   Security: no third-party scripts; key lives in localStorage; all provider calls go browser -> provider directly.
   Nothing here phones home to our servers — the only network calls are fetch() to the chosen provider's API. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'counteroffer_key';       // {provider, key, model}
const LS_OFFERS = 'counteroffer_offers'; // array of offer objects
const LS_SPEND = 'counteroffer_spend';   // count of completed analysis chains (for est. key-spend display)

function loadKey() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveKey(obj) { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadOffers() {
  try { return JSON.parse(localStorage.getItem(LS_OFFERS) || '[]'); } catch { return []; }
}
function saveOffers(offers) { localStorage.setItem(LS_OFFERS, JSON.stringify(offers)); }
function getOffer(id) { return loadOffers().find(o => o.id === id); }
function upsertOffer(offer) {
  const offers = loadOffers();
  const i = offers.findIndex(o => o.id === offer.id);
  if (i >= 0) offers[i] = offer; else offers.unshift(offer);
  saveOffers(offers.slice(0, 50));
}
function deleteOffer(id) { saveOffers(loadOffers().filter(o => o.id !== id)); }
function bumpSpend() {
  const n = parseInt(localStorage.getItem(LS_SPEND) || '0', 10) || 0;
  localStorage.setItem(LS_SPEND, String(n + 1));
}

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'new', 'results', 'drafts', 'history', 'pricing'];
let currentOfferId = null;
let activeDraftTab = 'collaborative';

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
  if (name === 'drafts' && currentOfferId) renderDrafts(currentOfferId);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) {
  if ((name === 'results' || name === 'drafts') && arg) currentOfferId = arg;
  location.hash = '#/' + name + (arg ? '/' + arg : '');
}
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if ((name === 'results' || name === 'drafts') && parts[1]) {
    currentOfferId = parts[1];
    if (name === 'results') renderResults(currentOfferId);
  }
  showView(name);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', route);
}

/* ================= Deterministic comp math ================= */
/* Every dollar figure comes from here. The LLM is never asked to do math. */
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }

function vestTable(equityValue, vestYears, cliffYears) {
  const yrs = Math.max(1, Math.min(6, Math.round(vestYears) || 4));
  const cliff = Math.max(0, Math.min(yrs, Math.round(cliffYears != null ? cliffYears : 1)));
  const perYear = yrs > 0 ? equityValue / yrs : 0;
  const table = [];
  let cumulative = 0;
  for (let y = 1; y <= yrs; y++) {
    // Typical 4yr/1yr cliff: nothing vests before the cliff year, then the
    // cliff year's tranche catches up; equal annual vesting thereafter.
    // cliff === 0 means no cliff: straight equal annual vesting.
    const vested = y < cliff ? 0 : perYear * (y === cliff ? Math.max(cliff, 1) : 1);
    cumulative += vested;
    table.push({ year: y, vested: Math.round(vested), cumulative: Math.round(cumulative) });
  }
  return table;
}

function compMath(x) {
  // x: {base, bonus, equityValue, vestYears, cliffYears, signing, ptoDays, match401kPct}
  const base = num(x.base);
  const bonus = num(x.bonus);
  const equity = num(x.equityValue);
  const vestYears = num(x.vestYears) || 4;
  const cliffYears = x.cliffYears != null && x.cliffYears !== '' ? num(x.cliffYears) : 1;
  const signing = num(x.signing);
  const ptoDays = num(x.ptoDays);
  const matchPct = num(x.match401kPct);

  const equityYr = vestYears > 0 ? equity / vestYears : 0;
  const firstYear = base + bonus + equityYr + signing;
  const fourYear = base * 4 + bonus * 4 + equity + signing;
  const monthly = firstYear / 12;
  const table = vestTable(equity, vestYears, cliffYears);

  const ptoValue = base > 0 && ptoDays > 0 ? (base / 260) * ptoDays : 0;
  const matchValue = base > 0 && matchPct > 0 ? base * matchPct / 100 : 0;
  const benefitsTotal = ptoValue + matchValue;

  return { base, bonus, equity, vestYears, cliffYears, signing, ptoDays, matchPct,
           equityYr, firstYear, fourYear, monthly, table, ptoValue, matchValue, benefitsTotal };
}

/* Fields the letter didn't state -> "not specified — ask about this" */
function missingFields(ex) {
  const labels = {
    bonus: 'Bonus target', signing: 'Signing bonus', equity: 'Equity grant',
    vestYears: 'Vesting schedule', ptoDays: 'PTO / vacation', match401kPct: '401(k) match',
    nonCompete: 'Non-compete terms', ipAssignment: 'IP assignment terms',
    startDate: 'Start date', contingencies: 'Contingencies',
  };
  const out = [];
  for (const k of Object.keys(labels)) {
    const f = ex[k];
    // bonus/signing of 0 with stated=true means "no bonus" — specified, not missing.
    // Only flag fields the letter did not state.
    if (!(f && f.stated === true)) out.push(labels[k]);
  }
  return out;
}

/* Spot-check: quoted numbers from extraction must appear in the source letter. */
function validateExtract(letter, ex) {
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  const src = norm(letter);
  const flags = [];
  const checkNum = (label, field) => {
    if (!field || field.stated !== true || !field.quote) return;
    const q = norm(field.quote);
    if (q.length >= 4 && !src.includes(q)) {
      flags.push(label + ' — quoted text not found in the letter; verify this number.');
    }
  };
  checkNum('Base salary', ex.base);
  checkNum('Bonus', ex.bonus);
  checkNum('Signing bonus', ex.signing);
  checkNum('Equity', ex.equity);
  return flags;
}

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compMath, vestTable, missingFields, validateExtract };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');
  const approx = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, msg + ': got ' + a + ', want ~' + b);

  // Test 1: $150k base / $20k bonus / $100k RSU 4yr / $10k signing — the canonical case
  const t1 = compMath({ base: 150000, bonus: 20000, equityValue: 100000, vestYears: 4, cliffYears: 1, signing: 10000 });
  assert.strictEqual(Math.round(t1.equityYr), 25000, 't1 equity/yr');
  assert.strictEqual(Math.round(t1.firstYear), 205000, 't1 first-year');
  assert.strictEqual(Math.round(t1.fourYear), 790000, 't1 4-year');
  approx(t1.monthly, 17083.33, 0.01, 't1 monthly');
  assert.strictEqual(t1.table.length, 4, 't1 vest rows');
  assert.strictEqual(t1.table[0].vested, 25000, 't1 cliff year vests 25%');
  assert.strictEqual(t1.table[3].cumulative, 100000, 't1 fully vested by yr 4');

  // Test 2: benefits — $200k base, 15 PTO days, 4% 401k match
  const t2 = compMath({ base: 200000, bonus: 0, equityValue: 0, vestYears: 4, signing: 0, ptoDays: 15, match401kPct: 4 });
  approx(t2.ptoValue, 200000 / 260 * 15, 0.01, 't2 PTO value');
  assert.strictEqual(Math.round(t2.matchValue), 8000, 't2 401k match');
  assert.strictEqual(Math.round(t2.firstYear), 200000, 't2 first-year (no bonus/equity)');

  // Test 3: missing equity -> zeros, flagged as not specified
  const t3 = compMath({ base: 120000, bonus: 10000, equityValue: 0, vestYears: 4, signing: 5000 });
  assert.strictEqual(t3.equityYr, 0, 't3 no equity/yr');
  assert.strictEqual(Math.round(t3.firstYear), 135000, 't3 first-year');
  const miss = missingFields({ base: { stated: true }, bonus: { stated: true }, equity: { stated: false }, vestYears: { stated: false } });
  assert(miss.includes('Equity grant'), 't3 missing equity flagged');
  assert(miss.includes('Vesting schedule'), 't3 missing vesting flagged');

  // Test 4: quote validation catches a fabricated quote
  const vf = validateExtract('base salary of $150,000 per year', {
    base: { stated: true, quote: 'base salary of $150,000' },
    bonus: { stated: true, quote: '$99,999 bonus' },
  });
  assert.strictEqual(vf.length, 1, 't4 one mismatch flagged');
  assert(vf[0].startsWith('Bonus'), 't4 flags the bonus');

  // Test 5: no-cliff vesting spreads evenly
  const t5 = vestTable(120000, 4, 0);
  assert(t5.every(r => r.vested === 30000), 't5 even vesting without cliff');

  console.log('All CounterOffer self-tests passed.');
}

/* ================= Formatting ================= */
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================= LLM (BYOK) ================= */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini', flagshipModel: 'gpt-4o', costHint: '~$0.02–0.05/offer' },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-3-mini',  flagshipModel: 'grok-3',  costHint: '~$0.02–0.05/offer' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', flagshipModel: 'claude-sonnet-4-5', costHint: '~$0.03–0.08/offer', corsNote: true },
  gemini: { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', keyHeader: k => ({}), defaultModel: 'gemini-3.5-flash-lite', flagshipModel: 'gemini-3.5-flash-lite', costHint: '~$0.03–0.08/offer', gemini: true },
};


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
      body: JSON.stringify({ model, max_tokens: maxTokens || 1500, system, messages: [{ role: 'user', content: user }] }),
    });
  } else {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 1500, temperature: 0.4 }),
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

function stripFences(t) {
  return String(t || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}
function safeParse(t) {
  try { return JSON.parse(stripFences(t)); }
  catch (e) {
    const m = stripFences(t).match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    throw new Error('Could not parse the extraction JSON. Please try again.');
  }
}

/* ---- Prompt 1: extract structured fields from the letter ---- */
function buildExtractPrompt(letter, ctx) {
  return {
    system: 'You are a precise compensation analyst extracting structured data from an offer letter. ' +
      'Return STRICT JSON only — no markdown fences, no commentary. Every field is an object with "value", "stated" (true only if the letter explicitly states it), and "quote" (the verbatim phrase from the letter, or ""). ' +
      'NEVER invent numbers: if the letter does not state a figure, set stated=false, value=null (or 0 for amounts), quote="". ' +
      'For clause fields (nonCompete, ipAssignment, arbitration) use {"present": true/false, "stated": bool, "quote": "", "summary": "one-line plain-English summary or null"}.',
    user:
`Offer letter text:
"""
${letter}
"""

Candidate context (for reference only, not extraction): role=${ctx.role || 'n/a'}, level=${ctx.level || 'n/a'}, location=${ctx.location || 'n/a'}.

Extract exactly this JSON shape:
{
  "title": {"value": "...", "stated": true, "quote": "..."},
  "base": {"value": 150000, "stated": true, "quote": "..."},
  "bonus": {"value": 20000, "stated": true, "quote": "...", "type": "target percent or dollar amount as written"},
  "signing": {"value": 10000, "stated": true, "quote": "..."},
  "equity": {"value": 100000, "stated": true, "quote": "...", "type": "RSU / stock options / shares as written"},
  "vestYears": {"value": 4, "stated": false, "quote": ""},
  "cliffYears": {"value": 1, "stated": false, "quote": ""},
  "ptoDays": {"value": 15, "stated": true, "quote": "..."},
  "match401kPct": {"value": 4, "stated": true, "quote": "..."},
  "nonCompete": {"present": false, "stated": false, "quote": "", "summary": null},
  "ipAssignment": {"present": true, "stated": true, "quote": "...", "summary": "..."},
  "arbitration": {"present": false, "stated": false, "quote": "", "summary": null},
  "startDate": {"value": "...", "stated": true, "quote": "..."},
  "contingencies": ["background check", "..."],
  "otherClauses": ["one-line notes on anything else binding: at-will, clawbacks, probation, relocation..."]
}
Amounts in plain dollars (no commas in numbers). If equity is stated as shares without a dollar value, put value=null, stated=true, and note the share count in type.`
  };
}

/* ---- Prompt 2: market positioning + red flags + leverage (uses code-computed totals) ---- */
function buildAnalyzePrompt(offer) {
  const m = offer.math, ctx = offer.context, ex = offer.extracted;
  const clauseLine = k => {
    const c = ex[k];
    if (!c) return k + ': not mentioned';
    return k + ': ' + (c.present ? 'PRESENT — ' + (c.summary || c.quote || '') : 'not mentioned in letter');
  };
  return {
    system: 'You are a pragmatic compensation analyst and negotiation coach. You NEVER invent numbers — use only the verified figures below, computed in code. ' +
      'Your market bands are estimates from training data, NOT live salary surveys: say so explicitly and never cite specific sources like Levels.fyi. ' +
      'Be direct, practical, and honest about uncertainty. This is coaching, not legal advice — say that once.',
    user:
`VERIFIED NUMBERS (computed in code — trust these, do not recompute):
- Role: ${ctx.role || 'n/a'} | Level: ${ctx.level} | Location: ${ctx.location || 'n/a'} | Company stage: ${ctx.stage} | YoE: ${ctx.yoe || 'n/a'} | Current comp: ${ctx.current ? '$' + Number(ctx.current).toLocaleString() : 'not shared'}
- Base: ${fmt$(m.base)} | Bonus target: ${fmt$(m.bonus)} | Equity grant: ${fmt$(m.equity)} over ${m.vestYears} yrs (${m.cliffYears}-yr cliff) | Signing: ${fmt$(m.signing)}
- Equity/yr: ${fmt$(m.equityYr)} | FIRST-YEAR TOTAL: ${fmt$(m.firstYear)} | 4-YEAR TOTAL: ${fmt$(m.fourYear)} | Monthly equiv: ${fmt$(Math.round(m.monthly))}
- Benefits stated: PTO ${m.ptoDays} days (~${fmt$(m.ptoValue)} value), 401k match ${m.matchPct}% (~${fmt$(m.matchValue)})
- NOT STATED in letter: ${offer.missing.length ? offer.missing.join('; ') : 'nothing major'}
- Verify flags: ${offer.verifyFlags.length ? offer.verifyFlags.join(' | ') : 'none'}
CLAUSES: ${clauseLine('nonCompete')} | ${clauseLine('ipAssignment')} | ${clauseLine('arbitration')}
Other clauses noted: ${(ex.otherClauses || []).join('; ') || 'none'}

Write exactly these sections (markdown, concise):

## MARKET POSITIONING
Place base, bonus, and equity each as BELOW / AT / ABOVE market for this role+level+location+stage. Give a wide estimated band for first-year total (e.g. "$X–$Y") and label it clearly: "Estimate from training data, not a live survey — directional only." One line on how it compares to their current comp if shared. End with a confidence note (high/medium/low) and why.

## RED FLAGS — clause by clause
For each of non-compete, IP assignment, arbitration, plus anything in "other clauses": severity (high/medium/low), what it means in plain English, and the one question to ask. If a clause wasn't mentioned, say so — don't assume the worst, but note what to confirm. Reminder woven in: this is coaching, not legal advice; an employment attorney should review anything binding.

## LEVERAGE — ranked asks
List the 3–5 highest-leverage negotiation asks, ranked by expected dollar impact × ease of getting a yes. For each: the ask with a specific number, expected $ impact, difficulty (easy/medium/hard), one-line rationale tied to THIS offer's gaps, and what to concede in return (negotiation is give-and-take). Signing bonus is usually the easiest yes; base is usually the hardest — adjust to this offer.

## DECISION
One paragraph: accept / negotiate / walk-away lean with the user's own numbers, and the single biggest risk of accepting as-is.`
  };
}

/* ---- Prompt 3: phone script + email drafts in 3 tones ---- */
function buildDraftsPrompt(offer) {
  const m = offer.math, ctx = offer.context;
  const topAsks = 'Top leverage asks from analysis: (see analysis above — use the top 2–3 ranked asks)';
  return {
    system: 'You are a negotiation coach writing ready-to-send counter-offer copy. Tone rules: professional and warm, never adversarial, never entitled. ' +
      'NEVER bluff about competing offers the candidate did not mention. Use bracketed placeholders like [Base: $165,000] pre-filled with the computed numbers below — the candidate edits before sending. ' +
      'Return STRICT JSON only: {"phone": "...", "collaborative": "...", "firm": "...", "extension": "..."} — no markdown fences.',
    user:
`Candidate: ${ctx.role || 'the role'}${ctx.location ? ' in ' + ctx.location : ''}. Deadline: ${offer.context.deadline || 'not specified'}.
COMPUTED TOTALS (pre-fill these into brackets): first-year ${fmt$(m.firstYear)}, base ${fmt$(m.base)}, bonus ${fmt$(m.bonus)}, equity ${fmt$(m.equity)} over ${m.vestYears}yrs, signing ${fmt$(m.signing)}.
${topAsks}

Write 4 pieces as JSON:
1. "phone": a phone/Zoom negotiation script — opening line, 3–4 talking points with the numbers, and objection handling for "the offer is firm", "this is our standard package", and "we need an answer today". Keep it conversational, ~250 words.
2. "collaborative": full counter-offer email, warm tone — excited about the role, hoping to close the gap on specific items. ~180 words. Sign as [Your Name].
3. "firm": full counter-offer email, confident tone — grounded in market positioning and the candidate's value, still professional. ~180 words. Sign as [Your Name].
4. "extension": short deadline-extension request email — enthusiastic, asks for a few more days to decide responsibly. ~80 words. Sign as [Your Name].`
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
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per offer: ' + PROVIDERS[provider].costHint + '.';
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
  const flagship = document.getElementById('flagship-toggle').checked;
  if (saved) {
    document.getElementById('api-key').value = saved.key || '';
    document.getElementById('model').value = saved.model || (flagship ? PROVIDERS[provider].flagshipModel : PROVIDERS[provider].defaultModel);
  } else {
    document.getElementById('model').value = flagship ? PROVIDERS[provider].flagshipModel : PROVIDERS[provider].defaultModel;
  }
  document.getElementById('model-hint').textContent =
    PROVIDERS[provider].name + ' default: ' + PROVIDERS[provider].defaultModel + ' (' + PROVIDERS[provider].costHint + '). Flagship: ' + PROVIDERS[provider].flagshipModel + '. You can type any model name.';
  const n = parseInt(localStorage.getItem(LS_SPEND) || '0', 10) || 0;
  document.getElementById('spend-note').textContent = n > 0
    ? 'Est. key spend so far: ~' + fmt$(n * 0.02) + '–' + fmt$(n * 0.08) + ' across ' + n + ' completed ' + (n === 1 ? 'analysis' : 'analyses') + ' (rough mini-model estimate).'
    : 'Your estimated key spend will be tracked here as you run analyses.';
}

function syncNoKeyNotice() {
  document.getElementById('no-key-notice').hidden = !!loadKey();
}

function daysLeft(deadline) {
  if (!deadline) return null;
  const ms = new Date(deadline + 'T23:59:59') - new Date();
  return Math.ceil(ms / 86400000);
}

function countdownHTML(deadline) {
  const d = daysLeft(deadline);
  if (d == null) return '<span class="tip">No deadline set — add one when you know it; most offers expect an answer within 2 weeks.</span>';
  if (d < 0) return '<span class="countdown urgent">Deadline passed (' + Math.abs(d) + 'd ago)</span>';
  if (d === 0) return '<span class="countdown urgent">Due today</span>';
  const cls = d <= 3 ? 'urgent' : d <= 7 ? 'soon' : '';
  return '<span class="countdown ' + cls + '">' + d + ' day' + (d === 1 ? '' : 's') + ' left to decide</span>';
}

/* ---------- Results ---------- */
function skeletonCard(title) {
  return '<div class="card" aria-live="polite"><h3>' + esc(title) + '</h3>' +
    '<div class="skeleton"></div><div class="skeleton" style="width:80%"></div>' +
    '<p style="color:var(--muted-fg);font-size:.9rem">Running on your key…</p></div>';
}

function renderResults(id) {
  const offer = getOffer(id);
  const box = document.getElementById('results-content');
  if (!offer) { box.innerHTML = '<div class="card"><p>Offer not found.</p></div>'; return; }
  document.getElementById('to-drafts-btn').onclick = () => go('drafts', offer.id);

  const title = offer.context.role || (offer.extracted && offer.extracted.title && offer.extracted.title.value) || 'Untitled offer';
  let html = '<h1 class="no-print">' + esc(title) + '</h1>';
  html += '<p style="margin-bottom:16px">' + countdownHTML(offer.context.deadline) + '</p>';

  if (offer.stage === 'extracting' || !offer.extracted) {
    html += skeletonCard('Reading your offer letter') + skeletonCard('Computing compensation');
    box.innerHTML = html;
    return;
  }

  const m = offer.math;
  // --- Comp breakdown (deterministic) ---
  html += '<div class="card"><h3>Total comp <span style="color:var(--muted-fg);font-weight:400">(computed in code)</span></h3>' +
    '<table class="breakdown"><tr><th>Component</th><th>Annual</th></tr>' +
    '<tr><td>Base salary</td><td>' + fmt$(m.base) + '</td></tr>' +
    '<tr><td>Annual bonus target</td><td class="pos">+' + fmt$(m.bonus) + '</td></tr>' +
    '<tr><td>Equity (' + fmt$(m.equity) + ' / ' + m.vestYears + ' yrs)</td><td class="pos">+' + fmt$(m.equityYr) + '</td></tr>' +
    '<tr><td>Signing bonus</td><td class="pos">+' + fmt$(m.signing) + '</td></tr>' +
    '<tr class="total"><td>First-year total</td><td>' + fmt$(m.firstYear) + '</td></tr>' +
    '<tr><td>4-year total</td><td>' + fmt$(m.fourYear) + '</td></tr>' +
    '<tr><td>Monthly equivalent</td><td>' + fmt$(Math.round(m.monthly)) + '</td></tr></table>';
  if (m.benefitsTotal > 0) {
    html += '<table class="breakdown" style="margin-top:12px"><tr><th>Stated benefits (est. value)</th><th>Annual</th></tr>' +
      (m.ptoDays > 0 ? '<tr><td>PTO — ' + m.ptoDays + ' days @ daily rate</td><td class="pos">+' + fmt$(m.ptoValue) + '</td></tr>' : '') +
      (m.matchPct > 0 ? '<tr><td>401(k) match — ' + m.matchPct + '% of base</td><td class="pos">+' + fmt$(m.matchValue) + '</td></tr>' : '') +
      '<tr class="total"><td>Benefits value</td><td>+' + fmt$(m.benefitsTotal) + '</td></tr></table>';
  }
  html += '<p class="tip" style="margin-top:8px">Benefits valued at stated terms only. PTO at base/260 per day; 401(k) match as % of base.</p></div>';

  // --- Vesting table ---
  if (m.equity > 0) {
    html += '<div class="card"><h3>Vesting schedule</h3><table class="breakdown"><tr><th>Year</th><th>Vests</th><th>Cumulative</th></tr>' +
      m.table.map(r => '<tr><td>Year ' + r.year + '</td><td class="pos">+' + fmt$(r.vested) + '</td><td>' + fmt$(r.cumulative) + '</td></tr>').join('') +
      '</table><p class="tip" style="margin-top:8px">' + m.vestYears + '-year vest' + (m.cliffYears > 0 ? ' with ' + m.cliffYears + '-year cliff' : ', no cliff') +
      ' (from letter' + (offer.extracted.vestYears && offer.extracted.vestYears.stated ? '' : '; assumed typical — confirm') + '). Annualized equity value: ' + fmt$(Math.round(m.equityYr)) + '/yr.</p></div>';
  }

  // --- Not specified / verify flags ---
  if (offer.missing.length || offer.verifyFlags.length) {
    html += '<div class="card"><h3>Ask about this</h3>';
    if (offer.missing.length) html += '<p style="margin-bottom:8px">' + offer.missing.map(x => '<span class="missing-tag">not specified — ' + esc(x) + '</span>').join('') + '</p>';
    if (offer.verifyFlags.length) html += offer.verifyFlags.map(f => '<span class="verify-tag">' + esc(f) + '</span>').join('');
    html += '<p class="tip" style="margin-top:8px">Anything the letter didn\'t state is labeled, never invented.</p></div>';
  }

  // --- AI analysis (positioning, red flags, leverage, decision) ---
  if (offer.analysis) {
    html += '<div class="card"><h3>Analyst\'s take</h3><div class="llm-body">' + esc(offer.analysis) + '</div>' +
      '<p class="disclaimer">Market bands are estimates from training data, not live salary surveys — treat as directional. Coaching only, not legal advice.</p></div>';
  } else if (offer.analysisError) {
    html += '<div class="card"><div class="notice warn">Analysis failed: ' + esc(offer.analysisError) + ' <button class="btn small secondary" id="retry-analysis-btn" style="margin-left:8px">Retry</button></div></div>';
  } else {
    html += skeletonCard('Market positioning, red flags & leverage');
  }

  // --- Drafts status ---
  if (offer.drafts) {
    html += '<div class="card no-print"><h3>Counter-offer drafts ready</h3><p style="color:var(--muted-fg);font-size:.92rem;margin-bottom:12px">Collaborative, firm, extension request, and a phone script — numbers pre-filled.</p><button class="btn" id="open-drafts-btn">Open drafts</button></div>';
  } else if (offer.draftsError) {
    html += '<div class="card"><div class="notice warn">Drafts failed: ' + esc(offer.draftsError) + ' <button class="btn small secondary" id="retry-drafts-btn" style="margin-left:8px">Retry</button></div></div>';
  } else if (offer.analysis) {
    html += skeletonCard('Drafting counter-offer emails');
  }

  box.innerHTML = html;
  const rd = document.getElementById('retry-analysis-btn');
  if (rd) rd.addEventListener('click', () => runAnalyzeStep(offer.id));
  const rdr = document.getElementById('retry-drafts-btn');
  if (rdr) rdr.addEventListener('click', () => runDraftsStep(offer.id));
  const od = document.getElementById('open-drafts-btn');
  if (od) od.addEventListener('click', () => go('drafts', offer.id));
}

/* ---------- Analysis orchestration ---------- */
function llmCreds() {
  const saved = loadKey();
  if (!saved || !saved.key) throw new Error('No API key saved. Set one up first.');
  return { provider: saved.provider, key: saved.key, model: saved.model || PROVIDERS[saved.provider].defaultModel };
}

async function runAnalyzeStep(offerId) {
  const offer = getOffer(offerId);
  if (!offer || !offer.extracted) return;
  offer.analysisError = null; upsertOffer(offer); renderResults(offerId);
  try {
    const { provider, key, model } = llmCreds();
    const { system, user } = buildAnalyzePrompt(offer);
    offer.analysis = (await callLLM(provider, key, model, system, user, 1800)).trim();
    upsertOffer(offer); renderResults(offerId);
    runDraftsStep(offerId); // chain next step
  } catch (e) {
    offer.analysisError = e.message; upsertOffer(offer); renderResults(offerId);
  }
}

async function runDraftsStep(offerId) {
  const offer = getOffer(offerId);
  if (!offer || !offer.math) return;
  offer.draftsError = null; upsertOffer(offer); renderResults(offerId);
  try {
    const { provider, key, model } = llmCreds();
    const { system, user } = buildDraftsPrompt(offer);
    const raw = await callLLM(provider, key, model, system, user, 2000);
    const d = safeParse(raw);
    if (!d.collaborative || !d.firm) throw new Error('Drafts came back incomplete. Please try again.');
    offer.drafts = {
      collaborative: String(d.collaborative),
      firm: String(d.firm),
      extension: String(d.extension || ''),
      phone: String(d.phone || ''),
    };
    upsertOffer(offer); bumpSpend(); renderResults(offerId);
  } catch (e) {
    offer.draftsError = e.message; upsertOffer(offer); renderResults(offerId);
  }
}

async function runExtractStep(offerId) {
  const offer = getOffer(offerId);
  if (!offer) return;
  offer.stage = 'extracting'; upsertOffer(offer); renderResults(offerId);
  try {
    const { provider, key, model } = llmCreds();
    const { system, user } = buildExtractPrompt(offer.letter, offer.context);
    const raw = await callLLM(provider, key, model, system, user, 1500);
    const ex = safeParse(raw);
    if (!ex || typeof ex !== 'object' || !ex.base) throw new Error('Extraction came back incomplete. Please try again.');
    offer.extracted = ex;
    offer.verifyFlags = validateExtract(offer.letter, ex);
    const g = f => (f && f.value != null ? num(f.value) : 0);
    offer.math = compMath({
      base: g(ex.base), bonus: g(ex.bonus), equityValue: g(ex.equity),
      vestYears: ex.vestYears && ex.vestYears.stated ? num(ex.vestYears.value) : 4,
      cliffYears: ex.cliffYears && ex.cliffYears.stated ? num(ex.cliffYears.value) : 1,
      signing: g(ex.signing), ptoDays: g(ex.ptoDays), match401kPct: g(ex.match401kPct),
    });
    offer.missing = missingFields(ex);
    offer.stage = 'analyzing';
    upsertOffer(offer); renderResults(offerId);
    runAnalyzeStep(offerId); // chain next step
  } catch (e) {
    offer.stage = 'extract-failed';
    offer.extractError = e.message;
    upsertOffer(offer);
    document.getElementById('results-content').innerHTML =
      '<div class="card"><h3>Extraction failed</h3><div class="notice warn">' + esc(e.message) +
      '</div><p><button class="btn" id="retry-extract-btn">Retry extraction</button> ' +
      '<button class="btn secondary" data-nav="new" style="margin-left:8px">Back</button></p></div>';
    document.getElementById('retry-extract-btn').addEventListener('click', () => runExtractStep(offerId));
    document.querySelector('#results-content [data-nav="new"]').addEventListener('click', e2 => { e2.preventDefault(); go('new'); });
  }
}

/* ---------- Drafts view ---------- */
const DRAFT_LABELS = { collaborative: 'Collaborative', firm: 'Firm', extension: 'Extension request', phone: 'Phone script' };

function renderDrafts(id) {
  const offer = getOffer(id);
  const box = document.getElementById('drafts-content');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.draft === activeDraftTab));
  if (!offer) { box.innerHTML = '<div class="card"><p>Offer not found.</p></div>'; return; }
  if (!offer.drafts) {
    box.innerHTML = offer.draftsError
      ? '<div class="card"><div class="notice warn">Drafts failed: ' + esc(offer.draftsError) + '</div><p><button class="btn" id="retry-drafts2-btn">Retry drafts</button></p></div>'
      : '<div class="card" aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><p style="color:var(--muted-fg);font-size:.9rem">Drafting on your key…</p></div>';
    const r = document.getElementById('retry-drafts2-btn');
    if (r) r.addEventListener('click', () => runDraftsStep(id));
    return;
  }
  const text = offer.drafts[activeDraftTab] || '';
  box.innerHTML =
    '<div class="draft-actions no-print"><button class="btn small" id="copy-draft-btn">Copy to clipboard</button></div>' +
    '<div class="draft-doc"><div class="doc-body">' + esc(text) + '</div></div>' +
    '<p class="tip">Bracketed fields like [Base: $165,000] are pre-filled from your analysis — edit before sending.</p>';
  document.getElementById('copy-draft-btn').addEventListener('click', async e => {
    const btn = e.target;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); btn.textContent = 'Copied!'; }
      catch { btn.textContent = 'Copy failed — select manually'; }
      ta.remove();
    }
    setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 2000);
  });
}

/* ---------- History ---------- */
function renderHistory() {
  const offers = loadOffers();
  const list = document.getElementById('history-list');
  if (!offers.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No analyzed offers yet. <a href="#/new" data-nav="new" style="color:var(--accent)">Analyze your first offer</a>.</p></div>';
    return;
  }
  list.innerHTML = offers.map(o => {
    const title = o.context.role || (o.extracted && o.extracted.title && o.extracted.title.value) || 'Untitled offer';
    const sub = o.math
      ? fmt$(o.math.firstYear) + ' first-yr &middot; ' + fmt$(o.math.fourYear) + ' 4-yr'
      : (o.stage === 'extract-failed' ? 'extraction failed' : 'analyzing…');
    const date = new Date(o.createdAt).toLocaleDateString();
    return '<div class="offer-row" data-open="' + o.id + '" role="button" tabindex="0" aria-label="Open ' + esc(title) + '">' +
      (o.math ? '<div class="comp-badge">' + fmt$(o.math.firstYear) + '</div>' : '') +
      '<div class="info"><strong>' + esc(title) + '</strong><small>' + sub + ' &middot; ' + date + '</small></div>' +
      '<div class="row-actions no-print"><button data-del="' + o.id + '" aria-label="Delete">Delete</button></div></div>';
  }).join('');
}

/* ================= Form & init ================= */
function readContext() {
  const v = id => document.getElementById(id).value.trim();
  return {
    role: v('c-role'), level: v('c-level'), stage: v('c-stage'),
    location: v('c-location'), yoe: v('c-yoe'), current: v('c-current'), deadline: v('c-deadline'),
  };
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
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
      const flagship = document.getElementById('flagship-toggle').checked;
      const saved = loadKey();
      if (!saved || saved.provider !== p) document.getElementById('model').value = flagship ? PROVIDERS[p].flagshipModel : PROVIDERS[p].defaultModel;
      document.getElementById('model-hint').textContent =
        PROVIDERS[p].name + ' default: ' + PROVIDERS[p].defaultModel + ' (' + PROVIDERS[p].costHint + '). Flagship: ' + PROVIDERS[p].flagshipModel + '. You can type any model name.';
    });
  });
  document.getElementById('flagship-toggle').addEventListener('change', e => {
    const p = document.querySelector('input[name="provider"]:checked').value;
    document.getElementById('model').value = e.target.checked ? PROVIDERS[p].flagshipModel : PROVIDERS[p].defaultModel;
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

  document.getElementById('offer-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('form-error');
    errEl.textContent = '';
    const letter = document.getElementById('offer-letter').value.trim();
    const ctx = readContext();
    if (letter.length < 50) { errEl.textContent = 'Paste the offer letter text (at least a few sentences).'; return; }
    if (!loadKey()) { errEl.textContent = 'Save an API key first — the extractor needs it.'; go('setup'); return; }
    const btn = document.getElementById('analyze-btn');
    btn.disabled = true; btn.textContent = 'Starting analysis…';
    const offer = {
      id: 'offer-' + Date.now().toString(36),
      createdAt: new Date().toISOString(),
      letter, context: ctx, stage: 'extracting',
      extracted: null, math: null, missing: [], verifyFlags: [],
      analysis: null, analysisError: null, drafts: null, draftsError: null,
    };
    upsertOffer(offer);
    btn.disabled = false; btn.textContent = 'Analyze this offer';
    go('results', offer.id);
    runExtractStep(offer.id); // async chain: extract -> analyze -> drafts
  });

  document.getElementById('print-btn').addEventListener('click', () => window.print());
  document.getElementById('to-drafts-btn').addEventListener('click', () => { if (currentOfferId) go('drafts', currentOfferId); });
  document.getElementById('back-results-btn').addEventListener('click', () => { if (currentOfferId) go('results', currentOfferId); });

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => { activeDraftTab = t.dataset.draft; renderDrafts(currentOfferId); });
  });

  document.getElementById('history-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteOffer(del.dataset.del); renderHistory(); return; }
    const row = e.target.closest('[data-open]');
    if (row) go('results', row.dataset.open);
  });
  document.getElementById('history-list').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const row = e.target.closest('[data-open]'); if (row) go('results', row.dataset.open); }
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    downloadJSON('counteroffer-export.json', { app: 'counteroffer', exportedAt: new Date().toISOString(), offers: loadOffers() });
  });
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(r.result);
        const arr = Array.isArray(j) ? j : j.offers;
        if (!Array.isArray(arr)) throw new Error('bad format');
        const existing = loadOffers();
        const ids = new Set(existing.map(o => o.id));
        arr.forEach(o => { if (o && o.id && !ids.has(o.id)) { existing.unshift(o); ids.add(o.id); } });
        saveOffers(existing.slice(0, 50));
        renderHistory();
      } catch { alert('Import failed: not a valid CounterOffer export file.'); }
      e.target.value = '';
    };
    r.readAsText(f);
  });

  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
