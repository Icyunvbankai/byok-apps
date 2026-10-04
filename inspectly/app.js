/* Inspectly MVP — static app. Deterministic triage math in code; the LLM extracts and explains only. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'inspectly_key';     // {provider, key, model}
const LS_PROPS = 'inspectly_props'; // array of property triage objects

function loadKey() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveKey(obj) { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadProps() {
  try { return JSON.parse(localStorage.getItem(LS_PROPS) || '[]'); } catch { return []; }
}
function saveProps(p) { localStorage.setItem(LS_PROPS, JSON.stringify(p)); }
function getProp(id) { return loadProps().find(p => p.id === id); }
function upsertProp(prop) {
  const props = loadProps();
  const i = props.findIndex(p => p.id === prop.id);
  if (i >= 0) props[i] = prop; else props.unshift(prop);
  saveProps(props);
}
function deleteProp(id) { saveProps(loadProps().filter(p => p.id !== id)); }
const uid = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'new', 'results', 'history', 'compare', 'sheet', 'pricing', 'settings'];
let currentPropId = null;

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
  if (name === 'settings') syncSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) {
  if ((name === 'results' || name === 'sheet') && arg) currentPropId = arg;
  location.hash = '#/' + name + (arg ? '/' + arg : '');
}
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if ((name === 'results' || name === 'sheet') && parts[1]) currentPropId = parts[1];
  if (name === 'results') renderResults(currentPropId);
  if (name === 'sheet') renderSheet(currentPropId);
  if (name === 'compare') syncCompareSelects();
  showView(name);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', route);
}

/* ================= Deterministic data ================= */
/* Estimate table: national-average RANGES, not quotes. Versioned. The LLM may
   narrow within a row's bounds but never go outside them (clamped in code). */
const ESTIMATE_TABLE = {
  version: '2026-10-01',
  rows: [
    { key: 'roof-replace',    label: 'Full roof replacement',        range: [8000, 15000], when: 'roof at end of life, widespread damage or multiple leaks' },
    { key: 'roof-repair',     label: 'Roof repair (localized)',      range: [500, 2500],   when: 'a few damaged shingles, small leak, flashing fix' },
    { key: 'gutter',          label: 'Gutter repair / replacement',  range: [800, 3000],   when: 'sagging, leaking, or missing gutters/downspouts' },
    { key: 'water-heater',    label: 'Water heater replacement',     range: [1200, 2500],  when: 'unit past 10-12 year typical life or failing' },
    { key: 'electrical-panel',label: 'Electrical panel upgrade',     range: [2000, 4000],  when: 'Federal Pacific / Zinsco panel, undersized or unsafe panel' },
    { key: 'rewire-circuit',   label: 'Circuit repair / GFCI-AFCI',  range: [300, 1500],   when: 'double-tapped breaker, missing GFCI, bad wiring run' },
    { key: 'hvac-replace',    label: 'HVAC system replacement',      range: [6000, 14000], when: 'furnace/AC past 15-20 year life or dead' },
    { key: 'hvac-service',    label: 'HVAC service / repair',        range: [200, 1200],   when: 'dirty, short-cycling, minor component failure' },
    { key: 'foundation-piers',label: 'Foundation repair (piers)',    range: [4000, 15000], when: 'settlement, stair-step cracks, sticking doors' },
    { key: 'grading',         label: 'Grading / drainage correction',range: [1500, 6000],  when: 'water pooling at foundation, negative grade' },
    { key: 'plumbing-leak',   label: 'Plumbing leak repair',         range: [300, 2000],   when: 'active or past leak under sink, toilet, supply line' },
    { key: 'sewer-line',      label: 'Sewer line repair / replace',  range: [3000, 12000], when: 'root intrusion, bellied or broken lateral' },
    { key: 'mold-remediate',  label: 'Mold remediation',             range: [1000, 6000],  when: 'visible microbial growth needing pro remediation' },
    { key: 'radon-mitigate',  label: 'Radon mitigation system',      range: [800, 2500],   when: 'elevated radon test result' },
    { key: 'termite',         label: 'Termite treatment',            range: [500, 3000],   when: 'active termites or conducive conditions found' },
    { key: 'window-each',     label: 'Window replacement (each)',    range: [400, 1200],   when: 'failed seals, rotted frames, broken sash' },
    { key: 'appliance',       label: 'Appliance replacement',        range: [500, 2500],   when: 'dead or dying range, dishwasher, microwave' },
    { key: 'deck-repair',     label: 'Deck repair',                  range: [500, 4000],   when: 'rotted boards, loose railings, ledger issues' },
    { key: 'paint-ext',       label: 'Exterior paint',               range: [3000, 8000],  when: 'peeling / failing exterior paint' },
    { key: 'insulation',      label: 'Attic insulation upgrade',     range: [1500, 3500],  when: 'thin or missing attic insulation' },
  ]
};
function estimateRow(key) { return ESTIMATE_TABLE.rows.find(r => r.key === key) || null; }

/* Safety-net keywords: these ALWAYS escalate to "matters", severity >= 4,
   regardless of what the LLM first said. Deterministic, in code. */
