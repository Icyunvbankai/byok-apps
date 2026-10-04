/* OfferUp Coach MVP — static app. Deterministic math in code; the LLM narrates and coaches only. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'offerup_key';         // {provider, key, model, budget}
const LS_SESSIONS = 'offerup_sessions'; // interview sessions
const LS_REWRITES = 'offerup_rewrites'; // resume rewrites
const LS_OFFERS = 'offerup_offers';     // offer analyses

function lsGet(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } }
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function loadKey() { return lsGet(LS_KEY, null); }
function saveKey(o) { lsSet(LS_KEY, o); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadSessions() { return lsGet(LS_SESSIONS, []); }
function saveSession(s) {
  const all = loadSessions();
  const i = all.findIndex(x => x.id === s.id);
  if (i >= 0) all[i] = s; else all.unshift(s);
  lsSet(LS_SESSIONS, all);
}
function getSession(id) { return loadSessions().find(s => s.id === id); }
function deleteSession(id) { lsSet(LS_SESSIONS, loadSessions().filter(s => s.id !== id)); }
const uid = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'dashboard', 'resume', 'interview-setup', 'interview', 'debrief', 'offer', 'history', 'offboarding', 'pricing'];
let currentSessionId = null;

function showView(name) {
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'history') renderHistory();
  if (name === 'dashboard') renderDashboard();
  if (name === 'setup') syncSetupUI();
  if (name === 'resume' || name === 'interview-setup' || name === 'offer') syncNoKeyNotices();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) {
  if (name === 'debrief' && arg) currentSessionId = arg;
  location.hash = '#/' + name + (arg ? '/' + arg : '');
}
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if (name === 'debrief' && parts[1]) { currentSessionId = parts[1]; renderDebriefFromSaved(parts[1]); }
  showView(name);
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', route);

/* ================= BYOK providers ================= */
const PROVIDERS = {
  openai: {
    name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions',
    keyHeader: k => ({ 'Authorization': 'Bearer ' + k }),
    defaultModel: 'gpt-4o', budgetModel: 'gpt-4o-mini',
    costHint: '~$0.30/mock', budgetHint: '~$0.03/mock',
  },
  xai: {
    name: 'xAI', url: 'https://api.x.ai/v1/chat/completions',
    keyHeader: k => ({ 'Authorization': 'Bearer ' + k }),
    defaultModel: 'grok-3', budgetModel: 'grok-3-mini',
    costHint: '~$0.30/mock', budgetHint: '~$0.03/mock',
  },
  anthropic: {
    name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',
    keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }),
    defaultModel: 'claude-sonnet-4-5', budgetModel: 'claude-haiku-4-5',
    costHint: '~$0.40/mock', budgetHint: '~$0.05/mock', corsNote: true,
  },
  gemini: {
    name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models',
    keyHeader: k => ({}),
    defaultModel: 'gemini-3.5-flash-lite', budgetModel: 'gemini-3.5-flash-lite',
    costHint: '~$0.20/mock', budgetHint: '~$0.03/mock', gemini: true,
  },
};
/* Approximate $/1M tokens [input, output]. Shown as estimates only. */
const MODEL_PRICES = [
  [/gpt-4o-mini/i, 0.15, 0.60], [/gpt-4o/i, 2.50, 10.00],
  [/grok-3-mini/i, 0.30, 0.50], [/grok-3/i, 3.00, 15.00],
  [/haiku/i, 0.80, 4.00], [/sonnet/i, 3.00, 15.00],
];
function modelPrice(model) {
  for (const [re, i, o] of MODEL_PRICES) if (re.test(model || '')) return [i, o];
  return [2.00, 8.00];
}
function effectiveModel() {
  const saved = loadKey();
  if (!saved) return { provider: 'openai', model: PROVIDERS.openai.defaultModel };
  const p = PROVIDERS[saved.provider] ? saved.provider : 'openai';
  const model = (saved.model && saved.model.trim()) || (saved.budget ? PROVIDERS[p].budgetModel : PROVIDERS[p].defaultModel);
  return { provider: p, model };
}
const estCost = (inTok, outTok, model) => {
  const [pi, po] = modelPrice(model);
  return inTok / 1e6 * pi + outTok / 1e6 * po;
};
const fmtCost = c => c < 0.01 ? '<$0.01' : '$' + c.toFixed(2);


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

async function callLLM(provider, key, model, system, user, maxTokens, temperature, history) {
  const p = PROVIDERS[provider];
  if (p.gemini) { const gt = await callGemini(key, model, system, user, maxTokens); return { text: gt, inTok: 0, outTok: 0 }; }
  let res, inTok = 0, outTok = 0;
  if (provider === 'anthropic') {
    const messages = (history || []).concat([{ role: 'user', content: user }]);
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, max_tokens: maxTokens || 700, system, messages }),
    });
  } else {
    const messages = [{ role: 'system', content: system }]
      .concat(history || [])
      .concat([{ role: 'user', content: user }]);
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, messages, max_tokens: maxTokens || 700, temperature: temperature == null ? 0.4 : temperature }),
    });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Provider error ' + res.status + ': ' + t.slice(0, 160));
  }
  const j = await res.json();
  let text = '';
  if (provider === 'anthropic') {
    text = (j.content || []).map(b => b.text || '').join('');
    inTok = (j.usage && j.usage.input_tokens) || 0;
    outTok = (j.usage && j.usage.output_tokens) || 0;
  } else {
    text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    inTok = (j.usage && j.usage.prompt_tokens) || 0;
    outTok = (j.usage && j.usage.completion_tokens) || 0;
  }
  return { text: text || '', inTok, outTok };
}

