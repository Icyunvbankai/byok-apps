/* RizzLab MVP — static app. Tasteful dating profile optimizer. BYOK: keys stay in localStorage, calls go browser→provider. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'rizzlab_key';         // {provider, key, model}
const LS_USAGE = 'rizzlab_usage';     // {photoRanks, bioRewrites}
const LS_VERSIONS = 'rizzlab_versions'; // array of version objects
const LS_TIPS = 'rizzlab_tips';       // {tipId: true}

const FREE_PHOTO_RANKS = 1;
const FREE_BIO_REWRITES = 1;

function lsGet(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } }
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function loadKey() { return lsGet(LS_KEY, null); }
function saveKey(o) { lsSet(LS_KEY, o); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadUsage() { return Object.assign({ photoRanks: 0, bioRewrites: 0 }, lsGet(LS_USAGE, {})); }
function saveUsage(u) { lsSet(LS_USAGE, u); }
function loadVersions() { return lsGet(LS_VERSIONS, []); }
function saveVersions(v) { lsSet(LS_VERSIONS, v); }

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'photos', 'bio', 'score', 'history', 'pricing', 'settings'];

function showView(name) {
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === name);
  });
  if (name === 'setup') syncSetupUI();
  if (name === 'photos') { syncPhotoNotices(); renderPhotoGrid(); }
  if (name === 'bio') syncBioNotices();
  if (name === 'score') renderScore();
  if (name === 'history') renderHistory();
  if (name === 'pricing') syncPricing();
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

/* ================= Deterministic profile score ================= */
/* All in code. Transparent components, shown in UI. */
const CLICHES = [
  'just ask', 'fluent in sarcasm', 'partner in crime', 'work hard play hard',
  'living life', "livin' life", 'adventure seeker', '6\'2"', '6\'1"', '6\'0"',
  'here for a good time', 'no drama', 'sapiosexual'
];

