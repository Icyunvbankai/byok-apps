/* OutTheDoor MVP — static app. Deterministic math in code; the LLM narrates only. */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'outthedoor_key';     // {provider, key, model}
const LS_DEALS = 'outthedoor_deals'; // array of deal objects
const LS_SPEND = 'outthedoor_spend'; // {calls}

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
function bumpSpend() {
  let s = { calls: 0 };
  try { s = JSON.parse(localStorage.getItem(LS_SPEND) || '{"calls":0}'); } catch {}
  s.calls = (s.calls || 0) + 1;
  localStorage.setItem(LS_SPEND, JSON.stringify(s));
  return s.calls;
}
function getSpend() {
  try { return JSON.parse(localStorage.getItem(LS_SPEND) || '{"calls":0}').calls || 0; } catch { return 0; }
}

/* ================= State norms table (v1.0 — estimates) ================= */
/* tax = state base rate (county/city may add); tradeCredit = trade-in reduces taxable price;
   docLo/docHi = typical doc-fee range; docCap = legal cap or null; titleReg = typical title+reg $ */
const STATES = {
  FL: { name: 'Florida',        tax: 0.06,   taxLabel: '6% state (+ county surtax)', tradeCredit: true,  docLo: 799, docHi: 999, docCap: null, titleReg: 135 },
  TX: { name: 'Texas',          tax: 0.0625, taxLabel: '6.25%',                      tradeCredit: true,  docLo: 100, docHi: 200, docCap: null, titleReg: 65 },
  CA: { name: 'California',     tax: 0.0725, taxLabel: '7.25% base (+ district)',   tradeCredit: false, docLo: 85,  docHi: 85,  docCap: 85,   titleReg: 70 },
  NY: { name: 'New York',       tax: 0.04,   taxLabel: '4% state (+ local)',        tradeCredit: true,  docLo: 75,  docHi: 175, docCap: null, titleReg: 100 },
  GA: { name: 'Georgia',        tax: 0.07,   taxLabel: '7% TAVT (replaces sales tax)', tradeCredit: true, docLo: 500, docHi: 699, docCap: null, titleReg: 50 },
  IL: { name: 'Illinois',       tax: 0.0725, taxLabel: '7.25% (Chicago area higher)', tradeCredit: true, docLo: 200, docHi: 358, docCap: null, titleReg: 200 },
  OH: { name: 'Ohio',           tax: 0.0575, taxLabel: '5.75% (+ county)',          tradeCredit: true,  docLo: 200, docHi: 300, docCap: null, titleReg: 50 },
  PA: { name: 'Pennsylvania',   tax: 0.06,   taxLabel: '6% (+ local)',              tradeCredit: true,  docLo: 150, docHi: 400, docCap: null, titleReg: 70 },
  NC: { name: 'North Carolina', tax: 0.03,   taxLabel: '3% highway-use tax',        tradeCredit: true,  docLo: 500, docHi: 699, docCap: null, titleReg: 100 },
  VA: { name: 'Virginia',       tax: 0.0415, taxLabel: '4.15% motor vehicle SUT',   tradeCredit: false, docLo: 500, docHi: 899, docCap: 899,  titleReg: 60 },
};
const NORMS_VERSION = 'v1.0';

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'new', 'results', 'lease', 'score', 'history', 'compare', 'pricing'];
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
  if (name === 'results' && currentDealId) renderResults(currentDealId);
  if (name === 'lease' && currentDealId) renderLease(currentDealId);
  if (name === 'score' && currentDealId) renderScore(currentDealId);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) {
  if ((name === 'results' || name === 'lease' || name === 'score') && arg) currentDealId = arg;
  location.hash = '#/' + name + (arg ? '/' + arg : '');
}
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if ((name === 'results' || name === 'lease' || name === 'score') && parts[1]) currentDealId = parts[1];
  showView(name);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', route);
}

/* ================= Deterministic OTD calculator ================= */
/* Every dollar figure comes from here. The LLM is never asked to do math.
   Assumptions (shown in UI): rebates cut amount financed, not the taxable price
   (manufacturer rebates are taxable in most states); trade-in credit capped at
   the selling price; tax rate is user-editable. */
function amortPayment(loan, aprPct, months) {
  if (loan <= 0 || months <= 0) return 0;
  const r = aprPct / 100 / 12;
  if (r <= 0) return loan / months;
  const f = Math.pow(1 + r, months);
  return loan * r * f / (f - 1);
}
function loanBalance(loan, aprPct, totalMonths, paidMonths) {
  if (loan <= 0) return 0;
  const r = aprPct / 100 / 12;
  if (r <= 0) return Math.max(0, loan * (1 - paidMonths / totalMonths));
  const fn = Math.pow(1 + r, totalMonths), fp = Math.pow(1 + r, paidMonths);
  return loan * (fn - fp) / (fn - 1);
}

function calc(d) {
  const num = v => (isFinite(+v) ? +v : 0);
  const msrp = num(d.msrp), discount = num(d.discount), rebates = num(d.rebates);
  const taxRate = num(d.taxRate) / 100;
  const st = STATES[d.state] || STATES.FL;
  const docFee = num(d.docFee), titleReg = num(d.titleReg);
  const addOns = (d.addOns || []).map(a => ({ name: String(a.name || ''), amount: num(a.amount) }));
  const addOnTotal = addOns.reduce((s, a) => s + a.amount, 0);
  const tradeValue = num(d.tradeValue), tradePayoff = num(d.tradePayoff);
  const down = num(d.down), apr = num(d.apr), term = num(d.term) || 60;

  const selling = Math.max(0, msrp - discount);
  const tradeEquity = tradeValue - tradePayoff;
  const creditBase = st.tradeCredit ? Math.min(tradeValue, selling) : 0;
  const taxable = Math.max(0, selling - creditBase);
  const tax = taxable * taxRate;
  const feesTotal = docFee + titleReg + addOnTotal;
  const otd = selling + tax + feesTotal;
  const amountFinanced = otd - down - rebates - tradeEquity;
  const discountPct = msrp > 0 ? discount / msrp : 0;

  const terms = [36, 48, 60, 72];
  const payments = {};
  terms.forEach(t => { payments[t] = amortPayment(amountFinanced, apr, t); });
  const totalInterest = {};
  terms.forEach(t => { totalInterest[t] = payments[t] * t - amountFinanced; });

  return {
    selling, tradeEquity, creditBase, taxable, tax, feesTotal, addOnTotal,
    otd, amountFinanced, discountPct, payments, totalInterest,
    msrp, taxRate, stateCode: d.state, tradeCredit: st.tradeCredit,
  };
}

