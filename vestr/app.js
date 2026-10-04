/* Vestr MVP — static app. Deterministic tax math in code; the LLM narrates only.
   EDUCATIONAL ESTIMATES ONLY — NOT TAX ADVICE. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'vestr_key';         // {provider, key, model}
const LS_GRANTS = 'vestr_grants';   // array of grant objects
const LS_RUNS = 'vestr_runs';       // array of saved strategy runs
const LS_SPEND = 'vestr_spend';     // cumulative est. key spend (USD)
const LS_SETTINGS = 'vestr_settings'; // {taxYear, filing, otherIncome, defState}

function lsGet(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } }
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
const loadKey = () => lsGet(LS_KEY, null);
const saveKey = o => lsSet(LS_KEY, o);
const clearKey = () => localStorage.removeItem(LS_KEY);
const loadGrants = () => lsGet(LS_GRANTS, []);
const saveGrants = g => lsSet(LS_GRANTS, g);
const loadRuns = () => lsGet(LS_RUNS, []);
const saveRuns = r => lsSet(LS_RUNS, r);
const loadSettings = () => Object.assign({ taxYear: 2026, filing: 'single', otherIncome: 200000, defState: 'CA' }, lsGet(LS_SETTINGS, {}));
const saveSettings = s => lsSet(LS_SETTINGS, s);

/* ================= Tax tables =================
   2026 brackets: IRS Rev. Proc. 2025-32 (verified Oct 2026 via multiple sources).
   2025 brackets: IRS Rev. Proc. 2024-40. AMT 2026: exemption $90,100 single /
   $140,200 joint; phaseout begins $500k / $1M at 50¢/$. AMT rates 26%/28%,
   28% above $244,500 excess AMTI. State rates = top marginal, rough estimates. */
const BRACKETS = {
  2026: {
    single: [[12400, .10], [50400, .12], [105700, .22], [201775, .24], [256225, .32], [640600, .35], [Infinity, .37]],
    joint:  [[24800, .10], [100800, .12], [211400, .22], [403550, .24], [512450, .32], [768700, .35], [Infinity, .37]],
  },
  2025: {
    single: [[11925, .10], [48475, .12], [103350, .22], [197300, .24], [250525, .32], [626350, .35], [Infinity, .37]],
    joint:  [[23850, .10], [96950, .12], [206700, .22], [394600, .24], [501050, .32], [751600, .35], [Infinity, .37]],
  },
};
const AMT = {
  2026: { single: { ex: 90100, phase: 500000 }, joint: { ex: 140200, phase: 1000000 }, phaseRate: 0.50, split28: 244500 },
  2025: { single: { ex: 88100, phase: 626350 }, joint: { ex: 137000, phase: 1252700 }, phaseRate: 0.25, split28: 239500 },
};
/* Top marginal state income-tax rates — ROUGH ESTIMATES for planning only. */
const STATE_RATES = {
  AL: 5.0, AK: 0, AZ: 2.5, AR: 3.9, CA: 9.3, CO: 4.4, CT: 6.99, DE: 6.6, DC: 8.95,
  FL: 0, GA: 5.39, HI: 11.0, ID: 5.695, IL: 4.95, IN: 3.15, IA: 3.8, KS: 5.7, KY: 4.0,
  LA: 4.25, ME: 7.15, MD: 5.75, MA: 5.0, MI: 4.25, MN: 9.85, MS: 4.7, MO: 4.7, MT: 5.9,
  NE: 5.2, NV: 0, NH: 0, NJ: 10.75, NM: 5.9, NY: 6.85, NC: 4.5, ND: 2.9, OH: 3.5,
  OK: 4.75, OR: 9.9, PA: 3.07, RI: 5.99, SC: 6.2, SD: 0, TN: 0, TX: 0, UT: 4.55,
  VT: 7.6, VA: 5.75, WA: 0, WV: 4.82, WI: 7.65, WY: 0, OTHER: 5.0,
};
const stateRate = st => STATE_RATES[st] != null ? STATE_RATES[st] / 100 : STATE_RATES.OTHER / 100;

function marginalRate(income, filing, year) {
  const b = BRACKETS[year][filing];
  for (const [cap, rate] of b) if (income <= cap) return rate;
  return 0.37;
}
function fedTax(income, filing, year) {
  const b = BRACKETS[year][filing];
  let tax = 0, prev = 0;
  for (const [cap, rate] of b) {
    const inBracket = Math.min(income, cap) - prev;
    if (inBracket <= 0) break;
    tax += inBracket * rate; prev = cap;
  }
  return tax;
}

/* ================= Vesting schedules ================= */
function addMonths(dateStr, m) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + m);
  return d.toISOString().slice(0, 10);
}
function parseCustom(text) {
  const out = [];
  String(text || '').split('\n').forEach(line => {
    const m = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s*,\s*([\d.]+)/);
    if (m) out.push({ date: m[1], shares: +m[2] });
  });
  return out.sort((a, b) => a.date < b.date ? -1 : 1);
}
/* Returns [{date, shares}] for all future vest events (and past, flagged). */
function vestSchedule(g) {
  if (g.custom && g.custom.length) return g.custom.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const events = [];
  const total = Math.max(1, +g.vestMonths || 48);
  const cliff = Math.min(total, Math.max(0, +g.cliffMonths || 0));
  const perMonth = g.qty / total;
  let last = 0, acc = 0;
  const push = (monthIdx, shares) => { acc += shares; events.push({ date: addMonths(g.grantDate, monthIdx), shares }); };
  if (g.frequency === 'quarterly') {
    for (let m = 3; m <= total; m += 3) {
      if (m < cliff) continue;
      push(m, perMonth * (m - last)); last = m;
    }
    if (last < total) { push(total, perMonth * (total - last)); }
  } else {
    for (let m = 1; m <= total; m++) {
      if (m < cliff) continue;
      push(m, m === cliff ? perMonth * cliff : perMonth);
    }
  }
  // Round to cents, then fix the final event so shares sum exactly to qty.
  const rounded = events.map(e => ({ date: e.date, shares: Math.round(e.shares * 100) / 100 }));
  if (rounded.length) {
    const rsum = rounded.reduce((s, e) => s + e.shares, 0);
    rounded[rounded.length - 1].shares = Math.round((rounded[rounded.length - 1].shares + (g.qty - rsum)) * 100) / 100;
  }
  return rounded;
}

/* ================= Deterministic tax engine =================
   Every dollar figure in the app comes from here. The LLM never computes. */
const HORIZON_MONTHS = 24;