/* ================= Formatting ================= */
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================= Deterministic engines ================= */
/* The LLM NEVER does math. Every number below comes from code. */

/* --- Resume STAR impact score (0-100), heuristic checks in code --- */
function starScore(bullet) {
  const t = String(bullet || '').trim();
  const checks = [
    { pass: /^(built|led|designed|launched|drove|owned|shipped|grew|reduced|increased|architected|mentored|automated|delivered|spearheaded|cut|improved|migrated|scaled)/i.test(t),
      tip: 'Start with a strong action verb (built, launched, drove…).' },
    { pass: /\d/.test(t),
      tip: 'Add a metric — %, $, users, or time saved. Mark estimates [est.].' },
    { pass: /(resulting in|leading to|which (cut|grew|increased|reduced|improved|saved|drove)|driving|achieving|to (cut|grow|increase|reduce|improve|save))/i.test(t),
      tip: 'Close with the result: what changed because of your work?' },
    { pass: (() => { const n = t.split(/\s+/).filter(Boolean).length; return n >= 12 && n <= 45; })(),
      tip: 'Aim for 12–45 words — one punchy line, not a paragraph.' },
    { pass: !/\b(responsible for|helped with|worked on|assisted|participated in|tasked with|involved in)\b/i.test(t),
      tip: 'Drop passive phrasing like "responsible for" — own the action.' },
  ];
  const passed = checks.filter(c => c.pass).length;
  return { score: Math.round(passed / checks.length * 100), checks };
}

/* --- Interview rubric (0-10 per dimension), heuristic signals in code --- */
function rubricScore(answers) {
  const text = (answers || []).join('\n');
  const words = text.split(/\s+/).filter(Boolean);
  const avgLen = words.length / Math.max(1, answers.length);
  const clamp = v => Math.max(0, Math.min(10, Math.round(v)));

  let comm = 5;
  if (avgLen >= 50 && avgLen <= 220) comm += 3;
  else if (avgLen >= 30) comm += 1;
  else comm -= 2;
  const fillers = (text.match(/\b(um|uh|like|you know|basically|actually|stuff|things kinda|sorta)\b/gi) || []).length;
  comm -= Math.min(3, Math.floor(fillers / 3));

  const nums = (text.match(/(?:\$\d[\d,.]*[kmb]?|\d+\s?(%|percent|\bk\b|\bm\b|million|users|engineers|dollars|x\b))/gi) || []).length;
  let depth = 4 + Math.min(4, nums) + (/(for example|for instance|specifically|in particular)/i.test(text) ? 1 : 0);

  const starHits = ['situation', 'task', 'action', 'result', 'challenge', 'approach', 'outcome', 'impact']
    .filter(w => new RegExp('\\b' + w, 'i').test(text)).length;
  let struct = 4 + Math.min(4, starHits) + (/\n\s*\n/.test(text) ? 1 : 0);

  const seniorHits = (text.match(/\b(led|owned|drove|mentored|strategy|architected|cross-functional|stakeholder|organi[sz]ation|roadmap|hired|scaled|trade-?off|prioritized|revenue|customers)\b/gi) || []).length;
  let seniority = 4 + Math.min(4, Math.floor(seniorHits / 2));

  const scores = { communication: clamp(comm), depth: clamp(depth), structure: clamp(struct), seniority: clamp(seniority) };
  scores.overall = Math.round((scores.communication + scores.depth + scores.structure + scores.seniority) / 4);
  return scores;
}

/* --- Offer comp math (deterministic) --- */
function compMath(o) {
  const num = v => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? n : 0; };
  const base = num(o.base), bonus = num(o.bonus), equity = num(o.equity);
  const vestYears = num(o.vestingYears) || 4, signing = num(o.signing);
  const equityYr = vestYears > 0 ? equity / vestYears : 0;
  const firstYear = base + bonus + equityYr + signing;
  const fourYear = base * 4 + bonus * 4 + equity + signing;
  return { base, bonus, equity, vestYears, signing, equityYr, firstYear, fourYear, monthly: firstYear / 12 };
}

/* --- Conservative JSON extraction of offer numbers from LLM text --- */
function parseOfferJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) && n >= 0 ? n : 0; };
    return {
      base: num(o.base), bonus: num(o.bonus), equity: num(o.equity),
      vestingYears: num(o.vestingYears) || 4, signing: num(o.signing),
    };
  } catch { return null; }
}