/* ================= Rule-based fee flagger ================= */
/* Severity: info / watch / rip-off. Each flag carries a concrete counter-ask. */
const ADDON_RULES = [
  { re: /vin\s*etch/i, label: 'VIN etching', typical: '$0–50 (often free)',
    judge: amt => amt > 100 ? ['rip-off', 'Pure margin — the "theft deterrent" is a sticker. Ask them to remove it entirely.']
                            : amt > 0 ? ['watch', 'Negotiable — many dealers throw this in free. Ask them to zero it.'] : null },
  { re: /nitrogen/i, label: 'Nitrogen fill', typical: 'free (air is already 78% nitrogen)',
    judge: amt => amt > 0 ? ['rip-off', 'Pure margin — refuse it outright. Air from the gas station is fine.'] : null },
  { re: /paint|sealant|ceramic/i, label: 'Paint protection', typical: '$200–500 aftermarket',
    judge: amt => amt > 800 ? ['rip-off', 'Huge markup — a detailer does better for a third of this. Ask them to remove it.']
                            : amt > 300 ? ['watch', 'Padded — get an outside detailer quote and ask them to match or remove.'] : null },
  { re: /fabric|interior\s*protect|scotchgard/i, label: 'Interior protection', typical: '$100–300 aftermarket',
    judge: amt => amt > 400 ? ['rip-off', 'Spray-can product at champagne prices. Ask them to remove it.']
                            : amt > 0 ? ['watch', 'Negotiable — ask them to cut it in half or drop it.'] : null },
  { re: /lojack|gps|track/i, label: 'GPS / tracker', typical: '$300–700 installed',
    judge: amt => amt > 900 ? ['watch', 'Above market — ask what hardware it is and get an independent quote.']
                            : amt > 0 ? ['info', 'Check the hardware brand; some insurers discount for trackers.'] : null },
  { re: /gap/i, label: 'GAP insurance', typical: '$300–500 via your lender or credit union',
    judge: amt => amt > 600 ? ['watch', 'Your bank or credit union sells the same coverage for half. Ask them to match or remove.']
                            : amt > 0 ? ['info', 'Fine if you need it — but price it against your lender first.'] : null },
  { re: /extended\s*warranty|service\s*contract|\bvsc\b/i, label: 'Extended warranty', typical: 'varies widely — shop independently',
    judge: () => ['info', 'Never buy this at the finance desk on day one. Get 2 outside quotes; the price is almost always negotiable.'] },
  { re: /tire|wheel/i, label: 'Tire & wheel protection', typical: '$300–600',
    judge: amt => amt > 700 ? ['watch', 'Above market — negotiable, and often cheaper from a tire shop.'] : null },
  { re: /key/i, label: 'Key replacement', typical: '$150–400 at a locksmith',
    judge: amt => amt > 500 ? ['watch', 'A locksmith cuts most fobs for far less. Negotiable.'] : null },
];

function feeFlags(d, m) {
  const flags = [];
  const st = STATES[d.state] || STATES.FL;
  const fmt = fmt$;

  // Doc fee vs state norms
  const doc = +d.docFee || 0;
  if (doc > 0) {
    if (st.docCap && doc > st.docCap) {
      flags.push({ sev: 'rip-off', title: 'Doc fee $' + doc.toLocaleString() + ' exceeds the state cap',
        text: st.name + ' caps doc fees at ' + fmt(st.docCap) + '. This charge is not legal as written — refuse it.',
        ask: 'Cut the doc fee to ' + fmt(st.docCap) + ' (the legal max).' });
    } else if (doc > st.docHi * 1.25) {
      flags.push({ sev: 'rip-off', title: 'Doc fee ' + fmt(doc) + ' — top quartile rip-off',
        text: st.name + ' doc fees typically run ' + fmt(st.docLo) + '–' + fmt(st.docHi) + '. This is ' + Math.round(doc / st.docHi * 100) + '% of the typical top end — pure dealer profit.',
        ask: 'Cut the doc fee to ' + fmt(st.docHi) + ' or take the same amount off the selling price.' });
    } else if (doc > st.docHi) {
      flags.push({ sev: 'watch', title: 'Doc fee ' + fmt(doc) + ' above typical range',
        text: st.name + ' typical: ' + fmt(st.docLo) + '–' + fmt(st.docHi) + '. Above the range, but not egregious.',
        ask: 'Ask them to meet the top of the typical range: ' + fmt(st.docHi) + '.' });
    } else {
      flags.push({ sev: 'info', title: 'Doc fee ' + fmt(doc) + ' in line with ' + st.name + ' norms',
        text: 'Typical range here is ' + fmt(st.docLo) + '–' + fmt(st.docHi) + '. Not a fight worth having.',
        ask: null });
    }
  }

  // Add-ons
  (d.addOns || []).forEach(a => {
    const amt = +a.amount || 0;
    if (!a.name && amt <= 0) return;
    const rule = ADDON_RULES.find(r => r.re.test(a.name || ''));
    if (rule) {
      const j = rule.judge(amt);
      if (j) flags.push({ sev: j[0], title: rule.label + ' — ' + fmt(amt) + ' (typical ' + rule.typical + ')', text: j[1], ask: j[1].split('.')[0] + '.' });
    } else if (amt >= 500) {
      flags.push({ sev: 'watch', title: 'Unverified add-on "' + a.name + '" — ' + fmt(amt),
        text: 'No norm on file for this item. Ask exactly what it covers and get an outside price.',
        ask: 'Remove it unless they can show an outside quote within 20%.' });
    } else if (amt > 0) {
      flags.push({ sev: 'info', title: 'Add-on "' + a.name + '" — ' + fmt(amt),
        text: 'Small enough to be real, but still negotiable.', ask: null });
    }
  });

  // Cross-checks (deterministic normalize)
  if (m.msrp > 0 && ((+d.discount || 0) + (+d.rebates || 0)) > m.msrp * 0.25) {
    flags.push({ sev: 'info', title: 'Verify this number',
      text: 'Discount + rebates exceed 25% of MSRP — double-check the worksheet; stacked incentives this deep are unusual.',
      ask: null });
  }
  if (m.tradeEquity < 0) {
    flags.push({ sev: 'watch', title: 'Negative equity: ' + fmt(-m.tradeEquity) + ' rolled in',
      text: 'You owe more on the trade than it\'s worth. That ' + fmt(-m.tradeEquity) + ' gets added to your new loan — you\'ll be underwater on day one.',
      ask: 'Ask for more on the trade, or put extra cash down to cover the gap.' });
  }
  if ((+d.apr || 0) > 10) {
    flags.push({ sev: 'watch', title: 'APR ' + d.apr + '% is high',
      text: 'Dealer-arranged financing at this rate deserves a second quote. Credit unions routinely beat it.',
      ask: 'Bring a pre-approved rate and make them beat it — or take your bank\'s money.' });
  }
  if ((+d.term || 0) >= 72) {
    flags.push({ sev: 'info', title: (d.term) + '-month term = more interest',
      text: 'Longer terms lower the payment but you pay far more interest and stay underwater longer.',
      ask: null });
  }
  return flags;
}