function engineCompute(grants, scenarios, settings) {
  const year = settings.taxYear, filing = settings.filing, otherIncome = +settings.otherIncome || 0;
  const today = new Date().toISOString().slice(0, 10);
  const horizonEnd = addMonths(today, HORIZON_MONTHS);
  const actions = [];   // {date, grantId, grantName, type, kind, shares, fmv, ordinary, bargain, amtPref, withholdingFed, withholdingState}
  const flags = [];

  for (const g of grants) {
    const sc = scenarios[g.id] || defaultScenario(g);
    const fmv = +g.fmv || 0, strike = +g.strike || 0;
    const sRate = stateRate(g.state);
    if (strike > fmv && g.type !== 'RSU') flags.push({ sev: 'watch', text: `${g.name}: strike $${strike} is above FMV $${fmv} — this grant is underwater. Exercising now would lose money.` });
    const sched = vestSchedule(g);
    const vestedToDate = sched.filter(e => e.date <= today).reduce((s, e) => s + e.shares, 0);

    if (g.type === 'RSU') {
      for (const e of sched) {
        if (e.date < today || e.date > horizonEnd) continue;
        const ordinary = e.shares * fmv;
        actions.push({ date: e.date, grantId: g.id, grantName: g.name, type: 'RSU', kind: sc === 'hold' ? 'vest_hold' : 'vest_sell',
          shares: e.shares, fmv, ordinary, bargain: 0, amtPref: 0,
          withholdingFed: ordinary * 0.22, withholdingState: ordinary * sRate,
          note: sc === 'hold' ? 'Taxed as ordinary income at vest; future appreciation taxed on sale.' : 'Sold at vest; tax due now.' });
      }
    } else {
      // Options: vested-to-date shares are the exercise candidates under active scenarios.
      const vested = Math.round(vestedToDate * 100) / 100;
      if (vested > 0 && sc !== 'wait') {
        const bargain = Math.max(0, (fmv - strike)) * vested;
        if (g.type === 'ISO') {
          if (sc === 'ex_hold') {
            actions.push({ date: today, grantId: g.id, grantName: g.name, type: 'ISO', kind: 'exercise_hold',
              shares: vested, fmv, ordinary: 0, bargain, amtPref: bargain,
              withholdingFed: 0, withholdingState: 0,
              note: 'No regular tax at exercise. Bargain element is an AMT preference item; hold 1yr post-exercise + 2yrs post-grant for qualifying disposition (LTCG).' });
          } else { // ex_sell — disqualifying disposition
            actions.push({ date: today, grantId: g.id, grantName: g.name, type: 'ISO', kind: 'exercise_sell',
              shares: vested, fmv, ordinary: bargain, bargain, amtPref: 0,
              withholdingFed: 0, withholdingState: 0,
              note: 'Disqualifying disposition: bargain element taxed as ordinary income NOW. Employers typically withhold $0 on ISO exercises — plan for the full bill.' });
          }
        } else { // NSO
          actions.push({ date: today, grantId: g.id, grantName: g.name, type: 'NSO', kind: 'exercise',
            shares: vested, fmv, ordinary: bargain, bargain, amtPref: 0,
            withholdingFed: bargain * 0.22, withholdingState: bargain * sRate,
            note: 'Bargain element taxed as ordinary income at exercise.' });
        }
      }
      if (sc === 'wait') {
        const upcoming = sched.filter(e => e.date > today && e.date <= horizonEnd);
        if (upcoming.length) flags.push({ sev: 'info', text: `${g.name}: waiting — next vest is ${upcoming[0].shares.toLocaleString()} shares on ${upcoming[0].date}.` });
      }
      // Expiry watch: ISOs/NSOs typically expire 10 years after grant.
      const expiry = addMonths(g.grantDate, 120);
      if (expiry <= addMonths(today, 12) && vested > 0) {
        flags.push({ sev: 'critical', text: `${g.name}: options expire on ${expiry} — ${vested.toLocaleString()} vested shares could go to zero. This is urgent.` });
      }
    }
  }

  // Per-year aggregation. Marginal rate computed on (other income + year's equity ordinary).
  const years = {};
  for (const a of actions) {
    const y = +a.date.slice(0, 4);
    (years[y] = years[y] || { ordinary: 0, amtPref: 0, actions: [] }).ordinary += a.ordinary;
    years[y].amtPref += a.amtPref;
    years[y].actions.push(a);
  }
  let totalShortfall = 0;
  const yearTotals = {};
  for (const [y, t] of Object.entries(years)) {
    const mRate = marginalRate(otherIncome + t.ordinary, filing, year);
    let fed = 0, state = 0, whF = 0, whS = 0;
    for (const a of t.actions) {
      a.marginalRate = mRate;
      a.fedTax = a.ordinary * mRate;
      a.stateTax = a.ordinary * stateRate(grants.find(g => g.id === a.grantId).state);
      fed += a.fedTax; state += a.stateTax; whF += a.withholdingFed; whS += a.withholdingState;
    }
    const shortfall = (fed + state) - (whF + whS);
    totalShortfall += shortfall;
    yearTotals[y] = { ordinary: t.ordinary, amtPref: t.amtPref, fedTax: fed, stateTax: state,
      withholding: whF + whS, shortfall, marginalRate: mRate, nActions: t.actions.length };
  }

  // AMT watchdog (per year).
  const amt = {};
  for (const [y, t] of Object.entries(yearTotals)) {
    const a = AMT[year][filing];
    const amti = otherIncome + t.ordinary + t.amtPref; // rough AMTI
    const ex = Math.max(0, a.ex - a.phaseRate * Math.max(0, amti - a.phase));
    const excess = Math.max(0, amti - ex);
    const tentative = 0.26 * Math.min(excess, AMT[year].split28) + 0.28 * Math.max(0, excess - AMT[year].split28);
    const regular = fedTax(otherIncome + t.ordinary, filing, year);
    amt[y] = { amti, exemption: ex, tentative, regular, likelyOwes: tentative > regular && t.amtPref > 0,
      exposure: t.amtPref * 0.28 };
    if (t.amtPref >= 100000) flags.push({ sev: 'critical', text: `${y}: exercising created $${Math.round(t.amtPref).toLocaleString()} in AMT preference income — consider splitting exercises across tax years.` });
    else if (t.amtPref >= 25000) flags.push({ sev: 'watch', text: `${y}: $${Math.round(t.amtPref).toLocaleString()} in AMT preference income — model AMT before exercising more.` });
  }

  // Urgency score 0–100 (transparent weights per spec).
  const q90 = addMonths(today, 3);
  const vest90Val = actions.filter(a => a.kind.startsWith('vest') && a.date <= q90).reduce((s, a) => s + a.ordinary, 0);
  const maxPref = Math.max(0, ...Object.values(yearTotals).map(t => t.amtPref));
  const uVest = 40 * Math.min(1, vest90Val / 50000);
  const uAmt = 25 * Math.min(1, maxPref / 200000);
  const uShort = 20 * Math.min(1, Math.max(0, totalShortfall) / 10000);
  const expirySoonVal = flags.some(f => f.sev === 'critical' && /expire/.test(f.text)) ? 15 : 0;
  const urgency = Math.round(Math.min(100, uVest + uAmt + uShort + expirySoonVal));

  // Quarter timeline.
  const quarters = {};
  for (const a of actions) {
    const d = new Date(a.date + 'T00:00:00');
    const q = 'Q' + (Math.floor(d.getMonth() / 3) + 1) + ' ' + d.getFullYear();
    (quarters[q] = quarters[q] || []).push(a);
  }
  const qOrder = Object.keys(quarters).sort((a, b) => {
    const [qa, ya] = a.split(' '), [qb, yb] = b.split(' ');
    return (ya - yb) || (qa[1] - qb[1]);
  });

  return { actions, years: yearTotals, amt, flags, urgency,
    urgencyParts: { vest90: Math.round(uVest), amt: Math.round(uAmt), shortfall: Math.round(uShort), expiry: expirySoonVal },
    quarters, qOrder, totalShortfall, settings: { year, filing, otherIncome } };
}