function findCliches(bio) {
  const low = String(bio || '').toLowerCase();
  return CLICHES.filter(c => low.includes(c));
}
function parseInterests(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

/* input: {bio, prompts[3], interests, photoCount} → {score, parts[]} */
function profileScore(inp) {
  const parts = [];
  const bio = String(inp.bio || '');
  const len = bio.length;

  let bioPts;
  if (!len) bioPts = 0;
  else if (len >= 120 && len <= 280) bioPts = 30;
  else if ((len >= 60 && len < 120) || (len > 280 && len <= 400)) bioPts = 18;
  else bioPts = 8;
  parts.push({ label: 'Bio length', detail: len ? len + ' characters (sweet spot: 120–280)' : 'no bio yet', pts: bioPts, max: 30 });

  const answered = (inp.prompts || []).filter(p => String(p || '').trim().length >= 20).length;
  const promptPts = Math.round(answered / 3 * 25);
  parts.push({ label: 'Prompts answered', detail: answered + ' of 3 with real substance (20+ chars)', pts: promptPts, max: 25 });

  const n = parseInterests(inp.interests).length;
  const intPts = n >= 3 && n <= 6 ? 15 : n >= 7 ? 10 : n >= 1 ? 8 : 0;
  parts.push({ label: 'Interests', detail: n ? n + ' listed (sweet spot: 3–6)' : 'none listed', pts: intPts, max: 15 });

  const pc = inp.photoCount || 0;
  const photoPts = pc >= 4 && pc <= 6 ? 20 : pc >= 7 ? 14 : pc >= 2 ? 12 : pc === 1 ? 6 : 0;
  parts.push({ label: 'Photos', detail: pc ? pc + ' uploaded (sweet spot: 4–6)' : 'none uploaded', pts: photoPts, max: 20 });

  const hits = findCliches(bio);
  const clichePts = Math.max(0, 10 - hits.length * 3);
  parts.push({ label: 'No tired clichés', detail: hits.length ? 'found: ' + hits.join(', ') : 'clean', pts: clichePts, max: 10 });

  const score = Math.max(0, Math.min(100, parts.reduce((a, p) => a + p.pts, 0)));
  const grade = score >= 80 ? 'Date-ready' : score >= 60 ? 'Solid foundation' : score >= 40 ? 'Needs work' : 'Start here';
  return { score, grade, parts };
}

/* Deterministic lineup rules (code, not LLM). Input: ranked photo meta [{is_group, is_mirror_selfie, face_clear}]. */
function lineupWarnings(meta) {
  const warns = [];
  if (!meta.length) return warns;
  if (meta[0].is_group) warns.push('Your #1 photo is a group shot — lead with a clear solo face photo so matches know who they\'re meeting.');
  const mirrors = meta.filter(m => m.is_mirror_selfie).length;
  if (mirrors > 1) warns.push(mirrors + ' mirror selfies in the lineup — keep at most one, and make the rest real-world shots.');
  if (!meta[0].face_clear) warns.push('Your lead photo doesn\'t show a clear face — that\'s the single biggest match-rate lever you have.');
  const groups = meta.filter(m => m.is_group).length;
  if (groups > 2) warns.push(groups + ' group photos — one is plenty. Matches want to see you, not your brunch crew.');
  return warns;
}

function scoreChipClass(s) { return s >= 70 ? 'good' : s >= 45 ? 'mid' : 'bad'; }

/* ================= Formatting ================= */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => p + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { profileScore, findCliches, parseInterests, lineupWarnings };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');

  // Strong profile: 200-char bio, 3 prompts, 4 interests, 5 photos, no clichés
  const s1 = profileScore({
    bio: 'Weekend hiker, weeknight cook. I plan good dates and laugh at my own jokes first. Looking for someone curious and kind who wants a real connection, not a pen pal. Vinyl collector with strong opinions.',
    prompts: ['My simple pleasures are slow Sunday mornings with good coffee and the crossword.', 'I am looking for someone who communicates clearly and likes adventures.', 'Fun fact: I once cooked a five-course meal for twelve people in a tiny kitchen.'],
    interests: 'hiking, tacos, vinyl, climbing',
    photoCount: 5
  });
  assert(s1.score >= 85, 'strong profile scores high, got ' + s1.score);
  assert.strictEqual(s1.parts.reduce((a, p) => a + p.pts, 0), s1.score, 'parts sum to score');

  // Empty profile
  const s2 = profileScore({ bio: '', prompts: ['', '', ''], interests: '', photoCount: 0 });
  assert(s2.score <= 15, 'empty profile scores low, got ' + s2.score);

  // Cliché bio loses points
  const s3 = profileScore({ bio: 'Just ask, I am 6\'2" and fluent in sarcasm. Here for a good time, no drama.', prompts: [], interests: '', photoCount: 0 });
  const clichePart = s3.parts.find(p => p.label === 'No tired clichés');
  assert(clichePart.pts < 10, 'clichés cost points, got ' + clichePart.pts);
  assert(findCliches('Just ask me anything').includes('just ask'), 'cliché detection works');

  // Lineup warnings
  const w1 = lineupWarnings([{ is_group: true, is_mirror_selfie: false, face_clear: false }]);
  assert(w1.length >= 2, 'group-shot lead produces warnings');
  const w2 = lineupWarnings([{ is_group: false, is_mirror_selfie: false, face_clear: true }]);
  assert(w2.length === 0, 'clean lead produces no warnings');

  // Boundary: 7 interests → 10 pts (not 8); 8 photos → 14 pts (not 12)
  const s4 = profileScore({ bio: 'x'.repeat(150), prompts: ['12345678901234567890', '12345678901234567890', '12345678901234567890'], interests: 'a,b,c,d,e,f,g', photoCount: 8 });
  assert.strictEqual(s4.parts.find(p => p.label === 'Interests').pts, 10, '7 interests → 10');
  assert.strictEqual(s4.parts.find(p => p.label === 'Photos').pts, 14, '8 photos → 14');
  assert.strictEqual(s4.parts.find(p => p.label === 'Bio length').pts, 30, '150-char bio → 30');

  console.log('All RizzLab self-tests passed.');
}