/* Node test hook: `node app.js` runs self-tests. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compMath, rubricScore, starScore, parseOfferJson, estCost };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');

  // Comp math: $150k base + $20k bonus + $100k RSU over 4 years = $195k first year
  const c = compMath({ base: 150000, bonus: 20000, equity: 100000, vestingYears: 4, signing: 0 });
  assert.strictEqual(c.firstYear, 195000, 'first-year comp');
  assert.strictEqual(c.fourYear, 780000, 'four-year total');
  assert.strictEqual(c.equityYr, 25000, 'equity per year');
  assert.strictEqual(c.monthly, 16250, 'monthly equivalent');
  const c2 = compMath({ base: 120000, bonus: 0, equity: 0, vestingYears: 4, signing: 15000 });
  assert.strictEqual(c2.firstYear, 135000, 'signing bonus included');

  // Rubric: strong answer outscores weak answer
  const strong = ['For example, in my last role at Acme, I led a cross-functional team of 5 engineers to rebuild our billing pipeline. The situation was that failed payments had grown 12% quarter over quarter, costing us real revenue. My approach was to architect a retry service with idempotency keys, and I prioritized the highest-failure routes first. The result: we cut payment failures by 40% in two months, driving $2M in recovered revenue and lifting our authorization rate from 91% to 96%.'];
  const weak = ['um, I like, worked on stuff with the team. things went pretty well basically.'];
  const rs = rubricScore(strong), rw = rubricScore(weak);
  assert(rs.overall > rw.overall, 'strong beats weak: ' + rs.overall + ' vs ' + rw.overall);
  assert(rs.overall >= 7, 'strong scores well: ' + rs.overall);

  // STAR: strong bullet outscores weak bullet
  const good = 'Led migration of 40 microservices to Kubernetes, cutting deploy time 65% and saving $180k/yr in infra costs.';
  const bad = 'Responsible for helping with backend services and various team tasks.';
  const gs = starScore(good), bs = starScore(bad);
  assert(gs.score > bs.score, 'good bullet beats bad: ' + gs.score + ' vs ' + bs.score);
  assert(gs.score >= 80, 'good bullet scores high: ' + gs.score);

  // Offer JSON parse
  const pj = parseOfferJson('Here you go: {"base": 150000, "bonus": 20000, "equity": 100000, "vestingYears": 4, "signing": 10000} done');
  assert(pj && pj.base === 150000 && pj.signing === 10000, 'offer JSON parsed');

  // Cost estimate sanity
  const cost = estCost(30000, 5000, 'gpt-4o');
  assert(cost > 0.05 && cost < 0.5, 'mock cost in range: ' + cost);

  console.log('All OfferUp Coach self-tests passed.');
}

/* ================= Interview tracks ================= */
const TRACKS = {
  swe: { label: 'Software Engineer', context: 'a top-tier tech company' },
  pm: { label: 'Product Manager', context: 'a top-tier tech company' },
  fin: { label: 'Finance Analyst', context: 'a bulge-bracket bank' },
};
const LEVELS = { junior: 'junior/intern', mid: 'mid-level', senior: 'senior' };

function interviewerSystem(role, level, count, company) {
  const t = TRACKS[role] || TRACKS.swe;
  return 'You are a senior hiring manager at ' + (company ? company + ', ' : '') + t.context +
    ' running a behavioral interview for a ' + LEVELS[level] + ' ' + t.label + ' role.\n' +
    'Rules:\n' +
    '- Ask EXACTLY ' + count + ' main questions, ONE per turn. Number them (Q1, Q2…).\n' +
    '- After each candidate answer: if the answer is vague, generic, or under 40 words, ask ONE sharp probing follow-up before moving on. Follow-ups do not count toward the ' + count + '.\n' +
    '- Calibrate difficulty to ' + LEVELS[level] + ' level. Push seniors on trade-offs, org impact, and conflict.\n' +
    '- Never break character. Never give feedback or scores during the interview.\n' +
    '- After the candidate answers your final (' + ordinal(count) + ') main question, end your response with INTERVIEW_COMPLETE on its own line.';
}
function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'; }

/* ================= Setup view ================= */
function syncSetupUI() {
  const saved = loadKey();
  const provider = (saved && saved.provider) || 'openai';
  document.querySelectorAll('.provider').forEach(el => {
    const sel = el.dataset.provider === provider;
    el.classList.toggle('selected', sel);
    el.querySelector('input').checked = sel;
  });
  const budget = !!(saved && saved.budget);
  document.getElementById('budget-mode').checked = budget;
  document.getElementById('anthropic-note').hidden = provider !== 'anthropic';
  if (saved) {
    document.getElementById('api-key').value = saved.key || '';
    document.getElementById('model').value = saved.model || '';
  }
  syncModelHint();
}
function syncModelHint() {
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const budget = document.getElementById('budget-mode').checked;
  const p = PROVIDERS[provider];
  const model = document.getElementById('model').value.trim() || (budget ? p.budgetModel : p.defaultModel);
  document.getElementById('model-hint').textContent =
    p.name + ' default: ' + (budget ? p.budgetModel + ' (budget mode, ' + p.budgetHint + ')' : p.defaultModel + ' (' + p.costHint + ')') +
    '. Effective model: ' + model + '. You can type any model name.';
}
function syncNoKeyNotices() {
  const has = !!loadKey();
  ['resume-no-key', 'iset-no-key', 'offer-no-key'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = has;
  });
}
async function testKey() {
  const errEl = document.getElementById('key-error'), okEl = document.getElementById('key-success');
  errEl.textContent = ''; okEl.textContent = '';
  const { provider, model } = effectiveModelFromForm();
  const key = document.getElementById('api-key').value.trim();
  if (!key) { errEl.textContent = 'Paste a key first.'; return; }
  const btn = document.getElementById('test-key-btn');
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    await callLLM(provider, key, model, 'Reply with exactly: ok', 'Reply with exactly: ok', 10, 0);
    okEl.textContent = PROVIDERS[provider].name + ' key works (' + model + ').';
  } catch (e) {
    errEl.textContent = 'Key test failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = false; btn.textContent = 'Test key'; }
}
function effectiveModelFromForm() {
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const budget = document.getElementById('budget-mode').checked;
  const typed = document.getElementById('model').value.trim();
  return { provider, model: typed || (budget ? PROVIDERS[provider].budgetModel : PROVIDERS[provider].defaultModel), budget };
}