/* ================= Lease vs buy (deterministic) ================= */
function leaseMath(d, m) {
  const mf = +d.leaseMF, resPct = +d.leaseResidual;
  if (!(mf > 0) || !(resPct > 0)) return null;
  const term = +d.leaseTerm || 36;
  const selling = m.selling, msrp = m.msrp;
  const residual = msrp * resPct / 100;
  const depreciation = (selling - residual) / term;
  const rentCharge = (selling + residual) * mf;
  const baseMonthly = depreciation + rentCharge;
  const monthlyTax = baseMonthly * m.taxRate;
  const leaseMonthly = baseMonthly + monthlyTax;
  const driveOff = +d.leaseDriveOff || 0;
  const disposition = +d.leaseDisposition || 0;
  const totalLease = driveOff + leaseMonthly * term + disposition;

  // Buy side: net cost over 3 and 5 years
  const a = d.leaseAssump || {};
  const retain3 = (a.retain3 != null ? +a.retain3 : 55) / 100;
  const retain5 = (a.retain5 != null ? +a.retain5 : 40) / 100;
  const payTerm = +d.term || 60;
  const pay = m.payments[payTerm] || amortPayment(m.amountFinanced, +d.apr || 0, payTerm);
  function buyCost(months, retainFrac) {
    const made = Math.min(months, payTerm);
    const paid = pay * made;
    const bal = made >= payTerm ? 0 : loanBalance(m.amountFinanced, +d.apr || 0, payTerm, made);
    const equity = Math.max(0, msrp * retainFrac - bal);
    return { paid: (+d.down || 0) + paid, equity, net: (+d.down || 0) + paid - equity, balance: bal };
  }
  const buy3 = buyCost(36, retain3), buy5 = buyCost(60, retain5);

  // Mileage note
  const milesYr = +d.leaseMiles || 12000;
  const overRate = (a.overRate != null ? +a.overRate : 0.20);
  const allowedTotal = milesYr * (term / 12);

  return {
    residual, depreciation, rentCharge, leaseMonthly, totalLease, term,
    driveOff, disposition, buy3, buy5, retain3: retain3 * 100, retain5: retain5 * 100,
    milesYr, allowedTotal, overRate,
    aprEquiv: mf * 2400,
  };
}

/* ================= Deal score 0–100 (deterministic) ================= */
/* discount 30% + comps 25% + term sanity 20% + clean-fees 25%.
   No comps → discount 40% + term 35% (redistributed, stated in UI). */
function dealScore(d, m, flags) {
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const comps = (d.comps || []).filter(c => c.otd > 0);
  const hasComps = comps.length > 0;
  const wD = hasComps ? 30 : 40, wC = hasComps ? 25 : 0, wT = hasComps ? 20 : 35;

  const discountPts = clamp01(m.discountPct / 0.10) * wD;
  let compPts = 0;
  if (hasComps) {
    const otds = comps.map(c => +c.otd);
    const lo = Math.min(...otds), hi = Math.max(...otds);
    const pos = hi > lo ? (hi - m.otd) / (hi - lo) : (m.otd <= lo ? 1 : 0);
    compPts = clamp01(pos) * wC;
  }
  const term = +d.term || 60, apr = +d.apr || 0;
  let termScore = term <= 60 ? 100 : term <= 72 ? 70 : 40;
  if (apr > 12) termScore = Math.max(0, termScore - 20);
  const termPts = termScore / 100 * wT;

  const sevW = { info: 0, watch: 5, 'rip-off': 12 };
  const penalty = Math.min(25, flags.reduce((s, f) => s + (sevW[f.sev] || 0), 0));
  const feePts = 25 - penalty;

  const score = Math.round(Math.max(0, Math.min(100, discountPts + compPts + termPts + feePts)));
  return { score, parts: { discountPts, compPts, termPts, feePts, penalty, hasComps, wD, wC, wT } };
}

/* ================= Formatting ================= */
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calc, feeFlags, leaseMath, dealScore, amortPayment, STATES };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');
  const approx = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, msg + ': got ' + a + ', want ~' + b);

  // Test 1: hand-computed OTD — $35k MSRP FL deal
  const t1 = {
    msrp: 35000, discount: 2500, rebates: 1000, state: 'FL', taxRate: 6,
    docFee: 899, titleReg: 135,
    addOns: [{ name: 'VIN etch', amount: 299 }, { name: 'Nitrogen', amount: 199 }],
    tradeValue: 8000, tradePayoff: 5000, down: 2000, apr: 7, term: 60,
  };
  const m1 = calc(t1);
  assert(m1.selling === 32500, 't1 selling');
  assert(m1.tradeEquity === 3000, 't1 trade equity');
  assert(m1.taxable === 24500, 't1 taxable (trade credit)');
  assert(m1.tax === 1470, 't1 tax');
  assert(m1.feesTotal === 1532, 't1 fees');
  assert(m1.otd === 35502, 't1 OTD');
  assert(m1.amountFinanced === 29502, 't1 financed');
  approx(m1.payments[60], 584.19, 0.05, 't1 monthly 60mo');
  approx(m1.payments[36], 911.02, 0.10, 't1 monthly 36mo');
  approx(m1.discountPct, 0.0714286, 0.0001, 't1 discount pct');

  // Test 2: CA — no trade credit
  const m2 = calc({ msrp: 30000, discount: 0, rebates: 0, state: 'CA', taxRate: 7.25, docFee: 85, titleReg: 70, addOns: [], tradeValue: 5000, tradePayoff: 0, down: 0, apr: 6, term: 60 });
  assert(m2.taxable === 30000, 't2 CA no trade credit');
  approx(m2.tax, 2175, 0.01, 't2 tax');

  // Test 3: fee flags — FL doc fee $1300 = rip-off; VIN etch + nitrogen flagged
  const f3 = feeFlags(t1, m1);
  const docFlag = f3.find(f => f.title.includes('Doc fee'));
  assert(docFlag && docFlag.sev === 'info', 't3 doc fee $899 FL = info (in 799-999 range), got ' + (docFlag && docFlag.sev));
  const t1b = Object.assign({}, t1, { docFee: 1300 });
  const f3b = feeFlags(t1b, calc(t1b));
  assert(f3b.find(f => f.title.includes('Doc fee')).sev === 'rip-off', 't3b doc fee $1300 = rip-off');
  assert(f3b.some(f => f.sev === 'rip-off' && f.title.includes('VIN')), 't3 VIN etch rip-off');
  assert(f3b.some(f => f.sev === 'rip-off' && f.title.includes('Nitrogen')), 't3 nitrogen rip-off');

  // Test 4: lease math — hand-computed
  const t4 = Object.assign({}, t1, { leaseMF: 0.0015, leaseResidual: 60, leaseTerm: 36, leaseMiles: 12000, leaseDisposition: 395, leaseDriveOff: 2000 });
  const l4 = leaseMath(t4, calc(t4));
  approx(l4.residual, 21000, 0.01, 't4 residual');
  approx(l4.leaseMonthly, 423.68, 0.05, 't4 lease monthly');
  approx(l4.totalLease, 17647.4, 0.5, 't4 total lease cost');
  approx(l4.aprEquiv, 3.6, 0.01, 't4 APR equiv');
  assert(l4.buy3.net > 0 && l4.buy5.net > 0, 't4 buy costs positive');

  // Test 5: score — clean-ish deal, no comps → redistributed weights
  const t5 = Object.assign({}, t1, { docFee: 899, addOns: [] });
  const m5 = calc(t5), f5 = feeFlags(t5, m5), s5 = dealScore(t5, m5, f5);
  assert(s5.parts.hasComps === false, 't5 no comps');
  assert(s5.score >= 80 && s5.score <= 95, 't5 score 80-95, got ' + s5.score);

  // Test 6: score with comps — best quote wins
  const t6 = Object.assign({}, t5, { comps: [{ label: 'Dealer B', otd: 37000 }, { label: 'Dealer C', otd: 39000 }] });
  const s6 = dealScore(t6, calc(t6), feeFlags(t6, calc(t6)));
  assert(s6.parts.hasComps === true, 't6 has comps');
  assert(s6.score >= 85, 't6 score >= 85 (best OTD), got ' + s6.score);

  console.log('All OutTheDoor self-tests passed.');
}