const SAFETY_KEYWORDS = ['mold', 'asbestos', 'lead', 'foundation', 'structural',
  'active leak', 'knob-and-tube', 'knob and tube', 'federal pacific', 'radon'];

function sevLabel(s) {
  s = +s || 1;
  if (s >= 4) return 'urgent';
  if (s === 3) return 'soon';
  if (s === 2) return 'monitor';
  return 'fine';
}
const BUCKET_LABEL = { matters: 'What actually matters', negotiate: 'Negotiate', normal: "Normal — don't panic" };

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
/* Dedupe near-identical findings (same item words + same location). */
function dedupeFindings(findings) {
  const seen = new Set(), out = [];
  for (const f of findings) {
    const k = normKey(f.item).split(' ').slice(0, 8).join(' ') + '|' + normKey(f.location).split(' ').slice(0, 4).join(' ');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}
/* Apply the deterministic safety net + clamp estimates to table bounds. */
function applySafetyNet(triaged) {
  return triaged.map(t => {
    const hay = normKey((t.item || '') + ' ' + (t.inspector_note || '') + ' ' + (t.plain_english || ''));
    const hit = SAFETY_KEYWORDS.find(k => hay.includes(k));
    if (hit) {
      t.bucket = 'matters';
      t.severity = Math.max(+t.severity || 1, 4);
      t.safety_flag = 'Auto-escalated: mentions "' + hit + '"';
    }
    if (!['matters', 'negotiate', 'normal'].includes(t.bucket)) t.bucket = 'negotiate';
    t.severity = Math.min(5, Math.max(1, Math.round(+t.severity || 2)));
    // Clamp estimates to the table row's bounds; drop unknown rows.
    if (t.estimate_key) {
      const row = estimateRow(t.estimate_key);
      if (!row) { t.estimate_key = null; t.estimate_low = null; t.estimate_high = null; }
      else {
        const lo = +t.estimate_low, hi = +t.estimate_high;
        t.estimate_low = isFinite(lo) ? Math.min(Math.max(lo, row.range[0]), row.range[1]) : row.range[0];
        t.estimate_high = isFinite(hi) ? Math.min(Math.max(hi, row.range[0]), row.range[1]) : row.range[1];
        if (t.estimate_low > t.estimate_high) { const tmp = t.estimate_low; t.estimate_low = t.estimate_high; t.estimate_high = tmp; }
      }
    }
    return t;
  });
}
/* Concern score (spec): -(sum matters sev * 2) - (sum negotiate sev * 0.5) + (normal * 0.1).
   Lower (more negative) = more concerning. Deterministic. */
function concernScore(triaged) {
  let m = 0, n = 0, ok = 0;
  for (const t of triaged) {
    if (t.bucket === 'matters') m += (+t.severity || 0);
    else if (t.bucket === 'negotiate') n += (+t.severity || 0);
    else ok += 1;
  }
  return Math.round((-(m * 2) - (n * 0.5) + (ok * 0.1)) * 10) / 10;
}
function negotiateRange(triaged) {
  let lo = 0, hi = 0, n = 0;
  for (const t of triaged) {
    if (t.bucket === 'negotiate' && isFinite(+t.estimate_low) && isFinite(+t.estimate_high)) {
      lo += +t.estimate_low; hi += +t.estimate_high; n++;
    }
  }
  return n ? { lo: Math.round(lo), hi: Math.round(hi), n } : null;
}
/* Repair-priority checklist: matters by severity desc, then negotiate by severity desc. */
function buildChecklist(triaged) {
  return triaged
    .filter(t => t.bucket !== 'normal')
    .sort((a, b) => (b.severity - a.severity) || (a.bucket === 'matters' ? -1 : 1))
    .map(t => ({ item: t.item, location: t.location, severity: t.severity, bucket: t.bucket, next_step: t.next_step || 'Get a licensed contractor to quote.' }));
}
/* Negotiation talking points from the negotiate bucket. */
function buildTalkingPoints(triaged) {
  return triaged.filter(t => t.bucket === 'negotiate').map(t => {
    const range = (isFinite(+t.estimate_low) && isFinite(+t.estimate_high))
      ? fmtRange(+t.estimate_low, +t.estimate_high) : null;
    const ask = t.ask || ('Consider asking your agent about a ' + (range ? range + ' ' : '') + 'seller credit for this item.');
    return { item: t.item, location: t.location, range, ask };
  });
}

/* ================= Formatting ================= */
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const fmtRange = (lo, hi) => fmt$(lo) + '–' + fmt$(hi);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function stripFences(s) {
  return String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}
function parseJsonArray(s, what) {
  const clean = stripFences(s);
  let j;
  try { j = JSON.parse(clean); }
  catch (e) { throw new Error('Could not parse the AI\'s ' + what + ' output as JSON. Try again or switch models.'); }
  if (!Array.isArray(j)) throw new Error('The AI\'s ' + what + ' output was not a list. Try again.');
  return j;
}

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { dedupeFindings, applySafetyNet, concernScore, negotiateRange, buildChecklist, buildTalkingPoints, sevLabel, ESTIMATE_TABLE };
  if (require.main === module) runSelfTests();
}
function runSelfTests() {
  const assert = require('assert');
  // dedupe
  const d = dedupeFindings([
    { item: 'Double tapped breaker', location: 'Main panel' },
    { item: 'double-tapped breaker!', location: 'main panel ' },
    { item: 'Water heater old', location: 'Garage' },
  ]);
  assert(d.length === 2, 'dedupe keeps 2, got ' + d.length);
  // safety net escalation
  const s = applySafetyNet([
    { item: 'Possible mold', inspector_note: 'mold-like growth in attic', bucket: 'normal', severity: 1, plain_english: 'x' },
    { item: 'Caulk gaps', inspector_note: 'minor', bucket: 'normal', severity: 1, plain_english: 'x' },
  ]);
  assert(s[0].bucket === 'matters' && s[0].severity >= 4, 'mold escalated to matters/4+');
  assert(s[1].bucket === 'normal', 'caulk stays normal');
  // estimate clamping
  const c = applySafetyNet([
    { item: 'Roof', inspector_note: '', bucket: 'negotiate', severity: 3, plain_english: 'x', estimate_key: 'roof-replace', estimate_low: 100, estimate_high: 999999 },
  ]);
  assert(c[0].estimate_low === 8000 && c[0].estimate_high === 15000, 'estimates clamped to table bounds');
  const c2 = applySafetyNet([
    { item: 'X', inspector_note: '', bucket: 'negotiate', severity: 3, plain_english: 'x', estimate_key: 'nope-not-real', estimate_low: 1, estimate_high: 2 },
  ]);
  assert(c2[0].estimate_key === null, 'unknown estimate row dropped');
  // concern score: 1 matters sev4, 2 negotiate sev3, 3 normal => -(8) -(3) + 0.3 = -10.7
  const sc = concernScore([
    { bucket: 'matters', severity: 4 }, { bucket: 'negotiate', severity: 3 },
    { bucket: 'negotiate', severity: 3 }, { bucket: 'normal', severity: 1 },
    { bucket: 'normal', severity: 1 }, { bucket: 'normal', severity: 1 },
  ]);
  assert(sc === -10.7, 'concern score -10.7, got ' + sc);
  // negotiate range sums
  const r = negotiateRange([
    { bucket: 'negotiate', estimate_low: 1200, estimate_high: 2500 },
    { bucket: 'negotiate', estimate_low: 500, estimate_high: 1500 },
    { bucket: 'matters', estimate_low: 9999, estimate_high: 99999 },
  ]);
  assert(r.lo === 1700 && r.hi === 4000 && r.n === 2, 'range sums only negotiate bucket');
  // sev labels
  assert(sevLabel(5) === 'urgent' && sevLabel(3) === 'soon' && sevLabel(2) === 'monitor' && sevLabel(1) === 'fine', 'sev labels');
  console.log('All Inspectly self-tests passed.');
}