/* ================= Dashboard ================= */
function readinessScore() {
  const done = loadSessions().filter(s => s.status === 'done');
  if (!done.length) return null;
  const last5 = done.slice(0, 5);
  return Math.round(last5.reduce((a, s) => a + s.scores.overall, 0) / last5.length);
}
function renderDashboard() {
  const sessions = loadSessions().filter(s => s.status === 'done');
  const r = readinessScore();
  const best = sessions.length ? Math.max(...sessions.map(s => s.scores.overall)) : null;
  document.getElementById('dash-metrics').innerHTML = [
    ['Readiness', r == null ? '—' : r + '<span style="font-size:1rem">/10</span>', r == null ? '' : (r >= 7 ? 'good' : r >= 5 ? 'warnv' : 'bad')],
    ['Sessions', sessions.length, ''],
    ['Avg score', sessions.length ? (sessions.reduce((a, s) => a + s.scores.overall, 0) / sessions.length).toFixed(1) : '—', ''],
    ['Best', best == null ? '—' : best + '<span style="font-size:1rem">/10</span>', best == null ? '' : 'good'],
  ].map(([l, v, c]) => `<div class="metric"><div class="v ${c}">${v}</div><div class="l">${l}</div></div>`).join('');
  const box = document.getElementById('dash-recent');
  if (!sessions.length) {
    box.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No sessions yet. Run your first mock — your future self says thanks.</p></div>';
    return;
  }
  box.innerHTML = sessions.slice(0, 3).map(s => `
    <div class="history-row" data-open="${s.id}" role="button" tabindex="0">
      <div class="score-badge ${s.scores.overall >= 7 ? 'good' : s.scores.overall >= 5 ? 'mid' : 'bad'}">${s.scores.overall}</div>
      <div class="info"><strong>${esc(TRACKS[s.role].label)} · ${esc(s.level)}</strong>
        <small>${new Date(s.createdAt).toLocaleDateString()} · ${s.qCount} questions · ${esc(fmtCost(s.cost || 0))}</small></div>
    </div>`).join('');
  box.querySelectorAll('[data-open]').forEach(el =>
    el.addEventListener('click', () => go('debrief', el.dataset.open)));
}