/* ================= LLM (BYOK) ================= */
/* Single verdict call. The prompt embeds pre-computed numbers; the model is
   told explicitly to use them and never recompute or invent market prices. */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini', costHint: '~$0.01/deal' },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-3-mini',  costHint: '~$0.01/deal' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', costHint: '~$0.02/deal', corsNote: true },
};

function buildVerdictPrompt(deal, m, flags, lease, score) {
  const st = STATES[deal.state] || STATES.FL;
  const feeLines = flags.map(f => `- [${f.sev.toUpperCase()}] ${f.title}: ${f.text}${f.ask ? ' COUNTER-ASK: ' + f.ask : ''}`).join('\n');
  const compLines = (deal.comps || []).filter(c => c.otd > 0).map(c => `- ${c.label || 'Comp'}: OTD ${fmt$(c.otd)}`).join('\n') || 'none provided';
  const leaseLines = lease
    ? `Lease ${lease.term}mo: ${fmt$(lease.leaseMonthly)}/mo, total ${fmt$(lease.totalLease)} (drive-off ${fmt$(lease.driveOff)} + disposition ${fmt$(lease.disposition)}). Buy 3-yr net cost ${fmt$(lease.buy3.net)}, 5-yr net cost ${fmt$(lease.buy5.net)}.`
    : 'No lease terms entered.';
  return {
    system: 'You are a former dealership finance-office insider turned consumer advocate. ' +
      'You explain dealer math in plain English. Use ONLY the numbers provided below — do not recompute them, ' +
      'do not invent competing dealer prices, market averages, or fees not listed. ' +
      'Score only against the comps the user provided plus the documented fee norms. ' +
      'Be direct and skeptical. Keep the whole response under 300 words.',
    user:
`VEHICLE: ${deal.year || ''} ${deal.make || ''} ${deal.model || ''} ${deal.trim || ''} (${st.name})
VERIFIED NUMBERS (computed in code — trust these, never recompute):
- MSRP ${fmt$(m.msrp)}, dealer discount ${fmt$(+deal.discount || 0)} (${(m.discountPct * 100).toFixed(1)}% off), rebates ${fmt$(+deal.rebates || 0)}
- Selling price ${fmt$(m.selling)}; trade-in ${fmt$(+deal.tradeValue || 0)} / payoff ${fmt$(+deal.tradePayoff || 0)} (equity ${fmt$(m.tradeEquity)}); down ${fmt$(+deal.down || 0)}
- Taxable base ${fmt$(m.taxable)} (${st.tradeCredit ? 'trade-in credit applied' : 'NO trade-in credit in this state'}) at ${(m.taxRate * 100).toFixed(2)}% = tax ${fmt$(m.tax)}
- Fees: doc ${fmt$(+deal.docFee || 0)}, title/reg ${fmt$(+deal.titleReg || 0)}, add-ons ${fmt$(m.addOnTotal)}
- TRUE OUT-THE-DOOR: ${fmt$(m.otd)}; amount financed ${fmt$(m.amountFinanced)}
- Monthly @ ${deal.apr}% APR: 36mo ${fmt$(m.payments[36])} / 48mo ${fmt$(m.payments[48])} / 60mo ${fmt$(m.payments[60])} / 72mo ${fmt$(m.payments[72])}
FEE FLAGS:
${feeLines || 'none'}
LEASE VS BUY: ${leaseLines}
DEAL SCORE: ${score.score}/100 (discount ${score.parts.discountPts.toFixed(0)}pts, comps ${score.parts.compPts.toFixed(0)}pts, term ${score.parts.termPts.toFixed(0)}pts, clean-fees ${score.parts.feePts.toFixed(0)}pts${score.parts.hasComps ? '' : '; NO comps provided — scored without market comparison'})
USER COMPS (OTD quotes from other dealers):
${compLines}

Write:
1. VERDICT: 2-3 sentences — is this a good deal and why.
2. FEE COUNTER-ASKS: one line per flagged fee — the exact ask to make at the desk.
3. TOP 3 REASONS: the three biggest drivers of the ${score.score}/100 score.
4. TALKING POINTS: 3 short, plain-English lines to say in the finance office.`
  };
}

async function callLLM(provider, key, model, system, user, maxTokens) {
  const p = PROVIDERS[provider];
  let res;
  if (provider === 'anthropic') {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, max_tokens: maxTokens || 900, system, messages: [{ role: 'user', content: user }] }),
    });
  } else {
    res = await fetch(p.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, p.keyHeader(key)),
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens || 900, temperature: 0.4 }),
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
    okEl.textContent = PROVIDERS[provider].name + ' key works. Est. cost per deal: ' + PROVIDERS[provider].costHint + '.';
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
  document.getElementById('spend-counter').textContent = '$' + (getSpend() * 0.02).toFixed(2);
}

function syncNoKeyNotice() {
  document.getElementById('no-key-notice').hidden = !!loadKey();
}