/* ================= LLM (BYOK) ================= */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini', carefulModel: 'gpt-4o', costHint: '~$0.01–0.04/report', corsNote: false },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-4-fast', carefulModel: 'grok-4', costHint: '~$0.01–0.04/report', corsNote: false },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', carefulModel: 'claude-sonnet-4-5', costHint: '~$0.01–0.04/report', corsNote: true },
};
/* Approx per-1M-token prices [input, output] for cost display. */
const MODEL_PRICES = {
  'gpt-4o-mini': [0.15, 0.60], 'gpt-4o': [2.50, 10.00],
  'grok-4-fast': [0.20, 0.50], 'grok-4': [3.00, 15.00],
  'claude-haiku-4-5': [1.00, 5.00], 'claude-sonnet-4-5': [3.00, 15.00],
};

function buildExtractPrompt(reportText) {
  return {
    system: "You are Inspectly's extraction engine. Extract discrete findings from home inspection reports into strict JSON. Never invent findings. If one paragraph describes multiple issues, split them into separate items.",
    user:
`Extract EVERY discrete finding from this home inspection report as a JSON array. Each item:
{"item": "short name", "location": "where in the house", "inspector_note": "the inspector's words, condensed to one line", "category_hint": "roof|electrical|plumbing|hvac|foundation|structural|exterior|interior|appliance|safety|other", "confidence": "high|medium|low"}

Rules: one issue per item; skip purely informational boilerplate and disclaimers; mark "low" confidence when the wording is ambiguous. Return ONLY the JSON array, no markdown fences.

REPORT:
${reportText}`
  };
}

