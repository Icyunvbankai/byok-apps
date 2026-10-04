/* DealLens v2 — static app. Deterministic math in code; the LLM narrates only.
   Strategies: buy (buy & hold), flip (rehab flip), build (new construction).
   Loan types modify the buy & flip math (conventional, fha, va, dscr, seller, cash). */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'deallens_key';     // {provider, key, model}
const LS_DEALS = 'deallens_deals'; // array of deal objects (photos stripped — session only)

function loadKey() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveKey(obj) { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadDeals() {
  try { return JSON.parse(localStorage.getItem(LS_DEALS) || '[]'); } catch { return []; }
}
/* Photos are object URLs / pasted URLs held in memory only — never persist them. */
function saveDeals(deals) {
  localStorage.setItem(LS_DEALS, JSON.stringify(deals.map(d => Object.assign({}, d, { photos: [] }))));
}
/* In-memory cache keeps the full deal (with photos) for the current session. */
const dealCache = {};
function getDeal(id) { return dealCache[id] || loadDeals().find(d => d.id === id); }
function upsertDeal(deal) {
  dealCache[deal.id] = deal;
  const deals = loadDeals();
  const i = deals.findIndex(d => d.id === deal.id);
  if (i >= 0) deals[i] = deal; else deals.unshift(deal);
  saveDeals(deals);
}
function deleteDeal(id) { delete dealCache[id]; saveDeals(loadDeals().filter(d => d.id !== id)); }

/* ================= Router ================= */
const VIEWS = ['landing', 'setup', 'new', 'results', 'report', 'history', 'compare', 'pricing'];
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
  if ((name === 'results' || name === 'report') && arg) currentDealId = arg;
  location.hash = '#/' + name + (arg ? '/' + arg : '');
}
function route() {
  const parts = (location.hash || '#/landing').replace('#/', '').split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if (name === 'results' && parts[1]) { currentDealId = parts[1]; renderResults(currentDealId); }
  if (name === 'report' && parts[1]) { currentDealId = parts[1]; renderReport(currentDealId); }
  showView(name);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', route);
}

/* ================= Loan types ================= */
/* Each loan type adjusts down payment default, rate, financed fees, and monthly MI/MIP.
   resolveLoan() is the single place financing is computed — calc() and calcFlip() use it. */
const LOAN_TYPES = {
  conventional: { label: 'Conventional', defaultDown: 20,
    note: 'Investor default 20% down. PMI of 0.50%/yr of the loan is added monthly when down < 20%.' },
  fha: { label: 'FHA', defaultDown: 3.5,
    note: '3.5% down. Upfront MIP 1.75% is financed into the loan; annual MIP 0.55%/yr of loan balance added monthly.' },
  va: { label: 'VA', defaultDown: 0,
    note: '0% down. VA funding fee 2.15% (first use) financed into the loan. No monthly mortgage insurance.' },
  dscr: { label: 'DSCR investor loan', defaultDown: 25,
    note: '25% down. Rate runs +1.00% over your base rate input (investor premium). No monthly MI.' },
  seller: { label: 'Seller financing', defaultDown: null,
    note: 'Your custom down % and rate below are the seller terms. No mortgage insurance.' },
  cash: { label: 'Cash', defaultDown: 100,
    note: 'No loan. Cash flow = NOI. DSCR does not apply.' },
};

function resolveLoan(d) {
  const num = v => (isFinite(+v) ? +v : 0);
  const type = (d.loanType && LOAN_TYPES[d.loanType]) ? d.loanType : 'conventional';
  const price = num(d.price);
  let downPct = num(d.downPct);
  let ratePct = num(d.ratePct);
  if (type === 'dscr') ratePct += 1.0;                    // investor premium over base rate
  const down = price * downPct / 100;
  const loan0 = Math.max(0, price - down);               // before financed fees
  let financedFee = 0, miM = 0;
  if (type === 'fha') {
    financedFee = loan0 * 0.0175;                        // upfront MIP financed
    miM = (loan0 + financedFee) * 0.0055 / 12;           // annual MIP, monthly
  } else if (type === 'va') {
    financedFee = loan0 * 0.0215;                        // funding fee, first use
  } else if (type === 'conventional') {
    if (downPct < 20 && loan0 > 0) miM = loan0 * 0.005 / 12; // PMI 0.50%/yr
  }
  const loan = type === 'cash' ? 0 : loan0 + financedFee;
  const r = ratePct / 100 / 12, n = (num(d.termYears) || 30) * 12;
  const pi = loan > 0 ? (r > 0
    ? loan * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1)
    : loan / n) : 0;
  return { type, label: LOAN_TYPES[type].label, downPct, ratePct, down, loan0,
           financedFee, loan, miM, pi, effPmt: pi + miM };
}

/* Remaining amortized balance after k months — used for flip payoff. */
function loanBalance(loan, ratePct, termYears, monthsElapsed) {
  const r = ratePct / 100 / 12, n = (termYears || 30) * 12;
  const k = Math.max(0, Math.min(monthsElapsed || 0, n));
  if (loan <= 0) return 0;
  if (r === 0) return Math.max(0, loan * (1 - k / n));
  const pmt = loan * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  const bal = loan * Math.pow(1 + r, k) - pmt * (Math.pow(1 + r, k) - 1) / r;
  return Math.max(0, bal);
}

/* ================= Deterministic calculators ================= */
/* Every dollar figure comes from here. The LLM is never asked to do math. */

/* --- BUY & HOLD --- */
function calc(d) {
  const num = v => (isFinite(+v) ? +v : 0);
  const price = num(d.price), rent = num(d.rent);
  const closingPct = num(d.closingPct);
  const taxA = num(d.taxA), insA = num(d.insA), hoaM = num(d.hoaM);
  const vacPct = num(d.vacPct), maintPct = num(d.maintPct), capexPct = num(d.capexPct), mgmtPct = num(d.mgmtPct);

  const L = resolveLoan(d);
  const closing = price * closingPct / 100;

  const taxM = taxA / 12, insM = insA / 12;
  const vacM = rent * vacPct / 100;
  const maintM = rent * maintPct / 100;
  const capexM = rent * capexPct / 100;
  const mgmtM = rent * mgmtPct / 100;
  const opexM = taxM + insM + hoaM + vacM + maintM + capexM + mgmtM; // excl. financing
  const finM = L.effPmt;                                            // P&I + MI/MIP
  const totalM = opexM + finM;
  const cfM = rent - totalM;
  const cfA = cfM * 12;
  const noiA = (rent - opexM) * 12;
  const capRate = price > 0 ? noiA / price : 0;
  const cashIn = L.down + closing;
  const coc = cashIn > 0 ? cfA / cashIn : 0;
  const annualDebt = finM * 12;
  const dscr = annualDebt > 0 ? noiA / annualDebt : (noiA > 0 ? 99 : 0);
  const rentToPrice = price > 0 ? rent / price : 0;
  const expenseRatio = rent > 0 ? opexM / rent : 0; // 50% rule check
  const breakEvenOcc = rent > 0 ? Math.min(1, Math.max(0, totalM / rent)) : 1;

  // Rent needed to hit DSCR 1.25, solving through the variable (% of rent) expenses:
  // NOI = (rent*(1-varPct) - fixedM) * 12 ;  1.25 = NOI / annualDebt
  const fixedM = taxM + insM + hoaM;
  const varPct = (vacPct + maintPct + capexPct + mgmtPct) / 100;
  const rentForDscr125 = (annualDebt > 0 && varPct < 1)
    ? (1.25 * annualDebt + fixedM * 12) / ((1 - varPct) * 12) : null;

  return { down: L.down, closing, loan: L.loan, loan0: L.loan0, financedFee: L.financedFee,
           pi: L.pi, miM: L.miM, effPmt: L.effPmt, loanLabel: L.label, loanType: L.type,
           ratePctEff: L.ratePct, downPct: L.downPct,
           taxM, insM, hoaM, vacM, maintM, capexM, mgmtM,
           opexM, totalM, cfM, cfA, noiA, capRate, cashIn, coc, annualDebt, dscr,
           rentToPrice, expenseRatio, breakEvenOcc, rentForDscr125,
           onePctPass: rentToPrice >= 0.01, fiftyPctOpex: rent * 0.5,
           price, rent };
}