function syncStateUI() {
  const sel = document.getElementById('f-state');
  const code = sel.value || 'FL';
  const st = STATES[code];
  document.getElementById('f-taxrate').value = (st.tax * 100).toFixed(2);
  document.getElementById('taxrate-hint').textContent = st.taxLabel + (st.tradeCredit ? ' · trade-in credit applies' : ' · NO trade-in credit in ' + st.name);
  document.getElementById('docfee-hint').textContent = st.name + ' typical doc fee: ' + fmt$(st.docLo) + '–' + fmt$(st.docHi) + (st.docCap ? ' (capped at ' + fmt$(st.docCap) + ')' : ' (no state cap)');
  const tr = document.getElementById('f-titlereg');
  if (!tr.dataset.touched) tr.value = st.titleReg;
  document.getElementById('titlereg-hint').textContent = 'Estimate for ' + st.name + ' — adjust to your county\'s actual.';
}

function scoreClass(s) { return s >= 70 ? 'good' : s >= 45 ? 'mid' : 'bad'; }
function vehicleLabel(d) { return [d.year, d.make, d.model, d.trim].filter(Boolean).join(' ') || 'Untitled deal'; }

function renderResults(id) {
  const deal = getDeal(id);
  const box = document.getElementById('results-content');
  if (!deal) { box.innerHTML = '<div class="card"><p>Deal not found.</p></div>'; return; }
  const m = deal.metrics, flags = deal.flags || [];
  const st = STATES[deal.state] || STATES.FL;
  const addOnRows = (deal.addOns || []).filter(a => (+a.amount || 0) > 0 || a.name)
    .map(a => `<tr><td>${esc(a.name || 'Add-on')}</td><td class="neg">+${fmt$(a.amount)}</td></tr>`).join('');

  box.innerHTML = `
    <h1 class="no-print">${esc(vehicleLabel(deal))}</h1>
    <div class="card">
      <h3>Out-the-door breakdown</h3>
      <table class="breakdown">
        <tr><th>Line item</th><th>Amount</th></tr>
        <tr><td>MSRP</td><td>${fmt$(m.msrp)}</td></tr>
        <tr><td>Dealer discount</td><td class="pos">−${fmt$(+deal.discount || 0)}</td></tr>
        <tr class="subtotal"><td>Selling price</td><td>${fmt$(m.selling)}</td></tr>
        <tr><td>Sales tax (${(m.taxRate * 100).toFixed(2)}%${st.tradeCredit ? ', trade credit applied' : ', no trade credit'})</td><td>+${fmt$(m.tax)}</td></tr>
        <tr><td>Doc fee</td><td>+${fmt$(+deal.docFee || 0)}</td></tr>
        <tr><td>Title &amp; registration</td><td>+${fmt$(+deal.titleReg || 0)}</td></tr>
        ${addOnRows}
        <tr class="total"><td>True out-the-door</td><td>${fmt$(m.otd)}</td></tr>
      </table>
      <p class="tip" style="margin-top:8px">Rebates (${fmt$(+deal.rebates || 0)}) cut the amount financed, not the taxable price — standard in most states.</p>
    </div>

    <h2>What you finance</h2>
    <div class="grid-metrics">
      <div class="metric"><div class="v accentv">${fmt$(m.otd)}</div><div class="l">Out-the-door</div></div>
      <div class="metric"><div class="v">${fmt$(m.amountFinanced)}</div><div class="l">Amount financed</div></div>
      <div class="metric"><div class="v ${m.tradeEquity >= 0 ? 'good' : 'bad'}">${fmt$(m.tradeEquity)}</div><div class="l">Trade equity</div></div>
      <div class="metric"><div class="v">${(m.discountPct * 100).toFixed(1)}%</div><div class="l">Off MSRP</div></div>
    </div>

    <h2>Monthly payment @ ${esc(String(deal.apr))}% APR</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Term</th><th>Payment</th><th>Total interest</th></tr>
      ${[36, 48, 60, 72].map(t => `<tr class="${t === +deal.term ? 'total' : ''}"><td>${t} mo</td><td>${fmt$(m.payments[t])}</td><td class="neg">${fmt$(m.totalInterest[t])}</td></tr>`).join('')}
    </table></div>

    <h2>Fee flags <span style="color:var(--muted-fg);font-weight:400;font-size:.85rem">(${flags.length} from code)</span></h2>
    <div class="card">${flags.length ? flags.map(f =>
      `<div class="flag"><span class="sev ${f.sev}">${f.sev.replace('-', ' ')}</span><div class="body"><b>${esc(f.title)}</b><span style="color:var(--muted-fg)">${esc(f.text)}</span>${f.ask ? `<br><span class="ask">→ ${esc(f.ask)}</span>` : ''}</div></div>`).join('')
      : '<p style="color:var(--muted-fg)">No flags. Either a clean sheet or an empty form.</p>'}</div>

    <div class="card no-print">
      <p class="tip">Analyzed ${new Date(deal.createdAt).toLocaleString()} · Fee norms ${NORMS_VERSION} (estimates). Educational estimates only — verify against your buyer's order.</p>
    </div>`;
}