function defaultScenario(g) {
  return g.type === 'RSU' ? 'sell' : g.type === 'ISO' ? 'ex_hold' : 'ex_now';
}
function scenarioLabel(g, sc) {
  if (g.type === 'RSU') return sc === 'hold' ? 'Vest & hold shares' : 'Sell at vest';
  if (g.type === 'ISO') return sc === 'ex_hold' ? 'Exercise now, hold for qualifying disposition' : sc === 'ex_sell' ? 'Exercise & sell (disqualifying)' : 'Wait — no exercise';
  return sc === 'ex_now' ? 'Exercise vested now' : 'Wait — no exercise';
}
function scenarioOptions(g) {
  if (g.type === 'RSU') return [['sell', 'Sell at vest'], ['hold', 'Vest & hold shares']];
  if (g.type === 'ISO') return [['ex_hold', 'Exercise now, hold (qualifying)'], ['ex_sell', 'Exercise & sell (disqualifying)'], ['wait', 'Wait']];
  return [['ex_now', 'Exercise vested now'], ['wait', 'Wait']];
}

/* ================= Formatting ================= */
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const fmtPct1 = v => (v * 100).toFixed(1) + '%';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { marginalRate, fedTax, vestSchedule, engineCompute, defaultScenario, stateRate, BRACKETS, AMT };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');
  const approx = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, msg + ': got ' + a + ', want ~' + b);

  // 2026 brackets: single $200k taxable → marginal 24%
  assert(marginalRate(200000, 'single', 2026) === 0.24, 'marginal 200k single 2026');
  assert(marginalRate(50000, 'single', 2026) === 0.12, 'marginal 50k');
  assert(marginalRate(700000, 'single', 2026) === 0.37, 'marginal top');
  // fedTax hand-check: $50,400 single 2026 = 1240 + (50400-12400)*.12 = 1240 + 4560 = 5800
  approx(fedTax(50400, 'single', 2026), 5800, 0.01, 'fedTax 50400');
  // $105,700: 5800 + (105700-50400)*.22 = 5800 + 12166 = 17966
  approx(fedTax(105700, 'single', 2026), 17966, 0.01, 'fedTax 105700');

  // Vesting: 4800 shares, 48mo, 12mo cliff, monthly → first event at month 12 with 1200 shares
  const sched = vestSchedule({ qty: 4800, grantDate: '2024-01-15', cliffMonths: 12, vestMonths: 48, frequency: 'monthly' });
  assert(sched[0].date === '2025-01-15', 'cliff date, got ' + sched[0].date);
  approx(sched[0].shares, 1200, 0.01, 'cliff shares');
  assert(sched.length === 37, 'monthly events after cliff, got ' + sched.length);
  approx(sched.reduce((s, e) => s + e.shares, 0), 4800, 0.01, 'shares sum');

  // Quarterly: 4800/48mo → 16 events of 900
  const q = vestSchedule({ qty: 4800, grantDate: '2024-01-15', cliffMonths: 12, vestMonths: 48, frequency: 'quarterly' });
  assert(q.length === 13, 'quarterly events, got ' + q.length);
  approx(q.reduce((s, e) => s + e.shares, 0), 4800, 0.01, 'quarterly sum');

  // ISO engine hand-test: 1000 ISOs, strike $10, FMV $50, ex_hold, single, $200k other income, CA
  const iso = { id: 'g1', name: 'Test ISO', type: 'ISO', qty: 1000, strike: 10, fmv: 50,
    grantDate: '2020-01-15', cliffMonths: 12, vestMonths: 48, frequency: 'monthly', state: 'CA', custom: [] };
  const r = engineCompute([iso], { g1: 'ex_hold' }, { taxYear: 2026, filing: 'single', otherIncome: 200000 });
  assert(r.actions.length === 1, 'one exercise action');
  const a = r.actions[0];
  assert(a.bargain === 40000, 'bargain element 40k, got ' + a.bargain);
  assert(a.amtPref === 40000, 'AMT preference 40k');
  assert(a.ordinary === 0, 'no regular tax on qualifying ISO exercise');
  const y = r.years[a.date.slice(0, 4)];
  assert(y.amtPref === 40000, 'year AMT pref');
  // Disqualifying: $200k salary + $40k bargain = $240k → 32% marginal (2026 single).
  // Fed: 40k × 32% = $12,800; CA 9.3% = $3,720; withholding $0 on ISO exercises.
  const r2 = engineCompute([iso], { g1: 'ex_sell' }, { taxYear: 2026, filing: 'single', otherIncome: 200000 });
  const a2 = r2.actions[0];
  approx(a2.fedTax, 12800, 0.01, 'ISO disqual fed');
  approx(a2.stateTax, 3720, 0.01, 'ISO disqual state');
  assert(a2.withholdingFed === 0 && a2.withholdingState === 0, 'no withholding on ISO exercise');
  const y2 = r2.years[a2.date.slice(0, 4)];
  approx(y2.shortfall, 16520, 0.01, 'shortfall = full bill');

  // RSU hand-test: 1200 shares, no cliff, 12mo monthly → 100-share vests; 100 × $50 = $5,000 ordinary
  const rsu = { id: 'g2', name: 'Test RSU', type: 'RSU', qty: 1200, strike: 0, fmv: 50,
    grantDate: '2026-01-15', cliffMonths: 0, vestMonths: 12, frequency: 'monthly', state: 'CA', custom: [] };
  const r3 = engineCompute([rsu], { g2: 'sell' }, { taxYear: 2026, filing: 'single', otherIncome: 200000 });
  const firstVest = r3.actions.find(x => x.kind === 'vest_sell');
  assert(firstVest, 'RSU vest action exists');
  approx(firstVest.ordinary, 5000, 0.01, 'RSU ordinary at vest');
  approx(firstVest.withholdingFed, 1100, 0.01, 'RSU 22% withholding');

  console.log('All Vestr engine self-tests passed.');
}