/* ================= LLM (BYOK) ================= */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini', costHint: '~$0.01/session', vision: true },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-4-fast',  costHint: '~$0.01/session', vision: true },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', costHint: '~$0.02/session', vision: true, corsNote: true },
  gemini: { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', keyHeader: k => ({}), defaultModel: 'gemini-3.5-flash-lite', costHint: '~$0.02/session', vision: true, gemini: true },
};

const COACH_SYSTEM = 'You are RizzLab\'s dating profile coach — direct, encouraging, never cringe. ' +
  'You give the advice a stylish older brother would give: honest about what is not working, specific about the fix, never mean. ' +
  'HARD RULES: no manipulation tactics (no negging, no manufactured scarcity, no deception about age/job/lifestyle). ' +
  'No sexual or harassing content — ever. ' +
  'When ranking photos, score PRESENTATION quality (lighting, framing, background, clarity) — never the person\'s looks or attractiveness. ' +
  'Bios must be tasteful: confident, specific, honest. No fabricated lifestyle.';

function userContent(text, images) {
  // images: [{dataUrl, mediaType, b64}] — provider-specific assembly happens in callLLM
  return { text, images: images || [] };
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

async function callLLM(provider, key, model, system, content, maxTokens, jsonMode) {
  const p = PROVIDERS[provider];
  if (p.gemini) { const gt = await callGemini(key, model, system, content.text, maxTokens, content.images); return { text: gt, usage: null }; }
  const { text, images } = content;
  let res;
  if (provider === 'anthropic') {
    const blocks = [{ type: 'text', text }];
    images.forEach(im => blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.b64 } }));
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, max_tokens: maxTokens || 900, system, messages: [{ role: 'user', content: blocks }] }),
    });
  } else {
    const parts = [{ type: 'text', text }];
    images.forEach(im => parts.push({ type: 'image_url', image_url: { url: im.dataUrl } }));
    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: parts }], max_tokens: maxTokens || 900, temperature: 0.5 };
    if (jsonMode) body.response_format = { type: 'json_object' };
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify(body),
    });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Provider error ' + res.status + ': ' + t.slice(0, 180));
  }
  const j = await res.json();
  const out = provider === 'anthropic'
    ? (j.content || []).map(b => b.text || '').join('')
    : (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { text: out, usage: j.usage || null };
}

function estimateCost(images, inChars, outChars) {
  const inTok = Math.round(inChars / 4 + images * 1000);
  const outTok = Math.round(outChars / 4);
  return { inTok, outTok, dollars: (inTok * 0.15 / 1e6 + outTok * 0.6 / 1e6) };
}

function parseJSONLoose(text) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  const aStart = clean.indexOf('['), aEnd = clean.lastIndexOf(']');
  let candidate = clean;
  if (start >= 0 && end > start) candidate = clean.slice(start, end + 1);
  else if (aStart >= 0 && aEnd > aStart) candidate = clean.slice(aStart, aEnd + 1);
  return JSON.parse(candidate);
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
    await callLLM(provider, key, model, 'Reply with exactly: ok', userContent('Reply with exactly: ok'), 10);
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per session: ' + PROVIDERS[provider].costHint + '.';
  } catch (e) {
    errEl.textContent = 'Key test failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = false; btn.textContent = 'Test key'; }
}

/* ================= Setup view ================= */
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