function buildTriagePrompt(findings) {
  const table = ESTIMATE_TABLE.rows.map(r =>
    `- ${r.key}: ${r.label} ${fmtRange(r.range[0], r.range[1])} — ${r.when}`).join('\n');
  return {
    system: "You are Inspectly's inspection analyst — a straight-talking general contractor's brain with a buyer's advocate's heart. Plain English, no jargon without a translation, never alarmist, never dismissive. " +
      "Never state a definitive diagnosis (\"this IS mold\" → \"possible microbial growth — needs testing\"). " +
      "Never give legal advice on contracts — phrase asks as \"consider asking your agent about…\".",
    user:
`Triage each finding below. Return a JSON array, one object per finding IN THE SAME ORDER:
{"bucket": "matters|negotiate|normal", "severity": 1-5, "plain_english": "what this means, one sentence", "why": "why it matters — or why it's normal — one sentence", "next_step": "concrete next step", "estimate_key": "<key from the table, or null>", "estimate_low": <number or null>, "estimate_high": <number or null>, "ask": "one-line negotiation ask, or null"}

Bucket rules:
- matters: safety hazards, structural issues, roof/foundation/HVAC/electrical/plumbing defects, or typically $2,000+
- negotiate: defects worth a seller credit or repair ask
- normal: cosmetic wear, maintenance items, "every house has this" — include a one-line don't-panic note in "why"

Severity: 5 = safety/structural emergency, 4 = major defect, 3 = moderate, 2 = minor, 1 = cosmetic.

ESTIMATE TABLE (national-average RANGES, not quotes — pick the closest row; your low/high MUST stay within that row's range, or use null):
${table}

FINDINGS:
${JSON.stringify(findings)}

Return ONLY the JSON array, no markdown fences.`
  };
}

async function callLLM(provider, key, model, system, user, maxTokens) {
  const p = PROVIDERS[provider];
  let res;
  if (provider === 'anthropic') {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, max_tokens: maxTokens || 4000, system, messages: [{ role: 'user', content: user }] }),
    });
  } else {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 4000, temperature: 0.3 }),
    });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Provider error ' + res.status + ': ' + t.slice(0, 160));
  }
  const j = await res.json();
  let text, usage = null;
  if (provider === 'anthropic') {
    text = (j.content || []).map(b => b.text || '').join('');
    if (j.usage) usage = { in: j.usage.input_tokens || 0, out: j.usage.output_tokens || 0 };
  } else {
    text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    if (j.usage) usage = { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 };
  }
  return { text, usage };
}

function estimateCost(model, usage) {
  if (!usage) return null;
  const pr = MODEL_PRICES[model];
  if (!pr) return null;
  return (usage.in / 1e6 * pr[0] + usage.out / 1e6 * pr[1]);
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
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per report: ' + PROVIDERS[provider].costHint + '.';
  } catch (e) {
    errEl.textContent = 'Key test failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = false; btn.textContent = 'Test key'; }
}

/* ================= Demo report ================= */
const DEMO_REPORT = `HOME INSPECTION REPORT — 123 Maple St, Tampa FL. Inspected 10/01/2026.

ROOF: Architectural shingles, approximately 18 years old. Granule loss visible on south slope; two lifted shingles near ridge. Estimated remaining life 2-4 years. Recommend budgeting for replacement.
ELECTRICAL: Main panel is Federal Pacific Stab-Lok, 100 amp. Double-tapped breaker observed on positions 4 and 6. Recommend evaluation by licensed electrician.
PLUMBING: Water heater (gas, 40 gal) manufactured 2009 — past typical service life. Corrosion at cold-water inlet. No active leak observed at time of inspection.
HVAC: Air handler (2019) and condenser (2019) operated normally. Filter dirty — replace.
EXTERIOR: Grading slopes toward foundation on north side; mulch piled against siding. Recommend regrading to direct water away.
INTERIOR: Minor caulk gaps at guest bathroom tub surround. Cosmetic nail pops in living room drywall. GFCI outlet missing at kitchen island — recommend licensed electrician install.
ATTIC: Musty odor noted near soffit vent; no visible microbial growth observed from hatch. Recommend monitoring.
GENERAL: Peeling paint on rear fascia boards.`;

/* ================= Triage flow ================= */
let demoMode = false;

function updateCostEstimate() {
  const el = document.getElementById('cost-estimate');
  const chars = (document.getElementById('report-text').value || '').length;
  if (chars < 50) { el.textContent = ''; return; }
  const k = (chars / 4 / 1000).toFixed(1);
  el.textContent = '≈ ' + k + 'k input tokens → roughly $0.01–0.04 on mini-class models (flagship high-stakes mode: ~$0.15–0.60). Your key, your bill.';
}