/* ================= LLM (BYOK) ================= */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini',   costHint: '~$0.01–0.04/run', tokRate: 0.25e-6 },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-3-mini',    costHint: '~$0.01–0.04/run', tokRate: 0.35e-6 },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', costHint: '~$0.02–0.05/run', tokRate: 1.2e-6, corsNote: true },
};
function trackSpend(provider, system, user, maxTokens) {
  const estTokens = Math.ceil((String(system).length + String(user).length) / 4) + (maxTokens || 600);
  const cost = estTokens * (PROVIDERS[provider].tokRate || 0.5e-6);
  lsSet(LS_SPEND, Math.round(((lsGet(LS_SPEND, 0)) + cost) * 10000) / 10000);
}
async function callLLM(provider, key, model, system, user, maxTokens) {
  const p = PROVIDERS[provider];
  trackSpend(provider, system, user, maxTokens);
  let res;
  if (provider === 'anthropic') {
    res = await fetch(p.url, { method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, max_tokens: maxTokens || 600, system, messages: [{ role: 'user', content: user }] }) });
  } else {
    res = await fetch(p.url, { method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 600, temperature: 0.4 }) });
  }
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('Provider error ' + res.status + ': ' + t.slice(0, 160)); }
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
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per strategy run: ' + PROVIDERS[provider].costHint + '.';
  } catch (e) {
    errEl.textContent = 'Key test failed: ' + e.message +
      (String(e.message).includes('Failed to fetch') ? ' (This can be a CORS block — try OpenAI or xAI.)' : '');
  } finally { btn.disabled = false; btn.textContent = 'Test key'; }
}

/* ---- Prompt chain (spec §6). The engine computes; the LLM only narrates. ---- */
const MATH_RULE = 'RULES: Use ONLY the dollar figures in VERIFIED NUMBERS. Never recompute taxes, never invent figures, never mention a dollar amount that is not listed below. You are an explainer, not a calculator. Plain language, no jargon without defining it.';
function engineNumberDump(plan) {
  const lines = [];
  for (const [y, t] of Object.entries(plan.years)) {
    lines.push(`${y}: ordinary income ${fmt$(t.ordinary)}, est. federal tax ${fmt$(t.fedTax)}, est. state tax ${fmt$(t.stateTax)}, withholding ${fmt$(t.withholding)}, shortfall ${fmt$(t.shortfall)}, AMT preference ${fmt$(t.amtPref)}`);
    const a = plan.amt[y];
    if (a) lines.push(`${y} AMT: tentative AMT ${fmt$(a.tentative)} vs regular ${fmt$(a.regular)}, likely owes AMT: ${a.likelyOwes ? 'YES' : 'no'}`);
  }
  lines.push(`Urgency score ${plan.urgency}/100. Total withholding shortfall ${fmt$(plan.totalShortfall)}.`);
  return lines.join('\n');
}
function grantDump(grants) {
  return grants.map(g => {
    const base = `${g.name} (${g.type}): ${g.qty.toLocaleString()} shares, FMV $${g.fmv}/share, granted ${g.grantDate}, state ${g.state}`;
    const extra = g.type === 'RSU' ? '' : `, strike $${g.strike}/share`;
    const sched = vestSchedule(g);
    const upcoming = sched.filter(e => e.date >= new Date().toISOString().slice(0, 10)).slice(0, 4)
      .map(e => `${e.date}: ${e.shares}`).join('; ') || 'fully vested';
    return base + extra + `. Upcoming vests: ${upcoming}. FMV as of ${g.fmvAsOf || 'today'}.`;
  }).join('\n');
}
function buildChainPrompts(plan, grants, scenarios) {
  const nums = engineNumberDump(plan), gd = grantDump(grants);
  const scen = grants.map(g => `${g.name}: ${scenarioLabel(g, scenarios[g.id])}`).join('\n');
  const flags = plan.flags.map(f => `[${f.sev}] ${f.text}`).join('\n') || 'none';
  return [
    { id: 'sanity', title: 'Input sanity check',
      system: 'You are a careful equity-compensation reviewer. ' + MATH_RULE,
      user: `GRANTS:\n${gd}\n\nCODE FLAGS:\n${flags}\n\nFlag anomalies a human should double-check before acting: underwater options, FMV older than 90 days, grants fully vested long ago, missing strike prices, odd vesting. ≤120 words. No new dollar figures.` },
    { id: 'actions', title: 'What to do this quarter',
      system: 'You are a plain-spoken equity-compensation planner writing a checklist for a busy tech worker. ' + MATH_RULE,
      user: `STRATEGIES:\n${scen}\n\nVERIFIED NUMBERS:\n${nums}\n\nCODE FLAGS:\n${flags}\n\nDraft the "what to do this quarter" checklist, ordered by urgency (withholding shortfalls and expiries first). ≤150 words. Reference the verified figures; do not create new ones.` },
    { id: 'donothing', title: 'If you do nothing',
      system: 'You are a plain-spoken equity-compensation explainer. ' + MATH_RULE,
      user: `GRANTS:\n${gd}\n\nFor each grant, explain in one or two sentences what happens if the user takes NO action this quarter — vesting, forfeiture risk, tax timing, expiry. No new dollar figures.` },
    { id: 'cpa', title: 'Questions for your CPA',
      system: 'You are helping a tech worker prepare for a CPA meeting about equity compensation. ' + MATH_RULE,
      user: `GRANTS:\n${gd}\n\nSTRATEGIES:\n${scen}\n\nVERIFIED NUMBERS:\n${nums}\n\nList 5–8 specific questions this person should bring to their CPA, grounded in their actual grants (e.g. 83(b) relevance, state-move timing, AMT credit, estimated payments). Numbered list. No new dollar figures.` },
  ];
}
/* Cross-check: suppress any sentence containing a $ figure not in the engine output. */
function engineFigures(plan) {
  const figs = new Set();
  const add = v => { v = Math.abs(Math.round(v)); figs.add(v); };
  for (const t of Object.values(plan.years)) [t.ordinary, t.fedTax, t.stateTax, t.withholding, t.shortfall, t.amtPref].forEach(add);
  for (const a of Object.values(plan.amt)) [a.tentative, a.regular, a.amti, a.exemption].forEach(add);
  for (const act of plan.actions) [act.ordinary, act.fedTax, act.stateTax, act.bargain, act.amtPref].forEach(add);
  return figs;
}
function crossCheck(text, figs) {
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  let dropped = 0;
  const kept = sentences.filter(s => {
    const nums = [...s.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map(m => +m[1].replace(/,/g, ''));
    for (const n of nums) {
      const ok = [...figs].some(f => Math.abs(f - n) <= Math.max(1, f * 0.01));
      if (!ok) { dropped++; return false; }
    }
    return true;
  });
  return { text: kept.join(' '), dropped };
}

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'grants', 'lab', 'results', 'compare', 'history', 'pricing', 'settings'];
let currentRunId = null;
let labScenarios = {};

function showView(name) {
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'setup') syncSetupUI();
  if (name === 'grants') { syncGrantsNoKey(); renderGrants(); }
  if (name === 'lab') renderLab();
  if (name === 'history') renderHistory();
  if (name === 'compare') syncCompareSelects();
  if (name === 'settings') syncSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) { location.hash = '#/' + name + (arg ? '/' + arg : ''); }
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if (name === 'results' && parts[1]) { currentRunId = parts[1]; renderResults(currentRunId); }
  showView(name);
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
function syncGrantsNoKey() { document.getElementById('grants-no-key').hidden = !!loadKey(); }