/* ================= Resume studio ================= */
function buildRewritePrompt(bullet, context) {
  return {
    system: 'You are a resume coach for tech and finance roles. Rewrite the bullet in STAR format: start with a strong action verb, include a metric (or mark an estimate [est.]), end with the result. ' +
      'Never invent employers, titles, or dates. Reply with ONLY the rewrite on line 1, then "ALT1: ..." on line 2 and "ALT2: ..." on line 3. Keep each under 40 words.',
    user: 'Bullet: ' + bullet + (context ? '\nRole context: ' + context : ''),
  };
}
async function runRewrite() {
  const errEl = document.getElementById('resume-error');
  const box = document.getElementById('resume-results');
  errEl.textContent = ''; box.innerHTML = '';
  const bullet = document.getElementById('resume-bullet').value.trim();
  if (!bullet) { errEl.textContent = 'Paste a bullet first.'; return; }
  const saved = loadKey();
  if (!saved || !saved.key) { errEl.textContent = 'Save an API key first (Setup tab).'; return; }
  const { provider, model } = effectiveModel();
  const btn = document.getElementById('rewrite-btn');
  btn.disabled = true; btn.textContent = 'Rewriting…';
  box.innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div>';
  try {
    const { system, user } = buildRewritePrompt(bullet, document.getElementById('resume-context').value.trim());
    const { text, inTok, outTok } = await callLLM(provider, saved.key, model, system, user, 400, 0.5);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const main = lines[0] || text.trim();
    const alts = lines.slice(1, 3).map(l => l.replace(/^ALT\d:\s*/i, ''));
    const before = starScore(bullet), after = starScore(main);
    const cost = estCost(inTok, outTok, model);
    const rewrites = lsGet(LS_REWRITES, []);
    rewrites.unshift({ id: uid('rw'), createdAt: new Date().toISOString(), before: before.score, after: after.score, bullet, rewrite: main });
    lsSet(LS_REWRITES, rewrites.slice(0, 50));
    box.innerHTML = `
      <div class="card">
        <h3>Rewrite <span style="color:var(--muted-fg);font-weight:400">· impact ${before.score} → <b style="color:var(--green)">${after.score}</b></span></h3>
        <p style="font-size:1.05rem;font-weight:600">"${esc(main)}"</p>
        ${alts.map(a => `<p style="color:var(--muted-fg);font-size:.92rem">Alt: "${esc(a)}"</p>`).join('')}
      </div>
      <div class="card">
        <h3>Impact check <span style="color:var(--muted-fg);font-weight:400">(computed in code)</span></h3>
        ${after.checks.map(c => `<div class="check-item"><span class="mark ${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓' : '!'}</span><span>${c.pass ? 'Passed' : esc(c.tip)}</span></div>`).join('')}
        <p class="tip">Session cost ≈ ${esc(fmtCost(cost))} on your key.</p>
      </div>`;
  } catch (e) {
    errEl.textContent = 'Rewrite failed: ' + e.message;
    box.innerHTML = '';
  } finally { btn.disabled = false; btn.textContent = 'Rewrite it'; }
}

/* ================= Mock interview ================= */
let iv = null; // active interview state

function startInterview() {
  const errEl = document.getElementById('iset-error');
  errEl.textContent = '';
  const saved = loadKey();
  if (!saved || !saved.key) { errEl.textContent = 'Save an API key first (Setup tab).'; return; }
  const role = document.getElementById('iset-role').value;
  const level = document.getElementById('iset-level').value;
  const count = parseInt(document.getElementById('iset-count').value, 10) || 5;
  const company = document.getElementById('iset-company').value.trim();
  const { provider, model } = effectiveModel();
  iv = {
    id: uid('iv'), role, level, count, company, provider, model,
    key: saved.key, messages: [], userAnswers: [],
    inTok: 0, outTok: 0, startTime: Date.now(), status: 'live',
    createdAt: new Date().toISOString(), qCount: count,
  };
  document.getElementById('interview-title').textContent =
    TRACKS[role].label + ' · ' + level + ' · behavioral';
  document.getElementById('chat-log').innerHTML = '';
  document.getElementById('interview-error').textContent = '';
  updateInterviewMeta();
  go('interview');
  startTimer();
  pushBubble('ai', 'Setting up your interviewer…', true);
  askNext('');
}

function ivHistory() {
  return iv.messages.filter(m => !m.typing).map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text }));
}
function pushBubble(role, text, typing) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'bubble ' + role + (typing ? ' typing' : '');
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  iv.messages.push({ role, text, typing: !!typing });
  return div;
}
function updateInterviewMeta() {
  const answered = iv.userAnswers.length;
  document.getElementById('interview-qcount').textContent = 'Q ' + Math.min(answered + 1, iv.qCount) + '/' + iv.qCount;
  document.getElementById('interview-cost').textContent = '≈ ' + fmtCost(estCost(iv.inTok, iv.outTok, iv.model));
}
let timerInt = null;
function startTimer() {
  clearInterval(timerInt);
  timerInt = setInterval(() => {
    if (!iv) { clearInterval(timerInt); return; }
    const s = Math.floor((Date.now() - iv.startTime) / 1000);
    const el = document.getElementById('interview-timer');
    if (el) el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}

async function askNext(userText) {
  const errEl = document.getElementById('interview-error');
  errEl.textContent = '';
  const sendBtn = document.getElementById('chat-send');
  sendBtn.disabled = true;
  const typing = pushBubble('ai', '…', true);
  try {
    const system = interviewerSystem(iv.role, iv.level, iv.qCount, iv.company);
    const { text, inTok, outTok } = await callLLM(iv.provider, iv.key, iv.model, system, userText, 350, 0.7, ivHistory());
    iv.inTok += inTok; iv.outTok += outTok;
    typing.remove();
    iv.messages = iv.messages.filter(m => !m.typing);
    let clean = text.trim();
    const done = /INTERVIEW_COMPLETE/i.test(clean);
    clean = clean.replace(/INTERVIEW_COMPLETE.*/i, '').trim();
    if (clean) pushBubble('ai', clean);
    updateInterviewMeta();
    if (done || iv.userAnswers.length >= iv.qCount + 3) { finishInterview(); return; }
  } catch (e) {
    typing.remove();
    iv.messages = iv.messages.filter(m => !m.typing);
    errEl.textContent = 'Interviewer error: ' + e.message + ' — your answers so far are kept; hit Wrap up for a partial debrief.';
  } finally { sendBtn.disabled = false; }
}

async function sendAnswer(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !iv || iv.status !== 'live') return;
  input.value = '';
  pushBubble('user', text);
  iv.userAnswers.push(text);
  updateInterviewMeta();
  await askNext(text);
}

async function sendHint() {
  if (!iv || iv.status !== 'live') return;
  const errEl = document.getElementById('interview-error');
  try {
    const { text, inTok, outTok } = await callLLM(iv.provider, iv.key, iv.model,
      'You are a helpful interview coach. Give 1-2 sentences of tactical hint for answering the last interview question well. Do not write the full answer.',
      'The interview so far:\n' + iv.messages.filter(m => !m.typing).map(m => (m.role === 'ai' ? 'Q: ' : 'A: ') + m.text).join('\n').slice(-1500),
      150, 0.5);
    iv.inTok += inTok; iv.outTok += outTok;
    pushBubble('ai', '💡 Hint: ' + text.trim());
    updateInterviewMeta();
  } catch (e) { errEl.textContent = 'Hint failed: ' + e.message; }
}

function finishInterview() {
  if (!iv || iv.status !== 'live') return;
  iv.status = 'done';
  clearInterval(timerInt);
  iv.scores = rubricScore(iv.userAnswers);
  iv.cost = estCost(iv.inTok, iv.outTok, iv.model);
  iv.feedback = null;
  saveSession(iv);
  const id = iv.id;
  iv = null;
  go('debrief', id);
  runDebriefFeedback(id);
}

async function runDebriefFeedback(id) {
  const s = getSession(id);
  if (!s || s.feedback) { if (s && s.feedback) renderDebrief(s); return; }
  renderDebrief(s, true); // render scores immediately, feedback streams in
  try {
    const transcript = s.messages.filter(m => !m.typing)
      .map(m => (m.role === 'ai' ? 'Interviewer: ' : 'Candidate: ') + m.text).join('\n');
    const { text, inTok, outTok } = await callLLM(s.provider, s.key, s.model,
      'You are an expert interview coach. You are given a transcript and CODE-COMPUTED rubric scores — trust the scores, do not restate or recompute them. ' +
      'Write: (1) "Strongest moments" — 3, each quoting the candidate briefly; (2) "Fixes" — 3, each with a concrete example rewritten answer (2-4 sentences). ' +
      'Be direct and specific. Under 400 words total.',
      'Rubric (0-10, computed): communication ' + s.scores.communication + ', depth ' + s.scores.depth +
      ', structure ' + s.scores.structure + ', seniority signal ' + s.scores.seniority + '.\n\nTranscript:\n' + transcript.slice(-6000),
      900, 0.5);
    s.inTok = (s.inTok || 0) + inTok; s.outTok = (s.outTok || 0) + outTok;
    s.cost = estCost(s.inTok, s.outTok, s.model);
    s.feedback = text.trim();
    saveSession(s);
    if (currentSessionId === id) renderDebrief(s);
  } catch (e) {
    s.feedback = 'Coach notes unavailable: ' + e.message + '. Your rubric scores above are complete without it.';
    saveSession(s);
    if (currentSessionId === id) renderDebrief(s);
  }
}

function renderDebrief(s, loadingFeedback) {
  const box = document.getElementById('debrief-content');
  if (!s) { box.innerHTML = '<div class="card"><p>Session not found.</p></div>'; return; }
  const dims = [['Communication', 'communication'], ['Depth', 'depth'], ['Structure', 'structure'], ['Seniority signal', 'seniority']];
  const cls = v => v >= 7 ? 'good' : v >= 5 ? 'mid' : 'bad';
  box.innerHTML = `
    <h1>Debrief <span style="color:var(--muted-fg);font-weight:400;font-size:1rem">· ${esc(TRACKS[s.role].label)} · ${esc(s.level)}</span></h1>
    <div class="card">
      <div class="score-wrap">
        <div class="score-dial" role="img" aria-label="Overall score ${s.scores.overall} out of 10">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="54" fill="none" stroke="#1C2338" stroke-width="12"/>
            <circle cx="70" cy="70" r="54" fill="none" stroke="${s.scores.overall >= 7 ? '#34D399' : s.scores.overall >= 5 ? '#F5B942' : '#EF4444'}"
              stroke-width="12" stroke-linecap="round" stroke-dasharray="${(2 * Math.PI * 54).toFixed(1)}"
              stroke-dashoffset="${(2 * Math.PI * 54 * (1 - s.scores.overall / 10)).toFixed(1)}"/>
          </svg>
          <div class="num"><b>${s.scores.overall}<span style="font-size:1rem">/10</span></b><span>overall</span></div>
        </div>
        <div style="flex:1;min-width:220px">
          ${dims.map(([label, k]) => `
            <div class="rubric-row"><div class="top"><span>${label}</span><span>${s.scores[k]}/10</span></div>
            <div class="bar"><i class="${cls(s.scores[k])}" style="width:${s.scores[k] * 10}%"></i></div></div>`).join('')}
        </div>
      </div>
      <div class="formula">Scores computed in code from answer signals (length, metrics, STAR markers, seniority language) — the AI coaches, it doesn't grade.</div>
    </div>
    <h2>Coach notes</h2>
    <div class="card" id="debrief-feedback-card">
      ${(loadingFeedback || !s.feedback)
        ? '<div aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div><p style="color:var(--muted-fg);font-size:.9rem">Writing your personalized feedback…</p></div>'
        : '<div class="llm-body">' + esc(s.feedback) + '</div>'}
    </div>
    <div class="card no-print">
      <p class="tip" style="margin:0">This session ≈ <strong>${esc(fmtCost(s.cost || 0))}</strong> on your key · ${s.userAnswers.length} answers · ${new Date(s.createdAt).toLocaleString()}</p>
    </div>`;
}
function renderDebriefFromSaved(id) {
  const s = getSession(id);
  if (s && !s.feedback && s.status === 'done') runDebriefFeedback(id);
  else renderDebrief(s);
}

/* ================= Offer analyzer ================= */
function buildExtractPrompt(letter) {
  return {
    system: 'Extract compensation numbers from the offer letter. Reply with ONLY a JSON object on one line: {"base": <annual base salary number>, "bonus": <annual bonus number>, "equity": <total equity grant value number>, "vestingYears": <number>, "signing": <signing bonus number>}. Use 0 for anything not stated. No other text.',
    user: letter.slice(0, 4000),
  };
}
async function extractOffer() {
  const errEl = document.getElementById('offer-error');
  errEl.textContent = '';
  const letter = document.getElementById('offer-paste').value.trim();
  if (!letter) { errEl.textContent = 'Paste the letter first.'; return; }
  const saved = loadKey();
  if (!saved || !saved.key) { errEl.textContent = 'Save an API key first (Setup tab).'; return; }
  const { provider, model } = effectiveModel();
  const btn = document.getElementById('offer-extract-btn');
  btn.disabled = true; btn.textContent = 'Extracting…';
  try {
    const { system, user } = buildExtractPrompt(letter);
    const { text } = await callLLM(provider, saved.key, model, system, user, 300, 0.1);
    const o = parseOfferJson(text);
    if (!o) throw new Error('could not parse numbers — enter them manually below');
    document.getElementById('of-base').value = o.base || '';
    document.getElementById('of-bonus').value = o.bonus || '';
    document.getElementById('of-equity').value = o.equity || '';
    document.getElementById('of-vestyears').value = o.vestingYears || 4;
    document.getElementById('of-signing').value = o.signing || '';
    errEl.textContent = '';
    document.getElementById('offer-error').className = 'success';
    document.getElementById('offer-error').textContent = 'Numbers extracted — verify them below, then Analyze.';
    setTimeout(() => { const e2 = document.getElementById('offer-error'); e2.textContent = ''; e2.className = 'error'; }, 4000);
  } catch (e) {
    errEl.textContent = 'Extraction failed: ' + e.message;
  } finally { btn.disabled = false; btn.textContent = 'Extract numbers from letter'; }
}
function readOfferForm() {
  return {
    base: document.getElementById('of-base').value,
    bonus: document.getElementById('of-bonus').value,
    equity: document.getElementById('of-equity').value,
    vestingYears: document.getElementById('of-vestyears').value || 4,
    signing: document.getElementById('of-signing').value,
    stance: document.getElementById('of-stance').value,
  };
}
async function analyzeOffer() {
  const errEl = document.getElementById('offer-error');
  const box = document.getElementById('offer-results');
  errEl.textContent = ''; box.innerHTML = '';
  const form = readOfferForm();
  if (!form.base || +form.base <= 0) { errEl.textContent = 'Enter at least a base salary.'; return; }
  const m = compMath(form);
  const saved = loadKey();
  const id = uid('of');
  const rec = { id, createdAt: new Date().toISOString(), inputs: form, math: m, stance: form.stance, script: null };
  const offers = lsGet(LS_OFFERS, []);
  offers.unshift(rec); lsSet(LS_OFFERS, offers.slice(0, 50));

  box.innerHTML = `
    <div class="card">
      <h3>Total comp <span style="color:var(--muted-fg);font-weight:400">(computed in code)</span></h3>
      <table class="breakdown">
        <tr><th>Component</th><th>Annual</th></tr>
        <tr><td>Base salary</td><td>${fmt$(m.base)}</td></tr>
        <tr><td>Annual bonus</td><td class="pos">+${fmt$(m.bonus)}</td></tr>
        <tr><td>Equity (${fmt$(m.equity)} / ${m.vestYears} yrs)</td><td class="pos">+${fmt$(m.equityYr)}</td></tr>
        <tr><td>Signing bonus</td><td class="pos">+${fmt$(m.signing)}</td></tr>
        <tr class="total"><td>First-year total</td><td>${fmt$(m.firstYear)}</td></tr>
        <tr><td>4-year total</td><td>${fmt$(m.fourYear)}</td></tr>
        <tr><td>Monthly equivalent</td><td>${fmt$(m.monthly)}</td></tr>
      </table>
    </div>
    <h2>Negotiation playbook</h2>
    <div class="card" id="offer-script-card">
      ${saved && saved.key
        ? '<div aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><p style="color:var(--muted-fg);font-size:.9rem">Drafting your negotiation script…</p></div>'
        : '<p style="color:var(--muted-fg)">Save an API key to generate the negotiation script and counter-email. The comp table above is complete without it.</p>'}
    </div>`;
  if (saved && saved.key) runOfferScript(rec);
}
async function runOfferScript(rec) {
  const { provider, model } = effectiveModel();
  const saved = loadKey();
  const m = rec.math;
  try {
    const { text, inTok, outTok } = await callLLM(provider, saved.key, model,
      'You are an expert salary negotiation coach. Use ONLY the verified comp numbers below — do not recompute or invent figures. ' +
      'Write in a ' + rec.stance + ' tone. Output two sections: (1) "Talking points" — 4-6 bullets for the call, each tied to a specific number; ' +
      '(2) "Counter email" — a complete, sendable email draft with [brackets] where they personalize. Under 450 words total.',
      'VERIFIED COMP (computed in code — trust these): first-year total ' + fmt$(m.firstYear) + ', base ' + fmt$(m.base) +
      ', bonus ' + fmt$(m.bonus) + ', equity ' + fmt$(m.equity) + ' over ' + m.vestYears + ' years (' + fmt$(m.equityYr) + '/yr), signing ' + fmt$(m.signing) +
      ', 4-year total ' + fmt$(m.fourYear) + '.',
      800, 0.5);
    rec.script = text.trim();
    rec.cost = estCost(inTok, outTok, model);
    const offers = lsGet(LS_OFFERS, []);
    const i = offers.findIndex(o => o.id === rec.id);
    if (i >= 0) { offers[i] = rec; lsSet(LS_OFFERS, offers); }
    const card = document.getElementById('offer-script-card');
    if (card) card.innerHTML = '<div class="llm-body">' + esc(rec.script) + '</div>' +
      '<p class="tip">Script cost ≈ ' + esc(fmtCost(rec.cost)) + ' on your key.</p>';
  } catch (e) {
    const card = document.getElementById('offer-script-card');
    if (card) card.innerHTML = '<div class="notice warn">Script failed: ' + esc(e.message) + '. The comp table above is complete without it.</div>';
  }
}

/* ================= History ================= */
function renderHistory() {
  const sessions = loadSessions();
  const list = document.getElementById('history-list');
  if (!sessions.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No sessions yet. <a href="#/interview-setup" data-nav="interview-setup" style="color:var(--accent)">Run your first mock</a>.</p></div>';
    return;
  }
  list.innerHTML = sessions.map(s => `
    <div class="history-row" data-open="${s.id}" role="button" tabindex="0" aria-label="Open debrief">
      <div class="score-badge ${s.scores && s.scores.overall >= 7 ? 'good' : s.scores && s.scores.overall >= 5 ? 'mid' : 'bad'}">${s.scores ? s.scores.overall : '–'}</div>
      <div class="info"><strong>${esc(TRACKS[s.role] ? TRACKS[s.role].label : s.role)} · ${esc(s.level || '')}</strong>
        <small>${new Date(s.createdAt).toLocaleString()} · ${s.userAnswers ? s.userAnswers.length : 0} answers${s.cost ? ' · ' + esc(fmtCost(s.cost)) : ''}</small></div>
      <div class="row-actions no-print"><button data-del="${s.id}" aria-label="Delete">Delete</button></div>
    </div>`).join('');
  list.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-del]')) return;
      go('debrief', el.dataset.open);
    });
  });
  list.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); deleteSession(el.dataset.del); renderHistory(); });
  });
}

/* ================= Offboarding ================= */
function submitOffboarding() {
  const data = {
    name: document.getElementById('off-name').value.trim(),
    company: document.getElementById('off-company').value.trim(),
    role: document.getElementById('off-role').value.trim(),
    comp: document.getElementById('off-comp').value.trim(),
    testimonial: document.getElementById('off-testimonial').value.trim(),
    at: new Date().toISOString(),
  };
  lsSet('offerup_win', data);
  const gift = 'OFFERUP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  document.getElementById('offboarding-form-wrap').hidden = true;
  document.getElementById('offboarding-result').innerHTML = `
    <div class="card">
      <h3>Subscription paused. Go celebrate. 🥂</h3>
      <p>Your win is recorded${data.name ? ', ' + esc(data.name) : ''}. Billing pause isn't wired in this MVP — we'll email before anything bills.</p>
      ${data.testimonial ? '<p style="color:var(--muted-fg)"><em>"' + esc(data.testimonial) + '"</em> — thank you. This goes on the wall of wins.</p>' : ''}
      <div class="notice">🎁 Your gift link for a friend (3 free months — activates at launch):<br>
        <strong style="color:var(--fg)">offerup.coach/gift/${gift}</strong></div>
      <p><button class="btn secondary" data-nav="dashboard">Back to dashboard</button></p>
    </div>`;
  document.querySelector('#offboarding-result [data-nav]').addEventListener('click', e => { e.preventDefault(); go('dashboard'); });
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
      if (!saved || saved.provider !== p) document.getElementById('model').value = '';
      syncModelHint();
    });
  });
  document.getElementById('budget-mode').addEventListener('change', syncModelHint);

  document.getElementById('test-key-btn').addEventListener('click', testKey);
  document.getElementById('save-key-btn').addEventListener('click', () => {
    const errEl = document.getElementById('key-error'), okEl = document.getElementById('key-success');
    errEl.textContent = ''; okEl.textContent = '';
    const { provider, model, budget } = effectiveModelFromForm();
    const key = document.getElementById('api-key').value.trim();
    if (!key) { errEl.textContent = 'Paste a key first.'; return; }
    saveKey({ provider, key, model, budget });
    okEl.textContent = 'Key saved in this browser only.';
  });
  document.getElementById('clear-key-btn').addEventListener('click', () => {
    clearKey();
    document.getElementById('api-key').value = '';
    document.getElementById('model').value = '';
    document.getElementById('key-success').textContent = 'Key removed.';
    syncSetupUI();
  });

  document.getElementById('rewrite-btn').addEventListener('click', runRewrite);
  document.getElementById('iset-start').addEventListener('click', startInterview);
  document.getElementById('chat-form').addEventListener('submit', sendAnswer);
  document.getElementById('hint-btn').addEventListener('click', sendHint);
  document.getElementById('wrapup-btn').addEventListener('click', () => { if (iv) finishInterview(); });
  document.getElementById('offer-extract-btn').addEventListener('click', extractOffer);
  document.getElementById('of-analyze-btn').addEventListener('click', analyzeOffer);
  document.getElementById('landed-btn').addEventListener('click', () => go('offboarding'));
  document.getElementById('off-submit').addEventListener('click', submitOffboarding);

  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