async function runTriage() {
  const errEl = document.getElementById('intake-error');
  errEl.textContent = '';
  const saved = loadKey();
  if (!saved || !saved.key) { errEl.textContent = 'Save an API key first — triage runs on your key.'; go('setup'); return; }
  const text = document.getElementById('report-text').value.trim();
  if (text.length < 200) { errEl.textContent = 'Paste more of the report — at least a few paragraphs (200+ characters).'; return; }

  const careful = document.getElementById('careful-toggle').checked;
  const model = careful ? PROVIDERS[saved.provider].carefulModel : (saved.model || PROVIDERS[saved.provider].defaultModel);
  const btn = document.getElementById('triage-btn');
  btn.disabled = true;

  try {
    btn.textContent = 'Extracting findings…';
    const ex = buildExtractPrompt(text);
    const r1 = await callLLM(saved.provider, saved.key, model, ex.system, ex.user, 4000);
    let findings = dedupeFindings(parseJsonArray(r1.text, 'extraction'));
    if (!findings.length) throw new Error('No findings extracted — is this an inspection report? Try pasting more text.');

    btn.textContent = 'Triaging ' + findings.length + ' findings…';
    const tr = buildTriagePrompt(findings);
    const r2 = await callLLM(saved.provider, saved.key, model, tr.system, tr.user, 8000);
    let triaged = parseJsonArray(r2.text, 'triage');
    // Merge extraction metadata back in (same order).
    triaged = triaged.map((t, i) => Object.assign({}, findings[i] || {}, t));
    triaged = applySafetyNet(triaged);

    const prop = {
      id: uid('prop'),
      name: document.getElementById('prop-name').value.trim() || 'Untitled property',
      address: document.getElementById('prop-address').value.trim(),
      createdAt: new Date().toISOString(),
      model, provider: saved.provider,
      reportText: text,
      findingCount: triaged.length,
      triaged,
      checklist: buildChecklist(triaged),
      talkingPoints: buildTalkingPoints(triaged),
      score: concernScore(triaged),
      negRange: negotiateRange(triaged),
      usage: { extract: r1.usage, triage: r2.usage },
      demo: demoMode,
    };
    if (!demoMode) upsertProp(prop);
    currentPropId = prop.id;
    if (demoMode) window._demoProp = prop; // demo results live in memory only
    btn.disabled = false; btn.textContent = 'Triage my report';
    go('results', prop.id);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Triage my report';
    errEl.textContent = 'Triage failed: ' + e.message;
  }
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
    PROVIDERS[provider].name + ' default: ' + PROVIDERS[provider].defaultModel + ' (' + PROVIDERS[provider].costHint + '). Careful mode uses ' + PROVIDERS[provider].carefulModel + '. You can type any model name.';
}
function syncNoKeyNotice() {
  document.getElementById('no-key-notice').hidden = !!loadKey();
}
function syncSettings() {
  const saved = loadKey();
  document.getElementById('key-status').textContent = saved
    ? 'Key saved for ' + PROVIDERS[saved.provider].name + ' (' + (saved.model || PROVIDERS[saved.provider].defaultModel) + ').'
    : 'No key saved.';
  document.getElementById('settings-msg').textContent = '';
}

function bucketCounts(t) {
  const c = { matters: 0, negotiate: 0, normal: 0 };
  t.forEach(x => { if (c[x.bucket] == null) c[x.bucket] = 0; c[x.bucket]++; });
  return c;
}

function findingCard(t) {
  const lab = sevLabel(t.severity);
  return `<div class="finding ${t.bucket}">
    <div class="finding-top"><h3>${esc(t.item)}</h3><span class="sev ${lab}">${t.severity}/5 · ${lab}</span></div>
    ${t.location ? `<div class="loc">${esc(t.location)}${t.confidence === 'low' ? '<span class="lowconf">low confidence</span>' : ''}${t.safety_flag ? `<span class="safety-flag">${esc(t.safety_flag)}</span>` : ''}</div>` : ''}
    <p><strong>What this means:</strong> ${esc(t.plain_english || '—')}</p>
    <p><strong>Why it ${t.bucket === 'normal' ? "doesn't" : 'does'} matter:</strong> ${esc(t.why || '—')}</p>
    <p><strong>Next step:</strong> ${esc(t.next_step || '—')}</p>
    ${t.estimate_key && isFinite(+t.estimate_low) ? `<span class="est-range">Est. ${fmtRange(+t.estimate_low, +t.estimate_high)} (range, not a quote)</span>` : ''}
  </div>`;
}