function stateOptions(sel) {
  const states = Object.keys(STATE_RATES).filter(s => s !== 'OTHER').sort();
  document.getElementById(sel).innerHTML =
    states.map(s => `<option value="${s}">${s} — ~${STATE_RATES[s]}% top marginal</option>`).join('') +
    `<option value="OTHER">Other / not listed — ~5%</option>`;
}

/* ---------- Grants ---------- */
function renderGrants() {
  const grants = loadGrants();
  const list = document.getElementById('grants-list');
  if (!grants.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No grants yet. Add your first one above — RSU, ISO, or NSO.</p></div>';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  list.innerHTML = grants.map(g => {
    const sched = vestSchedule(g);
    const upcoming = sched.filter(e => e.date >= today).slice(0, 6);
    const maxShares = Math.max(1, ...upcoming.map(e => e.shares));
    const totalVal = g.qty * (+g.fmv || 0);
    return `<div class="grant-row">
      <div class="top">
        <div class="info">
          <strong>${esc(g.name)}</strong>
          <small>${g.qty.toLocaleString()} shares &middot; FMV $${(+g.fmv || 0).toLocaleString()} &middot; est. value ${fmt$(totalVal)} &middot; ${esc(g.state)} &middot; granted ${esc(g.grantDate)}</small>
        </div>
        <span class="type-badge ${g.type}">${g.type}</span>
        <div class="row-actions no-print">
          <button data-edit="${g.id}">Edit</button>
          <button data-delgrant="${g.id}">Delete</button>
        </div>
      </div>
      ${upcoming.length ? `<div class="vest-viz" aria-label="Upcoming vesting">
        ${upcoming.map(e => `<div class="bar"><span class="lbl">${fmtDate(e.date)} — ${e.shares.toLocaleString()} sh</span><span class="fill" style="width:${Math.max(4, Math.round(e.shares / maxShares * 160))}px"></span></div>`).join('')}
      </div>` : '<p class="tip" style="margin-top:8px">Fully vested.</p>'}
    </div>`;
  }).join('');
}
function openGrantForm(g) {
  document.getElementById('grant-form-wrap').hidden = false;
  document.getElementById('grant-form-title').textContent = g ? 'Edit grant' : 'Add grant';
  document.getElementById('grant-id').value = g ? g.id : '';
  document.getElementById('g-name').value = g ? g.name : '';
  document.getElementById('g-type').value = g ? g.type : 'RSU';
  document.getElementById('g-qty').value = g ? g.qty : '';
  document.getElementById('g-strike').value = g && g.strike ? g.strike : '';
  document.getElementById('g-fmv').value = g ? g.fmv : '';
  document.getElementById('g-fmv-asof').value = g && g.fmvAsOf ? g.fmvAsOf : new Date().toISOString().slice(0, 10);
  document.getElementById('g-grant-date').value = g ? g.grantDate : '';
  document.getElementById('g-cliff').value = g ? g.cliffMonths : 12;
  document.getElementById('g-vest-months').value = g ? g.vestMonths : 48;
  document.getElementById('g-freq').value = g ? g.frequency : 'monthly';
  document.getElementById('g-state').value = g ? g.state : loadSettings().defState;
  document.getElementById('g-notes').value = g && g.notes ? g.notes : '';
  document.getElementById('g-custom').value = g && g.custom ? g.custom.map(e => `${e.date}, ${e.shares}`).join('\n') : '';
  document.getElementById('grant-error').textContent = '';
  syncStrikeVisibility();
  document.getElementById('grant-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function syncStrikeVisibility() {
  document.getElementById('g-strike-wrap').style.display =
    document.getElementById('g-type').value === 'RSU' ? 'none' : '';
}
function readGrantForm() {
  const v = id => document.getElementById(id).value.trim();
  const custom = parseCustom(v('g-custom'));
  return {
    id: v('grant-id') || 'grant-' + Date.now().toString(36),
    name: v('g-name'), type: v('g-type'), qty: +v('g-qty'), strike: +v('g-strike') || 0,
    fmv: +v('g-fmv'), fmvAsOf: v('g-fmv-asof') || new Date().toISOString().slice(0, 10),
    grantDate: v('g-grant-date'), cliffMonths: +v('g-cliff') || 0, vestMonths: +v('g-vest-months') || 48,
    frequency: v('g-freq'), state: v('g-state'), notes: v('g-notes'), custom,
  };
}
function validateGrant(g) {
  if (!g.name) return 'Give the grant a company/label.';
  if (!g.qty || g.qty <= 0) return 'Quantity must be positive.';
  if (!(g.fmv >= 0)) return 'Enter a current FMV.';
  if (!g.grantDate) return 'Enter the grant date.';
  if (g.type !== 'RSU' && !(g.strike > 0)) return 'Options need a strike price.';
  if (g.vestMonths < 1) return 'Vesting period must be at least 1 month.';
  return null;
}

/* ---------- Strategy lab ---------- */
function renderLab() {
  const grants = loadGrants();
  const wrap = document.getElementById('lab-grants');
  document.getElementById('lab-no-grants').hidden = grants.length > 0;
  document.getElementById('lab-run-card').hidden = grants.length === 0;
  grants.forEach(g => { if (!labScenarios[g.id]) labScenarios[g.id] = defaultScenario(g); });
  wrap.innerHTML = grants.map(g => `
    <div class="scenario-row">
      <div class="info"><strong>${esc(g.name)}</strong> <span class="type-badge ${g.type}">${g.type}</span>
        <div class="tip">${g.qty.toLocaleString()} shares &middot; FMV $${(+g.fmv || 0).toLocaleString()}${g.type === 'RSU' ? '' : ` &middot; strike $${(+g.strike || 0).toLocaleString()}`}</div></div>
      <select data-scenario="${g.id}" aria-label="Strategy for ${esc(g.name)}">
        ${scenarioOptions(g).map(([val, label]) => `<option value="${val}" ${labScenarios[g.id] === val ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>`).join('');
}

function currentPlan() {
  const grants = loadGrants();
  const settings = loadSettings();
  const scenarios = {};
  grants.forEach(g => { scenarios[g.id] = labScenarios[g.id] || defaultScenario(g); });
  return { plan: engineCompute(grants, scenarios, settings), grants, scenarios, settings };
}

/* ---------- Results ---------- */
function urgencyColor(u) { return u >= 70 ? '#EF4444' : u >= 40 ? '#F59E0B' : '#4ADE80'; }

function renderResults(id) {
  const run = loadRuns().find(r => r.id === id);
  const box = document.getElementById('results-content');
  if (!run) { box.innerHTML = '<div class="card"><p>Strategy run not found.</p></div>'; return; }
  const plan = run.plan, grants = run.grants;
  const dialC = 2 * Math.PI * 54, dialOff = dialC * (1 - plan.urgency / 100);
  const uParts = plan.urgencyParts;
  const yearKeys = Object.keys(plan.years).sort();
  const totOrd = yearKeys.reduce((s, y) => s + plan.years[y].ordinary, 0);
  const totFed = yearKeys.reduce((s, y) => s + plan.years[y].fedTax, 0);
  const totState = yearKeys.reduce((s, y) => s + plan.years[y].stateTax, 0);
  const totShort = yearKeys.reduce((s, y) => s + plan.years[y].shortfall, 0);

  const today = new Date().toISOString().slice(0, 10);
  const thisQ = 'Q' + (Math.floor(new Date().getMonth() / 3) + 1) + ' ' + new Date().getFullYear();
  const checklist = [];
  for (const a of plan.actions) {
    if (a.shortfall > 0 || a.withholdingFed + a.withholdingState < (a.fedTax + a.stateTax) * 0.9)
      checklist.push(`Set aside ${fmt$(Math.max(0, (a.fedTax + a.stateTax) - (a.withholdingFed + a.withholdingState)))} for ${a.grantName} (${a.kind.replace(/_/g, ' ')}) — withholding won't cover it.`);
  }
  plan.flags.filter(f => f.sev === 'critical').forEach(f => checklist.push(f.text));
  const qActions = (plan.quarters[thisQ] || []);

  box.innerHTML = `
    <div class="disclaimer-bar no-print" role="note"><strong>Not tax advice.</strong> Everything below is an educational estimate from Vestr's deterministic engine using ${plan.settings.year} tax tables. Confirm with a licensed CPA before acting.</div>
    <h1 class="no-print">Your strategy plan</h1>
    <p class="lead no-print" style="margin-bottom:16px">Run ${new Date(run.createdAt).toLocaleString()} &middot; ${grants.length} grant${grants.length === 1 ? '' : 's'} &middot; ${plan.settings.year} tax tables (${plan.settings.filing})</p>

    <div class="card">
      <div class="urgency-wrap">
        <div class="urgency-dial" role="img" aria-label="Urgency score ${plan.urgency} out of 100">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="54" fill="none" stroke="#2E2A26" stroke-width="12"/>
            <circle cx="70" cy="70" r="54" fill="none" stroke="${urgencyColor(plan.urgency)}" stroke-width="12" stroke-linecap="round"
              stroke-dasharray="${dialC.toFixed(1)}" stroke-dashoffset="${dialOff.toFixed(1)}"/>
          </svg>
          <div class="num"><b>${plan.urgency}</b><span>urgency</span></div>
        </div>
        <div style="flex:1;min-width:220px">
          <p style="color:var(--muted-fg);font-size:.92rem">Urgency blends vesting in the next 90 days, AMT exposure, withholding shortfall, and option expiry — weights shown so you can sanity-check the machine.</p>
          <div class="formula">0.40&times;vest-90d (${uParts.vest90}) + 0.25&times;AMT (${uParts.amt}) + 0.20&times;shortfall (${uParts.shortfall}) + 0.15&times;expiry (${uParts.expiry})</div>
        </div>
      </div>
    </div>

    <h2>Totals</h2>
    <div class="grid-metrics">
      <div class="metric"><div class="v gold">${fmt$(totOrd)}</div><div class="l">Taxable equity income (24 mo)</div></div>
      <div class="metric"><div class="v ${totFed > 0 ? 'warnv' : ''}">${fmt$(totFed)}</div><div class="l">Est. federal tax</div></div>
      <div class="metric"><div class="v ${totState > 0 ? 'warnv' : ''}">${fmt$(totState)}</div><div class="l">Est. state tax</div></div>
      <div class="metric"><div class="v ${totShort > 0 ? 'bad' : 'good'}">${fmt$(totShort)}</div><div class="l">Withholding shortfall</div></div>
    </div>

    <h2>Year-by-year tax</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Year</th><th>Ordinary income</th><th>Fed tax</th><th>State tax</th><th>Withheld</th><th>Shortfall</th><th>AMT pref.</th></tr>
      ${yearKeys.map(y => { const t = plan.years[y]; return `<tr>
        <td>${y}</td><td>${fmt$(t.ordinary)}</td><td class="neg">${fmt$(t.fedTax)}</td>
        <td class="neg">${fmt$(t.stateTax)}</td><td>${fmt$(t.withholding)}</td>
        <td class="${t.shortfall > 0 ? 'neg' : 'pos'}">${fmt$(t.shortfall)}</td><td>${fmt$(t.amtPref)}</td></tr>`; }).join('')}
      <tr class="total"><td>Total</td><td>${fmt$(totOrd)}</td><td class="neg">${fmt$(totFed)}</td><td class="neg">${fmt$(totState)}</td><td></td><td class="${totShort > 0 ? 'neg' : 'pos'}">${fmt$(totShort)}</td><td></td></tr>
    </table>
    <p class="tip" style="margin-top:8px">Federal tax uses your ${plan.settings.filing} marginal bracket on (other income ${fmt$(plan.settings.otherIncome)} + equity income). State tax uses top marginal rates — rough estimates. Withholding assumes 22% federal supplemental on RSU/NSO income and $0 on ISO exercises.</p></div>

    ${yearKeys.filter(y => plan.amt[y] && (plan.amt[y].likelyOwes || plan.years[y].amtPref > 0)).map(y => {
      const a = plan.amt[y];
      return `<div class="card" style="border-left:3px solid ${a.likelyOwes ? '#EF4444' : '#F59E0B'}">
        <h3>AMT watchdog — ${y}</h3>
        <p style="font-size:.92rem">AMT preference income: <strong class="gold">${fmt$(plan.years[y].amtPref)}</strong>. Tentative AMT: <strong>${fmt$(a.tentative)}</strong> vs regular tax <strong>${fmt$(a.regular)}</strong> on comparable income.</p>
        ${a.likelyOwes ? `<p class="error" style="margin-top:8px"><strong>Likely AMT exposure.</strong> Your tentative AMT exceeds regular tax — you may owe AMT for ${y}. Talk to your CPA about splitting exercises across tax years or adjusting estimated payments.</p>`
          : `<p class="tip" style="margin-top:8px">Tentative AMT is below regular tax, so no AMT likely — but the preference income still counts toward the phaseout. Re-run if FMV moves.</p>`}
        <p class="tip" style="margin-top:8px">2026 AMT exemption: $90,100 single / $140,200 joint; phaseout begins at $500k / $1M AMTI. Rough estimate — Form 6251 governs.</p>
      </div>`; }).join('')}

    <h2>Action timeline</h2>
    ${plan.qOrder.map(q => `<div class="timeline-q card">
      <h4>${q}${q === thisQ ? ' — this quarter' : ''}</h4>
      <table class="breakdown">
        <tr><th>Date</th><th>Grant</th><th>Action</th><th>Shares</th><th>Taxable</th><th>Est. tax</th></tr>
        ${plan.quarters[q].map(a => `<tr><td>${fmtDate(a.date)}</td><td>${esc(a.grantName)}</td>
          <td>${esc(a.kind.replace(/_/g, ' '))}</td><td>${a.shares.toLocaleString()}</td>
          <td>${fmt$(a.ordinary)}</td><td class="neg">${fmt$(a.fedTax + a.stateTax)}</td></tr>`).join('')}
      </table></div>`).join('') || '<div class="card"><p style="color:var(--muted-fg)">No taxable actions in the next 24 months under these scenarios.</p></div>'}

    <h2 class="no-print">What to do this quarter</h2>
    <div class="card no-print">
      ${checklist.length ? `<ul class="checklist">${checklist.slice(0, 8).map(c => `<li><span class="box"></span><span>${esc(c)}</span></li>`).join('')}</ul>`
        : '<p style="color:var(--muted-fg)">Nothing urgent this quarter. The engine sees no shortfalls, expiries, or critical flags.</p>'}
    </div>

    <h2>Code flags <span style="color:var(--muted-fg);font-weight:400;font-size:.85rem">(${plan.flags.length})</span></h2>
    <div class="card">${plan.flags.length ? plan.flags.map(f =>
      `<div class="flag"><span class="sev ${f.sev}">${f.sev}</span><span>${esc(f.text)}</span></div>`).join('')
      : '<p style="color:var(--muted-fg)">No flags from the engine.</p>'}</div>

    <h2 class="no-print">Strategy narrative <span style="color:var(--muted-fg);font-weight:400;font-size:.85rem">(AI on your key)</span></h2>
    <div class="card no-print" id="llm-card">
      ${run.llm ? run.llm.map(s => `<h3 style="margin-top:${s.id === 'sanity' ? '0' : '20px'}">${esc(s.title)}</h3><div class="llm-body">${esc(s.text)}</div>${s.dropped ? `<p class="tip">Note: ${s.dropped} line(s) mentioning figures outside the engine output were hidden.</p>` : ''}`).join('')
        : `<div aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div><p style="color:var(--muted-fg);font-size:.9rem">Running the AI strategy pass on your key…</p></div>`}
    </div>

    <div class="card no-print">
      <p class="tip">Engine math above is complete without the AI pass. Educational estimates only — verify with your CPA.</p>
    </div>`;
}

async function runLLMChain(runId) {
  const runs = loadRuns();
  const run = runs.find(r => r.id === runId);
  if (!run) return;
  const saved = loadKey();
  const card = document.getElementById('llm-card');
  if (!saved || !saved.key) {
    if (card) card.innerHTML = '<div class="notice warn">No API key saved — the engine math above is complete. <a href="#/setup" data-nav="setup">Add a key</a> for the AI-drafted narrative.</div>';
    return;
  }
  const prompts = buildChainPrompts(run.plan, run.grants, run.scenarios);
  const figs = engineFigures(run.plan);
  run.llm = [];
  for (const p of prompts) {
    try {
      if (card) card.innerHTML = `<div aria-live="polite"><div class="skeleton"></div><p style="color:var(--muted-fg);font-size:.9rem">Drafting: ${esc(p.title)}…</p></div>` + run.llm.map(s => `<h3 style="margin-top:20px">${esc(s.title)}</h3><div class="llm-body">${esc(s.text)}</div>`).join('');
      const raw = await callLLM(saved.provider, saved.key, saved.model || PROVIDERS[saved.provider].defaultModel, p.system, p.user, 600);
      const checked = crossCheck(raw.trim(), figs);
      run.llm.push({ id: p.id, title: p.title, text: checked.text, dropped: checked.dropped });
    } catch (e) {
      run.llm.push({ id: p.id, title: p.title, text: 'AI pass failed: ' + e.message + ' — the engine math above is unaffected.', dropped: 0 });
    }
    saveRuns(runs);
    if (currentRunId === runId) renderResults(runId); // re-render with progress
  }
}

/* ---------- Compare ---------- */
function syncCompareSelects() {
  const runs = loadRuns();
  const opts = runs.map(r => `<option value="${r.id}">${esc(r.name)} — ${new Date(r.createdAt).toLocaleDateString()}</option>`).join('');
  const aSel = document.getElementById('compare-a-sel'), bSel = document.getElementById('compare-b-sel');
  aSel.innerHTML = opts || '<option value="">No saved scenarios</option>';
  bSel.innerHTML = opts || '<option value="">No saved scenarios</option>';
  if (runs[1]) bSel.value = runs[1].id;
}
function runCompare() {
  const aId = document.getElementById('compare-a-sel').value, bId = document.getElementById('compare-b-sel').value;
  const box = document.getElementById('compare-content');
  const A = loadRuns().find(r => r.id === aId), B = loadRuns().find(r => r.id === bId);
  if (!A || !B) { box.innerHTML = '<p style="color:var(--muted-fg)">Pick two saved scenarios.</p>'; return; }
  const sum = run => {
    const ys = Object.values(run.plan.years);
    return {
      ord: ys.reduce((s, t) => s + t.ordinary, 0),
      fed: ys.reduce((s, t) => s + t.fedTax, 0),
      st: ys.reduce((s, t) => s + t.stateTax, 0),
      short: ys.reduce((s, t) => s + t.shortfall, 0),
      pref: ys.reduce((s, t) => s + t.amtPref, 0),
      urg: run.plan.urgency,
    };
  };
  const sa = sum(A), sb = sum(B);
  const rows = [
    ['Taxable equity income', sa.ord, sb.ord, 'min'],
    ['Est. federal tax', sa.fed, sb.fed, 'min'],
    ['Est. state tax', sa.st, sb.st, 'min'],
    ['Withholding shortfall', sa.short, sb.short, 'min'],
    ['AMT preference income', sa.pref, sb.pref, 'min'],
    ['Urgency score', sa.urg, sb.urg, 'min'],
  ];
  box.innerHTML = `<table class="compare"><tr><th></th><th>A: ${esc(A.name)}</th><th>B: ${esc(B.name)}</th><th>Delta (B−A)</th></tr>` +
    rows.map(([label, va, vb, dir]) => {
      const winA = dir === 'min' ? va <= vb : va >= vb;
      const d = vb - va;
      return `<tr><th>${label}</th><td class="${winA ? 'winner' : 'loser'}">${label.includes('score') ? va : fmt$(va)}</td><td class="${!winA ? 'winner' : 'loser'}">${label.includes('score') ? vb : fmt$(vb)}</td><td class="${d <= 0 ? 'winner' : 'loser'}">${d === 0 ? '—' : (d > 0 ? '+' : '') + (label.includes('score') ? d : fmt$(d))}</td></tr>`;
    }).join('') + '</table><p class="tip" style="margin-top:8px">Green marks the better side per row. Educational estimates only — not tax advice.</p>';
}

/* ---------- History ---------- */
function renderHistory() {
  const runs = loadRuns();
  const list = document.getElementById('history-list');
  if (!runs.length) {
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No strategy runs yet. Set scenarios in the <a href="#/lab" data-nav="lab" style="color:var(--accent)">Strategy Lab</a> and hit Run.</p></div>';
    return;
  }
  list.innerHTML = runs.map(r => {
    const ys = Object.values(r.plan.years);
    const tot = ys.reduce((s, t) => s + t.fedTax + t.stateTax, 0);
    return `<div class="history-row" data-open="${r.id}" role="button" tabindex="0" aria-label="Open ${esc(r.name)}">
      <div class="info"><strong>${esc(r.name)}</strong>
        <small>${new Date(r.createdAt).toLocaleString()} &middot; ${r.grants.length} grants &middot; est. total tax ${fmt$(tot)} &middot; urgency ${r.plan.urgency}</small></div>
      <div class="row-actions no-print">
        <button data-rerun="${r.id}">Re-run</button>
        <button data-delrun="${r.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
}

/* ---------- Settings ---------- */
function syncSettings() {
  const s = loadSettings();
  document.getElementById('set-tax-year').value = String(s.taxYear);
  document.getElementById('set-filing').value = s.filing;
  document.getElementById('set-other-income').value = s.otherIncome;
  document.getElementById('set-def-state').value = s.defState;
  document.getElementById('spend-counter').textContent = '$' + (lsGet(LS_SPEND, 0)).toFixed(2);
}

/* ================= Init & events ================= */
function init() {
  stateOptions('g-state');
  stateOptions('set-def-state');

  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); go(el.dataset.nav); });
  });

  // Provider cards (setup)
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

  // Grants
  document.getElementById('add-grant-btn').addEventListener('click', () => openGrantForm(null));
  document.getElementById('grant-cancel-btn').addEventListener('click', () => {
    document.getElementById('grant-form-wrap').hidden = true;
  });
  document.getElementById('g-type').addEventListener('change', syncStrikeVisibility);
  document.getElementById('grant-save-btn').addEventListener('click', () => {
    const errEl = document.getElementById('grant-error');
    errEl.textContent = '';
    const g = readGrantForm();
    const problem = validateGrant(g);
    if (problem) { errEl.textContent = problem; return; }
    const grants = loadGrants();
    const i = grants.findIndex(x => x.id === g.id);
    if (i >= 0) grants[i] = g; else grants.unshift(g);
    saveGrants(grants);
    document.getElementById('grant-form-wrap').hidden = true;
    renderGrants();
  });
  document.getElementById('grants-list').addEventListener('click', e => {
    const del = e.target.closest('[data-delgrant]');
    if (del) { saveGrants(loadGrants().filter(g => g.id !== del.dataset.delgrant)); renderGrants(); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) { const g = loadGrants().find(x => x.id === ed.dataset.edit); if (g) openGrantForm(g); }
  });

  // Lab
  document.getElementById('lab-grants').addEventListener('change', e => {
    const sel = e.target.closest('[data-scenario]');
    if (sel) labScenarios[sel.dataset.scenario] = sel.value;
  });
  document.getElementById('lab-run-btn').addEventListener('click', () => {
    const errEl = document.getElementById('lab-error');
    errEl.textContent = '';
    const grants = loadGrants();
    if (!grants.length) { errEl.textContent = 'Add at least one grant first.'; return; }
    const { plan, scenarios, settings } = currentPlan();
    const runs = loadRuns();
    const run = {
      id: 'run-' + Date.now().toString(36),
      name: 'Strategy ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      createdAt: new Date().toISOString(), grants, scenarios, settings, plan, llm: null,
    };
    runs.unshift(run);
    saveRuns(runs.slice(0, 50));
    go('results', run.id);
    runLLMChain(run.id); // async; renders into the card as sections complete
  });

  // Results actions
  document.getElementById('print-btn').addEventListener('click', () => window.print());
  const saveScenario = letter => {
    const runs = loadRuns();
    const run = runs.find(r => r.id === currentRunId);
    if (!run) return;
    run.name = 'Scenario ' + letter + ' — ' + new Date(run.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    saveRuns(runs);
    renderResults(currentRunId);
    const box = document.getElementById('results-content');
    const note = document.createElement('p');
    note.className = 'success no-print';
    note.textContent = 'Saved as Scenario ' + letter + '. Compare it under History → Compare.';
    box.prepend(note);
  };
  document.getElementById('save-a-btn').addEventListener('click', () => saveScenario('A'));
  document.getElementById('save-b-btn').addEventListener('click', () => saveScenario('B'));

  // Compare
  document.getElementById('compare-run-btn').addEventListener('click', runCompare);

  // History
  document.getElementById('history-list').addEventListener('click', e => {
    const del = e.target.closest('[data-delrun]');
    if (del) { e.stopPropagation(); saveRuns(loadRuns().filter(r => r.id !== del.dataset.delrun)); renderHistory(); return; }
    const re = e.target.closest('[data-rerun]');
    if (re) {
      e.stopPropagation();
      const old = loadRuns().find(r => r.id === re.dataset.rerun);
      if (!old) return;
      const grants = loadGrants(); // picks up updated FMVs
      const settings = loadSettings();
      const plan = engineCompute(grants, old.scenarios, settings);
      const runs = loadRuns();
      const run = { id: 'run-' + Date.now().toString(36),
        name: old.name.replace(/^Scenario [AB] — /, '') + ' (re-run)',
        createdAt: new Date().toISOString(), grants, scenarios: old.scenarios, settings, plan, llm: null };
      runs.unshift(run); saveRuns(runs.slice(0, 50));
      go('results', run.id); runLLMChain(run.id);
      return;
    }
    const row = e.target.closest('[data-open]');
    if (row) go('results', row.dataset.open);
  });
  document.getElementById('history-list').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const row = e.target.closest('[data-open]'); if (row) go('results', row.dataset.open); }
  });

  // Settings
  document.getElementById('settings-save-btn').addEventListener('click', () => {
    saveSettings({
      taxYear: +document.getElementById('set-tax-year').value,
      filing: document.getElementById('set-filing').value,
      otherIncome: +document.getElementById('set-other-income').value || 0,
      defState: document.getElementById('set-def-state').value,
    });
    document.getElementById('settings-saved').textContent = 'Tax profile saved. Re-run strategies to apply.';
    setTimeout(() => { document.getElementById('settings-saved').textContent = ''; }, 3000);
  });
  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(loadGrants(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vestr-grants-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.getElementById('import-file').addEventListener('change', e => {
    const errEl = document.getElementById('settings-error');
    errEl.textContent = '';
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const arr = JSON.parse(rd.result);
        if (!Array.isArray(arr)) throw new Error('not an array');
        saveGrants(arr);
        errEl.textContent = '';
        alert('Imported ' + arr.length + ' grants.');
      } catch (err) { errEl.textContent = 'Import failed: ' + err.message; }
    };
    rd.readAsText(f);
    e.target.value = '';
  });
  document.getElementById('clear-data-btn').addEventListener('click', () => {
    if (!confirm('Delete ALL Vestr local data — grants, runs, key, settings?')) return;
    [LS_KEY, LS_GRANTS, LS_RUNS, LS_SPEND, LS_SETTINGS].forEach(k => localStorage.removeItem(k));
    location.hash = '#/landing';
    location.reload();
  });

  window.addEventListener('hashchange', route);
  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