/* ================= Free tier ================= */
function freeLeft(kind) {
  const u = loadUsage();
  if (kind === 'photo') return Math.max(0, FREE_PHOTO_RANKS - u.photoRanks);
  return Math.max(0, FREE_BIO_REWRITES - u.bioRewrites);
}
function bumpUsage(kind) {
  const u = loadUsage();
  if (kind === 'photo') u.photoRanks++;
  else u.bioRewrites++;
  saveUsage(u);
}
function syncPhotoNotices() {
  document.getElementById('photos-no-key').hidden = !!loadKey();
  const left = freeLeft('photo');
  const note = document.getElementById('photos-free-note');
  if (left > 0) { note.hidden = false; note.textContent = 'Free tier: ' + left + ' photo ranking left. Unlimited on a paid plan.'; }
  else { note.hidden = false; note.textContent = 'Free photo ranking used up — upgrade for unlimited rankings (checkout arrives with launch).'; }
  document.getElementById('rank-cost').textContent = '≈ $0.01–0.03 of your API credit per run';
}
function syncBioNotices() {
  document.getElementById('bio-no-key').hidden = !!loadKey();
  const left = freeLeft('bio');
  const note = document.getElementById('bio-free-note');
  if (left > 0) { note.hidden = false; note.textContent = 'Free tier: ' + left + ' bio rewrite left. Unlimited on a paid plan.'; }
  else { note.hidden = false; note.textContent = 'Free bio rewrite used up — upgrade for unlimited rewrites (checkout arrives with launch).'; }
}
function syncPricing() {
  const u = loadUsage();
  document.getElementById('usage-summary').textContent =
    'used ' + u.photoRanks + '/' + FREE_PHOTO_RANKS + ' free photo ranking, ' + u.bioRewrites + '/' + FREE_BIO_REWRITES + ' free bio rewrite.';
}

/* ================= Photos ================= */
let photos = []; // {name, dataUrl, mediaType, b64}

const PHOTO_TIPS = [
  { id: 'light', t: 'Face the light', d: 'Stand 3 feet from a window, facing it. Backlit photos hide your face.' },
  { id: 'first', t: 'Lead with a clear solo face shot', d: 'No sunglasses, no group, no hat shadow. This is your first impression.' },
  { id: 'smile', t: 'Genuine smile beats posed', d: 'Think of something funny right before the shutter — forced smiles read instantly.' },
  { id: 'bg', t: 'Clean up the background', d: 'Tidy room, plain wall, or nature. Clutter competes with you.' },
  { id: 'variety', t: 'Show range: 1 face, 1 full-body, 1 doing something', d: 'Hobby or travel shots give matches something to ask about.' },
  { id: 'mirror', t: 'Max one mirror selfie', d: 'Prop the phone and use the back camera + timer instead — it looks 10x better.' },
  { id: 'group', t: 'Max one group photo, never first', d: 'And make it obvious which one is you.' },
  { id: 'recent', t: 'All photos from the last 2 years', d: 'Looking like your photos on the date is the whole game.' },
];

function renderPhotoTips() {
  const done = lsGet(LS_TIPS, {});
  document.getElementById('photo-tips').innerHTML = '<ul class="tips-list">' + PHOTO_TIPS.map(t =>
    `<li><input type="checkbox" data-tip="${t.id}" ${done[t.id] ? 'checked' : ''} aria-label="${esc(t.t)}"><div><strong>${esc(t.t)}</strong><small>${esc(t.d)}</small></div></li>`
  ).join('') + '</ul>';
}

function renderPhotoGrid() {
  const grid = document.getElementById('photo-grid');
  grid.innerHTML = photos.map((p, i) =>
    `<div class="photo-thumb"><img src="${p.dataUrl}" alt="Uploaded photo ${i + 1}"><button class="rm" data-rm="${i}" aria-label="Remove photo ${i + 1}">&times;</button></div>`
  ).join('');
  document.getElementById('rank-btn').disabled = photos.length === 0;
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxDim = 768;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      resolve({ name: file.name, dataUrl, mediaType: 'image/jpeg', b64: dataUrl.split(',')[1] });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read ' + file.name)); };
    img.src = url;
  });
}