function renderResults(id) {
  const box = document.getElementById('results-content');
  const prop = (window._demoProp && window._demoProp.id === id) ? window._demoProp : getProp(id);
  if (!prop) { box.innerHTML = '<div class="card"><p>Report not found.</p></div>'; return; }
  const counts = bucketCounts(prop.triaged);
  const byBucket = b => prop.triaged.filter(t => t.bucket === b);
  const usage = prop.usage || {};
  const totIn = (usage.extract && usage.extract.in || 0) + (usage.triage && usage.triage.in || 0);
  const totOut = (usage.extract && usage.extract.out || 0) + (usage.triage && usage.triage.out || 0);
  const cost = estimateCost(prop.model, { in: totIn, out: totOut });
  const neg = prop.negRange;

  const bucketSection = b => `
    <div class="bucket-head"><h2>${BUCKET_LABEL[b]}</h2><span class="count-badge ${b}">${counts[b] || 0}</span></div>
    ${(byBucket(b).length ? byBucket(b).map(findingCard).join('') : '<div class="card"><p style="color:var(--muted-fg)">Nothing here.</p></div>')}`;

  box.innerHTML = `
    <h1>${esc(prop.name)}</h1>
    <p style="color:var(--muted-fg);margin-bottom:12px">${esc(prop.address || '')} ${prop.address ? '· ' : ''}Triaged ${new Date(prop.createdAt).toLocaleString()} · ${prop.findingCount} findings · model ${esc(prop.model)}</p>
    ${prop.demo ? '<div class="notice warn">Demo triage — saving and the negotiation sheet are disabled for the sample report.</div>' : ''}
    <div class="score-strip">
      <div class="score-chip"><b>${prop.score}</b><small>concern score (lower = more concerning)</small></div>
      <div class="score-chip"><b>${counts.matters || 0}</b><small>need attention</small></div>
      <div class="score-chip"><b>${neg ? fmtRange(neg.lo, neg.hi) : '—'}</b><small>negotiate range (${neg ? neg.n : 0} items)</small></div>
      ${totIn ? `<div class="score-chip"><b>${(totIn / 1000).toFixed(1)}k / ${(totOut / 1000).toFixed(1)}k</b><small>tokens in/out${cost != null ? ' · ≈ $' + cost.toFixed(3) : ''}</small></div>` : ''}
    </div>
    ${bucketSection('matters')}
    ${bucketSection('negotiate')}
    <h2>Repair-priority checklist</h2>
    <div class="card"><ol class="checklist">
      ${prop.checklist.map(c => `<li><span><strong>${esc(c.item)}</strong>${c.location ? ' — ' + esc(c.location) : ''}<br><span style="color:var(--muted-fg)">${esc(c.next_step)}</span></span></li>`).join('') || '<li>No action items.</li>'}
    </ol></div>
    <h2>Negotiation talking points</h2>
    <div class="card">
      ${prop.talkingPoints.map(p => `<div class="talk"><strong>${esc(p.item)}${p.range ? ' — ' + p.range : ''}</strong>${esc(p.ask)}</div>`).join('') || '<p style="color:var(--muted-fg)">Nothing worth negotiating in this report.</p>'}
      <p class="tip" style="margin-top:8px">Phrase every ask as "consider asking your agent about…" — Inspectly doesn't give legal or contract advice.</p>
    </div>
    ${bucketSection('normal')}
    <div class="card"><h3>How the concern score works</h3>
      <p style="color:var(--muted-fg);font-size:.9rem">−(sum of matters severities × 2) − (sum of negotiate severities × 0.5) + (normal findings × 0.1). Deterministic — the AI never touches the math. Safety keywords (mold, asbestos, lead, foundation, structural, active leak, knob-and-tube, Federal Pacific, radon) auto-escalate to "matters" no matter what the AI first said.</p></div>`;

  const sheetBtn = document.getElementById('sheet-btn');
  sheetBtn.disabled = !!prop.demo;
  sheetBtn.onclick = () => go('sheet', prop.id);
}

/* ---- History ---- */
let compareSel = new Set();
function renderHistory() {
  const props = loadProps();
  const list = document.getElementById('history-list');
  compareSel = new Set([...compareSel].filter(id => props.some(p => p.id === id)));
  document.getElementById('compare-btn').disabled = compareSel.size !== 2;
  if (!props.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No triages yet. <a href="#/new" data-nav="new" style="color:var(--primary);font-weight:700">Triage your first report</a>.</p></div>';
    return;
  }
  list.innerHTML = props.map(p => {
    const c = bucketCounts(p.triaged);
    const neg = p.negRange;
    return `<div class="prop-row" data-open="${p.id}" role="button" tabindex="0" aria-label="Open ${esc(p.name)}">
      <div class="info"><strong>${esc(p.name)}</strong>
        <small>${new Date(p.createdAt).toLocaleDateString()} · ${c.matters || 0} matter / ${c.negotiate || 0} negotiate / ${c.normal || 0} normal${neg ? ' · ' + fmtRange(neg.lo, neg.hi) : ''}</small></div>
      <div class="row-actions no-print">
        <label class="compare-check"><input type="checkbox" data-compare="${p.id}" ${compareSel.has(p.id) ? 'checked' : ''}> Compare</label>
        <button data-retriage="${p.id}">Re-triage</button>
        <button data-del="${p.id}" aria-label="Delete">Delete</button>
      </div>
    </div>`;
  }).join('');
}