function renderLease(id) {
  const deal = getDeal(id);
  const box = document.getElementById('lease-content');
  if (!deal) { box.innerHTML = '<div class="card"><p>Deal not found.</p></div>'; return; }
  const m = deal.metrics;
  const a = deal.leaseAssump || {};
  const r3 = a.retain3 != null ? a.retain3 : 55, r5 = a.retain5 != null ? a.retain5 : 40;
  const over = a.overRate != null ? a.overRate : 0.20;
  const lease = leaseMath(Object.assign({}, deal, { leaseAssump: { retain3: r3, retain5: r5, overRate: over } }), m);

  if (!lease) {
    box.innerHTML = `
      <h1>Lease vs buy</h1>
      <div class="card"><p style="color:var(--muted-fg)">No lease terms on this deal yet. Money factor and residual % drive the whole comparison.</p>
      <p style="margin-top:12px"><button class="btn secondary" id="lease-edit-btn">Add lease terms</button></p></div>`;
    document.getElementById('lease-edit-btn').addEventListener('click', () => loadDealIntoForm(id));
    return;
  }

  box.innerHTML = `
    <h1 class="no-print">Lease vs buy — ${esc(vehicleLabel(deal))}</h1>
    <div class="grid-metrics">
      <div class="metric"><div class="v accentv">${fmt$(lease.totalLease)}</div><div class="l">3-yr lease total cost</div></div>
      <div class="metric"><div class="v">${fmt$(lease.buy3.net)}</div><div class="l">3-yr buy net cost</div></div>
      <div class="metric"><div class="v">${fmt$(lease.buy5.net)}</div><div class="l">5-yr buy net cost</div></div>
      <div class="metric"><div class="v ${lease.totalLease < lease.buy3.net ? 'good' : 'warnv'}">${lease.totalLease < lease.buy3.net ? 'Lease' : 'Buy'} wins 3-yr</div><div class="l">on raw cost</div></div>
    </div>

    <h2>Lease breakdown (${lease.term} mo)</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Line item</th><th>Amount</th></tr>
      <tr><td>Residual value (${(+deal.leaseResidual).toFixed(0)}% of MSRP)</td><td>${fmt$(lease.residual)}</td></tr>
      <tr><td>Depreciation / mo</td><td>${fmt$(lease.depreciation)}</td></tr>
      <tr><td>Rent charge / mo (money factor ${deal.leaseMF})</td><td>${fmt$(lease.rentCharge)}</td></tr>
      <tr><td>Monthly payment (incl. tax)</td><td>${fmt$(lease.leaseMonthly)}</td></tr>
      <tr><td>Drive-off</td><td>${fmt$(lease.driveOff)}</td></tr>
      <tr><td>Disposition fee</td><td>${fmt$(lease.disposition)}</td></tr>
      <tr class="total"><td>Total lease cost</td><td>${fmt$(lease.totalLease)}</td></tr>
    </table>
    <p class="tip" style="margin-top:8px">Money factor ${deal.leaseMF} ≈ ${(lease.aprEquiv).toFixed(2)}% APR equivalent. Mileage allowance: ${(+deal.leaseMiles || 0).toLocaleString()}/yr (${Math.round(lease.allowedTotal).toLocaleString()} over the term).</p></div>

    <h2>Buy side</h2>
    <div class="card"><table class="breakdown">
      <tr><th></th><th>3 years</th><th>5 years</th></tr>
      <tr><td>Out of pocket (down + payments)</td><td>${fmt$(lease.buy3.paid)}</td><td>${fmt$(lease.buy5.paid)}</td></tr>
      <tr><td>Est. equity (value − loan balance)</td><td class="pos">${fmt$(lease.buy3.equity)}</td><td class="pos">${fmt$(lease.buy5.equity)}</td></tr>
      <tr class="total"><td>Net cost</td><td>${fmt$(lease.buy3.net)}</td><td>${fmt$(lease.buy5.net)}</td></tr>
    </table></div>

    <div class="card no-print">
      <h3>Assumptions (editable)</h3>
      <div class="grid2">
        <div class="field"><label for="as-retain3">Retained value @ 3yr (% of MSRP)</label><input id="as-retain3" type="number" min="0" max="100" value="${r3}"></div>
        <div class="field"><label for="as-retain5">Retained value @ 5yr (% of MSRP)</label><input id="as-retain5" type="number" min="0" max="100" value="${r5}"></div>
        <div class="field"><label for="as-over">Lease overage ($/mile)</label><input id="as-over" type="number" min="0" max="1" step="0.01" value="${over}"></div>
      </div>
      <p><button class="btn secondary" id="as-recalc-btn">Recalculate</button></p>
      <p class="tip" style="margin-top:8px">Mileage note: at ${fmt$(over)}/mile over, every 1,000 miles over your allowance costs ~${fmt$(over * 1000)}. Drive a lot? Buying usually wins.</p>
    </div>`;

  document.getElementById('as-recalc-btn').addEventListener('click', () => {
    deal.leaseAssump = {
      retain3: +document.getElementById('as-retain3').value || 55,
      retain5: +document.getElementById('as-retain5').value || 40,
      overRate: +document.getElementById('as-over').value || 0.20,
    };
    upsertDeal(deal);
    renderLease(id);
  });
}

function renderScore(id) {
  const deal = getDeal(id);
  const box = document.getElementById('score-content');
  if (!deal) { box.innerHTML = '<div class="card"><p>Deal not found.</p></div>'; return; }
  const s = deal.score, m = deal.metrics, flags = deal.flags || [];
  const p = s.parts;
  const dialC = 2 * Math.PI * 54;
  const dialOff = dialC * (1 - s.score / 100);
  const comps = (deal.comps || []).filter(c => c.otd > 0);

  box.innerHTML = `
    <h1 class="no-print">Deal score — ${esc(vehicleLabel(deal))}</h1>
    <div class="card">
      <div class="score-wrap">
        <div class="score-dial" role="img" aria-label="Deal score ${s.score} out of 100">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="54" fill="none" stroke="#1A2036" stroke-width="12"/>
            <circle cx="70" cy="70" r="54" fill="none" stroke="${s.score >= 70 ? '#22C55E' : s.score >= 45 ? '#F59E0B' : '#DC2626'}"
              stroke-width="12" stroke-linecap="round" stroke-dasharray="${dialC.toFixed(1)}" stroke-dashoffset="${dialOff.toFixed(1)}"/>
          </svg>
          <div class="num"><b>${s.score}</b><span>deal score</span></div>
        </div>
        <div style="flex:1;min-width:220px">
          <p style="color:var(--muted-fg);font-size:.9rem">Scored against the comps <strong style="color:var(--fg)">you</strong> provided plus documented fee norms — not a live market feed.</p>
          <div class="formula">discount ${p.discountPts.toFixed(0)} + comps ${p.compPts.toFixed(0)} + term ${p.termPts.toFixed(0)} + clean-fees ${p.feePts.toFixed(0)}${p.hasComps ? '' : ' (no comps — weights redistributed)'}</div>
        </div>
      </div>
    </div>

    <h2>Analyst's take</h2>
    <div class="card" id="llm-card">
      ${deal.llm ? `<div class="llm-body">${esc(deal.llm)}</div>`
        : (!loadKey() || !loadKey().key
          ? `<div class="notice warn">No API key saved — the AI negotiation analysis needs one. <a href="#/setup" data-nav="setup">Set it up</a> (30 seconds). The math and score above are complete without it.</div>`
          : `<div aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div><p style="color:var(--muted-fg);font-size:.9rem">Running the AI negotiation analysis on your key…</p></div>`)}
    </div>

    <h2 class="no-print">Negotiation sheet</h2>
    <div class="card" id="sheet-content">
      <div class="sheet-head">
        <h1>OutTheDoor — Negotiation Sheet</h1>
        <p style="color:var(--muted-fg)">${esc(vehicleLabel(deal))} · ${new Date().toLocaleDateString()}</p>
      </div>
      <table class="breakdown">
        <tr><th>Line item</th><th>Amount</th></tr>
        <tr><td>MSRP</td><td>${fmt$(m.msrp)}</td></tr>
        <tr><td>Dealer discount</td><td class="pos">−${fmt$(+deal.discount || 0)}</td></tr>
        <tr><td>Selling price</td><td>${fmt$(m.selling)}</td></tr>
        <tr><td>Tax + fees + add-ons</td><td>+${fmt$(m.tax + m.feesTotal)}</td></tr>
        <tr class="total"><td>My out-the-door number</td><td>${fmt$(m.otd)}</td></tr>
        <tr><td>Target monthly (${deal.term}mo @ ${esc(String(deal.apr))}%)</td><td>${fmt$(m.payments[+deal.term] || m.payments[60])}</td></tr>
      </table>
      <h3 style="margin-top:16px">Push back on</h3>
      ${flags.filter(f => f.sev !== 'info').map(f => `<div class="talking-point"><strong>[${f.sev.replace('-', ' ').toUpperCase()}] ${esc(f.title)}</strong><br>${f.ask ? esc(f.ask) : esc(f.text)}</div>`).join('') || '<p style="color:var(--muted-fg)">No major flags — hold your discount and walk if they add anything.</p>'}
      <h3 style="margin-top:16px">Say this</h3>
      <div class="talking-point">"My out-the-door number is <strong>${fmt$(m.otd)}</strong>. Get there however you like — I'm not negotiating monthly payments."</div>
      <div class="talking-point">"I have my own financing at ${esc(String(deal.apr))}%. Beat it or I'll use mine."</div>
      <div class="talking-point">"Remove the add-ons I didn't ask for, or itemize them at cost. I'm ready to sign today at my number."</div>
    </div>`;
}