function buildRankPrompt(n) {
  return `You are ranking ${n} dating-app profile photos (in upload order, photo 1 … photo ${n}) for presentation quality. ` +
    `Score each 1–10 on: lighting, framing, background clarity, and whether the face is clearly visible with a natural expression. ` +
    `Also flag: is_group (more than one person prominent), is_mirror_selfie, face_clear (face fully visible, no sunglasses/hat shadow). ` +
    `Be honest but kind. Reply with ONLY a JSON array, one object per photo, in this exact shape: ` +
    `[{"index":1,"score":8,"strengths":["warm window light","real smile"],"issues":["slightly tilted framing"],"retake_tip":"Straighten the horizon — prop the phone on a shelf instead of holding it.","is_group":false,"is_mirror_selfie":false,"face_clear":true}] ` +
    `Order the array best photo first (rank order). One concrete retake_tip per photo.`;
}

async function rankPhotos() {
  const errEl = document.getElementById('rank-error');
  errEl.textContent = '';
  const saved = loadKey();
  if (!saved || !saved.key) { errEl.textContent = 'Save an API key first (Setup tab, 30 seconds).'; return; }
  if (freeLeft('photo') <= 0) { errEl.textContent = 'Free photo ranking used up — upgrade for unlimited (checkout arrives with launch).'; return; }
  if (!photos.length) { errEl.textContent = 'Upload at least one photo first.'; return; }

  const btn = document.getElementById('rank-btn');
  btn.disabled = true; btn.textContent = 'Ranking…';
  const box = document.getElementById('rank-results');
  box.innerHTML = '<div class="card" aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><p class="tip">Vision model is scoring your photos on your key…</p></div>';

  try {
    const model = saved.model || PROVIDERS[saved.provider].defaultModel;
    const prompt = buildRankPrompt(photos.length);
    const { text, usage } = await callLLM(saved.provider, saved.key, model, COACH_SYSTEM,
      userContent(prompt, photos), 1200, saved.provider !== 'anthropic');
    let ranked;
    try { ranked = parseJSONLoose(text); }
    catch { throw new Error('The model returned an unparseable response. Try again — occasionally the JSON comes back malformed.'); }
    if (!Array.isArray(ranked) || !ranked.length) throw new Error('Empty ranking returned. Try again.');

    bumpUsage('photo');
    const cost = estimateCost(photos.length, prompt.length, text.length);
    renderRanked(ranked, cost);
    syncPhotoNotices();
  } catch (e) {
    box.innerHTML = '';
    errEl.textContent = 'Ranking failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = photos.length === 0; btn.textContent = 'Rank my photos'; }
}

function renderRanked(ranked, cost) {
  const byIndex = {};
  ranked.forEach(r => { byIndex[r.index] = r; });
  const ordered = photos.map((p, i) => ({ photo: p, r: byIndex[i + 1] || null }));
  const warns = lineupWarnings(ranked.map(r => ({
    is_group: !!r.is_group, is_mirror_selfie: !!r.is_mirror_selfie, face_clear: r.face_clear !== false
  })));

  document.getElementById('rank-results').innerHTML = `
    <h2>Your lineup, ranked</h2>
    ${warns.length ? `<div class="notice warn"><strong>Lineup rules (applied in code):</strong><br>${warns.map(esc).join('<br>')}</div>` : ''}
    ${ordered.map(({ photo, r }, i) => `
      <div class="card"><div class="rank-card">
        <div class="photo-thumb"><img src="${photo.dataUrl}" alt="Ranked photo ${i + 1}"><span class="badge">#${i + 1}</span></div>
        <div class="rank-meta">
          <div class="score-line"><span class="score-chip ${scoreChipClass((r && r.score || 0) * 10)}">${r && r.score != null ? r.score : '–'}</span><strong>/10</strong></div>
          ${r ? `
            ${r.strengths && r.strengths.length ? `<strong>Working:</strong><ul>${r.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
            ${r.issues && r.issues.length ? `<strong>Not working:</strong><ul>${r.issues.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
            ${r.retake_tip ? `<div class="retake"><strong>Retake tip:</strong> ${esc(r.retake_tip)}</div>` : ''}
          ` : '<p class="tip">No critique returned for this photo.</p>'}
        </div>
      </div></div>`).join('')}
    <p class="tip">Session estimate: ~${cost.inTok.toLocaleString()} tokens in / ~${cost.outTok.toLocaleString()} out ≈ $${cost.dollars.toFixed(4)} on your key. Photos never touched our servers.</p>`;
}

/* ================= Bio lab ================= */
let currentTones = null; // {witty:{bio,note}, genuine:{...}, bold:{...}, before}
let activeTone = 'witty';
let chosenTone = null;

function buildBioPrompt(bio, prompts) {
  const ctx = prompts.filter(Boolean).join(' | ');
  return `The user pasted their dating profile bio${ctx ? ' and prompt answers' : ''}. ` +
    `Current bio: """${bio || '(none — working from prompt answers only)'}"""` +
    (ctx ? `\nPrompt answers: """${ctx}"""` : '') +
    `\n\nFirst extract 3–5 real facts/hooks. Then write THREE rewrites from the SAME facts (all three must reference at least 2 of the same facts — no invented lifestyle): ` +
    `WITTY (playful, clever, warm), GENUINE (sincere, specific, calm confidence), BOLD (direct, decisive, plans-a-good-date energy). ` +
    `Each bio: under 280 characters, no emojis overload (max 1), no clichés ("just ask", "fluent in sarcasm", "partner in crime"). ` +
    `Reply with ONLY JSON: {"witty":{"bio":"...","note":"one line on what this signals"},"genuine":{"bio":"...","note":"..."},"bold":{"bio":"...","note":"..."}}`;
}

async function rewriteBio() {
  const errEl = document.getElementById('bio-error');
  errEl.textContent = '';
  const saved = loadKey();
  if (!saved || !saved.key) { errEl.textContent = 'Save an API key first (Setup tab, 30 seconds).'; return; }
  if (freeLeft('bio') <= 0) { errEl.textContent = 'Free bio rewrite used up — upgrade for unlimited (checkout arrives with launch).'; return; }
  const bio = document.getElementById('bio-input').value.trim();
  const prompts = ['prompt-1', 'prompt-2', 'prompt-3'].map(id => document.getElementById(id).value.trim());
  if (!bio && !prompts.some(Boolean)) { errEl.textContent = 'Paste a bio or at least one prompt answer first.'; return; }

  const btn = document.getElementById('rewrite-btn');
  btn.disabled = true; btn.textContent = 'Rewriting…';
  const box = document.getElementById('bio-results');
  box.innerHTML = '<div class="card" aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:75%"></div><p class="tip">Writing three tones on your key…</p></div>';

  try {
    const model = saved.model || PROVIDERS[saved.provider].defaultModel;
    const prompt = buildBioPrompt(bio, prompts);
    const { text } = await callLLM(saved.provider, saved.key, model, COACH_SYSTEM,
      userContent(prompt), 900, saved.provider !== 'anthropic');
    let tones;
    try { tones = parseJSONLoose(text); }
    catch { throw new Error('The model returned an unparseable response. Try again.'); }
    if (!tones.witty || !tones.genuine || !tones.bold) throw new Error('Incomplete rewrite returned. Try again.');

    bumpUsage('bio');
    currentTones = { witty: tones.witty, genuine: tones.genuine, bold: tones.bold, before: bio };
    activeTone = 'witty'; chosenTone = null;
    renderBioResults();
    syncBioNotices();
  } catch (e) {
    box.innerHTML = '';
    errEl.textContent = 'Rewrite failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = false; btn.textContent = 'Rewrite my bio'; }
}

function renderBioResults() {
  const box = document.getElementById('bio-results');
  if (!currentTones) { box.innerHTML = ''; return; }
  const t = currentTones[activeTone];
  const len = (t.bio || '').length;
  box.innerHTML = `
    <h2>Your three tones</h2>
    <div class="card">
      <div class="tone-tabs" role="tablist" aria-label="Bio tones">
        ${['witty', 'genuine', 'bold'].map(k =>
          `<button role="tab" data-tone="${k}" class="${k === activeTone ? 'active' : ''}" aria-selected="${k === activeTone}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
      </div>
      <div class="bio-before"><h4>Before</h4><div class="bio-text">${esc(currentTones.before) || '<span style="color:var(--muted-fg)">(started from prompt answers)</span>'}</div></div>
      <div class="bio-after"><h4>After — ${activeTone}</h4><div class="bio-text">${esc(t.bio)}</div>
        <div class="char-count ${len > 280 ? 'over' : ''}">${len} / 280 characters${len > 280 ? ' — over the limit, trim before using' : ''}</div></div>
      <p class="tone-note">${esc(t.note || '')}</p>
      <p><button class="btn" id="use-tone-btn">Use this bio</button></p>
    </div>`;
  box.querySelectorAll('[data-tone]').forEach(b =>
    b.addEventListener('click', () => { activeTone = b.dataset.tone; renderBioResults(); }));
  document.getElementById('use-tone-btn').addEventListener('click', () => {
    document.getElementById('bio-input').value = currentTones[activeTone].bio || '';
    chosenTone = activeTone;
    document.getElementById('bio-error').textContent = '';
    const ok = document.createElement('p');
    ok.className = 'success'; ok.textContent = 'Bio updated to the ' + activeTone + ' version.';
    box.appendChild(ok);
    setTimeout(() => ok.remove(), 4000);
  });
}

/* ================= Score view ================= */
function currentProfileInput() {
  return {
    bio: document.getElementById('bio-input').value,
    prompts: ['prompt-1', 'prompt-2', 'prompt-3'].map(id => document.getElementById(id).value),
    interests: document.getElementById('interests-input').value,
    photoCount: photos.length
  };
}

function renderScore() {
  const r = profileScore(currentProfileInput());
  const dialC = 2 * Math.PI * 54;
  const dialOff = dialC * (1 - r.score / 100);
  const color = r.score >= 70 ? '#34D399' : r.score >= 45 ? '#F59E0B' : '#EF4444';
  document.getElementById('score-content').innerHTML = `
    <div class="card">
      <div class="score-wrap">
        <div class="score-dial" role="img" aria-label="Profile score ${r.score} out of 100">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="54" fill="none" stroke="#2A1820" stroke-width="12"/>
            <circle cx="70" cy="70" r="54" fill="none" stroke="${color}"
              stroke-width="12" stroke-linecap="round" stroke-dasharray="${dialC.toFixed(1)}" stroke-dashoffset="${dialOff.toFixed(1)}"/>
          </svg>
          <div class="num"><b>${r.score}</b><span>/ 100</span></div>
        </div>
        <div style="flex:1;min-width:220px">
          <h3 style="margin-bottom:4px">${esc(r.grade)}</h3>
          <p style="color:var(--muted-fg);font-size:.92rem">Deterministic — computed from your inputs right now, in this browser. No AI involved.</p>
          <div class="formula">Bio 30 + Prompts 25 + Interests 15 + Photos 20 + No clichés 10 = 100</div>
        </div>
      </div>
      <div class="score-parts">
        ${r.parts.map(p => `
          <div class="score-part">
            <span class="lbl">${esc(p.label)}</span>
            <span class="bar"><i style="width:${Math.round(p.pts / p.max * 100)}%"></i></span>
            <span class="pts">${p.pts}/${p.max}</span>
          </div>
          <p class="tip" style="margin:-2px 0 6px">${esc(p.detail)}</p>`).join('')}
      </div>
    </div>`;
}

/* ================= Versions ================= */
function renderHistory() {
  const list = document.getElementById('history-list');
  const versions = loadVersions();
  if (!versions.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No saved versions yet. Tune your profile, then snapshot it here.</p></div>';
    return;
  }
  list.innerHTML = versions.map(v => `
    <div class="version-row">
      <div class="vhead">
        <div style="display:flex;gap:12px;align-items:center">
          <span class="score-chip ${scoreChipClass(v.score)}">${v.score}</span>
          <div><strong>${esc(v.name)}</strong><small>${new Date(v.createdAt).toLocaleString()}${v.tone ? ' · ' + esc(v.tone) + ' bio' : ''}</small></div>
        </div>
      </div>
      ${v.bio ? `<div class="vbio">“${esc(v.bio)}”</div>` : ''}
      <div class="vmeta">${v.photoCount} photos${v.photoNames && v.photoNames.length ? ' (' + esc(v.photoNames.slice(0, 3).join(', ')) + (v.photoNames.length > 3 ? ', …' : '') + ')' : ''}${v.interests ? ' · ' + esc(v.interests) : ''}</div>
      <div class="row-actions no-print">
        <button data-load="${v.id}">Load bio</button>
        <button data-delv="${v.id}">Delete</button>
      </div>
    </div>`).join('');
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
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

  // Photos
  renderPhotoTips();
  document.getElementById('photo-tips').addEventListener('change', e => {
    const cb = e.target.closest('[data-tip]');
    if (!cb) return;
    const done = lsGet(LS_TIPS, {});
    if (cb.checked) done[cb.dataset.tip] = true; else delete done[cb.dataset.tip];
    lsSet(LS_TIPS, done);
  });
  document.getElementById('photo-input').addEventListener('change', async e => {
    const files = [...e.target.files].slice(0, 12 - photos.length);
    for (const f of files) {
      try { photos.push(await resizeImage(f)); }
      catch (err) { document.getElementById('rank-error').textContent = err.message; }
    }
    if (photos.length >= 12) document.getElementById('rank-error').textContent = '12-photo max reached.';
    e.target.value = '';
    renderPhotoGrid();
  });
  document.getElementById('photo-grid').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    photos.splice(+rm.dataset.rm, 1);
    document.getElementById('rank-error').textContent = '';
    renderPhotoGrid();
  });
  document.getElementById('rank-btn').addEventListener('click', rankPhotos);

  // Bio
  document.getElementById('rewrite-btn').addEventListener('click', rewriteBio);

  // Versions
  document.getElementById('save-version-btn').addEventListener('click', () => {
    const errEl = document.getElementById('version-error'), okEl = document.getElementById('version-success');
    errEl.textContent = ''; okEl.textContent = '';
    const name = document.getElementById('version-name').value.trim();
    if (!name) { errEl.textContent = 'Give this version a name first.'; return; }
    const inp = currentProfileInput();
    const versions = loadVersions();
    versions.unshift({
      id: uid('v'), name, createdAt: new Date().toISOString(),
      bio: inp.bio.trim(), tone: chosenTone,
      prompts: inp.prompts.map(p => p.trim()), interests: inp.interests.trim(),
      photoCount: inp.photoCount, photoNames: photos.map(p => p.name),
      score: profileScore(inp).score
    });
    saveVersions(versions.slice(0, 50));
    document.getElementById('version-name').value = '';
    okEl.textContent = 'Version saved.';
    renderHistory();
  });
  document.getElementById('history-list').addEventListener('click', e => {
    const del = e.target.closest('[data-delv]');
    if (del) { saveVersions(loadVersions().filter(v => v.id !== del.dataset.delv)); renderHistory(); return; }
    const load = e.target.closest('[data-load]');
    if (load) {
      const v = loadVersions().find(x => x.id === load.dataset.load);
      if (v && v.bio) {
        document.getElementById('bio-input').value = v.bio;
        chosenTone = v.tone || null;
        go('bio');
      }
    }
  });

  // Settings
  document.getElementById('export-btn').addEventListener('click', () => {
    download('rizzlab-versions.json', JSON.stringify(loadVersions(), null, 2));
    document.getElementById('settings-success').textContent = 'Versions exported.';
  });
  document.getElementById('delete-data-btn').addEventListener('click', () => {
    if (!confirm('Delete all RizzLab local data — key, versions, usage, checklist?')) return;
    [LS_KEY, LS_USAGE, LS_VERSIONS, LS_TIPS].forEach(k => localStorage.removeItem(k));
    photos = []; currentTones = null; chosenTone = null;
    document.getElementById('settings-success').textContent = 'All local data deleted.';
    renderPhotoGrid(); renderPhotoTips(); renderBioResults();
  });

  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