/* ---- Compare ---- */
function syncCompareSelects() {
  const props = loadProps();
  const opts = props.map(p => `<option value="${p.id}">${esc(p.name)} (${new Date(p.createdAt).toLocaleDateString()})</option>`).join('');
  const a = document.getElementById('compare-a'), b = document.getElementById('compare-b');
  a.innerHTML = opts || '<option value="">No saved properties</option>';
  b.innerHTML = opts || '<option value="">No saved properties</option>';
  if (props[1]) b.value = props[1].id;
  if (compareSel.size === 2) { const [x, y] = [...compareSel]; a.value = x; b.value = y; }
}
function compareRows(a, b) {
  const ca = bucketCounts(a.triaged), cb = bucketCounts(b.triaged);
  const na = a.negRange, nb = b.negRange;
  const mid = arr => arr.length ? (arr[0] + arr[1]) / 2 : 0;
  const rows = [
    ['Concern score (lower = worse)', a.score, b.score, 'min'],
    ['Matters count', ca.matters || 0, cb.matters || 0, 'min'],
    ['Negotiate count', ca.negotiate || 0, cb.negotiate || 0, 'max'],
    ['Negotiate range', na ? fmtRange(na.lo, na.hi) : '—', nb ? fmtRange(nb.lo, nb.hi) : '—', 'maxnum', na ? mid([na.lo, na.hi]) : 0, nb ? mid([nb.lo, nb.hi]) : 0],
    ['Normal findings', ca.normal || 0, cb.normal || 0, 'max'],
    ['Total findings', a.findingCount, b.findingCount, 'min'],
  ];
  let html = '<table class="compare"><tr><th></th><th>' + esc(a.name) + '</th><th>' + esc(b.name) + '</th></tr>';
  rows.forEach(r => {
    const [label, va, vb, dir, naNum, nbNum] = r;
    let wa = false, wb = false;
    if (dir === 'min') { wa = va < vb; wb = vb < va; }
    else if (dir === 'max') { wa = va > vb; wb = vb > va; }
    else { wa = naNum > nbNum; wb = nbNum > naNum; }
    html += `<tr><th>${label}</th><td class="${wa ? 'winner' : (!wb && va !== vb ? 'loser' : '')}">${va}</td><td class="${wb ? 'winner' : (!wa && va !== vb ? 'loser' : '')}">${vb}</td></tr>`;
  });
  return html + '</table>';
}
function redFlagOverlap(a, b) {
  const stop = new Set(['with', 'from', 'that', 'this', 'have', 'area', 'near', 'over', 'under', 'needs', 'recommend']);
  const words = p => {
    const s = new Set();
    p.triaged.filter(t => t.bucket === 'matters').forEach(t => {
      normKey(t.item + ' ' + (t.location || '')).split(' ').forEach(w => { if (w.length > 4 && !stop.has(w)) s.add(w); });
    });
    return s;
  };
  const wa = words(a), wb = words(b);
  return [...wa].filter(w => wb.has(w)).slice(0, 8);
}
async function runCompare() {
  const box = document.getElementById('compare-content');
  const a = getProp(document.getElementById('compare-a').value);
  const b = getProp(document.getElementById('compare-b').value);
  if (!a || !b || a.id === b.id) { box.innerHTML = '<div class="notice warn">Pick two different saved properties.</div>'; return; }
  const overlap = redFlagOverlap(a, b);
  box.innerHTML = `<div class="compare-table-wrap card">${compareRows(a, b)}</div>
    <div class="card"><h3>Red-flag overlap</h3>
    <p style="color:var(--muted-fg);font-size:.92rem">${overlap.length ? 'Both properties flag: <strong>' + overlap.map(esc).join(', ') + '</strong>' : 'No shared red-flag themes.'}</p></div>
    <div class="card" id="verdict-card"><div aria-live="polite"><div class="skeleton"></div><p style="color:var(--muted-fg);font-size:.9rem">Writing the verdict on your key…</p></div></div>`;
  const saved = loadKey();
  if (!saved || !saved.key) {
    document.getElementById('verdict-card').innerHTML = '<div class="notice warn">Save an API key for the written verdict — the table above is complete without it.</div>';
    return;
  }
  try {
    const prompt = `Two houses, triaged. A: "${a.name}" — concern score ${a.score}, matters ${bucketCounts(a.triaged).matters}, negotiate range ${a.negRange ? fmtRange(a.negRange.lo, a.negRange.hi) : 'none'}. ` +
      `B: "${b.name}" — concern score ${b.score}, matters ${bucketCounts(b.triaged).matters}, negotiate range ${b.negRange ? fmtRange(b.negRange.lo, b.negRange.hi) : 'none'}. ` +
      `Top matters for A: ${a.triaged.filter(t => t.bucket === 'matters').slice(0, 4).map(t => t.item).join('; ') || 'none'}. ` +
      `Top matters for B: ${b.triaged.filter(t => t.bucket === 'matters').slice(0, 4).map(t => t.item).join('; ') || 'none'}. ` +
      `In 4-6 sentences: which house is the cleaner buy and why, where each side has negotiation leverage, and the one question to ask the inspector before deciding. Plain English, no jargon without translation. Never state a definitive diagnosis.`;
    const r = await callLLM(saved.provider, saved.key, saved.model || PROVIDERS[saved.provider].defaultModel,
      'You are Inspectly\'s inspection analyst — straight-talking, never alarmist, never dismissive.', prompt, 600);
    document.getElementById('verdict-card').innerHTML = '<h3>The verdict</h3><p style="white-space:pre-wrap;font-size:.94rem">' + esc(r.text.trim()) + '</p>';
  } catch (e) {
    document.getElementById('verdict-card').innerHTML = '<div class="notice warn">Verdict failed: ' + esc(e.message) + '. The comparison table above is unaffected.</div>';
  }
}