async function runLLMForDeal(deal) {
  const saved = loadKey();
  if (!saved || !saved.key) return;
  try {
    const m = deal.metrics;
    const lease = leaseMath(deal, m);
    const { system, user } = buildVerdictPrompt(deal, m, deal.flags, lease, deal.score);
    const text = await callLLM(saved.provider, saved.key, saved.model || PROVIDERS[saved.provider].defaultModel, system, user, 900);
    deal.llm = text.trim();
    upsertDeal(deal);
    bumpSpend();
    if (currentDealId === deal.id) {
      const card = document.getElementById('llm-card');
      if (card) card.innerHTML = `<div class="llm-body">${esc(deal.llm)}</div>`;
      syncSetupUI();
    }
  } catch (e) {
    const card = document.getElementById('llm-card');
    if (card && currentDealId === deal.id) {
      card.innerHTML = `<div class="notice warn">AI analysis failed: ${esc(e.message)}. The math above is unaffected — your numbers are complete without it.</div>`;
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
    list.innerHTML = '<div class="card"><p style="color:var(--muted-fg)">No deals yet. <a href="#/new" data-nav="new" style="color:var(--accent)">Decode your first deal</a>.</p></div>';
    return;
  }
  list.innerHTML = deals.map(d => `
    <div class="deal-row" data-open="${d.id}" role="button" tabindex="0" aria-label="Open ${esc(vehicleLabel(d))}">
      <div class="score-badge ${scoreClass(d.score.score)}">${d.score.score}</div>
      <div class="info"><strong>${esc(vehicleLabel(d))}</strong>
        <small>OTD ${fmt$(d.metrics.otd)} &middot; ${fmt$(d.metrics.payments[+d.term] || d.metrics.payments[60])}/mo &middot; ${esc(STATES[d.state] ? STATES[d.state].name : '')}</small></div>
      <div class="row-actions no-print">
        <label class="compare-check"><input type="checkbox" data-compare="${d.id}" ${compareSel.has(d.id) ? 'checked' : ''}> Compare</label>
        <button data-edit="${d.id}">Edit</button>
        <button data-del="${d.id}" aria-label="Delete">Delete</button>
      </div>
    </div>`).join('');
}

function renderCompare() {
  const deals = compareSel.size >= 2 ? [...compareSel].map(getDeal).filter(Boolean)
    : loadDeals().slice(0, 3);
  const box = document.getElementById('compare-content');
  if (deals.length < 2) { box.innerHTML = '<p style="color:var(--muted-fg)">Select at least 2 deals in History to compare.</p>'; return; }
  const rows = [
    ['Deal score', d => d.score.score, 'max'],
    ['Out-the-door', d => d.metrics.otd, 'min'],
    ['Selling price', d => d.metrics.selling, 'min'],
    ['Discount %', d => d.metrics.discountPct * 100, 'max', v => v.toFixed(1) + '%'],
    ['Doc fee', d => +d.docFee || 0, 'min', v => fmt$(v)],
    ['Add-ons total', d => d.metrics.addOnTotal, 'min', v => fmt$(v)],
    ['Tax', d => d.metrics.tax, 'min', v => fmt$(v)],
    ['Amount financed', d => d.metrics.amountFinanced, 'min', v => fmt$(v)],
    ['Monthly (60mo)', d => d.metrics.payments[60], 'min', v => fmt$(v)],
  ];
  let html = '<table class="compare"><tr><th></th>' + deals.map(d => `<th>${esc(vehicleLabel(d))}</th>`).join('') + '</tr>';
  rows.forEach(([label, fn, dir, fmtFn]) => {
    const vals = deals.map(fn);
    const best = dir === 'max' ? Math.max(...vals) : Math.min(...vals);
    html += `<tr><th>${label}</th>` + deals.map((d, i) => {
      const raw = vals[i];
      const shown = fmtFn ? fmtFn(raw) : (label === 'Deal score' ? raw : fmt$(raw));
      return `<td class="${raw === best ? 'winner' : ''}">${esc(String(shown))}</td>`;
    }).join('') + '</tr>';
  });
  box.innerHTML = html + '</table>';
}

/* ================= Form & init ================= */
function addonRow(name, amount) {
  const div = document.createElement('div');
  div.className = 'addon-row';
  div.innerHTML = `<input placeholder="Add-on name (e.g. VIN etch)" value="${esc(name || '')}" aria-label="Add-on name">
    <input type="number" min="0" placeholder="$" value="${amount != null ? amount : ''}" aria-label="Add-on amount">
    <button type="button" class="row-del" aria-label="Remove add-on">×</button>`;
  div.querySelector('.row-del').addEventListener('click', () => div.remove());
  return div;
}
function compRow(label, otd) {
  const div = document.createElement('div');
  div.className = 'comp-row';
  div.innerHTML = `<input placeholder="Dealer / quote label" value="${esc(label || '')}" aria-label="Comp label">
    <input type="number" min="0" placeholder="OTD $" value="${otd != null ? otd : ''}" aria-label="Comp OTD">
    <button type="button" class="row-del" aria-label="Remove comp">×</button>`;
  div.querySelector('.row-del').addEventListener('click', () => { div.remove(); syncCompCount(); });
  return div;
}
function syncCompCount() {
  const n = document.querySelectorAll('#comp-rows .comp-row').length;
  document.getElementById('comp-count').textContent = n ? '(' + n + ')' : '';
}

function readForm() {
  const v = id => document.getElementById(id).value.trim();
  const addOns = [...document.querySelectorAll('#addon-rows .addon-row')].map(r => {
    const [n, a] = r.querySelectorAll('input');
    return { name: n.value.trim(), amount: +a.value || 0 };
  }).filter(a => a.name || a.amount > 0);
  const comps = [...document.querySelectorAll('#comp-rows .comp-row')].map(r => {
    const [l, o] = r.querySelectorAll('input');
    return { label: l.value.trim(), otd: +o.value || 0 };
  }).filter(c => c.otd > 0);
  return {
    id: 'deal-' + Date.now().toString(36),
    year: v('f-year'), make: v('f-make'), model: v('f-model'), trim: v('f-trim'),
    msrp: +v('f-msrp'), discount: +v('f-discount'), rebates: +v('f-rebates'),
    state: document.getElementById('f-state').value, zip: v('f-zip'), taxRate: +v('f-taxrate'),
    docFee: +v('f-docfee'), titleReg: +v('f-titlereg'), addOns,
    tradeValue: +v('f-tradevalue'), tradePayoff: +v('f-tradeoff'), down: +v('f-down'),
    apr: +v('f-apr'), term: +v('f-term'),
    leaseMF: v('f-mf') ? +v('f-mf') : null, leaseResidual: v('f-residual') ? +v('f-residual') : null,
    leaseTerm: +v('f-leaseterm') || 36, leaseMiles: +v('f-mileage') || 12000,
    leaseDisposition: +v('f-disposition') || 0, leaseDriveOff: +v('f-driveoff') || 0,
    comps, createdAt: new Date().toISOString(),
  };
}

function loadDealIntoForm(id) {
  const d = getDeal(id);
  if (!d) return;
  const set = (el, val) => { document.getElementById(el).value = val == null ? '' : val; };
  set('f-year', d.year); set('f-make', d.make); set('f-model', d.model); set('f-trim', d.trim);
  set('f-msrp', d.msrp); set('f-discount', d.discount); set('f-rebates', d.rebates);
  document.getElementById('f-state').value = d.state || 'FL'; syncStateUI();
  set('f-zip', d.zip); set('f-taxrate', d.taxRate);
  set('f-docfee', d.docFee); set('f-titlereg', d.titleReg);
  document.getElementById('f-titlereg').dataset.touched = '1';
  const ar = document.getElementById('addon-rows'); ar.innerHTML = '';
  (d.addOns || []).forEach(a => ar.appendChild(addonRow(a.name, a.amount)));
  if (!(d.addOns || []).length) ar.appendChild(addonRow('', ''));
  set('f-tradevalue', d.tradeValue); set('f-tradeoff', d.tradePayoff); set('f-down', d.down);
  set('f-apr', d.apr); document.getElementById('f-term').value = String(d.term || 60);
  set('f-mf', d.leaseMF); set('f-residual', d.leaseResidual); set('f-leaseterm', d.leaseTerm);
  set('f-mileage', d.leaseMiles); set('f-disposition', d.leaseDisposition); set('f-driveoff', d.leaseDriveOff);
  const cr = document.getElementById('comp-rows'); cr.innerHTML = '';
  (d.comps || []).forEach(c => cr.appendChild(compRow(c.label, c.otd)));
  syncCompCount();
  go('new');
}

function init() {
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); go(el.dataset.nav); });
  });

  // State select
  const stateSel = document.getElementById('f-state');
  stateSel.innerHTML = Object.entries(STATES).map(([code, s]) =>
    `<option value="${code}"${code === 'FL' ? ' selected' : ''}>${s.name}</option>`).join('');
  stateSel.addEventListener('change', () => {
    document.getElementById('f-titlereg').dataset.touched = '';
    syncStateUI();
  });
  document.getElementById('f-titlereg').addEventListener('input', e => { e.target.dataset.touched = '1'; });
  syncStateUI();

  // Dynamic rows
  document.getElementById('addon-rows').appendChild(addonRow('', ''));
  document.getElementById('addon-add-btn').addEventListener('click', () => {
    const rows = document.querySelectorAll('#addon-rows .addon-row');
    if (rows.length >= 6) return;
    document.getElementById('addon-rows').appendChild(addonRow('', ''));
  });
  document.getElementById('comp-add-btn').addEventListener('click', () => {
    const rows = document.querySelectorAll('#comp-rows .comp-row');
    if (rows.length >= 3) return;
    document.getElementById('comp-rows').appendChild(compRow('', ''));
    syncCompCount();
  });

  // Provider picker
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

  // Export / import
  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'outthedoor', version: 1, deals: loadDeals() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'outthedoor-deals.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', e => {
    const errEl = document.getElementById('settings-error'), okEl = document.getElementById('settings-success');
    errEl.textContent = ''; okEl.textContent = '';
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(r.result);
        const deals = Array.isArray(j) ? j : j.deals;
        if (!Array.isArray(deals)) throw new Error('bad format');
        const cur = loadDeals();
        deals.forEach(dd => { if (dd && dd.id && !cur.some(c => c.id === dd.id)) cur.unshift(dd); });
        saveDeals(cur);
        okEl.textContent = 'Imported ' + deals.length + ' deal(s).';
      } catch { errEl.textContent = 'Could not read that file — expected OutTheDoor JSON.'; }
    };
    r.readAsText(f);
    e.target.value = '';
  });

  // Deal form submit
  document.getElementById('deal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('form-error');
    errEl.textContent = '';
    const deal = readForm();
    if (!deal.msrp || deal.msrp <= 0) { errEl.textContent = 'Enter the MSRP.'; return; }
    if (deal.discount < 0 || deal.discount >= deal.msrp) { errEl.textContent = 'Discount looks off — check it against the MSRP.'; return; }
    const btn = document.getElementById('analyze-btn');
    btn.disabled = true; btn.textContent = 'Decoding…';

    deal.metrics = calc(deal);
    deal.flags = feeFlags(deal, deal.metrics);
    deal.score = dealScore(deal, deal.metrics, deal.flags);
    upsertDeal(deal);
    btn.disabled = false; btn.textContent = 'Decode this deal';
    go('results', deal.id);
    runLLMForDeal(deal); // async; renders into the card when done
  });

  document.getElementById('sheet-btn').addEventListener('click', () => window.print());

  // History interactions
  document.getElementById('history-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteDeal(del.dataset.del); renderHistory(); return; }
    const edt = e.target.closest('[data-edit]');
    if (edt) { e.stopPropagation(); loadDealIntoForm(edt.dataset.edit); return; }
    const cmp = e.target.closest('[data-compare]');
    if (cmp) {
      const id = cmp.dataset.compare;
      if (cmp.checked) { if (compareSel.size >= 3) { cmp.checked = false; return; } compareSel.add(id); }
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