/* --- REHAB FLIP --- */
function calcFlip(d) {
  const num = v => (isFinite(+v) ? +v : 0);
  const price = num(d.price);
  const f = d.flip || {};
  const rehab = num(f.rehab), arv = num(f.arv);
  const holdMonths = Math.max(0, num(f.holdMonths) || 6);
  const sellCostPct = num(f.sellCostPct) || 0;
  const carryM = num(f.carryM); // monthly carry: taxes, insurance, utilities while held
  const closingPct = num(d.closingPct);

  const L = resolveLoan(d);
  const closing = price * closingPct / 100;
  const holding = (L.effPmt + carryM) * holdMonths;
  const cashIn = L.down + closing + rehab + holding;
  const payoff = loanBalance(L.loan, L.ratePct, num(d.termYears) || 30, holdMonths);
  const sellCosts = arv * sellCostPct / 100;
  const netProceeds = arv - sellCosts - payoff;
  const profit = netProceeds - cashIn;
  const roi = cashIn > 0 ? profit / cashIn : 0;
  const annRoi = holdMonths > 0 ? Math.pow(Math.max(0, 1 + roi), 12 / holdMonths) - 1 : 0;
  const mao = arv * 0.70 - rehab;                                   // 70% rule max allowable offer
  const breakEvenSale = sellCostPct < 100
    ? (payoff + cashIn) / (1 - sellCostPct / 100) : null;            // sale price where profit = 0

  return { down: L.down, closing, loan: L.loan, financedFee: L.financedFee,
           pi: L.pi, miM: L.miM, effPmt: L.effPmt, loanLabel: L.label, loanType: L.type,
           ratePctEff: L.ratePct, rehab, arv, holdMonths, sellCostPct, carryM,
           holding, cashIn, payoff, sellCosts, netProceeds,
           profit, roi, annRoi, mao, breakEvenSale, price };
}

/* --- NEW BUILD --- */
function calcBuild(d) {
  const num = v => (isFinite(+v) ? +v : 0);
  const b = d.build || {};
  const land = num(b.land), hard = num(b.hard);
  const softPct = num(b.softPct);
  const soft = hard * softPct / 100;
  const months = Math.max(0, num(b.months) || 9);
  const carryM = num(b.carryM);   // monthly carry: loan interest, taxes, insurance during build
  const arv = num(b.arv);
  const sellCostPct = num(b.sellCostPct) || 0;
  const sqft = num(b.sqft);

  const carry = carryM * months;
  const totalCost = land + hard + soft + carry;
  const sellCosts = arv * sellCostPct / 100;
  const profit = arv - sellCosts - totalCost;
  const margin = arv > 0 ? profit / arv : 0;      // profit as % of sale price
  const markup = totalCost > 0 ? profit / totalCost : 0; // profit as % of cost
  const costPerSqft = sqft > 0 ? totalCost / sqft : null;
  const breakEvenSale = sellCostPct < 100 ? totalCost / (1 - sellCostPct / 100) : null;

  return { land, hard, softPct, soft, months, carryM, carry, totalCost,
           arv, sellCostPct, sellCosts, profit, margin, markup,
           sqft, costPerSqft, breakEvenSale };
}

/* ================= Risk flags (code, not LLM) ================= */
function codeFlags(d, m) {
  const flags = [];
  const strat = d.strategy || 'buy';
  if (strat === 'buy') {
    if (m.cfM < 0) flags.push({ sev: 'dealbreaker', text: 'Negative monthly cash flow (' + fmt$(-m.cfM) + '/mo). The property loses money from day one at these assumptions.' });
    if (m.dscr < 1 && m.annualDebt > 0) flags.push({ sev: 'dealbreaker', text: 'DSCR below 1.0 — net operating income does not cover the effective payment (P&I + MI/MIP). Most lenders require 1.20–1.25.' });
    else if (m.dscr < 1.25 && m.annualDebt > 0) flags.push({ sev: 'watch', text: 'DSCR of ' + m.dscr.toFixed(2) + ' is under the 1.25 lenders typically want — financing may be harder or pricier.' });
    if (m.hoaM > m.rent * 0.25 && m.rent > 0) flags.push({ sev: 'watch', text: 'HOA is over 25% of rent. Check for rental caps and special assessments in the HOA docs.' });
    if (d.price > 0 && d.taxA / d.price > 0.025) flags.push({ sev: 'watch', text: 'Property tax above 2.5% of price — verify against county records; reassessment risk on sale.' });
    if (m.expenseRatio > 0.6 && m.rent > 0) flags.push({ sev: 'watch', text: 'Operating expenses are ' + Math.round(m.expenseRatio * 100) + '% of rent — well above the 50% rule of thumb.' });
    if (m.rentToPrice < 0.0075 && m.price > 0) flags.push({ sev: 'info', text: 'Rent is under 0.75% of price — fails the 1% rule; needs appreciation or value-add to make sense.' });
    if (m.miM > 0) flags.push({ sev: 'info', text: (m.loanLabel || 'Loan') + ' adds ' + fmt$(m.miM) + '/mo in mortgage insurance — effective payment is ' + fmt$(m.effPmt) + '/mo vs ' + fmt$(m.pi) + '/mo P&I.' });
    return flags;
  }
  if (strat === 'flip') {
    if (m.profit < 0) flags.push({ sev: 'dealbreaker', text: 'Projected loss of ' + fmt$(-m.profit) + ' at a ' + fmt$(m.arv) + ' sale. Do not pay ' + fmt$(m.price) + ' for this flip.' });
    if (m.price > m.mao && m.arv > 0) flags.push({ sev: 'dealbreaker', text: 'Purchase price ' + fmt$(m.price) + ' exceeds the 70%-rule max offer of ' + fmt$(m.mao) + ' — no margin of safety.' });
    if (m.annRoi < 0.15 && m.profit >= 0) flags.push({ sev: 'watch', text: 'Annualized ROI of ' + fmtPct1(m.annRoi) + ' is thin for flip risk — most flippers target 20%+ annualized.' });
    if (m.holdMonths > 9) flags.push({ sev: 'watch', text: 'Holding ' + m.holdMonths + ' months burns ' + fmt$(m.holding) + ' in carry — every extra month eats profit.' });
    return flags;
  }
  // build
  if (m.profit < 0) flags.push({ sev: 'dealbreaker', text: 'Projected loss of ' + fmt$(-m.profit) + ' — total cost exceeds the finished value.' });
  if (m.margin < 0.15 && m.profit >= 0) flags.push({ sev: 'watch', text: 'Margin of ' + fmtPct1(m.margin) + ' is thin for new construction — 15–20%+ is the usual cushion for overruns.' });
  if (m.months > 12) flags.push({ sev: 'watch', text: m.months + '-month build timeline — carry costs compound fast if permits or subs slip.' });
  return flags;
}

/* ================= Scores 0–100 (transparent, shown in UI) ================= */
const clamp01 = v => Math.min(1, Math.max(0, v));

function dealScore(m, flags) {
  const cocS = clamp01(m.coc / 0.12) * 100;          // 12% cash-on-cash = 100
  const capS = clamp01(m.capRate / 0.08) * 100;      // 8% cap rate = 100
  const dscrS = clamp01((m.dscr - 1) / 0.25) * 100;  // 1.25 DSCR = 100
  const rtpS = clamp01(m.rentToPrice / 0.01) * 100;  // 1% rule = 100
  const base = (0.30 * cocS + 0.20 * capS + 0.20 * dscrS + 0.15 * rtpS) / 0.85;
  const penalty = Math.min(15, flags.length * 5);
  return { score: Math.round(Math.max(0, base - penalty)), parts: { cocS, capS, dscrS, rtpS }, penalty, kind: 'buy' };
}

function flipScore(m, flags) {
  const roiS = clamp01(m.annRoi / 0.30) * 100;                    // 30% annualized = 100
  const maoS = m.arv > 0 ? clamp01((m.mao - m.price) / (0.10 * m.arv)) * 100 : 0; // 10% under MAO = 100
  const base = 0.6 * roiS + 0.4 * maoS;
  const penalty = Math.min(15, flags.length * 5);
  return { score: Math.round(Math.max(0, base - penalty)), parts: { roiS, maoS }, penalty, kind: 'flip' };
}

function buildScore(m, flags) {
  const marginS = clamp01(m.margin / 0.20) * 100;    // 20% margin on sale price = 100
  const penalty = Math.min(15, flags.length * 5);
  return { score: Math.round(Math.max(0, marginS - penalty)), parts: { marginS }, penalty, kind: 'build' };
}

/* ================= Property intel (free public sources) ================= */
function intelLinks(addr) {
  const q = encodeURIComponent((addr || '').trim());
  if (!q) return [];
  const dash = (addr || '').trim().replace(/\s+/g, '-');
  return [
    { label: 'St. Lucie Co. Property Appraiser', url: 'https://www.paslc.gov/', note: 'Search the address for assessed value, tax history, exemptions' },
    { label: 'Parcel lines / GIS map — pick your county', url: 'https://gis.stlucieco.gov/', note: 'St. Lucie GIS parcel viewer (other counties: use your county GIS site)' },
    { label: 'Google Street View / Maps', url: 'https://www.google.com/maps/search/?api=1&query=' + q, note: 'Free, no key — drop into Street View from the map' },
    { label: 'Zillow address search', url: 'https://www.zillow.com/homes/' + q + '_rb/', note: '' },
    { label: 'Realtor.com address search', url: 'https://www.realtor.com/realestateandhomes-search/' + encodeURIComponent(dash), note: '' },
    { label: 'Redfin (via Google)', url: 'https://www.google.com/search?q=site:redfin.com+' + q, note: '' },
  ];
}
function streetViewEmbed(addr) {
  const q = encodeURIComponent((addr || '').trim());
  return q ? 'https://maps.google.com/maps?q=' + q + '&z=17&output=embed' : '';
}
/* Years since last sale + price change since last sale, from manual intel fields. */
function intelStats(price, lastSalePrice, lastSaleDate, nowMs) {
  const out = { yearsSinceSale: null, priceChangePct: null };
  if (lastSaleDate) {
    const then = new Date(lastSaleDate + 'T12:00:00');
    if (!isNaN(then)) out.yearsSinceSale = ((nowMs || Date.now()) - then.getTime()) / (365.25 * 24 * 3600 * 1000);
  }
  if (isFinite(+lastSalePrice) && +lastSalePrice > 0 && isFinite(+price) && +price > 0) {
    out.priceChangePct = (+price - +lastSalePrice) / +lastSalePrice;
  }
  return out;
}