/* ---- Negotiation sheet (print view) ---- */
function renderSheet(id) {
  const box = document.getElementById('sheet-content');
  const prop = getProp(id);
  if (!prop) { box.innerHTML = '<div class="card"><p>Report not found.</p></div>'; return; }
  const items = prop.triaged.filter(t => t.bucket === 'negotiate');
  const neg = prop.negRange;
  box.innerHTML = `<div class="sheet-doc">
    <h1>Negotiation sheet — ${esc(prop.name)}</h1>
    <p style="color:var(--muted-fg);margin-bottom:16px">${esc(prop.address || '')} · Triaged ${new Date(prop.createdAt).toLocaleDateString()} · Inspectly</p>
    ${neg ? `<p style="font-size:1.1rem;margin-bottom:16px"><strong>Total ask range: ${fmtRange(neg.lo, neg.hi)}</strong> across ${neg.n} items (ranges, not quotes).</p>` : ''}
    ${items.map(t => `<div class="sheet-item">
      <h3>${esc(t.item)}${t.location ? ' <span style="color:var(--muted-fg);font-weight:400">— ' + esc(t.location) + '</span>' : ''}</h3>
      <p>${esc(t.plain_english || '')}</p>
      ${isFinite(+t.estimate_low) ? `<p><strong>Estimate range: ${fmtRange(+t.estimate_low, +t.estimate_high)}</strong></p>` : ''}
      <div class="ask"><strong>Suggested ask:</strong> ${esc((prop.talkingPoints.find(p => p.item === t.item) || {}).ask || 'Consider asking your agent about a seller credit for this item.')}</div>
    </div>`).join('') || '<p>No negotiate-bucket items in this report.</p>'}
    <p style="margin-top:20px;font-size:.85rem;color:var(--muted-fg)">Estimates are ranges based on national averages, not quotes. Get a licensed inspector or contractor for final numbers before negotiating. Inspectly is not legal or contract advice — phrase every ask through your buyer's agent.</p>
  </div>`;
  document.getElementById('sheet-back-btn').onclick = () => go('results', prop.id);
}

/* ================= Form & init ================= */
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
        PROVIDERS[p].name + ' default: ' + PROVIDERS[p].defaultModel + ' (' + PROVIDERS[p].costHint + '). Careful mode uses ' + PROVIDERS[p].carefulModel + '. You can type any model name.';
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

  document.getElementById('report-text').addEventListener('input', () => { demoMode = false; updateCostEstimate(); });
  document.getElementById('file-input').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { document.getElementById('report-text').value = String(r.result || ''); demoMode = false; updateCostEstimate(); };
    r.readAsText(f);
  });
  document.getElementById('demo-btn').addEventListener('click', () => {
    document.getElementById('report-text').value = DEMO_REPORT;
    document.getElementById('prop-name').value = 'Demo — Maple St (sample)';
    document.getElementById('prop-address').value = '';
    demoMode = true;
    updateCostEstimate();
    document.getElementById('intake-error').textContent = '';
  });
  document.getElementById('triage-btn').addEventListener('click', runTriage);

  document.getElementById('history-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteProp(del.dataset.del); renderHistory(); return; }
    const ret = e.target.closest('[data-retriage]');
    if (ret) {
      e.stopPropagation();
      const p = getProp(ret.dataset.retriage);
      if (p && p.reportText) {
        document.getElementById('prop-name').value = p.name || '';
        document.getElementById('prop-address').value = p.address || '';
        document.getElementById('report-text').value = p.reportText;
        demoMode = false; updateCostEstimate();
      }
      go('new');
      return;
    }
    const cmp = e.target.closest('[data-compare]');
    if (cmp) {
      const id = cmp.dataset.compare;
      if (cmp.checked) { if (compareSel.size >= 2) { cmp.checked = false; return; } compareSel.add(id); }
      else compareSel.delete(id);
      document.getElementById('compare-btn').disabled = compareSel.size !== 2;
      return;
    }
    const row = e.target.closest('[data-open]');
    if (row) go('results', row.dataset.open);
  });
  document.getElementById('history-list').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const row = e.target.closest('[data-open]'); if (row) go('results', row.dataset.open); }
  });
  document.getElementById('compare-btn').addEventListener('click', () => go('compare'));
  document.getElementById('compare-run-btn').addEventListener('click', runCompare);
  document.getElementById('sheet-print-btn').addEventListener('click', () => window.print());

  document.getElementById('export-json-btn').addEventListener('click', () => {
    const data = JSON.stringify({ exportedAt: new Date().toISOString(), properties: loadProps() }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'inspectly-data.json';
    a.click();
    URL.revokeObjectURL(a.href);
    document.getElementById('settings-msg').textContent = 'Data exported.';
  });
  document.getElementById('wipe-data-btn').addEventListener('click', () => {
    if (!window.confirm('Delete ALL saved properties and the API key from this browser? This cannot be undone.')) return;
    localStorage.removeItem(LS_PROPS);
    clearKey();
    compareSel = new Set();
    document.getElementById('settings-msg').textContent = 'All local data deleted.';
    syncSettings();
  });

  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
