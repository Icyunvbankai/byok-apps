/* EarningsEdge MVP — static app. Deterministic transcript intel in code; the LLM
   reads the call four ways (extract, tone, red-flags, synthesize). Every claim
   the AI makes must carry a transcript quote. No price targets, ever. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'ee_key';        // {provider, key, model}
const LS_WL = 'ee_watchlist';   // [{ticker, quarters: [...]}]
const LS_MODELS = 'ee_models';  // {openai, xai, anthropic} default model overrides

function loadKey() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveKey(obj) { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem(LS_WL) || '[]'); } catch { return []; }
}
function saveWatchlist(wl) { localStorage.setItem(LS_WL, JSON.stringify(wl)); }
function loadModels() {
  try { return JSON.parse(localStorage.getItem(LS_MODELS) || '{}'); } catch { return {}; }
}
function saveModels(m) { localStorage.setItem(LS_MODELS, JSON.stringify(m)); }
function uid(p) { return (p || 'id') + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'new', 'results', 'watchlist', 'ticker', 'pricing', 'settings'];
let currentBreakdown = null; // {ticker, quarter, createdAt, intel, extraction, tone, redflags, synth, usage, cost, saved}
let currentTicker = null;
let breakdownRunning = false; // true while the 4-call chain is in flight

function showView(name) {
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === name);
  });
  if (name === 'watchlist') renderWatchlist();
  if (name === 'setup') syncSetupUI();
  if (name === 'new') syncNoKeyNotice();
  if (name === 'settings') syncSettings();
  if (name === 'ticker' && currentTicker) renderTicker(currentTicker);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) {
  if (name === 'ticker' && arg) currentTicker = arg;
  location.hash = '#/' + name + (arg ? '/' + encodeURIComponent(arg) : '');
}
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if (name === 'ticker' && parts[1]) currentTicker = decodeURIComponent(parts[1]);
  if (name === 'results') {
    if (currentBreakdown && currentBreakdown.synth) {
      renderResults(currentBreakdown);
    } else if (!breakdownRunning) {
      // Not in flight and nothing to show — seed the empty state.
      // (While a breakdown is running we leave the progress UI alone.)
      document.getElementById('results-content').innerHTML =
        '<div class="card"><p style="color:var(--muted-fg)">No breakdown loaded. <a href="#/new" data-nav="new" style="color:var(--accent)">Run one</a>.</p></div>';
    }
  }
  showView(name);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', route);
}

/* ================= Deterministic transcript intel (code, not LLM) ================= */
function analyzeTranscript(text) {
  const t = String(text || '');
  const words = (t.match(/\S+/g) || []).length;
  const minutes = Math.max(1, Math.round(words / 180));

  // Speaker detection: "First Last:" / "Operator:" line starts
  const speakers = new Set();
  const re = /^([A-Z][A-Za-z.'\-]+(?: [A-Z][A-Za-z.'\-]+){0,3}|Operator|Moderator)\s*:/gm;
  let m;
  while ((m = re.exec(t)) !== null) speakers.add(m[1].trim());

  const hasPrepared = /(prepared remarks|opening remarks|good (morning|afternoon|evening)[,.] (and )?welcome)/i.test(t);
  const hasQA = /(Q\s*[-–:]|question\s*[-–:]|we'll (now |begin )?(take|open).*questions|operator,? (please )?(open|begin))/i.test(t);

  const KW = [
    ['guidance', /\bguidance\b/gi],
    ['raised', /\brais\w*\b/gi],
    ['lowered', /\blower\w*\b/gi],
    ['margin', /\bmargins?\b/gi],
    ['buyback', /buyback|share repurchase/gi],
    ['dividend', /\bdividend\b/gi],
    ['capex', /\bcapex\b|capital expenditure/gi],
    ['headwind', /\bheadwind\b/gi],
    ['AI', /\bAI\b/g],
  ];
  const hits = {};
  KW.forEach(([label, rx]) => { hits[label] = (t.match(rx) || []).length; });

  return {
    words, minutes,
    speakers: [...speakers].slice(0, 24), speakerCount: speakers.size,
    hasPrepared, hasQA,
    qaOnly: hasQA && !hasPrepared,
    tooShort: words > 0 && words < 1500,
    tooLong: words > 95000,
    empty: words === 0,
    hits,
  };
}

/* Rough cost estimate from word count (before the run). ~1.3 tokens/word. */
function estimateCost(words, inRate, outRate) {
  const inTok = Math.round(words * 1.3) * 4; // 4 passes over the transcript
  const outTok = 4500;
  const usd = inTok / 1e6 * inRate + outTok / 1e6 * outRate;
  return { inTok, outTok, usd };
}

/* ================= Formatting ================= */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt$ = v => '$' + Math.abs(Math.round(v)).toLocaleString('en-US');

function trajArrow(dir) {
  return dir === 'raised' ? '<span class="up">↑</span>'
    : dir === 'lowered' ? '<span class="down">↓</span>'
    : dir === 'maintained' ? '<span class="flat">→</span>'
    : '<span class="na">–</span>';
}