/* Recompute metrics for deals saved by older app versions missing new fields. */
function ensureMetrics(deal) {
  if (!deal) return deal;
  const strat = deal.strategy || 'buy';
  const m = deal.metrics || {};
  const stale = strat === 'buy' ? (m.rentForDscr125 === undefined || m.loanLabel === undefined)
    : strat === 'flip' ? m.mao === undefined : m.margin === undefined;
  if (stale || !deal.score) { analyzeDeal(deal); upsertDeal(deal); }
  return deal;
}

/* ================= Formatting ================= */
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const fmtPct = v => (v * 100).toFixed(2) + '%';
const fmtPct1 = v => (v * 100).toFixed(1) + '%';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => { try { return new Date(iso + 'T12:00:00').toLocaleDateString('en-US'); } catch { return iso || '—'; } };

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calc, calcFlip, calcBuild, resolveLoan, loanBalance, codeFlags, dealScore, flipScore, buildScore, intelStats, intelLinks, streetViewEmbed, LOAN_TYPES };
  if (require.main === module) runSelfTests();
}

function runSelfTests() {
  const assert = require('assert');
  const approx = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, msg + ': got ' + a + ', want ~' + b);

  // T1: legacy buy math unchanged — $200k / $1,800 / 20% down / 7% 30yr conventional
  const t1 = calc({ price: 200000, rent: 1800, taxA: 2400, insA: 1200, hoaM: 0, downPct: 20, ratePct: 7, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 8 });
  approx(t1.pi, 1064.48, 0.05, 't1 P&I');
  approx(t1.miM, 0, 0.001, 't1 no MI at 20% down');
  approx(t1.cfM, 21.52, 0.10, 't1 cash flow');
  approx(t1.capRate, 0.06516, 0.0005, 't1 cap rate');
  approx(t1.coc, 0.00587, 0.0005, 't1 cash-on-cash');
  approx(t1.dscr, 1.020, 0.005, 't1 DSCR');
  const s1 = dealScore(t1, codeFlags({ price: 200000, taxA: 2400 }, t1));
  assert(s1.score >= 30 && s1.score <= 40, 't1 score in 30-40, got ' + s1.score);

  // T2: strong buy deal
  const t2 = calc({ price: 150000, rent: 1600, taxA: 1800, insA: 900, hoaM: 0, downPct: 25, ratePct: 6.5, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 8 });
  approx(t2.pi, 711.1, 0.5, 't2 P&I');
  approx(t2.cfM, 295.9, 1.0, 't2 cash flow');
  approx(t2.capRate, 0.0806, 0.002, 't2 cap rate');
  const s2 = dealScore(t2, codeFlags({ price: 150000, taxA: 1800 }, t2));
  assert(s2.score >= 85, 't2 score >= 85, got ' + s2.score);

  // T3: all-cash — no debt, DSCR sentinel
  const t3 = calc({ price: 100000, rent: 1100, taxA: 1200, insA: 800, hoaM: 0, downPct: 100, ratePct: 0, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 0, loanType: 'cash' });
  assert(t3.pi === 0 && t3.miM === 0, 't3 no payment');
  assert(t3.dscr === 99, 't3 DSCR sentinel');
  assert(t3.rentForDscr125 === null, 't3 no DSCR target for cash');
  approx(t3.cfM, t3.noiA / 12, 0.01, 't3 cash flow = NOI');

  // T4: conventional PMI kicks in below 20% down
  const t4 = calc({ price: 200000, rent: 1800, taxA: 2400, insA: 1200, hoaM: 0, downPct: 10, ratePct: 7, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 8, loanType: 'conventional' });
  approx(t4.miM, 180000 * 0.005 / 12, 0.01, 't4 PMI');
  approx(t4.effPmt, t4.pi + t4.miM, 0.01, 't4 effective payment');

  // T5: FHA — 3.5% down, upfront MIP financed, annual MIP monthly
  const t5 = resolveLoan({ price: 200000, downPct: 3.5, ratePct: 6.5, termYears: 30, loanType: 'fha' });
  approx(t5.down, 7000, 0.01, 't5 down');
  approx(t5.financedFee, 193000 * 0.0175, 0.01, 't5 upfront MIP');
  approx(t5.loan, 193000 * 1.0175, 0.01, 't5 loan incl fee');
  approx(t5.miM, 193000 * 1.0175 * 0.0055 / 12, 0.01, 't5 annual MIP');

  // T6: VA — 0% down, funding fee financed, no monthly MI
  const t6 = resolveLoan({ price: 300000, downPct: 0, ratePct: 6.25, termYears: 30, loanType: 'va' });
  approx(t6.loan, 300000 * 1.0215, 0.01, 't6 loan incl funding fee');
  assert(t6.miM === 0, 't6 no monthly MI');

  // T7: DSCR — 25% down, +1% rate premium
  const t7 = resolveLoan({ price: 200000, downPct: 25, ratePct: 7, termYears: 30, loanType: 'dscr' });
  approx(t7.ratePct, 8, 0.001, 't7 rate bump');
  assert(t7.miM === 0, 't7 no MI');

  // T8: flip — $165k buy, $60k rehab, $330k ARV, 6 mo hold, 8% sell costs, cash
  const t8 = calcFlip({ price: 165000, downPct: 100, ratePct: 0, termYears: 30, closingPct: 2, loanType: 'cash',
    flip: { rehab: 60000, arv: 330000, holdMonths: 6, sellCostPct: 8, carryM: 500 } });
  approx(t8.cashIn, 165000 + 3300 + 60000 + 3000, 0.01, 't8 cash in');
  approx(t8.sellCosts, 26400, 0.01, 't8 sell costs');
  approx(t8.profit, 330000 - 26400 - 231300, 0.01, 't8 profit');
  approx(t8.roi, 72300 / 231300, 0.0005, 't8 ROI');
  approx(t8.mao, 330000 * 0.7 - 60000, 0.01, 't8 MAO');
  approx(t8.breakEvenSale, 231300 / 0.92, 0.5, 't8 break-even sale');
  const fs8 = flipScore(t8, codeFlags({ strategy: 'flip', price: 165000 }, t8));
  assert(fs8.score > 60, 't8 flip score strong, got ' + fs8.score);

  // T9: flip with loan — payoff < original loan after holding
  const t9 = calcFlip({ price: 200000, downPct: 20, ratePct: 7, termYears: 30, closingPct: 2, loanType: 'conventional',
    flip: { rehab: 40000, arv: 300000, holdMonths: 6, sellCostPct: 8, carryM: 400 } });
  assert(t9.payoff < 160000 && t9.payoff > 150000, 't9 payoff amortized, got ' + t9.payoff);
  assert(t9.miM === 0, 't9 no PMI at 20% down');

  // T10: build — $60k land, $220k hard, 15% soft, $350k ARV, 9 mo, 1800 sqft
  const t10 = calcBuild({ build: { land: 60000, hard: 220000, softPct: 15, arv: 350000, months: 9, carryM: 800, sellCostPct: 8, sqft: 1800 } });
  approx(t10.soft, 33000, 0.01, 't10 soft costs');
  approx(t10.totalCost, 60000 + 220000 + 33000 + 7200, 0.01, 't10 total cost');
  approx(t10.profit, 350000 - 28000 - 320200, 0.01, 't10 profit');
  approx(t10.margin, 1800 / 350000, 0.0005, 't10 margin');
  approx(t10.costPerSqft, 320200 / 1800, 0.01, 't10 cost/sqft');

  // T11: intel stats
  const t11 = intelStats(200000, 150000, '2020-01-01', new Date('2026-01-01T12:00:00').getTime());
  approx(t11.yearsSinceSale, 6, 0.02, 't11 years since sale');
  approx(t11.priceChangePct, 1 / 3, 0.0005, 't11 price change');

  // T12: rent needed for DSCR 1.25 solves correctly (verify by recompute)
  const t12 = calc({ price: 200000, rent: 1800, taxA: 2400, insA: 1200, hoaM: 0, downPct: 20, ratePct: 7, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 8 });
  const chk = calc(Object.assign({}, { price: 200000, taxA: 2400, insA: 1200, hoaM: 0, downPct: 20, ratePct: 7, termYears: 30, closingPct: 2, vacPct: 5, maintPct: 5, capexPct: 5, mgmtPct: 8 }, { rent: t12.rentForDscr125 }));
  approx(chk.dscr, 1.25, 0.005, 't12 DSCR target');

  console.log('All calculator self-tests passed (12 tests).');
}