/* ================= LLM (BYOK) ================= */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o',          costHint: '~$0.15–0.40/breakdown', inRate: 2.5, outRate: 10 },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-3',           costHint: '~$0.15–0.40/breakdown', inRate: 3,   outRate: 15, approxRate: true },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-sonnet-4-5', costHint: '~$0.40–0.60/breakdown', inRate: 3, outRate: 15, corsNote: true },
  gemini: { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', keyHeader: k => ({}), defaultModel: 'gemini-3.5-flash-lite', costHint: '~$0.15–0.30/breakdown', inRate: 0.5, outRate: 2, gemini: true },
};
function getDefaultModel(provider) {
  const saved = loadModels();
  return (saved && saved[provider]) || PROVIDERS[provider].defaultModel;
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

async function callLLM(provider, key, model, system, user, maxTokens, temperature) {
  const p = PROVIDERS[provider];
  if (p.gemini) { const gt = await callGemini(key, model, system, user, maxTokens); return { text: gt, usage: { in: 0, out: 0 } }; }
  let res;
  const body = provider === 'anthropic'
    ? { model, max_tokens: maxTokens || 2000, system, messages: [{ role: 'user', content: user }] }
    : { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 2000, temperature: temperature == null ? 0.2 : temperature };
  res = await fetch(p.url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Provider error ' + res.status + ': ' + t.slice(0, 160));
  }
  const j = await res.json();
  const text = provider === 'anthropic'
    ? (j.content || []).map(b => b.text || '').join('')
    : ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  const u = j.usage || {};
  return { text, usage: { in: u.prompt_tokens || u.input_tokens || 0, out: u.completion_tokens || u.output_tokens || 0 } };
}

/* LLMs wrap JSON in fences; be liberal in what we accept. */
function parseJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Model did not return JSON.');
  try { return JSON.parse(t.slice(a, b + 1)); }
  catch (e) { throw new Error('Could not parse model JSON: ' + e.message); }
}

const ANALYST_SYS = 'You are a skeptical equity research analyst writing for a smart non-professional investor. ' +
  'Every claim must be backed by a verbatim transcript quote (max ~40 words each). ' +
  'Never invent numbers — if the transcript does not say it, use null and say so. ' +
  'No price targets, no buy/sell recommendations — comprehension, not prediction. ' +
  'Return ONLY valid JSON, no markdown fences, no commentary.';

function buildExtract(ticker, quarter, transcript) {
  return {
    system: ANALYST_SYS,
    user:
`Ticker: ${ticker} | Quarter: ${quarter}

TRANSCRIPT:
${transcript}

Extract structured facts as JSON with EXACTLY this shape:
{
  "guidance": {"direction": "raised|lowered|maintained|not-discussed", "details": "one or two sentences", "quotes": ["verbatim quote"]},
  "margins": {"commentary": "one or two sentences on gross/operating margin discussion", "quotes": ["verbatim quote"]},
  "segments": [{"name": "segment or product line", "note": "what was said", "quote": "verbatim quote"}],
  "capital": {"capex": "what was said or null", "buybacks": "what was said or null", "dividend": "what was said or null"},
  "notable": ["other material facts, each one sentence"]
}
Keep every quote verbatim and under 40 words. Empty arrays where nothing was said.`,
    maxTokens: 2200,
  };
}

function buildTone(ticker, quarter, transcript) {
  return {
    system: ANALYST_SYS,
    user:
`Ticker: ${ticker} | Quarter: ${quarter}

TRANSCRIPT:
${transcript}

Read management's tone as JSON with EXACTLY this shape:
{
  "confidence": 1-5 (5 = highly confident),
  "evasiveness": 1-5 (5 = highly evasive),
  "confidence_evidence": ["verbatim quote showing confidence or lack of it"],
  "evasiveness_evidence": ["verbatim quote showing evasion, hedging, or deflection"],
  "pushback": [{"analyst": "name or firm if given", "moment": "what they pressed on", "quote": "verbatim analyst quote or question"}]
}
Score honestly — a 3/3 call is fine. Flag moments analysts had to ask twice.`,
    maxTokens: 1400,
  };
}

function buildRedFlags(ticker, quarter, transcript) {
  return {
    system: ANALYST_SYS,
    user:
`Ticker: ${ticker} | Quarter: ${quarter}

TRANSCRIPT:
${transcript}

Adversarial pass. Argue why a short seller would love this call. Return JSON with EXACTLY this shape:
{
  "flags": [{"severity": "high|medium|low", "category": "guidance|accounting|demand|management|macro|other", "text": "the concern in one sentence", "quote": "verbatim supporting quote"}]
}
Look for: weasel words, guidance walk-downs, accounting changes, blame-shifting to macro, dodged questions, insider-selling mentions, channel stuffing hints. Empty array if genuinely clean — do not invent.`,
    maxTokens: 1600,
  };
}

function buildSynth(ticker, quarter, extraction, tone, redflags) {
  return {
    system: ANALYST_SYS,
    user:
`Ticker: ${ticker} | Quarter: ${quarter}

You have three analyst passes on this earnings call (JSON below). Synthesize the briefing as JSON with EXACTLY this shape:
{
  "summary": ["exactly 5 lines: what actually matters from this call"],
  "bull": [{"point": "bullish point, one sentence", "quote": "verbatim transcript quote"} x5],
  "bear": [{"point": "bearish point, one sentence", "quote": "verbatim transcript quote"} x5]
}
Reuse quotes from the passes where they fit — do not invent new ones. Balance the cases honestly; a weak quarter still gets 5 bear points and its best 5 bull points. No price targets, no recommendations.

EXTRACTION: ${JSON.stringify(extraction).slice(0, 6000)}
TONE: ${JSON.stringify(tone).slice(0, 2500)}
RED FLAGS: ${JSON.stringify(redflags).slice(0, 3500)}`,
    maxTokens: 2600,
  };
}

/* 4-call chain: extract, then tone + red-flags in parallel, then synthesize. */
async function runBreakdown(saved, ticker, quarter, transcript, onProgress) {
  const usage = { in: 0, out: 0 };
  const step = async (id, fn) => {
    if (onProgress) onProgress(id, 'doing');
    const r = await fn();
    usage.in += r.usage.in; usage.out += r.usage.out;
    if (onProgress) onProgress(id, 'done');
    return r;
  };
  const p = saved.provider, key = saved.key, model = saved.model || getDefaultModel(p);

  const exR = await step('extract', () => {
    const pr = buildExtract(ticker, quarter, transcript);
    return callLLM(p, key, model, pr.system, pr.user, pr.maxTokens, 0.2);
  });
  const extraction = parseJSON(exR.text);

  const [toneR, rfR] = await Promise.all([
    step('tone', () => { const pr = buildTone(ticker, quarter, transcript); return callLLM(p, key, model, pr.system, pr.user, pr.maxTokens, 0.2); }),
    step('redflags', () => { const pr = buildRedFlags(ticker, quarter, transcript); return callLLM(p, key, model, pr.system, pr.user, pr.maxTokens, 0.2); }),
  ]);
  const tone = parseJSON(toneR.text);
  const redflags = parseJSON(rfR.text);

  const syR = await step('synth', () => {
    const pr = buildSynth(ticker, quarter, extraction, tone, redflags);
    return callLLM(p, key, model, pr.system, pr.user, pr.maxTokens, 0.3);
  });
  const synth = parseJSON(syR.text);

  const prov = PROVIDERS[p];
  const cost = usage.in / 1e6 * prov.inRate + usage.out / 1e6 * prov.outRate;
  return { extraction, tone, redflags, synth, usage, cost };
}

async function testKey() {
  const errEl = document.getElementById('key-error'), okEl = document.getElementById('key-success');
  errEl.textContent = ''; okEl.textContent = '';
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const key = document.getElementById('api-key').value.trim();
  const model = document.getElementById('model').value.trim() || getDefaultModel(provider);
  if (!key) { errEl.textContent = 'Paste a key first.'; return; }
  const btn = document.getElementById('test-key-btn');
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    await callLLM(provider, key, model, 'Reply with exactly: ok', 'Reply with exactly: ok', 10, 0);
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per breakdown: ' + PROVIDERS[provider].costHint + '.';
  } catch (e) {
    errEl.textContent = 'Key test failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = false; btn.textContent = 'Test key'; }
}

/* ================= Views ================= */
function syncSetupUI() {
  const saved = loadKey();
  const provider = (saved && saved.provider) || 'anthropic';
  document.querySelectorAll('.provider').forEach(el => {
    const sel = el.dataset.provider === provider;
    el.classList.toggle('selected', sel);
    el.querySelector('input').checked = sel;
  });
  document.getElementById('anthropic-note').hidden = provider !== 'anthropic';
  document.getElementById('api-key').value = (saved && saved.key) || '';
  document.getElementById('model').value = (saved && saved.model) || getDefaultModel(provider);
  const pr = PROVIDERS[provider];
  document.getElementById('model-hint').textContent =
    pr.name + ' default: ' + getDefaultModel(provider) + ' (' + pr.costHint + '). You can type any model name.';
}

function syncNoKeyNotice() {
  document.getElementById('no-key-notice').hidden = !!loadKey();
}

function syncSettings() {
  const saved = loadKey();
  document.getElementById('settings-key-status').textContent = saved
    ? 'Key saved for ' + PROVIDERS[saved.provider].name + ' (' + (saved.model || getDefaultModel(saved.provider)) + '). Stored only in this browser.'
    : 'No key saved.';
  const models = loadModels();
  document.getElementById('set-model-openai').value = models.openai || PROVIDERS.openai.defaultModel;
  document.getElementById('set-model-xai').value = models.xai || PROVIDERS.xai.defaultModel;
  document.getElementById('set-model-anthropic').value = models.anthropic || PROVIDERS.anthropic.defaultModel;
}