/* ================= LLM (BYOK) ================= */
/* Single narrative call. The prompt embeds pre-computed numbers; the model is
   told explicitly to use them and never recompute. Loan type + strategy are
   included so the narrative matches the financing the user chose. */
const PROVIDERS = {
  openai:    { name: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions', keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'gpt-4o-mini', costHint: '~$0.01/analysis' },
  xai:       { name: 'xAI',       url: 'https://api.x.ai/v1/chat/completions',       keyHeader: k => ({ 'Authorization': 'Bearer ' + k }), defaultModel: 'grok-3-mini',  costHint: '~$0.01/analysis' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages',      keyHeader: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }), defaultModel: 'claude-haiku-4-5', costHint: '~$0.02/analysis', corsNote: true },
  gemini: { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', keyHeader: k => ({}), defaultModel: 'gemini-3.5-flash-lite', costHint: '~$0.01/analysis', gemini: true },
};

const STRATEGY_LABELS = { buy: 'Buy & Hold', flip: 'Rehab Flip', build: 'New Build' };

function buildAnalysisPrompt(deal, m, flags) {
  const strat = deal.strategy || 'buy';
  const loanLine = strat === 'build' ? 'Financing: cash-basis build analysis (no loan modeled)'
    : 'Loan: ' + (m.loanLabel || 'Conventional') + ' — down ' + fmt$(m.down) + ', effective rate ' + (m.ratePctEff != null ? m.ratePctEff.toFixed(3) : deal.ratePct) + '%'
      + (m.miM > 0 ? ', MI/MIP ' + fmt$(m.miM) + '/mo' : ', no monthly MI') + ', effective payment ' + fmt$(m.effPmt) + '/mo';
  let numbers, ask;
  if (strat === 'flip') {
    numbers =
`- Purchase ${fmt$(m.price)}, rehab ${fmt$(m.rehab)}, ARV ${fmt$(m.arv)}, hold ${m.holdMonths} mo, selling costs ${m.sellCostPct}%
- Total cash invested ${fmt$(m.cashIn)} (down ${fmt$(m.down)} + closing ${fmt$(m.closing)} + rehab + ${fmt$(m.holding)} holding)
- Loan payoff at sale ${fmt$(m.payoff)}, net proceeds ${fmt$(m.netProceeds)}
- Profit ${fmt$(m.profit)}, ROI on cash ${fmtPct(m.roi)}, annualized ROI ${fmtPct(m.annRoi)}
- 70%-rule max offer ${fmt$(m.mao)}, break-even sale price ${m.breakEvenSale != null ? fmt$(m.breakEvenSale) : 'n/a'}`;
    ask = `Write:\n1. VERDICT: 2-3 sentences on whether this flip works and why.\n2. RISKS: 3-5 specific risk flags with severity (info/watch/dealbreaker) — rehab overruns, ARV comps, holding time.\n3. OFFER: a suggested offer price and a walk-away price, each tied to the 70% rule and at least 20% annualized ROI.`;
  } else if (strat === 'build') {
    numbers =
`- Land ${fmt$(m.land)}, hard costs ${fmt$(m.hard)}, soft costs ${fmt$(m.soft)} (${m.softPct}%), carry ${fmt$(m.carry)} over ${m.months} mo
- Total project cost ${fmt$(m.totalCost)}${m.costPerSqft != null ? ' (' + fmt$(m.costPerSqft) + '/sqft on ' + m.sqft.toLocaleString() + ' sqft)' : ''}
- Finished value (ARV) ${fmt$(m.arv)}, selling costs ${fmt$(m.sellCosts)}
- Profit ${fmt$(m.profit)}, margin on sale price ${fmtPct(m.margin)}, markup on cost ${fmtPct(m.markup)}
- Break-even sale price ${m.breakEvenSale != null ? fmt$(m.breakEvenSale) : 'n/a'}`;
    ask = `Write:\n1. VERDICT: 2-3 sentences on whether this build works and why.\n2. RISKS: 3-5 specific risk flags with severity (info/watch/dealbreaker) — cost overruns, timeline slip, ARV comps.\n3. GO/NO-GO: the margin cushion needed and what would kill the deal.`;
  } else {
    numbers =
`- Price ${fmt$(m.price)}, rent ${fmt$(m.rent)}/mo, ${loanLine}
- Effective monthly payment (P&I + MI/MIP) ${fmt$(m.effPmt)}, operating expenses ${fmt$(m.opexM)}/mo, cash flow ${fmt$(m.cfM)}/mo
- Cap rate ${fmtPct(m.capRate)}, cash-on-cash ${fmtPct(m.coc)}, DSCR ${m.dscr === 99 ? 'n/a (cash)' : m.dscr.toFixed(2)}, rent-to-price ${fmtPct1(m.rentToPrice)}/mo
- Cash invested ${fmt$(m.cashIn)}, 1% rule ${m.onePctPass ? 'PASS' : 'FAIL'}, break-even occupancy ${fmtPct1(m.breakEvenOcc)}
- Rent needed for DSCR 1.25: ${m.rentForDscr125 != null ? fmt$(m.rentForDscr125) + '/mo' : 'n/a (cash purchase)'}`;
    ask = `Write:\n1. VERDICT: 2-3 sentences on whether this deal works and why.\n2. RISKS: 3-5 specific risk flags with severity (info/watch/dealbreaker) — go beyond the code flags above.\n3. OFFER: a suggested offer price and a walk-away price, each tied to hitting at least 8% cash-on-cash. Show the target price numbers.`;
  }
  const intel = deal.intel ? `\nPROPERTY INTEL (user-supplied): address ${deal.intel.addr || deal.addr || 'n/a'}, days on market ${deal.intel.dom || 'n/a'}, last sale ${deal.intel.lastSaleDate || 'n/a'} at ${deal.intel.lastSalePrice ? fmt$(+deal.intel.lastSalePrice) : 'n/a'}, built ${deal.intel.yearBuilt || 'n/a'}, sqft ${deal.intel.sqft || 'n/a'}` : '';
  return {
    system: 'You are a conservative property underwriter. Be direct and skeptical. ' +
      'Use ONLY the numbers provided below — do not recompute ratios, do not invent comps or market data. ' +
      'Label anything you estimate as ESTIMATE. Keep the whole response under 220 words.',
    user:
`Deal: ${deal.name || 'Untitled'} — strategy: ${STRATEGY_LABELS[strat] || strat}${intel}
VERIFIED NUMBERS (computed in code — trust these):
${numbers}
CODE FLAGS: ${flags.length ? flags.map(f => '[' + f.sev + '] ' + f.text).join(' | ') : 'none'}
Notes from user: ${deal.notes || 'none'}

${ask}`
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

/* ---------- Strategy + loan type form state ---------- */
let currentStrategy = 'buy';
let sessionPhotos = []; // {id, src, name} — in-memory only, cleared on reset

function setStrategy(s) {
  currentStrategy = s;
  document.querySelectorAll('.strat-tab').forEach(b => b.classList.toggle('on', b.dataset.strategy === s));
  document.querySelectorAll('#deal-form [data-modes]').forEach(el => {
    const modes = el.dataset.modes.split(' ');
    el.style.display = modes.includes(s) ? '' : 'none';
  });
  document.getElementById('analyze-btn').textContent =
    s === 'flip' ? 'Run flip analysis' : s === 'build' ? 'Run build analysis' : 'Run analysis';
}

function setLoanType(t, fromUser) {
  const sel = document.getElementById('f-loantype');
  if (sel) sel.value = t;
  const info = LOAN_TYPES[t] || LOAN_TYPES.conventional;
  const note = document.getElementById('loan-note');
  if (note) note.textContent = info.note;
  const debtFields = document.getElementById('fin-debt-fields');
  const cashNote = document.getElementById('cash-note');
  if (debtFields) debtFields.style.display = t === 'cash' ? 'none' : '';
  if (cashNote) cashNote.hidden = t !== 'cash';
  if (fromUser && info.defaultDown != null) {
    document.getElementById('f-down').value = info.defaultDown;
  }
  if (fromUser && t === 'cash') document.getElementById('f-down').value = 100;
}

/* ---------- Photos (session only) ---------- */
function renderPhotoGallery() {
  const g = document.getElementById('photo-gallery');
  if (!g) return;
  g.innerHTML = sessionPhotos.map(p => `
    <figure class="photo-thumb">
      <img src="${esc(p.src)}" alt="${esc(p.name || 'property photo')}" loading="lazy">
      <button type="button" data-rmphoto="${p.id}" aria-label="Remove photo">✕</button>
    </figure>`).join('')
    + (sessionPhotos.length ? '' : '<p class="tip">No photos yet — upload files or paste an image URL.</p>');
  const count = document.getElementById('photo-count');
  if (count) count.textContent = sessionPhotos.length + ' / 6';
}
function addPhoto(src, name) {
  if (sessionPhotos.length >= 6 || !src) return;
  sessionPhotos.push({ id: 'ph' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), src, name: name || 'photo' });
  renderPhotoGallery();
}
function clearPhotos() {
  sessionPhotos.forEach(p => { if (p.src.startsWith('blob:')) { try { URL.revokeObjectURL(p.src); } catch {} } });
  sessionPhotos = [];
  renderPhotoGallery();
}

/* ---------- Shared result fragments ---------- */
function flagsHtml(flags) {
  return `<div class="card"><h3>Risk flags <span style="color:var(--muted-fg);font-weight:400;font-size:.85rem">(${flags.length} from code)</span></h3>${
    flags.length ? flags.map(f =>
      `<div class="flag"><span class="sev ${f.sev}">${f.sev}</span><span>${esc(f.text)}</span></div>`).join('')
      : '<p style="color:var(--muted-fg)">No code flags. The AI pass below may add more.</p>'}</div>`;
}
function llmCardHtml(deal) {
  return `<div class="card" id="llm-card"><h3>Underwriter's take</h3>${
    deal.llm ? `<div class="llm-body">${esc(deal.llm)}</div>`
      : `<div aria-live="polite"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div><p style="color:var(--muted-fg);font-size:.9rem">Running the AI narrative on your key…</p></div>`}</div>`;
}
function intelCardHtml(deal) {
  const it = deal.intel || {};
  const addr = it.addr || deal.addr || '';
  const links = intelLinks(addr);
  const sv = streetViewEmbed(addr);
  const photos = (deal.photos || []).map(p =>
    `<figure class="photo-thumb"><img src="${esc(p.src)}" alt="${esc(p.name || 'property photo')}" loading="lazy"></figure>`).join('');
  const rows = [
    ['Days on market', it.dom || '—'],
    ['List price history', it.listNote || '—'],
    ['Last sale date', it.lastSaleDate ? fmtDate(it.lastSaleDate) : '—'],
    ['Last sale price', it.lastSalePrice ? fmt$(+it.lastSalePrice) : '—'],
    ['Years since last sale', it.yearsSinceSale != null ? it.yearsSinceSale.toFixed(1) + ' yrs' : '—'],
    ['Price change since last sale', it.priceChangePct != null ? (it.priceChangePct >= 0 ? '+' : '') + fmtPct1(it.priceChangePct) : '—'],
    ['Year built', it.yearBuilt || '—'],
    ['Square feet', it.sqft || '—'],
  ];
  return `<div class="card"><h3>Property intel</h3>
    ${addr ? `<p style="margin-bottom:10px"><strong>${esc(addr)}</strong></p>` : ''}
    <table class="breakdown"><tr><th>Item</th><th>Detail</th></tr>
    ${rows.map(r => `<tr><td>${r[0]}</td><td style="text-align:right">${esc(String(r[1]))}</td></tr>`).join('')}</table>
    ${sv ? `<div class="map-wrap"><iframe title="Map of ${esc(addr)}" src="${esc(sv)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>` : ''}
    ${links.length ? `<div class="intel-links no-print">${links.map(l =>
      `<a class="intel-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</div>
      <p class="tip">Free public sources — nothing is auto-fetched; open a link to verify records yourself.</p>` : ''}
    ${photos ? `<h3 style="margin-top:16px">Photos (${deal.photos.length})</h3><div class="photo-strip">${photos}</div>
      <p class="tip no-print">Photos live for this browser session only.</p>` : ''}
  </div>`;
}
function scoreDialHtml(s) {
  const dialC = 2 * Math.PI * 54, dialOff = dialC * (1 - s.score / 100);
  const color = s.score >= 70 ? '#22C55E' : s.score >= 45 ? '#F59E0B' : '#EF4444';
  return `<div class="score-dial" role="img" aria-label="Deal score ${s.score} out of 100">
    <svg width="140" height="140" viewBox="0 0 140 140">
      <circle cx="70" cy="70" r="54" fill="none" stroke="#1A1E2F" stroke-width="12"/>
      <circle cx="70" cy="70" r="54" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${dialC.toFixed(1)}" stroke-dashoffset="${dialOff.toFixed(1)}"/>
    </svg><div class="num"><b>${s.score}</b><span>deal score</span></div></div>`;
}

/* ---------- Buy & hold results ---------- */
function renderBuyResults(deal, m, s, flags) {
  return `
    <div class="card"><div class="score-wrap">${scoreDialHtml(s)}
      <div style="flex:1;min-width:220px">
        <p style="color:var(--muted-fg);font-size:.92rem"><span class="badge">${esc(m.loanLabel)}</span>
        Score blends cash-on-cash (30%), cap rate (20%), DSCR (20%) and rent-to-price (15%), minus up to 15 points for risk flags.</p>
        <div class="formula">0.30&times;CoC + 0.20&times;Cap + 0.20&times;DSCR + 0.15&times;Rent/Price &minus; flags (max 15)</div>
      </div></div></div>

    <h2>Key metrics</h2>
    <div class="grid-metrics">
      <div class="metric"><div class="v ${m.cfM >= 0 ? 'good' : 'bad'}">${fmt$(m.cfM)}<span style="font-size:.8rem;color:var(--muted-fg)">/mo</span></div><div class="l">Cash flow</div></div>
      <div class="metric"><div class="v ${valClass(m.capRate, 0.07, 0.04)}">${fmtPct1(m.capRate)}</div><div class="l">Cap rate</div></div>
      <div class="metric"><div class="v ${valClass(m.coc, 0.08, 0.02)}">${fmtPct1(m.coc)}</div><div class="l">Cash-on-cash</div></div>
      <div class="metric"><div class="v ${m.dscr === 99 ? '' : valClass(m.dscr, 1.25, 1.0)}">${m.dscr === 99 ? 'n/a' : m.dscr.toFixed(2)}</div><div class="l">DSCR${m.dscr === 99 ? ' (cash)' : ''}</div></div>
      <div class="metric"><div class="v ${m.onePctPass ? 'good' : 'bad'}">${m.onePctPass ? 'PASS' : 'FAIL'}</div><div class="l">1% rule (${fmtPct1(m.rentToPrice)}/mo)</div></div>
      <div class="metric"><div class="v ${m.expenseRatio <= 0.5 ? 'good' : m.expenseRatio <= 0.6 ? 'warnv' : 'bad'}">${fmtPct1(m.expenseRatio)}</div><div class="l">Opex vs 50% rule (actual ${fmt$(m.opexM)}/mo vs ${fmt$(m.fiftyPctOpex)}/mo)</div></div>
      <div class="metric"><div class="v">${fmtPct1(m.breakEvenOcc)}</div><div class="l">Break-even occupancy</div></div>
      <div class="metric"><div class="v">${m.rentForDscr125 != null ? fmt$(m.rentForDscr125) + '<span style="font-size:.8rem;color:var(--muted-fg)">/mo</span>' : 'n/a'}</div><div class="l">Rent needed for DSCR 1.25</div></div>
    </div>

    <h2>Monthly breakdown</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Line item</th><th>Amount</th></tr>
      <tr><td>Rental income</td><td class="pos">+${fmt$(m.rent)}</td></tr>
      <tr><td>Vacancy (${esc(String(deal.vacPct))}%)</td><td class="neg">−${fmt$(m.vacM)}</td></tr>
      <tr><td>Mortgage P&amp;I <span class="tip">(${(m.ratePctEff != null ? m.ratePctEff : deal.ratePct).toFixed(3)}%, ${esc(String(deal.termYears))}yr)</span></td><td class="neg">−${fmt$(m.pi)}</td></tr>
      ${m.miM > 0 ? `<tr><td>Mortgage insurance <span class="tip">(${esc(m.loanLabel)})</span></td><td class="neg">−${fmt$(m.miM)}</td></tr>` : ''}
      ${m.financedFee > 0 ? `<tr><td>Financed fee <span class="tip">(${esc(m.loanLabel)}, in loan)</span></td><td>${fmt$(m.financedFee)}</td></tr>` : ''}
      <tr><td><strong>Effective payment</strong> <span class="tip">(P&amp;I + MI/MIP)</span></td><td class="neg"><strong>−${fmt$(m.effPmt)}</strong></td></tr>
      <tr><td>Property tax</td><td class="neg">−${fmt$(m.taxM)}</td></tr>
      <tr><td>Insurance</td><td class="neg">−${fmt$(m.insM)}</td></tr>
      <tr><td>HOA</td><td class="neg">−${fmt$(m.hoaM)}</td></tr>
      <tr><td>Maintenance</td><td class="neg">−${fmt$(m.maintM)}</td></tr>
      <tr><td>CapEx reserve</td><td class="neg">−${fmt$(m.capexM)}</td></tr>
      <tr><td>Management</td><td class="neg">−${fmt$(m.mgmtM)}</td></tr>
      <tr class="total"><td>Cash flow</td><td class="${m.cfM >= 0 ? 'pos' : 'neg'}">${fmt$(m.cfM)}</td></tr>
    </table></div>

    ${flagsHtml(flags)}
    ${llmCardHtml(deal)}

    <div class="card no-print"><h3>Cash invested</h3>
      <p>Down payment ${fmt$(m.down)} + closing ${fmt$(m.closing)} = <strong>${fmt$(m.cashIn)}</strong>. Annual cash flow ${fmt$(m.cfA)}. Loan amount ${fmt$(m.loan)}.</p>
      <p class="tip" style="margin-top:8px">Analyzed ${new Date(deal.createdAt).toLocaleString()}. Educational estimates only — verify with your lender and CPA.</p>
    </div>`;
}

/* ---------- Flip results ---------- */
function renderFlipResults(deal, m, s, flags) {
  return `
    <div class="card"><div class="score-wrap">${scoreDialHtml(s)}
      <div style="flex:1;min-width:220px">
        <p style="color:var(--muted-fg);font-size:.92rem"><span class="badge">${esc(m.loanLabel)}</span>
        Flip score: 60% annualized ROI (30% = 100) + 40% margin under the 70%-rule max offer (10% under = 100), minus up to 15 points for risk flags.</p>
      </div></div></div>

    <h2>Flip economics</h2>
    <div class="grid-metrics">
      <div class="metric"><div class="v ${m.profit >= 0 ? 'good' : 'bad'}">${fmt$(m.profit)}</div><div class="l">Projected profit</div></div>
      <div class="metric"><div class="v ${valClass(m.roi, 0.2, 0)}">${fmtPct1(m.roi)}</div><div class="l">ROI on cash</div></div>
      <div class="metric"><div class="v ${valClass(m.annRoi, 0.2, 0)}">${fmtPct1(m.annRoi)}</div><div class="l">Annualized ROI (${m.holdMonths} mo)</div></div>
      <div class="metric"><div class="v">${fmt$(m.mao)}</div><div class="l">Max offer — 70% rule</div></div>
      <div class="metric"><div class="v">${m.breakEvenSale != null ? fmt$(m.breakEvenSale) : 'n/a'}</div><div class="l">Break-even sale price</div></div>
      <div class="metric"><div class="v">${fmt$(m.cashIn)}</div><div class="l">Total cash invested</div></div>
    </div>

    <h2>Deal anatomy</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Line item</th><th>Amount</th></tr>
      <tr><td>Purchase price</td><td>${fmt$(m.price)}</td></tr>
      <tr><td>Down payment (${esc(m.loanLabel)})</td><td class="neg">−${fmt$(m.down)}</td></tr>
      <tr><td>Closing costs</td><td class="neg">−${fmt$(m.closing)}</td></tr>
      <tr><td>Rehab budget</td><td class="neg">−${fmt$(m.rehab)}</td></tr>
      <tr><td>Holding costs <span class="tip">(${fmt$(m.effPmt + m.carryM)}/mo × ${m.holdMonths} mo)</span></td><td class="neg">−${fmt$(m.holding)}</td></tr>
      <tr><td>ARV (sale price)</td><td class="pos">+${fmt$(m.arv)}</td></tr>
      <tr><td>Selling costs (${m.sellCostPct}%)</td><td class="neg">−${fmt$(m.sellCosts)}</td></tr>
      <tr><td>Loan payoff at sale</td><td class="neg">−${fmt$(m.payoff)}</td></tr>
      <tr class="total"><td>Profit</td><td class="${m.profit >= 0 ? 'pos' : 'neg'}">${fmt$(m.profit)}</td></tr>
    </table></div>

    ${flagsHtml(flags)}
    ${llmCardHtml(deal)}

    <div class="card no-print">
      <p class="tip">Analyzed ${new Date(deal.createdAt).toLocaleString()}. Educational estimates only — verify ARV comps and rehab bids yourself.</p>
    </div>`;
}

/* ---------- Build results ---------- */
function renderBuildResults(deal, m, s, flags) {
  return `
    <div class="card"><div class="score-wrap">${scoreDialHtml(s)}
      <div style="flex:1;min-width:220px">
        <p style="color:var(--muted-fg);font-size:.92rem">Build score: margin on sale price (20% = 100), minus up to 15 points for risk flags. Cash-basis analysis — construction financing not modeled.</p>
      </div></div></div>

    <h2>Build economics</h2>
    <div class="grid-metrics">
      <div class="metric"><div class="v ${m.profit >= 0 ? 'good' : 'bad'}">${fmt$(m.profit)}</div><div class="l">Projected profit</div></div>
      <div class="metric"><div class="v ${valClass(m.margin, 0.15, 0.05)}">${fmtPct1(m.margin)}</div><div class="l">Margin on sale price</div></div>
      <div class="metric"><div class="v">${fmtPct1(m.markup)}</div><div class="l">Markup on cost</div></div>
      <div class="metric"><div class="v">${fmt$(m.totalCost)}</div><div class="l">Total project cost</div></div>
      <div class="metric"><div class="v">${m.costPerSqft != null ? fmt$(m.costPerSqft) : 'n/a'}</div><div class="l">Cost per sqft${m.sqft ? ' (' + m.sqft.toLocaleString() + ' sqft)' : ''}</div></div>
      <div class="metric"><div class="v">${m.breakEvenSale != null ? fmt$(m.breakEvenSale) : 'n/a'}</div><div class="l">Break-even sale price</div></div>
    </div>

    <h2>Cost stack</h2>
    <div class="card"><table class="breakdown">
      <tr><th>Line item</th><th>Amount</th></tr>
      <tr><td>Land</td><td>${fmt$(m.land)}</td></tr>
      <tr><td>Hard construction costs</td><td>${fmt$(m.hard)}</td></tr>
      <tr><td>Soft costs (${m.softPct}% of hard)</td><td>${fmt$(m.soft)}</td></tr>
      <tr><td>Carry <span class="tip">(${fmt$(m.carryM)}/mo × ${m.months} mo)</span></td><td>${fmt$(m.carry)}</td></tr>
      <tr><td><strong>Total project cost</strong></td><td><strong>${fmt$(m.totalCost)}</strong></td></tr>
      <tr><td>Finished value (ARV)</td><td class="pos">+${fmt$(m.arv)}</td></tr>
      <tr><td>Selling costs (${m.sellCostPct}%)</td><td class="neg">−${fmt$(m.sellCosts)}</td></tr>
      <tr class="total"><td>Profit</td><td class="${m.profit >= 0 ? 'pos' : 'neg'}">${fmt$(m.profit)}</td></tr>
    </table></div>

    ${flagsHtml(flags)}
    ${llmCardHtml(deal)}

    <div class="card no-print">
      <p class="tip">Analyzed ${new Date(deal.createdAt).toLocaleString()}. Educational estimates only — get real bids and comp the finished value.</p>
    </div>`;
}

function renderResults(id) {
  const deal = ensureMetrics(getDeal(id));
  const box = document.getElementById('results-content');
  if (!deal) { box.innerHTML = '<div class="card"><p>Deal not found.</p></div>'; return; }
  const strat = deal.strategy || 'buy';
  const m = deal.metrics, s = deal.score, flags = deal.flags || [];
  const stratBadge = `<p class="no-print" style="margin-bottom:12px"><span class="badge">${esc(STRATEGY_LABELS[strat] || strat)}</span></p>`;
  const body = strat === 'flip' ? renderFlipResults(deal, m, s, flags)
    : strat === 'build' ? renderBuildResults(deal, m, s, flags)
    : renderBuyResults(deal, m, s, flags);
  box.innerHTML = `<h1 class="no-print">${esc(deal.name || 'Untitled deal')}</h1>` + stratBadge + body + intelCardHtml(deal);
}

/* ---------- Full printable report ---------- */
function inputsTableHtml(deal) {
  const strat = deal.strategy || 'buy';
  const rows = [];
  const R = (k, v) => { if (v !== '' && v != null) rows.push([k, v]); };
  R('Strategy', STRATEGY_LABELS[strat]);
  if (deal.addr) R('Address', deal.addr);
  if (deal.beds) R('Beds / baths', deal.beds);
  if (strat !== 'build') {
    R('Purchase price', fmt$(deal.price));
    R('Loan type', (LOAN_TYPES[deal.loanType] || LOAN_TYPES.conventional).label);
    if (deal.loanType !== 'cash') { R('Down payment', deal.downPct + '%'); R('Rate', deal.ratePct + '%'); R('Term', deal.termYears + ' yr'); }
    R('Closing costs', deal.closingPct + '%');
  }
  if (strat === 'buy') {
    R('Monthly rent', fmt$(deal.rent));
    R('Property tax', fmt$(deal.taxA) + '/yr'); R('Insurance', fmt$(deal.insA) + '/yr'); R('HOA', fmt$(deal.hoaM) + '/mo');
    R('Vacancy', deal.vacPct + '%'); R('Maintenance', deal.maintPct + '%'); R('CapEx', deal.capexPct + '%'); R('Management', deal.mgmtPct + '%');
  }
  if (strat === 'flip' && deal.flip) {
    R('Rehab budget', fmt$(deal.flip.rehab)); R('ARV', fmt$(deal.flip.arv));
    R('Hold time', deal.flip.holdMonths + ' mo'); R('Selling costs', deal.flip.sellCostPct + '%'); R('Monthly carry', fmt$(deal.flip.carryM));
  }
  if (strat === 'build' && deal.build) {
    R('Land cost', fmt$(deal.build.land)); R('Hard costs', fmt$(deal.build.hard)); R('Soft costs', deal.build.softPct + '% of hard');
    R('Build time', deal.build.months + ' mo'); R('Monthly carry', fmt$(deal.build.carryM));
    R('Finished value (ARV)', fmt$(deal.build.arv)); R('Selling costs', deal.build.sellCostPct + '%');
    if (deal.build.sqft) R('Square feet', deal.build.sqft);
  }
  const it = deal.intel || {};
  if (it.dom) R('Days on market', it.dom);
  if (it.lastSaleDate) R('Last sale', fmtDate(it.lastSaleDate) + (it.lastSalePrice ? ' at ' + fmt$(+it.lastSalePrice) : ''));
  if (it.yearBuilt) R('Year built', it.yearBuilt);
  if (it.sqft) R('Sqft', it.sqft);
  if (it.listNote) R('List history', it.listNote);
  if (deal.notes) R('Notes', deal.notes);
  return `<table class="breakdown report-table"><tr><th>Input</th><th>Value</th></tr>${
    rows.map(r => `<tr><td>${esc(r[0])}</td><td style="text-align:right">${esc(String(r[1]))}</td></tr>`).join('')}</table>`;
}

function outputsTableHtml(deal) {
  const strat = deal.strategy || 'buy', m = deal.metrics;
  const rows = [];
  const R = (k, v) => rows.push([k, v]);
  if (strat === 'buy') {
    R('Deal score', m && deal.score ? deal.score.score + ' / 100' : '—');
    R('Monthly cash flow', fmt$(m.cfM)); R('Annual cash flow', fmt$(m.cfA));
    R('Cap rate', fmtPct(m.capRate)); R('Cash-on-cash', fmtPct(m.coc));
    R('DSCR', m.dscr === 99 ? 'n/a (cash)' : m.dscr.toFixed(2));
    R('NOI (annual)', fmt$(m.noiA)); R('Cash invested', fmt$(m.cashIn));
    R('Effective payment (P&I + MI/MIP)', fmt$(m.effPmt) + '/mo');
    R('1% rule', m.onePctPass ? 'PASS' : 'FAIL'); R('Break-even occupancy', fmtPct1(m.breakEvenOcc));
    R('Rent for DSCR 1.25', m.rentForDscr125 != null ? fmt$(m.rentForDscr125) + '/mo' : 'n/a');
  } else if (strat === 'flip') {
    R('Deal score', deal.score.score + ' / 100');
    R('Projected profit', fmt$(m.profit)); R('ROI on cash', fmtPct(m.roi)); R('Annualized ROI', fmtPct(m.annRoi));
    R('Total cash invested', fmt$(m.cashIn)); R('70%-rule max offer', fmt$(m.mao));
    R('Break-even sale price', m.breakEvenSale != null ? fmt$(m.breakEvenSale) : 'n/a');
  } else {
    R('Deal score', deal.score.score + ' / 100');
    R('Projected profit', fmt$(m.profit)); R('Margin on sale price', fmtPct(m.margin));
    R('Total project cost', fmt$(m.totalCost));
    R('Cost per sqft', m.costPerSqft != null ? fmt$(m.costPerSqft) : 'n/a');
    R('Break-even sale price', m.breakEvenSale != null ? fmt$(m.breakEvenSale) : 'n/a');
  }
  return `<table class="breakdown report-table"><tr><th>Output</th><th>Value</th></tr>${
    rows.map(r => `<tr><td>${esc(r[0])}</td><td style="text-align:right">${esc(String(r[1]))}</td></tr>`).join('')}</table>`;
}

function renderReport(id) {
  const deal = ensureMetrics(getDeal(id));
  const box = document.getElementById('report-content');
  if (!deal) { box.innerHTML = '<div class="card"><p>Deal not found.</p></div>'; return; }
  const strat = deal.strategy || 'buy';
  const flags = deal.flags || [];
  const photos = (deal.photos || []).map(p =>
    `<figure class="photo-report"><img src="${esc(p.src)}" alt="${esc(p.name || 'property photo')}"><figcaption>${esc(p.name || '')}</figcaption></figure>`).join('');
  box.innerHTML = `
    <div class="report-head">
      <div><div class="report-brand">Deal<span>Lens</span> — Full Report</div>
      <h1>${esc(deal.name || 'Untitled deal')}</h1>
      <p class="tip">${esc(STRATEGY_LABELS[strat] || strat)}${strat !== 'build' ? ' · ' + esc((LOAN_TYPES[deal.loanType] || LOAN_TYPES.conventional).label) : ''} · Analyzed ${new Date(deal.createdAt).toLocaleString()}</p></div>
      <div class="report-score"><div class="score-badge ${scoreClass(deal.score.score)}" style="min-width:72px;height:72px;font-size:1.6rem">${deal.score.score}</div><small>deal score</small></div>
    </div>
    ${photos ? `<div class="card"><h3>Photos</h3><div class="photo-report-grid">${photos}</div></div>` : ''}
    <div class="card"><h3>All inputs</h3>${inputsTableHtml(deal)}</div>
    <div class="card"><h3>All outputs</h3>${outputsTableHtml(deal)}</div>
    <div class="card"><h3>Risk flags (${flags.length})</h3>${
      flags.length ? flags.map(f => `<div class="flag"><span class="sev ${f.sev}">${f.sev}</span><span>${esc(f.text)}</span></div>`).join('')
      : '<p>No code flags.</p>'}</div>
    ${deal.llm ? `<div class="card"><h3>Underwriter's take (AI)</h3><div class="llm-body">${esc(deal.llm)}</div></div>` : ''}
    <div class="card"><h3>Property intel</h3>${intelCardHtml(deal).replace(/^<div class="card"><h3>Property intel<\/h3>/, '').replace(/<\/div>$/, '')}</div>
    <p class="tip">DealLens is an educational underwriting tool. Estimates only — not financial, investment, or tax advice. Verify every number with your lender and CPA.</p>
    <p class="no-print" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="report-print-btn">Print / Save PDF</button>
      <button class="btn secondary" data-nav="results-back">Back to results</button>
    </p>`;
  const pb = document.getElementById('report-print-btn');
  if (pb) pb.addEventListener('click', () => window.print());
  box.querySelectorAll('[data-nav="results-back"]').forEach(b =>
    b.addEventListener('click', e => { e.preventDefault(); go('results', deal.id); }));
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
      if (card) card.innerHTML = `<h3>Underwriter's take</h3><div class="llm-body">${esc(deal.llm)}</div>`;
    }
  } catch (e) {
    const card = document.getElementById('llm-card');
    if (card && currentDealId === deal.id) {
      card.innerHTML = `<h3>Underwriter's take</h3><div class="notice warn">AI narrative failed: ${esc(e.message)}. The math above is unaffected — your numbers are complete without it.</div>`;
    }
  }
}

/* ================= History & compare ================= */
let compareSel = new Set();

function historyLine(d) {
  const strat = d.strategy || 'buy';
  if (strat === 'flip' && d.metrics) return `${fmt$(d.price)} buy → ${fmt$(d.metrics.arv)} ARV · ${fmt$(d.metrics.profit)} profit`;
  if (strat === 'build' && d.metrics) return `${fmt$(d.metrics.totalCost)} cost → ${fmt$(d.metrics.arv)} value · ${fmtPct1(d.metrics.margin)} margin`;
  return `${fmt$(d.price)} · ${fmt$(d.metrics.cfM)}/mo · ${fmtPct1(d.metrics.capRate)} cap`;
}

function renderHistory() {
  const deals = loadDeals().map(ensureMetrics);
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
        <small><span class="badge">${esc(STRATEGY_LABELS[d.strategy] || 'Buy & Hold')}</span> ${esc(historyLine(d))}</small></div>
      <div class="row-actions no-print">
        <label class="compare-check"><input type="checkbox" data-compare="${d.id}" ${compareSel.has(d.id) ? 'checked' : ''}> Compare</label>
        <button data-del="${d.id}" aria-label="Delete">Delete</button>
      </div>
    </div>`).join('');
}

function renderCompare() {
  const buyDeals = [...compareSel].map(id => ensureMetrics(getDeal(id))).filter(d => d && (d.strategy || 'buy') === 'buy');
  const box = document.getElementById('compare-content');
  if (buyDeals.length < 2) {
    box.innerHTML = '<p style="color:var(--muted-fg)">Comparison covers Buy &amp; Hold deals — select at least 2 of them in History. (Flip and build deals use different math and are not comparable here.)</p>';
    return;
  }
  const deals = buyDeals.slice(0, 4);
  const rows = [
    ['Deal score', d => d.score.score, 'max'],
    ['Loan type', d => (LOAN_TYPES[d.loanType] || LOAN_TYPES.conventional).label, null],
    ['Price', d => fmt$(d.price), 'min'],
    ['Monthly cash flow', d => fmt$(d.metrics.cfM), 'max'],
    ['Cap rate', d => fmtPct1(d.metrics.capRate), 'max'],
    ['Cash-on-cash', d => fmtPct1(d.metrics.coc), 'max'],
    ['DSCR', d => d.metrics.dscr === 99 ? 'n/a' : d.metrics.dscr.toFixed(2), 'maxnum'],
    ['Effective payment', d => fmt$(d.metrics.effPmt), 'min'],
    ['Cash invested', d => fmt$(d.metrics.cashIn), 'min'],
  ];
  const numOf = (d, fn) => { const v = fn(d); return typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, '')); };
  let html = '<table class="compare"><tr><th></th>' + deals.map(d => `<th>${esc(d.name || 'Deal')}</th>`).join('') + '</tr>';
  rows.forEach(([label, fn, dir]) => {
    const vals = deals.map(d => dir === 'maxnum' ? (d.metrics.dscr === 99 ? 99 : d.metrics.dscr) : numOf(d, fn));
    const best = dir && dir.startsWith('max') ? Math.max(...vals) : dir ? Math.min(...vals) : null;
    html += `<tr><th>${label}</th>` + deals.map((d, i) =>
      `<td class="${best !== null && vals[i] === best ? 'winner' : ''}">${esc(String(fn(d)))}</td>`).join('') + '</tr>';
  });
  box.innerHTML = html + '</table>';
}

/* ================= Form & init ================= */
function readForm() {
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const n = id => { const x = parseFloat(v(id)); return isFinite(x) ? x : 0; };
  const intel = {
    addr: v('f-addr'), dom: v('f-dom'), listNote: v('f-listnote'),
    lastSaleDate: v('f-lastsaledate'), lastSalePrice: v('f-lastsaleprice'),
    yearBuilt: v('f-yearbuilt'), sqft: v('f-sqft'),
  };
  const stats = intelStats(n('f-price') || n('f-build-land'), intel.lastSalePrice, intel.lastSaleDate);
  intel.yearsSinceSale = stats.yearsSinceSale;
  intel.priceChangePct = stats.priceChangePct;
  return {
    id: 'deal-' + Date.now().toString(36),
    strategy: currentStrategy,
    name: v('f-name'), addr: v('f-addr'), price: n('f-price'), rent: n('f-rent'), beds: v('f-beds'),
    loanType: v('f-loantype') || 'conventional',
    downPct: n('f-down'), ratePct: n('f-rate'), termYears: n('f-term') || 30, closingPct: n('f-closing'),
    taxA: n('f-tax'), insA: n('f-ins'), hoaM: n('f-hoa'),
    vacPct: n('f-vac'), maintPct: n('f-maint'), capexPct: n('f-capex'), mgmtPct: n('f-mgmt'),
    flip: { rehab: n('f-flip-rehab'), arv: n('f-flip-arv'), holdMonths: n('f-flip-hold'), sellCostPct: n('f-flip-sellcost'), carryM: n('f-flip-carry') },
    build: { land: n('f-build-land'), hard: n('f-build-hard'), softPct: n('f-build-softpct'), arv: n('f-build-arv'), months: n('f-build-months'), carryM: n('f-build-carry'), sellCostPct: n('f-build-sellcost'), sqft: n('f-build-sqft') },
    intel,
    photos: sessionPhotos.map(p => ({ src: p.src, name: p.name })),
    notes: v('f-notes'), createdAt: new Date().toISOString(),
  };
}

function analyzeDeal(deal) {
  const strat = deal.strategy || 'buy';
  if (strat === 'flip') {
    deal.metrics = calcFlip(deal);
    deal.flags = codeFlags(deal, deal.metrics);
    deal.score = flipScore(deal.metrics, deal.flags);
  } else if (strat === 'build') {
    deal.metrics = calcBuild(deal);
    deal.flags = codeFlags(deal, deal.metrics);
    deal.score = buildScore(deal.metrics, deal.flags);
  } else {
    deal.metrics = calc(deal);
    deal.flags = codeFlags(deal, deal.metrics);
    deal.score = dealScore(deal.metrics, deal.flags);
  }
  return deal;
}

function validateDeal(deal) {
  const strat = deal.strategy || 'buy';
  if (strat === 'build') {
    if (!(deal.build.land > 0 || deal.build.hard > 0)) return 'Enter at least a land cost or hard construction cost.';
    if (!(deal.build.arv > 0)) return 'Enter the finished value (ARV).';
    return null;
  }
  if (!deal.price || deal.price <= 0) return 'Enter a purchase price.';
  if (strat === 'buy' && deal.rent < 0) return "Rent can't be negative.";
  if (strat === 'flip') {
    if (!(deal.flip.arv > 0)) return 'Enter the after-repair value (ARV).';
  }
  return null;
}

/* Prominent reset: every field back to defaults, results/photos cleared. */
function resetAnalysis() {
  if (!window.confirm('Start a new analysis? Every input, result, and photo will be cleared.')) return;
  const form = document.getElementById('deal-form');
  if (form) form.reset();
  clearPhotos();
  currentDealId = null;
  setStrategy('buy');
  setLoanType('conventional', true);
  renderPhotoGallery();
  const pe = document.getElementById('form-error');
  if (pe) pe.textContent = '';
  const rc = document.getElementById('results-content');
  if (rc) rc.innerHTML = '';
  const pc = document.getElementById('report-content');
  if (pc) pc.innerHTML = '';
  go('new');
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

  /* Strategy tabs */
  document.querySelectorAll('.strat-tab').forEach(b =>
    b.addEventListener('click', () => setStrategy(b.dataset.strategy)));
  /* Loan type */
  const loanSel = document.getElementById('f-loantype');
  if (loanSel) loanSel.addEventListener('change', () => setLoanType(loanSel.value, true));

  /* Photos */
  const fileInput = document.getElementById('f-photos');
  if (fileInput) fileInput.addEventListener('change', () => {
    [...fileInput.files].slice(0, 6 - sessionPhotos.length).forEach(f => {
      if (f.type.startsWith('image/')) addPhoto(URL.createObjectURL(f), f.name);
    });
    fileInput.value = '';
  });
  const urlAdd = document.getElementById('photourl-add');
  if (urlAdd) urlAdd.addEventListener('click', () => {
    const inp = document.getElementById('f-photourl');
    const u = inp.value.trim();
    if (/^https?:\/\//i.test(u)) { addPhoto(u, 'pasted image'); inp.value = ''; }
  });
  const gallery = document.getElementById('photo-gallery');
  if (gallery) gallery.addEventListener('click', e => {
    const btn = e.target.closest('[data-rmphoto]');
    if (!btn) return;
    const p = sessionPhotos.find(x => x.id === btn.dataset.rmphoto);
    if (p && p.src.startsWith('blob:')) { try { URL.revokeObjectURL(p.src); } catch {} }
    sessionPhotos = sessionPhotos.filter(x => x.id !== btn.dataset.rmphoto);
    renderPhotoGallery();
  });
  /* Address → refresh intel links hint */
  const addrInput = document.getElementById('f-addr');
  if (addrInput) addrInput.addEventListener('input', () => {
    const hint = document.getElementById('intel-links-hint');
    if (hint) hint.textContent = addrInput.value.trim()
      ? 'Links unlock after you run the analysis — they open in new tabs.'
      : 'Enter the street address above to get parcel, map, and listing deep-links.';
  });

  /* Reset buttons */
  document.querySelectorAll('[data-reset]').forEach(b =>
    b.addEventListener('click', e => { e.preventDefault(); resetAnalysis(); }));

  document.getElementById('deal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('form-error');
    errEl.textContent = '';
    const deal = readForm();
    const problem = validateDeal(deal);
    if (problem) { errEl.textContent = problem; return; }
    const btn = document.getElementById('analyze-btn');
    btn.disabled = true; btn.textContent = ' crunching numbers…';
    analyzeDeal(deal);
    upsertDeal(deal);
    btn.disabled = false;
    setStrategy(deal.strategy); // restore button label
    go('results', deal.id);
    runLLMForDeal(deal); // async; renders into the card when done
  });

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

  /* Results-view buttons are rendered statically; wire via delegation */
  document.getElementById('view-results').addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'results-report-btn' && currentDealId) go('report', currentDealId);
    if (t.id === 'results-print-btn') window.print();
  });

  setStrategy('buy');
  setLoanType('conventional', false);
  renderPhotoGallery();
  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