function renderIntel(intel) {
  const box = document.getElementById('transcript-intel');
  if (intel.empty) { box.innerHTML = ''; return; }
  const warn = [];
  if (intel.tooShort) warn.push('Short transcript (' + intel.words.toLocaleString() + ' words) — a full call is usually 8,000–15,000 words. Results will be thinner.');
  if (intel.tooLong) warn.push('Very long transcript — may exceed the model context window. Consider trimming to prepared remarks + Q&A.');
  if (intel.qaOnly) warn.push('This looks like Q&A only — full transcript (prepared remarks + Q&A) gives better results.');
  const kwOrder = ['guidance', 'raised', 'lowered', 'margin', 'buyback', 'dividend', 'capex', 'headwind', 'AI'];
  box.innerHTML = `
    <div class="card" style="margin-top:12px">
      <h3>Transcript check <span style="color:var(--muted-fg);font-weight:400;font-size:.85rem">(computed in code, instant)</span></h3>
      ${warn.map(w => `<div class="notice warn" style="margin:8px 0">${esc(w)}</div>`).join('')}
      <div class="intel-grid">
        <div class="intel"><div class="v">${intel.words.toLocaleString()}</div><div class="l">words · ~${intel.minutes} min read</div></div>
        <div class="intel"><div class="v">${intel.speakerCount}</div><div class="l">speakers detected</div></div>
        <div class="intel"><div class="v">${intel.hasPrepared ? 'Yes' : 'No'}</div><div class="l">prepared remarks</div></div>
        <div class="intel"><div class="v">${intel.hasQA ? 'Yes' : 'No'}</div><div class="l">Q&amp;A section</div></div>
      </div>
      <div class="kw-hits">${kwOrder.map(k => `<span class="kw">${esc(k)} <b>${intel.hits[k] || 0}</b></span>`).join('')}</div>
      ${intel.speakers.length ? `<p class="tip" style="margin-top:8px">Heard from: ${esc(intel.speakers.slice(0, 8).join(', '))}${intel.speakers.length > 8 ? '…' : ''}</p>` : ''}
    </div>`;
}

function quoteHtml(q) {
  return q ? `<span class="quote">&ldquo;${esc(q)}&rdquo;</span>` : '';
}

function renderProgress() {
  const steps = [['extract', 'Structured extraction'], ['tone', 'Management tone read'], ['redflags', 'Red-flag scan'], ['synth', 'Bull/bear synthesis']];
  return `<div class="card"><h3>Reading the call on your key…</h3>
    <ul class="progress-steps" id="progress-list">
      ${steps.map(([id, label]) => `<li id="ps-${id}">○ ${label}</li>`).join('')}
    </ul>
    <p class="tip">Four passes, tone + red-flags in parallel. Long transcripts take a minute or two.</p></div>`;
}
function markProgress(id, state) {
  const el = document.getElementById('ps-' + id);
  if (!el) return;
  el.classList.remove('doing', 'done');
  if (state === 'doing') { el.classList.add('doing'); el.textContent = '◐ ' + el.textContent.slice(2); }
  if (state === 'done') { el.classList.add('done'); el.textContent = '● ' + el.textContent.slice(2); }
}

function renderResults(b) {
  const box = document.getElementById('results-content');
  const ex = b.extraction || {}, tone = b.tone || {}, rf = b.redflags || {}, sy = b.synth || {};
  const g = ex.guidance || {};
  const dir = g.direction || 'not-discussed';
  const dirLabel = { raised: 'Raised', lowered: 'Lowered', maintained: 'Maintained', 'not-discussed': 'Not discussed' }[dir] || dir;

  const bullBear = (items, cls) => (items || []).map(x => `
    <div class="bb-point"><p>${esc(x.point)}</p>${quoteHtml(x.quote)}</div>`).join('');

  box.innerHTML = `
    <h1 class="no-print"><span class="ticker">${esc(b.ticker)}</span> <span style="color:var(--muted-fg);font-weight:400;font-size:1.2rem">${esc(b.quarter)}</span></h1>

    <h2>What actually matters</h2>
    <div class="card"><ol class="exec-summary">
      ${(sy.summary || []).map(s => `<li>${esc(s)}</li>`).join('')}
    </ol></div>

    <h2>Guidance</h2>
    <div class="card">
      <p><span class="dir ${esc(dir)}">${esc(dirLabel)}</span></p>
      <p style="margin-top:10px">${esc(g.details || 'No guidance detail extracted.')}</p>
      ${(g.quotes || []).map(quoteHtml).join('')}
    </div>

    <h2>Margins</h2>
    <div class="card">
      <p>${esc((ex.margins && ex.margins.commentary) || 'No margin commentary extracted.')}</p>
      ${((ex.margins && ex.margins.quotes) || []).map(quoteHtml).join('')}
    </div>

    ${(ex.segments && ex.segments.length) ? `
    <h2>Segments</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Segment</th><th>What was said</th></tr>
      ${ex.segments.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.note)}${quoteHtml(s.quote)}</td></tr>`).join('')}
    </table></div>` : ''}

    <h2>Management tone</h2>
    <div class="card">
      <div class="grid2">
        <div><p><strong>Confidence</strong> <span class="mono">${tone.confidence != null ? tone.confidence : '–'}/5</span></p>
          <div class="meter" aria-hidden="true">${[1, 2, 3, 4, 5].map(i => `<i class="${tone.confidence >= i ? 'on' : ''}"></i>`).join('')}</div></div>
        <div><p><strong>Evasiveness</strong> <span class="mono">${tone.evasiveness != null ? tone.evasiveness : '–'}/5</span></p>
          <div class="meter warn" aria-hidden="true">${[1, 2, 3, 4, 5].map(i => `<i class="${tone.evasiveness >= i ? 'on' : ''}"></i>`).join('')}</div></div>
      </div>
      ${((tone.confidence_evidence) || []).concat(tone.evasiveness_evidence || []).map(quoteHtml).join('')}
      ${((tone.pushback) || []).map(p => `<div class="flag"><span class="sev low">pushback</span><span><strong>${esc(p.analyst || 'Analyst')}</strong> pressed on ${esc(p.moment || 'a topic')}.${quoteHtml(p.quote)}</span></div>`).join('')}
    </div>

    <h2>Red flags <span style="color:var(--muted-fg);font-weight:400;font-size:.85rem">(${(rf.flags || []).length} found)</span></h2>
    <div class="card">${(rf.flags && rf.flags.length) ? rf.flags.map(f => `
      <div class="flag"><span class="sev ${esc(f.severity || 'low')}">${esc(f.severity || 'low')}</span>
      <span class="body"><span class="cat">${esc(f.category || 'other')}</span><br>${esc(f.text)}${quoteHtml(f.quote)}</span></div>`).join('')
      : '<p style="color:var(--muted-fg)">Adversarial pass came back clean. No invented flags — the call genuinely lacked red-flag material.</p>'}</div>

    <h2>Bull / bear</h2>
    <div class="bb-grid">
      <div class="bb-col bull"><h3><span class="tag bull">BULL</span> The case for</h3>${bullBear(sy.bull, 'bull')}</div>
      <div class="bb-col bear"><h3><span class="tag bear">BEAR</span> The case against</h3>${bullBear(sy.bear, 'bear')}</div>
    </div>
    <p class="tip" style="margin-top:8px">No price targets, no recommendations — comprehension, not prediction. Every point above is tied to a transcript quote.</p>

    <div class="card no-print">
      <h3>Run cost</h3>
      <div class="cost-line">tokens in: ${(b.usage.in || 0).toLocaleString()} · tokens out: ${(b.usage.out || 0).toLocaleString()} · est. cost on your key: ~$${(b.cost || 0).toFixed(2)}${PROVIDERS[b.provider] && PROVIDERS[b.provider].approxRate ? ' (approx. rate)' : ''}</div>
      <p class="tip" style="margin-top:8px">Breakdown ran ${b.createdAt ? new Date(b.createdAt).toLocaleString() : 'just now'} on ${esc(b.model || '')}.</p>
      ${b.saved
        ? `<p class="success">Saved to watchlist (${esc(b.ticker)} · ${esc(b.quarter)}).</p>`
        : `<p style="margin-top:12px"><button class="btn" id="save-watchlist-btn">Save to watchlist</button></p>`}
    </div>`;
}

/* ================= Watchlist ================= */
function upsertQuarter(ticker, q) {
  const wl = loadWatchlist();
  let entry = wl.find(e => e.ticker === ticker);
  if (!entry) { entry = { ticker, quarters: [] }; wl.push(entry); }
  const i = entry.quarters.findIndex(x => x.quarter.toLowerCase() === q.quarter.toLowerCase());
  if (i >= 0) entry.quarters[i] = q; else entry.quarters.unshift(q);
  entry.quarters.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  saveWatchlist(wl);
}
function deleteTicker(ticker) { saveWatchlist(loadWatchlist().filter(e => e.ticker !== ticker)); }

function guidanceDir(q) {
  return (q.extraction && q.extraction.guidance && q.extraction.guidance.direction) || 'not-discussed';
}

function renderWatchlist() {
  const wl = loadWatchlist();
  const list = document.getElementById('watchlist-list');
  if (!wl.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">Watchlist is empty. <a href="#/new" data-nav="new" style="color:var(--accent)">Break down a call</a> and save it here — the quarter-over-quarter story builds itself.</p></div>';
    return;
  }
  list.innerHTML = wl.map(e => {
    const latest = e.quarters[0] || {};
    const dir = guidanceDir(latest);
    const traj = e.quarters.slice(0, 6).reverse().map(q => trajArrow(guidanceDir(q))).join('');
    const firstBull = (latest.synth && latest.synth.bull && latest.synth.bull[0] && latest.synth.bull[0].point) || '';
    return `
    <div class="ticker-row" data-ticker="${esc(e.ticker)}" role="button" tabindex="0" aria-label="Open ${esc(e.ticker)} history">
      <div class="tk">${esc(e.ticker)}</div>
      <div class="info"><strong>${e.quarters.length} quarter${e.quarters.length === 1 ? '' : 's'} · latest ${esc(latest.quarter || '—')}</strong>
        <small>${esc(firstBull).slice(0, 90)}${firstBull.length > 90 ? '…' : ''}</small></div>
      <div class="traj" title="Guidance trajectory (oldest → latest)">${traj}</div>
      <div class="row-actions no-print">
        <span class="dir ${esc(dir)}" style="font-size:.68rem">${esc(dir.replace('-', ' '))}</span>
        <button data-del-ticker="${esc(e.ticker)}" aria-label="Remove ${esc(e.ticker)}">Remove</button>
      </div>
    </div>`;
  }).join('');
}

function renderTicker(ticker) {
  const box = document.getElementById('ticker-content');
  const entry = loadWatchlist().find(e => e.ticker === ticker);
  if (!entry) { box.innerHTML = '<div class="card"><p>Ticker not on watchlist.</p></div>'; return; }
  const traj = entry.quarters.slice().reverse().map(q =>
    `<span class="dir ${esc(guidanceDir(q))}" style="margin-right:6px">${esc(q.quarter)} ${trajArrow(guidanceDir(q))}</span>`).join('');
  box.innerHTML = `
    <h1><span class="ticker">${esc(ticker)}</span></h1>
    <p class="lead" style="margin-bottom:12px">Guidance trajectory (oldest → latest):</p>
    <p style="margin-bottom:8px">${traj}</p>
    <div class="timeline">
      ${entry.quarters.map(q => {
        const sy = q.synth || {};
        const flags = (q.redflags && q.redflags.flags) || [];
        return `
        <div class="tl-item">
          <span class="q">${esc(q.quarter)}</span>
          <span class="dir ${esc(guidanceDir(q))}" style="margin-left:8px;font-size:.68rem">${esc(guidanceDir(q).replace('-', ' '))}</span>
          <div class="card">
            <ol class="exec-summary">${(sy.summary || []).slice(0, 3).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
            <p class="tip" style="margin-top:8px">${flags.length} red flag${flags.length === 1 ? '' : 's'} · tone ${q.tone && q.tone.confidence != null ? q.tone.confidence + '/5 confident' : 'n/a'}${q.tone && q.tone.evasiveness != null ? ', ' + q.tone.evasiveness + '/5 evasive' : ''}</p>
            <p style="margin-top:10px"><button class="btn secondary" data-qid="${esc(q.id)}">View full brief</button></p>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ================= Form & init ================= */
let intelTimer = null;

function init() {
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); go(el.dataset.nav); });
  });

  /* Provider picker */
  document.querySelectorAll('.provider').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.provider').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      el.querySelector('input').checked = true;
      const p = el.dataset.provider;
      document.getElementById('anthropic-note').hidden = p !== 'anthropic';
      const saved = loadKey();
      if (!saved || saved.provider !== p) document.getElementById('model').value = getDefaultModel(p);
      document.getElementById('model-hint').textContent =
        PROVIDERS[p].name + ' default: ' + getDefaultModel(p) + ' (' + PROVIDERS[p].costHint + '). You can type any model name.';
    });
  });

  document.getElementById('test-key-btn').addEventListener('click', testKey);
  document.getElementById('save-key-btn').addEventListener('click', () => {
    const errEl = document.getElementById('key-error'), okEl = document.getElementById('key-success');
    errEl.textContent = ''; okEl.textContent = '';
    const provider = document.querySelector('input[name="provider"]:checked').value;
    const key = document.getElementById('api-key').value.trim();
    if (!key) { errEl.textContent = 'Paste a key first.'; return; }
    saveKey({ provider, key, model: document.getElementById('model').value.trim() || getDefaultModel(provider) });
    okEl.textContent = 'Key saved in this browser only.';
  });
  document.getElementById('clear-key-btn').addEventListener('click', () => {
    clearKey();
    document.getElementById('api-key').value = '';
    document.getElementById('key-success').textContent = 'Key removed.';
    syncSetupUI();
  });

  /* Live transcript intel */
  const transcriptEl = document.getElementById('f-transcript');
  const updateIntel = () => {
    const text = transcriptEl.value;
    const intel = analyzeTranscript(text);
    document.getElementById('transcript-count').textContent = intel.words.toLocaleString() + ' words';
    const saved = loadKey();
    const prov = saved ? saved.provider : 'anthropic';
    const est = estimateCost(intel.words, PROVIDERS[prov].inRate, PROVIDERS[prov].outRate);
    document.getElementById('cost-estimate').textContent = intel.words
      ? 'est. ~$' + est.usd.toFixed(2) + ' on your key (' + est.inTok.toLocaleString() + ' in / ' + est.outTok.toLocaleString() + ' out tokens, 4 passes)'
      : 'est. cost shows after paste';
    renderIntel(intel);
    transcriptEl.dataset.intel = JSON.stringify({ tooLong: intel.tooLong });
  };
  transcriptEl.addEventListener('input', () => {
    clearTimeout(intelTimer);
    intelTimer = setTimeout(updateIntel, 350);
  });

  /* Breakdown submit */
  document.getElementById('breakdown-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('form-error');
    errEl.textContent = '';
    const ticker = document.getElementById('f-ticker').value.trim().toUpperCase();
    const quarter = document.getElementById('f-quarter').value.trim();
    const transcript = transcriptEl.value;
    const intel = analyzeTranscript(transcript);
    const saved = loadKey();
    if (!ticker) { errEl.textContent = 'Enter a ticker.'; return; }
    if (!quarter) { errEl.textContent = 'Enter the quarter (e.g. Q3 2026).'; return; }
    if (intel.words < 200) { errEl.textContent = 'Paste the transcript — at least a few hundred words.'; return; }
    if (intel.tooLong) { errEl.textContent = 'Transcript is very long (over ~95k words) and may exceed the model context window. Trim it and try again.'; return; }
    if (!saved || !saved.key) { errEl.textContent = 'Save an API key first — the AI analysis runs on your key.'; go('setup'); return; }

    const btn = document.getElementById('analyze-btn');
    btn.disabled = true; btn.textContent = 'Reading the call…';
    breakdownRunning = true;
    currentBreakdown = {
      id: uid('q'), ticker, quarter, createdAt: new Date().toISOString(),
      intel: { words: intel.words, minutes: intel.minutes, speakerCount: intel.speakerCount },
      provider: saved.provider, model: saved.model || getDefaultModel(saved.provider),
      extraction: null, tone: null, redflags: null, synth: null,
      usage: { in: 0, out: 0 }, cost: 0, saved: false,
    };
    go('results');
    document.getElementById('results-content').innerHTML = renderProgress();
    try {
      const r = await runBreakdown(saved, ticker, quarter, transcript, markProgress);
      Object.assign(currentBreakdown, {
        extraction: r.extraction, tone: r.tone, redflags: r.redflags, synth: r.synth,
        usage: r.usage, cost: r.cost,
      });
      renderResults(currentBreakdown);
    } catch (err) {
      document.getElementById('results-content').innerHTML =
        `<div class="card"><h3>Breakdown failed</h3><p class="error">${esc(err.message)}</p>
         <p class="tip" style="margin-top:8px">Your key was not charged for failed calls (or only for partial usage). Check the key in setup, then try again.</p>
         <p style="margin-top:12px"><button class="btn secondary" data-nav="new">Back to input</button></p></div>`;
      document.querySelector('#results-content [data-nav]').addEventListener('click', ev => { ev.preventDefault(); go('new'); });
    } finally {
      breakdownRunning = false;
      btn.disabled = false; btn.textContent = 'Run breakdown';
    }
  });

  /* Results: save to watchlist (delegated — button is rendered dynamically) */
  document.getElementById('results-content').addEventListener('click', e => {
    if (e.target && e.target.id === 'save-watchlist-btn' && currentBreakdown) {
      const q = {
        id: currentBreakdown.id, quarter: currentBreakdown.quarter, createdAt: currentBreakdown.createdAt,
        intel: currentBreakdown.intel, extraction: currentBreakdown.extraction, tone: currentBreakdown.tone,
        redflags: currentBreakdown.redflags, synth: currentBreakdown.synth,
        usage: currentBreakdown.usage, cost: currentBreakdown.cost,
        provider: currentBreakdown.provider, model: currentBreakdown.model,
      };
      upsertQuarter(currentBreakdown.ticker, q);
      currentBreakdown.saved = true;
      renderResults(currentBreakdown);
    }
  });

  document.getElementById('print-btn').addEventListener('click', () => window.print());

  /* Watchlist interactions */
  document.getElementById('watchlist-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del-ticker]');
    if (del) { e.stopPropagation(); deleteTicker(del.dataset.delTicker); renderWatchlist(); return; }
    const row = e.target.closest('[data-ticker]');
    if (row) go('ticker', row.dataset.ticker);
  });
  document.getElementById('watchlist-list').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const row = e.target.closest('[data-ticker]'); if (row) go('ticker', row.dataset.ticker); }
  });

  /* Ticker timeline: view full brief */
  document.getElementById('ticker-content').addEventListener('click', e => {
    const btn = e.target.closest('[data-qid]');
    if (!btn) return;
    const entry = loadWatchlist().find(x => x.ticker === currentTicker);
    const q = entry && entry.quarters.find(y => y.id === btn.dataset.qid);
    if (q) {
      currentBreakdown = Object.assign({ ticker: currentTicker, saved: true }, q);
      go('results');
      renderResults(currentBreakdown);
    }
  });

  /* Settings */
  document.getElementById('save-models-btn').addEventListener('click', () => {
    const m = {
      openai: document.getElementById('set-model-openai').value.trim() || PROVIDERS.openai.defaultModel,
      xai: document.getElementById('set-model-xai').value.trim() || PROVIDERS.xai.defaultModel,
      anthropic: document.getElementById('set-model-anthropic').value.trim() || PROVIDERS.anthropic.defaultModel,
      gemini: document.getElementById('set-model-gemini').value.trim() || PROVIDERS.gemini.defaultModel,
    };
    saveModels(m);
    document.getElementById('models-success').textContent = 'Defaults saved.';
    setTimeout(() => { document.getElementById('models-success').textContent = ''; }, 2500);
  });
  document.getElementById('export-data-btn').addEventListener('click', () => {
    const errEl = document.getElementById('settings-error'), okEl = document.getElementById('settings-success');
    errEl.textContent = ''; okEl.textContent = '';
    try {
      const data = { exportedAt: new Date().toISOString(), watchlist: loadWatchlist() };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'earningsedge-export.json';
      document.body.appendChild(a); a.click(); a.remove();
      okEl.textContent = 'Exported.';
    } catch (err) { errEl.textContent = 'Export failed: ' + err.message; }
  });
  document.getElementById('delete-data-btn').addEventListener('click', () => {
    const errEl = document.getElementById('settings-error'), okEl = document.getElementById('settings-success');
    errEl.textContent = ''; okEl.textContent = '';
    if (!window.confirm('Delete ALL EarningsEdge local data (watchlist, history, key)? This cannot be undone.')) return;
    try {
      localStorage.removeItem(LS_WL); localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_MODELS);
      currentBreakdown = null;
      okEl.textContent = 'All local data deleted.';
      syncSettings();
    } catch (err) { errEl.textContent = 'Delete failed: ' + err.message; }
  });

  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

/* ================= Node self-tests ================= */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { analyzeTranscript, parseJSON, esc, trajArrow, estimateCost, renderResults };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');

  // Test 1: transcript intel on a realistic sample
  const sample = [
    'Operator: Good afternoon, and welcome to the ACME Corp third quarter 2026 earnings call.',
    'Jane Smith: Thanks. We are raising full-year revenue guidance to 14 to 16 percent growth.',
    'Jane Smith: Gross margin expanded 120 basis points on software mix shift.',
    'Q - John Doe, Goldman Sachs: Can you talk about buybacks this quarter?',
    'Jane Smith: We repurchased 2 million shares. We will update you on capital returns in due course.',
    'Q - Mary Jones, Morgan Stanley: Channel inventory remains elevated — when does that normalize?',
    'Bob Lee: We expect normalization by mid next year, though macro headwinds persist.',
  ].join('\n');
  const intel = analyzeTranscript(sample);
  assert(intel.words > 60 && intel.words < 120, 't1 word count sane, got ' + intel.words);
  assert(intel.speakerCount === 3, 't1 3 speakers (Operator, Jane Smith, Bob Lee), got ' + intel.speakerCount + ': ' + intel.speakers.join('|'));
  assert(intel.hasPrepared === true, 't1 prepared remarks detected');
  assert(intel.hasQA === true, 't1 Q&A detected');
  assert(intel.qaOnly === false, 't1 not Q&A-only');
  assert(intel.hits.guidance >= 1, 't1 guidance hit');
  assert(intel.hits.margin >= 1, 't1 margin hit');
  assert(intel.hits.buyback >= 1, 't1 buyback hit');
  assert(intel.tooShort === true, 't1 short-transcript warning');

  // Test 2: Q&A-only detection
  const qaOnly = 'Q - Analyst: What about margins?\nCEO: Margins were fine.';
  const i2 = analyzeTranscript(qaOnly);
  assert(i2.hasQA === true && i2.hasPrepared === false && i2.qaOnly === true, 't2 Q&A-only detected');

  // Test 3: parseJSON strips fences and leading chatter
  const fenced = 'Here you go:\n```json\n{"a": 1, "b": [2, 3]}\n```';
  assert.deepStrictEqual(parseJSON(fenced), { a: 1, b: [2, 3] }, 't3 fence stripping');
  assert.throws(() => parseJSON('no json here'), /did not return JSON/, 't3 throws on non-JSON');

  // Test 4: esc prevents HTML injection in quotes
  const evil = '<script>alert(1)</script>';
  assert(!esc(evil).includes('<script>'), 't4 quote escaping');
  assert(esc(evil).includes('&lt;script&gt;'), 't4 entities');

  // Test 5: trajectory arrows
  assert(trajArrow('raised').includes('up'), 't5 raised arrow');
  assert(trajArrow('lowered').includes('down'), 't5 lowered arrow');
  assert(trajArrow('maintained').includes('flat'), 't5 maintained arrow');
  assert(trajArrow('not-discussed').includes('na'), 't5 na arrow');

  // Test 6: cost estimate math — 60k words * 1.3 tok/word * 4 passes @ $3/M in + 4.5k out @ $15/M
  const c = estimateCost(60000, 3, 15);
  assert(c.inTok === 312000, 't6 input tokens, got ' + c.inTok);
  const want = 312000 / 1e6 * 3 + 4500 / 1e6 * 15;
  assert(Math.abs(c.usd - want) < 1e-9, 't6 cost math');

  // Test 7: empty transcript
  const i7 = analyzeTranscript('');
  assert(i7.empty === true && i7.words === 0, 't7 empty');

  console.log('All EarningsEdge self-tests passed.');
}
