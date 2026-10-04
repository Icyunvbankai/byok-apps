/* DealLens v2 — static app. Deterministic math in code; the LLM narrates only.
   Strategies: buy (buy & hold), flip (rehab flip), build (new construction).
   Loan types modify the buy & flip math (conventional, fha, va, dscr, seller, cash). */
'use strict';

/* ================= Storage ================= */
const LS_KEY = 'deallens_key';     // {provider, key, model}
const LS_DEALS = 'deallens_deals'; // array of deal objects (photos stripped — session only)
const LS_RC = 'deallens_rentcast_key'; // raw RentCast API key string (BYOK property data)

function loadKey() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}
function saveKey(obj) { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
function clearKey() { localStorage.removeItem(LS_KEY); }
function loadRcKey() {
  try { return localStorage.getItem(LS_RC) || ''; } catch { return ''; }
}
function saveRcKey(k) { localStorage.setItem(LS_RC, k); }
function clearRcKey() { localStorage.removeItem(LS_RC); }
/* RentCast usage: {month:"YYYY-MM", used:n} — counts HTTP requests actually
   fired. Rolls over automatically when the calendar month changes. */
const LS_RC_USAGE = 'deallens_rentcast_usage';
const RC_FREE_LIMIT = 50;
const RC_WARN_AT = 40;
function rcMonthStr() { return new Date().toISOString().slice(0, 7); }
function rcUsage() {
  try {
    const u = JSON.parse(localStorage.getItem(LS_RC_USAGE) || 'null');
    if (u && u.month === rcMonthStr()) return { month: u.month, used: Math.max(0, +u.used || 0) };
  } catch (e) { /* fall through to fresh */ }
  return { month: rcMonthStr(), used: 0 };
}
function rcUsageAdd(n) {
  const u = rcUsage();
  u.used += n;
  try { localStorage.setItem(LS_RC_USAGE, JSON.stringify(u)); } catch (e) { /* ignore */ }
  return u;
}

/* RentCast response cache: deallens_rentcast_cache = { key: {at: ms, data} }.
   Keys: "pull:<normalized address>" (TTL 7 days) and "search:<query JSON>"
   (TTL 24h). Capped at 50 entries; oldest evicted first. */
const LS_RC_CACHE = 'deallens_rentcast_cache';
const RC_PULL_TTL_MS = 7 * 24 * 3600 * 1000;
const RC_SEARCH_TTL_MS = 24 * 3600 * 1000;
const RC_CACHE_MAX = 50;
function rcCacheNorm(addr) { return String(addr || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function rcCacheRead() {
  try { const c = JSON.parse(localStorage.getItem(LS_RC_CACHE) || '{}'); return (c && typeof c === 'object') ? c : {}; }
  catch (e) { return {}; }
}
function rcCacheWrite(c) { try { localStorage.setItem(LS_RC_CACHE, JSON.stringify(c)); } catch (e) { /* ignore */ } }
function rcCacheGet(key, ttlMs) {
  const c = rcCacheRead(), e = c[key];
  if (!e || !e.at || (Date.now() - e.at) > ttlMs) return null;
  return e.data;
}
function rcCacheSet(key, data) {
  const c = rcCacheRead();
  c[key] = { at: Date.now(), data };
  const keys = Object.keys(c).sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
  while (keys.length > RC_CACHE_MAX) delete c[keys.shift()];
  rcCacheWrite(c);
}
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
const VIEWS = ['landing', 'setup', 'new', 'watch', 'results', 'report', 'history', 'compare', 'pricing'];
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
  if (name === 'setup') { syncSetupUI(); syncRcSetupUI(); }
  if (name === 'new') syncNoKeyNotice();
  if (name === 'watch') renderWatch();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function go(name, arg) {
  if ((name === 'results' || name === 'report') && arg) currentDealId = arg;
  location.hash = '#/' + name + (arg ? '/' + arg : '');
}
function route() {
  let h = (location.hash || '#/landing').replace('#/', '');
  let query = '';
  const qi = h.indexOf('?');
  if (qi >= 0) { query = h.slice(qi + 1); h = h.slice(0, qi); }
  const parts = h.split('/');
  const name = VIEWS.includes(parts[0]) ? parts[0] : 'landing';
  if (name === 'results' && parts[1]) { currentDealId = parts[1]; renderResults(currentDealId); }
  if (name === 'report' && parts[1]) { currentDealId = parts[1]; renderReport(currentDealId); }
  showView(name);
  if (name === 'new' && query) applySharedParams(query);
}

/* Pre-fill the Buy & Hold form from a shared hash link, e.g.
   #/new?price=200000&rent=2500&address=1403%20Avenue%20M&taxA=2600&insA=1800
   &downPct=20&ratePct=7&termYears=30&loanType=conventional&units=2&zip=34950
   or #/new?sharedUrl=<encoded listing URL> (address parsed via parseListingUrl).
   Supported params: price, rent, address, taxA, insA, hoaM, downPct, ratePct,
   termYears, loanType, units (appended to notes), zip (appended to address). */
function applySharedParams(query) {
  let p;
  try { p = new URLSearchParams(query); } catch (err) { return; }
  const setVal = (id, val) => {
    if (val == null || val === '') return false;
    const el = document.getElementById(id);
    if (el) { el.value = val; return true; }
    return false;
  };
  let filled = 0;
  setStrategy('buy');
  const lt = p.get('loanType');
  if (lt && LOAN_TYPES[lt]) { setLoanType(lt, false); filled++; }
  [['price', 'f-price'], ['rent', 'f-rent'], ['taxA', 'f-tax'], ['insA', 'f-ins'],
   ['hoaM', 'f-hoa'], ['downPct', 'f-down'], ['ratePct', 'f-rate'], ['termYears', 'f-term']
  ].forEach(([param, id]) => { if (setVal(id, p.get(param))) filled++; });
  const addr = p.get('address'), zip = p.get('zip');
  if (addr) {
    const a = (zip && !addr.includes(zip)) ? addr + ' ' + zip : addr;
    if (setVal('f-addr', a)) filled++;
  } else if (zip && setVal('f-addr', zip)) filled++;
  const sharedUrl = p.get('sharedUrl');
  if (sharedUrl) {
    const parsed = parseListingUrl(sharedUrl);
    if (parsed && setVal('f-addr', parsed.address)) filled++;
  }
  const units = p.get('units');
  if (units) {
    const n = document.getElementById('f-notes');
    if (n) { n.value = (n.value ? n.value + ' ' : '') + 'Units: ' + units; filled++; }
  }
  if (filled > 0) {
    const notice = document.getElementById('shared-notice');
    if (notice) { notice.hidden = false; notice.textContent = 'Fields filled from shared link — review and hit Analyze.'; }
  }
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

/* ================= Listing URL intake (agentic) ================= */
/* Pure function — no network calls (listing sites block CORS, so the address
   is parsed from the URL slug and the full numbers come via Ziggy in chat). */
const STREET_TYPES = ['st','street','ave','avenue','blvd','boulevard','dr','drive','ct','court',
  'ln','lane','rd','road','way','ter','terrace','pl','place','pkwy','parkway','cir','circle','trl','trail'];

function titleCase(s) {
  return String(s || '').split(/[\s_\-]+/).filter(Boolean).map(w =>
    w.length === 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(' ');
}

/* Split slug tokens (state/zip already peeled) into street + city.
   The street ends at the last street-type word, plus one trailing token when
   it's a single letter ("Avenue M", "Street B"). */
function splitStreetCity(tokens) {
  const lower = tokens.map(t => t.toLowerCase());
  let cut = -1;
  for (let i = 0; i < lower.length; i++) if (STREET_TYPES.includes(lower[i])) cut = i;
  if (cut < 0) return { street: null, city: null };
  let end = cut + 1;
  if (end < tokens.length && tokens[end].length === 1) end++;
  const street = tokens.slice(0, end).join(' ');
  const city = tokens.slice(end).join(' ');
  return { street: street || null, city: city || null };
}

function peelStateZip(tokens) {
  const t = tokens.slice();
  let zip = null, state = null;
  if (t.length && /^\d{5}(-\d{4})?$/.test(t[t.length - 1])) zip = t.pop().slice(0, 5);
  if (t.length && /^[a-zA-Z]{2}$/.test(t[t.length - 1])) state = t.pop().toUpperCase();
  return { tokens: t, zip, state };
}

function parseListingUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); }
  catch (err) { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname;
  let source = null, street = null, city = null, state = null, zip = null;

  const fromSlug = slug => {
    const p = peelStateZip(slug.split('-'));
    const sc = splitStreetCity(p.tokens);
    return { street: sc.street, city: sc.city, state: p.state, zip: p.zip };
  };

  if (host.includes('zillow.com')) {
    // /homedetails/1403-Avenue-M-Fort-Pierce-FL-34950/1234567_zpid/
    const m = path.match(/\/homedetails\/([^\/]+)/);
    if (!m) return null;
    source = 'Zillow';
    ({ street, city, state, zip } = fromSlug(m[1]));
  } else if (host.includes('redfin.com')) {
    // /FL/Fort-Pierce/1403-Avenue-M-34950/home/141339060
    const segs = path.split('/').filter(Boolean);
    if (segs.length < 3) return null;
    source = 'Redfin';
    state = /^[a-zA-Z]{2}$/.test(segs[0]) ? segs[0].toUpperCase() : null;
    city = titleCase(segs[1]);
    const r = fromSlug(segs[2]);
    street = r.street; if (r.zip) zip = r.zip;
  } else if (host.includes('realtor.com')) {
    // /realestateandhomes-detail/1403-Avenue-M_Fort-Pierce_FL_34950_M12345-67890
    const m = path.match(/\/realestateandhomes-detail\/([^\/_]+)_([^\/_]+)_([^\/_]+)_([^\/]+)/);
    if (!m) return null;
    source = 'Realtor.com';
    street = titleCase(m[1]); city = titleCase(m[2]);
    state = m[3].toUpperCase(); zip = /^\d{5}/.test(m[4]) ? m[4].slice(0, 5) : null;
  } else if (host.includes('homes.com')) {
    // /property/1403-avenue-m-fort-pierce-fl/3f1w047vlyb9p/
    const m = path.match(/\/property\/([^\/]+)/);
    if (!m) return null;
    source = 'Homes.com';
    ({ street, city, state, zip } = fromSlug(m[1]));
  } else if (host.includes('compass.com')) {
    // /homedetails/1403-Avenue-M-Fort-Pierce-FL-34950/1C95ZW_pid/
    const m = path.match(/\/homedetails\/([^\/]+)/);
    if (!m) return null;
    source = 'Compass';
    ({ street, city, state, zip } = fromSlug(m[1]));
  } else if (host.includes('loopnet.com') || host.includes('crexi.com')) {
    // Best effort: address slugs vary — LoopNet is usually street-first
    // ("1403-Avenue-M-Fort-Pierce-FL"), Crexi is city-first ("fl-fort-pierce-1403-avenue-m").
    source = host.includes('loopnet.com') ? 'LoopNet' : 'Crexi';
    const segs = path.split('/').filter(Boolean);
    const trySeg = s => {
      const toks0 = s.split('-');
      let toks = toks0.slice(), leadState = null;
      if (toks.length >= 3 && /^[a-zA-Z]{2}$/.test(toks[0])) leadState = toks.shift().toUpperCase();
      const p = peelStateZip(toks);
      const stateFromTail = !!p.state;
      if (!p.state && leadState) p.state = leadState;
      p.cityFirst = !!leadState && !stateFromTail;
      return p;
    };
    let found = null;
    for (const s of segs) {
      const p = trySeg(s);
      if (p.zip && p.state && p.tokens.length >= 2) { found = p; break; }
    }
    if (!found) {
      for (const s of segs) {
        const p = trySeg(s);
        const low = p.tokens.map(t => t.toLowerCase());
        if (p.state && p.tokens.length >= 2 && low.some(t => STREET_TYPES.includes(t))) { found = p; break; }
      }
    }
    if (!found) return null;
    if (found.cityFirst) {
      // city-first: the street starts at the first numeric (house number) token
      const idx = found.tokens.findIndex(t => /^\d+$/.test(t));
      if (idx < 0) return null;
      city = found.tokens.slice(0, idx).join(' ');
      street = found.tokens.slice(idx).join(' ');
    } else {
      const sc = splitStreetCity(found.tokens);
      street = sc.street; city = sc.city;
    }
    state = found.state; zip = found.zip;
  } else {
    return null;
  }

  if (!street) return null;
  street = titleCase(street);
  city = city ? titleCase(city) : null;
  let address = street;
  if (city) address += ', ' + city;
  if (state) address += ', ' + state;
  if (zip) address += ' ' + zip;
  return { source, street, city, state, zip, address };
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
  if (require.main === module) {
    runSelfTests();
    runRentcastTests().then(
      () => runAgentTests().then(
        () => console.log('All agent-loop tests passed.'),
        e => { console.error('Agent-loop tests FAILED:', (e && e.message) || e); process.exit(1); }),
      e => { console.error('RentCast tests FAILED:', (e && e.message) || e); process.exit(1); });
  }
}

/* Agent-loop tests: geocode, repair estimator, new-build comp, intake→run
   field mapping, dig-deeper gating. Pure functions + mocked fetch. */
async function runAgentTests() {
  const assert = require('assert');
  const realFetch = global.fetch;

  // A1: geocode success → coords stored
  global.fetch = async () => ({ ok: true, json: async () => [{ lat: '27.4467', lon: '-80.3256' }] });
  let g = await geocodeAddress('1403 Avenue M, Fort Pierce, FL 34950');
  assert(g && Math.abs(g.lat - 27.4467) < 1e-6 && Math.abs(g.lng + 80.3256) < 1e-6, 'A1 geocode coords, got ' + JSON.stringify(g));

  // A2: geocode failure → null, no throw (HTTP error)
  global.fetch = async () => ({ ok: false, status: 500 });
  g = await geocodeAddress('Nowhere XYZ');
  assert(g === null, 'A2 geocode HTTP failure → null');

  // A3: geocode failure → null, no throw (network reject)
  global.fetch = async () => { throw new Error('boom'); };
  g = await geocodeAddress('Nowhere XYZ');
  assert(g === null, 'A3 geocode network failure → null');

  // A4: geocode empty address → null without fetching
  let fetched = false;
  global.fetch = async () => { fetched = true; return { ok: true, json: async () => [] }; };
  g = await geocodeAddress('   ');
  assert(g === null && fetched === false, 'A4 empty address → null, no fetch');

  // A5: repair estimator math — 1,005 sqft × Moderate $42 = $42,210
  const re = repairEstimate(1005, 'moderate');
  assert(re.total === 42210, 'A5 repair 1005×42=42210, got ' + re.total);
  assert(re.label === 'Moderate rehab' && re.rate === 42, 'A5 tier label/rate');
  const re0 = repairEstimate(0, 'gut');
  assert(re0.total === 0, 'A5 zero sqft → 0');

  // A6: new-build comp — 1,005 × $175 = $175,875
  assert(newBuildEstimate(1005, 175) === 175875, 'A6 new-build 1005×175=175875');

  // A7: repair tiers labeled as Treasure Coast rough averages
  assert(REPAIR_TIERS.length === 4 && REPAIR_TIERS[0].rate === 5 && REPAIR_TIERS[3].rate === 85, 'A7 tier table intact');

  // A8: permit links present and honestly labeled
  const pl = permitLinksHtml();
  assert(pl.includes('codeinspectionpublic.stlucieco.gov'), 'A8 county permit portal link');
  assert(pl.includes('stlucieco.gov'), 'A8 county permitting page link');
  assert(pl.includes('msc.fema.gov'), 'A8 FEMA flood map link');
  assert(/isn't auto-pulled/.test(pl), 'A8 honest auto-pull label');

  // A9: dealSqft prefers intel.sqft, falls back to rcData
  assert(dealSqft({ intel: { sqft: 1005 } }) === 1005, 'A9 intel sqft');
  assert(dealSqft({ intel: {}, rcData: { sqft: 1440 } }) === 1440, 'A9 rcData sqft fallback');
  assert(dealSqft({ intel: {} }) === 0, 'A9 no sqft → 0');

  // A10: intake → run field mapping (buy/FHA, flip, validation)
  const valsBuy = { 'a-price': '200000', 'a-rent': '1800' };
  global.document = { getElementById: id => ({ value: valsBuy[id] !== undefined ? valsBuy[id] : '' }) };
  agentState.parsed = { address: '1403 Avenue M, Fort Pierce, FL 34950', source: 'Zillow' };
  agentState.strategy = 'buy'; agentState.loan = 'fha'; agentState.coords = null;
  const ap = agentPatch();
  assert(!ap.error, 'A10 no error, got ' + ap.error);
  assert(ap.strategy === 'buy' && ap.loan === 'fha', 'A10 strategy/loan passthrough');
  assert(ap.fields['f-price'] === 200000 && ap.fields['f-rent'] === 1800, 'A10 price/rent mapped');
  assert(ap.fields['f-addr'] === '1403 Avenue M, Fort Pierce, FL 34950', 'A10 address mapped');
  agentState.strategy = 'flip';
  const valsFlip = { 'a-fprice': '150000', 'a-arv': '250000', 'a-rehab': '40000' };
  global.document = { getElementById: id => ({ value: valsFlip[id] !== undefined ? valsFlip[id] : '' }) };
  const apf = agentPatch();
  assert(!apf.error, 'A10 flip no error');
  assert(apf.fields['f-price'] === 150000 && apf.fields['f-flip-arv'] === 250000 && apf.fields['f-flip-rehab'] === 40000, 'A10 flip fields mapped');
  agentState.strategy = 'build';
  const valsBuild = { 'a-land': '60000', 'a-buildcost': '220000', 'a-barv': '350000' };
  global.document = { getElementById: id => ({ value: valsBuild[id] !== undefined ? valsBuild[id] : '' }) };
  const apb = agentPatch();
  assert(!apb.error, 'A10 build no error');
  assert(apb.fields['f-build-land'] === 60000 && apb.fields['f-build-hard'] === 220000 && apb.fields['f-build-arv'] === 350000, 'A10 build fields mapped');
  agentState.strategy = 'buy';
  global.document = { getElementById: () => ({ value: '' }) };
  const ape = agentPatch();
  assert(ape.error === 'Enter a purchase price.', 'A10 missing price errors, got ' + ape.error);
  agentState.parsed = null;
  const ape2 = agentPatch();
  assert(ape2.error === 'Parse a listing link first.', 'A10 no parse errors');
  delete global.document;

  global.fetch = realFetch;
  console.log('Agent-loop tests: all passed (10 groups).');
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

  // T13: parseListingUrl — 6 listing sites + garbage
  const t13cases = [
    ['https://www.zillow.com/homedetails/1403-Avenue-M-Fort-Pierce-FL-34950/1234567_zpid/', 'Zillow', '1403 Avenue M', 'Fort Pierce', 'FL', '34950'],
    ['https://www.redfin.com/FL/Fort-Pierce/1403-Avenue-M-34950/home/141339060', 'Redfin', '1403 Avenue M', 'Fort Pierce', 'FL', '34950'],
    ['https://www.realtor.com/realestateandhomes-detail/1403-Avenue-M_Fort-Pierce_FL_34950_M12345-67890', 'Realtor.com', '1403 Avenue M', 'Fort Pierce', 'FL', '34950'],
    ['https://www.homes.com/property/1403-avenue-m-fort-pierce-fl/3f1w047vlyb9p/', 'Homes.com', '1403 Avenue M', 'Fort Pierce', 'FL', null],
    ['https://www.compass.com/homedetails/1403-Avenue-M-Fort-Pierce-FL-34950/1C95ZW_pid/', 'Compass', '1403 Avenue M', 'Fort Pierce', 'FL', '34950'],
    ['https://www.loopnet.com/Listing/1403-Avenue-M-Fort-Pierce-FL/27553604/', 'LoopNet', '1403 Avenue M', 'Fort Pierce', 'FL', null],
    ['https://www.crexi.com/properties/98765/fl-fort-pierce-1403-avenue-m-34950', 'Crexi', '1403 Avenue M', 'Fort Pierce', 'FL', '34950'],
  ];
  t13cases.forEach(([u, src, street, city, state, zip], i) => {
    const r = parseListingUrl(u);
    assert(r, 't13.' + i + ' parsed ' + u);
    assert(r.source === src, 't13.' + i + ' source: got ' + r.source);
    assert(r.street === street, 't13.' + i + ' street: got ' + r.street);
    assert(r.city === city, 't13.' + i + ' city: got ' + r.city);
    assert(r.state === state, 't13.' + i + ' state: got ' + r.state);
    assert(r.zip === zip, 't13.' + i + ' zip: got ' + r.zip);
  });
  assert(parseListingUrl('https://example.com/not-a-listing') === null, 't13 garbage null');
  assert(parseListingUrl('not a url') === null, 't13 invalid null');
  assert(parseListingUrl('') === null, 't13 empty null');

  // T14: suggested-offer bisection
  const d14a = { price: 200000, rent: 2500, taxA: 2600, insA: 1800, hoaM: 0, downPct: 20, ratePct: 7, termYears: 30, closingPct: 2, vacPct: 8, maintPct: 5, capexPct: 5, mgmtPct: 8, loanType: 'conventional' };
  const o14a = suggestOffer(d14a, 200);
  assert(o14a && o14a.atAsking && o14a.offer >= 200000, 't14a asking already beats target');
  const d14b = { price: 475000, rent: 4800, taxA: 6939, insA: 2800, hoaM: 0, downPct: 3.5, ratePct: 7, termYears: 30, closingPct: 2, vacPct: 8, maintPct: 5, capexPct: 5, mgmtPct: 8, loanType: 'conventional' };
  assert(calc(d14b).cfM < 200, 't14b asking misses target (sanity)');
  const o14b = suggestOffer(d14b, 200);
  assert(o14b && !o14b.atAsking && o14b.offer < 475000, 't14b offer below asking, got ' + (o14b && o14b.offer));
  approx(o14b.metrics.cfM, 200, 5, 't14b cash flow within $5 of target');

  console.log('All calculator self-tests passed (14 tests).');
}

/* RentCast tests — global.fetch is mocked; the real API is never hit. */
async function runRentcastTests() {
  const assert = require('assert');
  const realFetch = global.fetch;
  const hadLS = 'localStorage' in global;
  const realLS = global.localStorage;
  let calls = [];
  const okJson = data => ({ ok: true, status: 200, json: async () => data });
  const mockFetch = impl => { global.fetch = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); }; };
  const setKey = k => { global.localStorage = {
    getItem: id => (id === LS_RC ? (k || '') : (memStore[id] !== undefined ? memStore[id] : null)),
    setItem: (id, v) => { memStore[id] = String(v); },
    removeItem: id => { delete memStore[id]; },
  }; };
  const memStore = {};
  const resetStore = () => { for (const k in memStore) delete memStore[k]; };
  let confirmCalls = 0;
  const stubConfirm = v => { global.confirm = () => { confirmCalls++; return v; }; };
  const ADDR = '1403 Avenue M, Fort Pierce, FL 34950';

  const FULL_PROP = [{ bedrooms: 3, bathrooms: 2, squareFootage: 1440, yearBuilt: 1972, lotSize: 7500, lastSaleDate: '2019-04-02T00:00:00', lastSalePrice: 150000, propertyType: 'Multi-Family' }];
  const FULL_LIST = [{ price: 200000, bedrooms: 3, bathrooms: 2, squareFootage: 1440, daysOnMarket: 21, listedDate: '2026-09-10', photos: ['https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg', 'https://img/4.jpg', 'https://img/5.jpg', 'https://img/6.jpg', 'https://img/7.jpg', 'https://img/8.jpg'] }];
  const FULL_AVMV = { price: 210000, priceRangeLow: 190000, priceRangeHigh: 230000 };
  const FULL_AVMD = { rent: 1850, rentRangeLow: 1700, rentRangeHigh: 2000 };
  const fullMock = async url => {
    if (url.includes('/listings/sale?')) return okJson(FULL_LIST);
    if (url.includes('/properties?')) return okJson(FULL_PROP);
    if (url.includes('/avm/value?')) return okJson(FULL_AVMV);
    if (url.includes('/avm/rent/')) return okJson(FULL_AVMD);
    return okJson({});
  };

  try {
    // R1: no-key short-circuits without calling fetch
    setKey(''); calls = [];
    mockFetch(async () => okJson({}));
    let r = await rentcastLookup(ADDR);
    assert(r.ok === false && r.reason === 'no-key', 'R1 no-key reason, got ' + JSON.stringify(r));
    assert(calls.length === 0, 'R1 fetch must not be called without a key');

    // R2: request construction — 4 parallel calls, encoded address, X-Api-Key
    setKey('test-key-123'); calls = [];
    mockFetch(fullMock);
    r = await rentcastLookup(ADDR);
    assert(r.ok === true, 'R2 lookup ok');
    assert(calls.length === 4, 'R2 four parallel calls, got ' + calls.length);
    const urls = calls.map(c => c.url);
    assert(urls.some(u => u.startsWith(RC_BASE + '/properties?address=1403%20Avenue%20M')), 'R2 properties URL, got ' + urls[0]);
    assert(urls.some(u => u.startsWith(RC_BASE + '/listings/sale?address=1403%20Avenue%20M')), 'R2 listings URL');
    assert(urls.some(u => u.startsWith(RC_BASE + '/avm/value?address=1403%20Avenue%20M')), 'R2 avm value URL');
    assert(urls.some(u => u.startsWith(RC_BASE + '/avm/rent/long-term?address=1403%20Avenue%20M')), 'R2 avm rent URL');
    calls.forEach(c => assert(c.opts && c.opts.headers && c.opts.headers['X-Api-Key'] === 'test-key-123', 'R2 X-Api-Key header'));

    // R3: normalization of a full shape
    assert(r.price === 200000, 'R3 price, got ' + r.price);
    assert(r.beds === 3 && r.baths === 2, 'R3 beds/baths');
    assert(r.sqft === 1440 && r.yearBuilt === 1972 && r.lotSqft === 7500, 'R3 sqft/year/lot');
    assert(r.lastSaleDate === '2019-04-02', 'R3 lastSaleDate, got ' + r.lastSaleDate);
    assert(r.lastSalePrice === 150000, 'R3 lastSalePrice');
    assert(r.dom === 21 && r.listedDate === '2026-09-10', 'R3 dom/listedDate');
    assert(Array.isArray(r.photos) && r.photos.length === 6, 'R3 photos capped at 6, got ' + r.photos.length);
    assert(r.avmValue === 210000 && r.avmLow === 190000 && r.avmHigh === 230000, 'R3 avm value range');
    assert(r.rentEst === 1850 && r.rentLow === 1700 && r.rentHigh === 2000, 'R3 rent range');
    assert(r.source === 'rentcast', 'R3 source tag');

    // R4: sparse shape → nulls, no crash
    calls = [];
    mockFetch(async () => okJson({}));
    r = await rentcastLookup(ADDR);
    assert(r.ok === true, 'R4 ok on sparse');
    assert(r.price === null && r.beds === null && r.rentEst === null, 'R4 nulls');
    assert(Array.isArray(r.photos) && r.photos.length === 0, 'R4 empty photos');

    // R5: error mapping — 401 / 429
    mockFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    r = await rentcastLookup(ADDR);
    assert(!r.ok && r.reason === 'bad-key' && /Setup/.test(r.message), 'R5 401 → bad-key, got ' + r.reason);
    mockFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    r = await rentcastLookup(ADDR);
    assert(!r.ok && r.reason === 'rate-limit' && /50/.test(r.message), 'R5 429 → rate-limit, got ' + r.reason);

    // R6: network failure and timeout map to 'network', never throw
    mockFetch(async () => { throw new Error('boom'); });
    r = await rentcastLookup(ADDR);
    assert(!r.ok && r.reason === 'network', 'R6 reject → network, got ' + r.reason);
    mockFetch((url, opts) => new Promise((_, rej) => {
      const sig = opts && opts.signal;
      if (sig) sig.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    }));
    const t = await rentcastFetch('/properties?address=x', 'k', 30);
    assert(!t.ok && t.reason === 'network' && /timed out/.test(t.message), 'R6 timeout → network/timed out, got ' + JSON.stringify(t));

    // R7: partial failure — one endpoint down, rest fine → ok with partial flag
    mockFetch(async url => url.includes('/avm/rent/') ? { ok: false, status: 500, json: async () => ({}) } : fullMock(url));
    r = await rentcastLookup(ADDR);
    assert(r.ok === true && r.partial === true && r.price === 200000 && r.rentEst === null, 'R7 partial');

    // R8: pure fill mapping, incl. AVM price fallback
    const fills = rentcastFills(r);
    assert(fills.price === 200000 && !('rent' in fills), 'R8 fills from R7 data');
    const f2 = rentcastFills({ price: null, avmValue: 210500, rentEst: 1850, beds: 3, baths: 2.5, sqft: 1440, yearBuilt: 1972, lastSaleDate: '2019-04-02', lastSalePrice: 150000, dom: 21, photos: ['a', 'b'] });
    assert(f2.price === 210500, 'R8 price falls back to AVM, got ' + f2.price);
    assert(f2.rent === 1850 && f2.beds === '3 / 2.5' && f2.sqft === 1440 && f2.yearBuilt === 1972, 'R8 fills fields');
    assert(f2.lastSaleDate === '2019-04-02' && f2.lastSalePrice === 150000 && f2.dom === 21, 'R8 intel fills');
    assert(f2.photos.length === 2, 'R8 photos');

    // T9: intake flow — parse success must NOT auto-fire fetch; explicit tap does
    const els = {};
    const mkEl = () => ({ value: '', textContent: '', innerHTML: '', hidden: true, disabled: false,
      dataset: {}, style: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      _h: {},
      addEventListener(ev, fn) { this._h[ev] = fn; },
      appendChild() {}, querySelector() { return null; } });
    global.document = {
      getElementById: id => (els[id] || (els[id] = mkEl())),
      createElement: () => mkEl(),
      createTextNode: t => ({ text: t }),
      querySelector: () => null,
    };
    setKey('test-key-123'); resetStore(); stubConfirm(true); confirmCalls = 0; calls = [];
    mockFetch(fullMock);
    wireListingIntake();
    const gid = id => global.document.getElementById(id);
    gid('f-listingurl').value = 'https://www.zillow.com/homedetails/1403-Avenue-M-Fort-Pierce-FL-34950/12345678_zpid/';
    await gid('listingurl-pull')._h['click']();
    assert(calls.every(c => String(c.url).includes('nominatim.openstreetmap.org')), 'T9 parse fires no RentCast calls');
    assert(calls.length <= 1, 'T9 at most the free geocode call, got ' + calls.length + ' fetches');
    assert(gid('agent-flow').hidden === false, 'T9 agent flow revealed after parse');
    assert(agentState.parsed && /1403 Avenue M/i.test(agentState.parsed.address), 'T9 parsed address in agent state');
    assert(/What the agent found/.test(gid('agent-intel').innerHTML), 'T9 agent intel rendered');
    // RentCast pull no longer lives in the intake card — the deep-dive card appears on results instead
    // Dig-deeper gating: prominent card for score >= 60
    gid('dig-deeper-slot').innerHTML = '';
    renderDigDeeper({ score: 75, addr: ADDR });
    assert(/Dig deeper with RentCast/.test(gid('dig-deeper-slot').innerHTML), 'T9 dig-deeper card for score>=60');
    gid('dig-deeper-slot').innerHTML = '';
    renderDigDeeper({ score: 40, addr: ADDR });
    assert(gid('dig-deeper-slot').innerHTML === '', 'T9 no dig-deeper card for score<60 (subtle link instead)');

    // T10: no-key gate — zero requests, confirm never shown
    setKey(''); resetStore(); stubConfirm(true); confirmCalls = 0; calls = [];
    mockFetch(async () => okJson({}));
    r = await gatedRentcastPull(ADDR);
    assert(!r.ok && r.reason === 'no-key', 'T10 no-key reason, got ' + JSON.stringify(r));
    assert(calls.length === 0, 'T10 zero fetches without key');
    assert(confirmCalls === 0, 'T10 confirm not shown without key');

    // T11: confirm cancel — zero requests, usage untouched
    setKey('k'); resetStore(); stubConfirm(false); confirmCalls = 0; calls = [];
    mockFetch(async () => okJson({}));
    r = await gatedRentcastPull(ADDR);
    assert(!r.ok && r.reason === 'cancelled', 'T11 cancelled reason, got ' + JSON.stringify(r));
    assert(calls.length === 0, 'T11 zero fetches on cancel');
    assert(confirmCalls === 1, 'T11 confirm shown once');
    assert(rcUsage().used === 0, 'T11 usage untouched');

    // T12: month rollover resets usage; next pull counts fresh
    const _d = new Date(); _d.setDate(_d.getDate() - 40);
    memStore[LS_RC_USAGE] = JSON.stringify({ month: _d.toISOString().slice(0, 7), used: 37 });
    const ru = rcUsage();
    assert(ru.used === 0 && ru.month === rcMonthStr(), 'T12 rollover resets, got ' + JSON.stringify(ru));
    setKey('k'); stubConfirm(true); confirmCalls = 0; calls = [];
    mockFetch(fullMock);
    r = await gatedRentcastPull(ADDR);
    assert(r.ok === true, 'T12 pull ok after rollover');
    assert(rcUsage().used === 4, 'T12 usage 4 after rollover pull, got ' + rcUsage().used);

    // T13: applyRentcastToDeal — pure deal-object mapping
    const res13 = normalizeRentcast(FULL_PROP, FULL_LIST, FULL_AVMV, FULL_AVMD);
    const deal13 = { price: 0, rent: 0, beds: '', intel: {}, photos: [], addr: ADDR };
    applyRentcastToDeal(deal13, Object.assign({ ok: true }, res13));
    assert(deal13.price === 200000, 'T13 price, got ' + deal13.price);
    assert(deal13.rent === 1850, 'T13 rent, got ' + deal13.rent);
    assert(deal13.beds === '3 / 2', 'T13 beds, got ' + deal13.beds);
    assert(deal13.intel.sqft === 1440 && deal13.intel.yearBuilt === 1972 && deal13.intel.dom === 21, 'T13 intel sqft/year/dom');
    assert(deal13.intel.lastSaleDate === '2019-04-02' && deal13.intel.lastSalePrice === 150000, 'T13 last sale');
    assert(deal13.photos.length === 6 && deal13.photos[0].name === 'via RentCast', 'T13 photos');
    assert(deal13.rcData && deal13.rcData.price === 200000, 'T13 rcData stored');

    // T14: failed attempts still count (the API bills them)
    setKey('k'); resetStore(); stubConfirm(true); confirmCalls = 0; calls = [];
    mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    r = await gatedRentcastPull(ADDR);
    assert(!r.ok, 'T14 not ok on 500s');
    assert(r.attempts === 4, 'T14 attempts counted on failure, got ' + r.attempts);
    assert(calls.length === 4, 'T14 four fetches fired on failure');
    assert(rcUsage().used === 4, 'T14 usage +4 on failure, got ' + rcUsage().used);

    // T15: response cache — hit costs 0, expired refires, force bypasses, cap evicts
    setKey('k'); resetStore(); delete memStore[LS_RC_CACHE];
    stubConfirm(true); confirmCalls = 0; calls = [];
    mockFetch(fullMock);
    let r15 = await gatedRentcastPull(ADDR);
    assert(r15.ok && !r15.cached && calls.length === 4, 'T15a first pull fires 4, got ' + calls.length);
    assert(rcUsage().used === 4, 'T15a usage 4, got ' + rcUsage().used);
    calls = []; confirmCalls = 0;
    r15 = await gatedRentcastPull(ADDR);
    assert(r15.ok && r15.cached === true && r15.attempts === 0, 'T15b cache hit flagged');
    assert(calls.length === 0, 'T15b zero fetches on hit');
    assert(confirmCalls === 0, 'T15b no confirm on hit');
    assert(rcUsage().used === 4, 'T15b usage unchanged on hit, got ' + rcUsage().used);
    assert(r15.price === 200000, 'T15b cached data intact');
    calls = []; confirmCalls = 0;
    r15 = await gatedRentcastPull(ADDR, { force: true });
    assert(!r15.cached && calls.length === 4 && confirmCalls === 1, 'T15c force refires with confirm');
    const _ck = rcCacheRead();
    const _k15 = 'pull:' + rcCacheNorm(ADDR);
    _ck[_k15].at = Date.now() - 8 * 24 * 3600 * 1000; // age past the 7-day TTL
    rcCacheWrite(_ck);
    calls = [];
    r15 = await gatedRentcastPull(ADDR);
    assert(!r15.cached && calls.length === 4, 'T15d expired entry refires');
    for (let i = 0; i < 55; i++) rcCacheSet('pull:evict' + i, { price: i });
    const _c2 = rcCacheRead(), _n2 = Object.keys(_c2).length;
    assert(_n2 <= 50, 'T15e cache capped at 50, got ' + _n2);
    assert(!('pull:evict0' in _c2), 'T15e oldest evicted first');

    // T16: search param building
    const SEARCH_LIST = [{ addressLine1: '1403 Avenue M', city: 'Fort Pierce', state: 'FL', zipCode: '34950', price: 200000, bedrooms: 3, bathrooms: 2, squareFootage: 1440, daysOnMarket: 21, photos: ['https://img/1.jpg'] }];
    setKey('sk'); resetStore(); delete memStore[LS_RC_CACHE]; calls = [];
    mockFetch(async url => (url.includes('/listings/sale?') ? okJson(SEARCH_LIST) : okJson({})));
    let s16 = await rentcastSearch({ zipCode: '34950', propertyType: 'Multi-Family' });
    assert(s16.ok && s16.listings.length === 1, 'T16a zip search ok');
    let u16 = new URL(calls[0].url);
    assert(u16.searchParams.get('zipCode') === '34950', 'T16a zipCode param');
    assert(u16.searchParams.get('propertyType') === 'Multi-Family', 'T16a propertyType param');
    assert(u16.searchParams.get('limit') === '20', 'T16a limit param');
    assert(calls[0].opts.headers['X-Api-Key'] === 'sk', 'T16a X-Api-Key header');
    assert(calls[0].url.startsWith(RC_BASE + '/listings/sale?'), 'T16a endpoint');
    const l0 = s16.listings[0];
    assert(l0.address === '1403 Avenue M, Fort Pierce, FL 34950', 'T16a addr, got ' + l0.address);
    assert(l0.price === 200000 && l0.beds === 3 && l0.baths === 2 && l0.sqft === 1440 && l0.dom === 21, 'T16a fields');
    assert(l0.photo === 'https://img/1.jpg', 'T16a first photo');
    calls = [];
    await rentcastSearch({ city: 'Fort Pierce', state: 'FL', propertyType: 'Single Family' });
    u16 = new URL(calls[0].url);
    assert(u16.searchParams.get('city') === 'Fort Pierce' && u16.searchParams.get('state') === 'FL', 'T16b city/state params');
    calls = [];
    await rentcastSearch({ latitude: 27.44, longitude: -80.33, radius: '25', propertyType: 'Condo' });
    u16 = new URL(calls[0].url);
    assert(u16.searchParams.get('latitude') === '27.44' && u16.searchParams.get('longitude') === '-80.33' && u16.searchParams.get('radius') === '25', 'T16c geo params, got ' + calls[0].url);
    assert(JSON.stringify(parseLocationInput('34950')) === JSON.stringify({ zipCode: '34950' }), 'T16d zip parse');
    const _cf = parseLocationInput('Fort Pierce, FL');
    assert(_cf && _cf.city === 'Fort Pierce' && _cf.state === 'FL', 'T16e city parse');
    assert(parseLocationInput('nonsense') === null && parseLocationInput('') === null, 'T16f bad parse null');

    // T17: search usage — 1 on miss, 0 on cache hit
    setKey('sk'); resetStore(); delete memStore[LS_RC_CACHE]; calls = [];
    mockFetch(async url => (url.includes('/listings/sale?') ? okJson(SEARCH_LIST) : okJson({})));
    await rentcastSearch({ zipCode: '34950', propertyType: 'Multi-Family' });
    assert(rcUsage().used === 1, 'T17a search +1, got ' + rcUsage().used);
    calls = [];
    const s17 = await rentcastSearch({ zipCode: '34950', propertyType: 'Multi-Family' });
    assert(s17.cached === true && calls.length === 0, 'T17b cached search fires nothing');
    assert(rcUsage().used === 1, 'T17b usage unchanged on cached search');

    // T18: Analyze wiring fills the intake address and navigates
    global.location = { hash: '' };
    fillIntakeAddress('1403 Avenue M, Fort Pierce, FL 34950');
    assert(gid('f-addr').value === '1403 Avenue M, Fort Pierce, FL 34950', 'T18a intake addr filled');
    assert(global.location.hash === '#/new', 'T18b navigates to new, got ' + global.location.hash);
    assert(gid('agent-flow').hidden === false, 'T18c agent flow revealed');
    delete global.location;

    console.log('RentCast tests: all passed (18 groups).');
  } finally {
    global.fetch = realFetch;
    if (hadLS) global.localStorage = realLS; else delete global.localStorage;
    delete global.document;
    delete global.confirm;
  }
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

function syncRcSetupUI() {
  const k = loadRcKey();
  const inp = document.getElementById('rc-key');
  const okEl = document.getElementById('rc-success'), errEl = document.getElementById('rc-error');
  if (inp) inp.value = k || '';
  if (errEl) errEl.textContent = '';
  if (okEl) okEl.textContent = k ? 'RentCast key saved in this browser.' : '';
  refreshRcUsageLabels();
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
function intelCardHtml(deal, interactive) {
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
  const rcBits = [];
  if (deal.rcData) {
    if (deal.rcData.price != null) rcBits.push('price ' + fmt$(deal.rcData.price));
    if (deal.rcData.avmValue != null) rcBits.push('AVM ' + fmt$(deal.rcData.avmValue));
    if (deal.rcData.rentEst != null) rcBits.push('rent est. ' + fmt$(deal.rcData.rentEst) + '/mo');
    if (deal.rcData.beds != null || deal.rcData.baths != null) rcBits.push((deal.rcData.beds != null ? deal.rcData.beds : '?') + ' bd / ' + (deal.rcData.baths != null ? deal.rcData.baths : '?') + ' ba');
    if (deal.rcData.sqft != null) rcBits.push(Math.round(deal.rcData.sqft).toLocaleString('en-US') + ' sqft');
  }
  const rcLine = deal.rcData
    ? `<p class="tip"><strong style="color:var(--fg)">Data source: RentCast</strong>${rcBits.length ? ' — ' + esc(rcBits.join(' · ')) : ''}.</p>` : '';
  const verifyTip = deal.rcData
    ? 'Some fields were auto-filled via RentCast — verify against the listing.'
    : 'Free public sources — nothing is auto-fetched; open a link to verify records yourself.';
  const digSubtle = (interactive && !deal.rcData && (deal.score || 0) < 60 && (deal.strategy || 'buy') === 'buy')
    ? '<p class="tip no-print"><a href="#" id="rc-subtle-link" style="color:var(--accent)">Full RentCast pull</a> — tax history, AVM, photos, DOM (uses ~4 calls).</p>'
    : '';
  return `<div class="card"><h3>Property intel</h3>
    ${addr ? `<p style="margin-bottom:10px"><strong>${esc(addr)}</strong></p>` : ''}
    ${rcLine}
    <table class="breakdown"><tr><th>Item</th><th>Detail</th></tr>
    ${rows.map(r => `<tr><td>${r[0]}</td><td style="text-align:right">${esc(String(r[1]))}</td></tr>`).join('')}</table>
    ${sv ? `<div class="map-wrap"><iframe title="Map of ${esc(addr)}" src="${esc(sv)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>` : ''}
    ${links.length ? `<div class="intel-links no-print">${links.map(l =>
      `<a class="intel-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</div>
      <p class="tip">${verifyTip}</p>` : ''}
    ${digSubtle}
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

/* ---------- Suggested offer (buy & hold) ---------- */
/* Solve for the highest purchase price with monthly cash flow >= target.
   Cash flow falls monotonically as price rises (P&I scales with the loan),
   so bisection converges. Reuses calc() — no duplicated math. */
function suggestOffer(deal, target) {
  const t = isFinite(+target) ? +target : 200;
  const asking = +deal.price;
  if (!(asking > 0)) return null;
  const mAsk = calc(deal);
  if (mAsk.cfM >= t) return { offer: asking, atAsking: true, metrics: mAsk, target: t, asking };
  const mMin = calc(Object.assign({}, deal, { price: 1 }));
  if (mMin.cfM < t) return null; // rent can't cover fixed opex even free — no card
  let lo = 1, hi = asking;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (calc(Object.assign({}, deal, { price: mid })).cfM >= t) lo = mid; else hi = mid;
  }
  return { offer: lo, atAsking: false, metrics: calc(Object.assign({}, deal, { price: lo })), target: t, asking };
}

function suggestedOfferHtml(deal) {
  let target = 200;
  try {
    const w = JSON.parse(localStorage.getItem('deallens_watch') || 'null');
    if (w && isFinite(+w.minCashFlow)) target = +w.minCashFlow;
  } catch (err) { /* no watch saved — default target */ }
  const o = suggestOffer(deal, target);
  if (!o) return '';
  if (o.atAsking) {
    const m = o.metrics;
    return `<div class="card"><h3>Suggested offer</h3>
      <p>Asking price already beats your ${fmt$(target)}/mo target — no discount needed.</p>
      <p class="tip">At ${fmt$(o.offer)}: cash flow ${fmt$(m.cfM)}/mo, DSCR ${m.dscr === 99 ? 'n/a' : m.dscr.toFixed(2)}.</p></div>`;
  }
  const mo = o.metrics;
  const pctBelow = (1 - o.offer / o.asking) * 100;
  return `<div class="card"><h3>Suggested offer</h3>
    <div class="grid-metrics">
      <div class="metric"><div class="v good">${fmt$(o.offer)}</div><div class="l">Offer to hit ${fmt$(target)}/mo (${pctBelow.toFixed(1)}% below asking)</div></div>
      <div class="metric"><div class="v">${fmt$(mo.cfM)}<span style="font-size:.8rem;color:var(--muted-fg)">/mo</span></div><div class="l">Cash flow at offer</div></div>
      <div class="metric"><div class="v">${fmtPct1(mo.capRate)}</div><div class="l">Cap rate at offer</div></div>
      <div class="metric"><div class="v">${mo.dscr === 99 ? 'n/a' : mo.dscr.toFixed(2)}</div><div class="l">DSCR at offer</div></div>
    </div>
    <p class="tip">Cash in at offer: ${fmt$(mo.cashIn)}. Walk-away: anything above ${fmt$(o.offer)} misses your cash-flow target.</p></div>`;
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

    ${suggestedOfferHtml(deal)}
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
      <div class="metric"><div class="v">${fmt$(m.mao)}</div><div class="l">Suggested max offer (70% rule)</div></div>
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
  box.innerHTML = `<h1 class="no-print">${esc(deal.name || 'Untitled deal')}</h1>` + stratBadge +
    (strat === 'buy' ? '<div id="dig-deeper-slot"></div>' : '') + body +
    rehabEstimateCardHtml(deal) + newBuildCompCardHtml(deal) + intelCardHtml(deal, true);
  if (strat === 'buy') {
    renderDigDeeper(deal, false);
    const sub = document.getElementById('rc-subtle-link');
    if (sub) sub.addEventListener('click', e => {
      e.preventDefault();
      renderDigDeeper(deal, true);
      const slot = document.getElementById('dig-deeper-slot');
      if (slot && slot.scrollIntoView) { try { slot.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e2) {} }
    });
  }
  wireEstimatorCards(deal);
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
    lat: v('f-lat'), lng: v('f-lng'),
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
    rcData: lastRcData, // normalized RentCast payload (null when unused)
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
  lastRcData = null;
  const rh = document.getElementById('f-rent-rc-hint');
  if (rh) rh.hidden = true;
  setStrategy('buy');
  setLoanType('conventional', true);
  renderPhotoGallery();
  const pe = document.getElementById('form-error');
  if (pe) pe.textContent = '';
  // reset the agent intake card
  agentState.parsed = null; agentState.url = ''; agentState.coords = null;
  agentState.loan = 'conventional'; agentState.strategy = 'buy'; agentState.geocoding = false;
  const af = document.getElementById('agent-flow');
  if (af) af.hidden = true;
  const lu = document.getElementById('f-listingurl');
  if (lu) lu.value = '';
  const lm = document.getElementById('listingurl-msg');
  if (lm) lm.textContent = '';
  const rc = document.getElementById('results-content');
  if (rc) rc.innerHTML = '';
  const pc = document.getElementById('report-content');
  if (pc) pc.innerHTML = '';
  go('new');
}

/* ================= RentCast (BYOK property data) =================
   Free tier: 50 lookups/month. One listing pull = 4 API calls (property
   record, active listing, AVM value, AVM rent). The user brings their own
   key, stored in localStorage under LS_RC. No live calls are made without
   a saved key; node tests mock global.fetch. */
const RC_BASE = 'https://api.rentcast.io/v1';
const RC_TIMEOUT_MS = 12000;

function rcErr(reason, message) { return { ok: false, reason, message }; }

async function rentcastFetch(path, key, timeoutMs) {
  const ms = timeoutMs == null ? RC_TIMEOUT_MS : timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(RC_BASE + path, {
      headers: { 'X-Api-Key': key, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 401) return rcErr('bad-key', 'RentCast rejected the key — check it in Setup.');
    if (res.status === 403) return rcErr('forbidden', 'RentCast blocked this key (403). In your RentCast dashboard: 1) make sure the free plan is selected for this key, 2) remove any IP or endpoint restrictions. Then try again.');
    if (res.status === 429) return rcErr('rate-limit', 'RentCast rate limit hit (free tier: 50 lookups/month).');
    if (!res.ok) return rcErr('http', 'RentCast error (HTTP ' + res.status + ') — try again.');
    const json = await res.json();
    return { ok: true, data: json };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String((e && e.message) || '')));
    return rcErr('network', aborted
      ? 'RentCast request timed out — check connection and try again.'
      : 'Could not reach RentCast — check connection and try again.');
  } finally { clearTimeout(timer); }
}

const rcPick = (obj, keys) => {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};
const rcNum = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
const rcFirst = v => (Array.isArray(v) ? v[0] : v) || {};

/* Defensive normalization — every field optional, null when absent. */
function normalizeRentcast(propRaw, listingRaw, avmVRaw, avmRRaw) {
  const p = rcFirst(propRaw), l = rcFirst(listingRaw);
  const photosRaw = rcPick(l, ['photos', 'images', 'photoUrls', 'imageUrls', 'photosUrls'])
    || rcPick(p, ['photos', 'images', 'photoUrls', 'imageUrls']) || [];
  const photos = (Array.isArray(photosRaw) ? photosRaw : [])
    .map(x => (typeof x === 'string' ? x : (x && (x.url || x.src || x.href))) || null)
    .filter(Boolean).slice(0, 6);
  const lastSaleDate = rcPick(p, ['lastSaleDate', 'lastSoldDate', 'last_sale_date']);
  const listedDate = rcPick(l, ['listedDate', 'listDate', 'listed_date']);
  const avmV = avmVRaw || {}, avmR = avmRRaw || {};
  return {
    price: rcNum(rcPick(l, ['price', 'listPrice'])) ?? rcNum(rcPick(p, ['price'])),
    beds: rcNum(rcPick(l, ['bedrooms', 'beds'])) ?? rcNum(rcPick(p, ['bedrooms', 'beds'])),
    baths: rcNum(rcPick(l, ['bathrooms', 'baths'])) ?? rcNum(rcPick(p, ['bathrooms', 'baths'])),
    sqft: rcNum(rcPick(l, ['squareFootage', 'sqft', 'livingArea', 'living_area'])) ?? rcNum(rcPick(p, ['squareFootage', 'sqft', 'livingArea'])),
    yearBuilt: rcNum(rcPick(p, ['yearBuilt', 'year_built'])),
    lotSqft: rcNum(rcPick(p, ['lotSize', 'lotSqft', 'lot_size'])),
    lastSaleDate: lastSaleDate ? String(lastSaleDate).slice(0, 10) : null,
    lastSalePrice: rcNum(rcPick(p, ['lastSalePrice', 'lastSoldPrice', 'last_sale_price'])),
    dom: rcNum(rcPick(l, ['daysOnMarket', 'days_on_market'])),
    listedDate: listedDate ? String(listedDate).slice(0, 10) : null,
    photos,
    avmValue: rcNum(rcPick(avmV, ['price', 'value'])),
    avmLow: rcNum(rcPick(avmV, ['priceRangeLow', 'low', 'rangeLow'])),
    avmHigh: rcNum(rcPick(avmV, ['priceRangeHigh', 'high', 'rangeHigh'])),
    rentEst: rcNum(rcPick(avmR, ['rent', 'price', 'value'])),
    rentLow: rcNum(rcPick(avmR, ['rentRangeLow', 'priceRangeLow', 'low', 'rangeLow'])),
    rentHigh: rcNum(rcPick(avmR, ['rentRangeHigh', 'priceRangeHigh', 'high', 'rangeHigh'])),
    propertyType: rcPick(p, ['propertyType', 'property_type']) || rcPick(l, ['propertyType']),
    source: 'rentcast',
  };
}

async function rentcastLookup(address) {
  const key = loadRcKey();
  if (!key) return rcErr('no-key', 'No RentCast key saved.');
  const enc = encodeURIComponent(address);
  let attempts = 0; // every HTTP request fired counts, even on failure
  const fire = (path, k) => { attempts++; return rentcastFetch(path, k); };
  const [prop, listing, avmV, avmR] = await Promise.all([
    fire('/properties?address=' + enc + '&limit=1', key),
    fire('/listings/sale?address=' + enc + '&limit=1', key),
    fire('/avm/value?address=' + enc, key),
    fire('/avm/rent/long-term?address=' + enc, key),
  ]);
  const results = [prop, listing, avmV, avmR];
  const fatal = results.find(r => !r.ok && (r.reason === 'bad-key' || r.reason === 'rate-limit' || r.reason === 'forbidden'));
  if (fatal) { fatal.attempts = attempts; return fatal; }
  if (!results.some(r => r.ok)) { const e = results.find(r => !r.ok); e.attempts = attempts; return e; }
  const data = normalizeRentcast(
    prop.ok ? prop.data : null, listing.ok ? listing.data : null,
    avmV.ok ? avmV.data : null, avmR.ok ? avmR.data : null);
  const out = Object.assign({ ok: true, attempts }, data);
  if (results.some(r => !r.ok)) out.partial = true;
  return out;
}

/* Pure mapping: normalized RentCast data -> form fills. Tested in node. */
function rentcastFills(d) {
  const fills = {};
  const price = d.price != null ? d.price : d.avmValue;
  if (price != null) fills.price = Math.round(price);
  if (d.rentEst != null) fills.rent = Math.round(d.rentEst);
  if (d.beds != null || d.baths != null) {
    fills.beds = (d.beds != null ? String(d.beds).replace(/\.0$/, '') : '?') + ' / ' +
      (d.baths != null ? String(d.baths).replace(/\.0$/, '') : '?');
  }
  if (d.sqft != null) fills.sqft = Math.round(d.sqft);
  if (d.yearBuilt != null) fills.yearBuilt = Math.round(d.yearBuilt);
  if (d.lastSaleDate) fills.lastSaleDate = d.lastSaleDate;
  if (d.lastSalePrice != null) fills.lastSalePrice = Math.round(d.lastSalePrice);
  if (d.dom != null) fills.dom = Math.round(d.dom);
  if (d.photos && d.photos.length) fills.photos = d.photos.slice(0, 6);
  return fills;
}

function applyRentcastFills(fills) {
  const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
  set('f-price', fills.price);
  set('f-rent', fills.rent);
  const rh = document.getElementById('f-rent-rc-hint');
  if (rh) {
    if (fills.rent != null) { rh.textContent = 'RentCast estimate — verify against the listing.'; rh.hidden = false; }
    else rh.hidden = true;
  }
  set('f-beds', fills.beds);
  set('f-sqft', fills.sqft);
  set('f-yearbuilt', fills.yearBuilt);
  set('f-lastsaledate', fills.lastSaleDate);
  set('f-lastsaleprice', fills.lastSalePrice);
  set('f-dom', fills.dom);
  (fills.photos || []).forEach(u => addPhoto(u, 'via RentCast'));
}

/* ================= DealLens agent loop =================
   Drop a link → pick loan → pick strategy → the app does the rest.
   Free auto-enrichment only (listing sites block scraping, so nothing is
   fetched from them): the address is parsed from the URL slug, geocoded via
   Nominatim, and free deep-links render (parcel/GIS, Street View, FEMA flood
   map, St. Lucie County permit search). Price + rent are the only manual
   inputs — no free source has them. RentCast is the deep-dive on good deals,
   not the entry step (see the results-view "Dig deeper" card). */
let lastListingUrl = '';
let lastRcData = null; // normalized RentCast payload for the current deal (or null)

const AGENT_LOANS = [
  ['conventional', 'Conventional'], ['fha', 'FHA'], ['va', 'VA'],
  ['dscr', 'DSCR loan'], ['seller', 'Seller finance'], ['cash', 'Cash'],
];
const AGENT_STRATS = [
  ['buy', 'Buy & Hold'], ['flip', 'Rehab Flip'], ['build', 'New Build'],
];
let agentState = { parsed: null, url: '', loan: 'conventional', strategy: 'buy', coords: null, geocoding: false };

/* Free geocode via Nominatim (OpenStreetMap). 8s timeout, silent failure → null. */
async function geocodeAddress(address) {
  if (typeof fetch === 'undefined') return null;
  const q = encodeURIComponent(String(address || '').trim());
  if (!q) return null;
  let ctl = null, to = null;
  try {
    if (typeof AbortController !== 'undefined') {
      ctl = new AbortController();
      to = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 8000);
    }
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + q, {
      headers: { 'Accept': 'application/json' },
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng };
  } catch (err) { return null; }
  finally { if (to) clearTimeout(to); }
}

/* Permit links — St. Lucie County (verified 2026-10-04 by web search):
   the legacy Permit Status portal is searchable by site address / permit #;
   the county is rolling out a new Tyler EnerGov portal, so the county
   permitting & zoning page is linked too. Honestly labeled: history is NOT
   auto-pulled. */
function permitLinksHtml() {
  const items = [
    { label: 'St. Lucie County permit search', url: 'http://codeinspectionpublic.stlucieco.gov/Permit_Status.aspx' },
    { label: 'County permitting & zoning', url: 'https://www.stlucieco.gov/departments-and-services/planning-and-development-services/permitting-zoning' },
    { label: 'FEMA flood map', url: 'https://msc.fema.gov/portal/search' },
  ];
  return '<div class="intel-links">' + items.map(l =>
    '<a class="intel-link" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>').join('') + '</div>' +
    '<p class="tip">Permit history isn\'t auto-pulled — check here in 2 minutes: roof permit age, electrical/plumbing permits, any open violations.</p>';
}

function renderAgentPills() {
  const loanBox = document.getElementById('agent-loans');
  if (loanBox) loanBox.innerHTML = AGENT_LOANS.map(([v, l]) =>
    '<label class="radio-pill"><input type="radio" name="agent-loan" value="' + v + '"' +
    (agentState.loan === v ? ' checked' : '') + '> ' + esc(l) + '</label>').join('');
  const stratBox = document.getElementById('agent-strats');
  if (stratBox) stratBox.innerHTML = AGENT_STRATS.map(([v, l]) =>
    '<label class="radio-pill"><input type="radio" name="agent-strat" value="' + v + '"' +
    (agentState.strategy === v ? ' checked' : '') + '> ' + esc(l) + '</label>').join('');
  syncAgentInputs();
}

function syncAgentInputs() {
  const s = agentState.strategy;
  ['agent-inputs-buy', 'agent-inputs-flip', 'agent-inputs-build'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  const show = document.getElementById(s === 'flip' ? 'agent-inputs-flip' : s === 'build' ? 'agent-inputs-build' : 'agent-inputs-buy');
  if (show) show.hidden = false;
}

function renderAgentIntel() {
  const box = document.getElementById('agent-intel');
  if (!box) return;
  if (!agentState.parsed) { box.innerHTML = ''; return; }
  const addr = agentState.parsed.address;
  const links = intelLinks(addr);
  const sv = streetViewEmbed(addr);
  const c = agentState.coords;
  const coordLine = c ? ' · ' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5)
    : agentState.geocoding ? ' · locating…' : '';
  box.innerHTML =
    '<p class="tip" style="margin-bottom:6px"><strong>What the agent found</strong> — via ' +
    esc(agentState.parsed.source || 'link') + coordLine + '</p>' +
    '<div class="intel-links">' + links.map(l =>
      '<a class="intel-link" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>').join('') + '</div>' +
    (sv ? '<div class="map-wrap"><iframe title="Map of ' + esc(addr) + '" src="' + esc(sv) + '" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>' : '') +
    permitLinksHtml();
}

function agentSetVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

/* Pure-ish mapping: agent inputs → main-form field values. Returns
   {error} or {strategy, loan, fields:{id:value}}. Node-testable with a
   stubbed document. */
function agentPatch() {
  const gv = id => { const el = (typeof document !== 'undefined') && document.getElementById(id); return el ? el.value : ''; };
  const num = id => { const x = parseFloat(gv(id)); return isFinite(x) ? x : 0; };
  const p = agentState.parsed;
  if (!p) return { error: 'Parse a listing link first.' };
  const fields = { 'f-addr': p.address, 'f-name': p.address };
  if (agentState.coords) {
    fields['f-lat'] = agentState.coords.lat.toFixed(6);
    fields['f-lng'] = agentState.coords.lng.toFixed(6);
  }
  if (agentState.strategy === 'buy') {
    const price = num('a-price'), rent = num('a-rent');
    if (!(price > 0)) return { error: 'Enter a purchase price.' };
    fields['f-price'] = price; fields['f-rent'] = rent;
  } else if (agentState.strategy === 'flip') {
    const price = num('a-fprice'), arv = num('a-arv'), rehab = num('a-rehab');
    if (!(price > 0)) return { error: 'Enter a purchase price.' };
    if (!(arv > 0)) return { error: 'Enter the after-repair value (ARV).' };
    fields['f-price'] = price; fields['f-flip-arv'] = arv; fields['f-flip-rehab'] = rehab;
  } else {
    const land = num('a-land'), build = num('a-buildcost'), arv = num('a-barv');
    if (!(land > 0 || build > 0)) return { error: 'Enter at least a land cost or build cost.' };
    if (!(arv > 0)) return { error: 'Enter the finished value (ARV).' };
    fields['f-build-land'] = land; fields['f-build-hard'] = build; fields['f-build-arv'] = arv;
  }
  return { strategy: agentState.strategy, loan: agentState.loan, fields };
}

function agentRunAnalysis() {
  const errEl = document.getElementById('agent-error');
  const setErr = t => { if (errEl) errEl.textContent = t || ''; };
  setErr('');
  const r = agentPatch();
  if (r.error) { setErr(r.error); return; }
  setStrategy(r.strategy);
  setLoanType(r.loan, true);
  Object.keys(r.fields).forEach(id => agentSetVal(id, r.fields[id]));
  const form = document.getElementById('deal-form');
  if (form && form.requestSubmit) form.requestSubmit();
  else if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
}

/* Fill the agent loop from an address alone (Find-deals "Analyze" buttons). */
function intakeFromAddress(addr) {
  const addrEl = document.getElementById('f-addr');
  if (addrEl) addrEl.value = addr;
  agentState.parsed = { address: addr, source: 'RentCast search', street: addr, city: null, state: null, zip: null };
  agentState.url = '';
  agentState.coords = null;
  agentState.geocoding = true;
  const flow = document.getElementById('agent-flow');
  if (flow) flow.hidden = false;
  renderAgentPills();
  const head = document.getElementById('agent-head');
  if (head) head.innerHTML = '📍 <strong>' + esc(addr) + '</strong>';
  const found = document.getElementById('agent-found');
  if (found) found.textContent = 'Agent found the address — add price + rent and I\'ll run it.';
  renderAgentIntel();
  geocodeAddress(addr).then(c => {
    agentState.geocoding = false;
    if (c) { agentState.coords = c; renderAgentIntel(); }
  }).catch(() => { agentState.geocoding = false; });
}

async function onAgentParse() {
  const inp = document.getElementById('f-listingurl');
  const msg = document.getElementById('listingurl-msg');
  const flow = document.getElementById('agent-flow');
  const url = (inp.value || '').trim();
  const parsed = parseListingUrl(url);
  if (!parsed) {
    if (msg) msg.textContent = "Couldn't read that link — paste the address manually or try another listing site (Zillow, Redfin, Realtor.com, Homes.com, Compass, LoopNet, Crexi).";
    if (flow) flow.hidden = true;
    agentState.parsed = null;
    agentState.url = '';
    return;
  }
  lastListingUrl = url;
  agentState.parsed = parsed;
  agentState.url = url;
  agentState.coords = null;
  agentState.geocoding = true;
  if (flow) flow.hidden = false;
  renderAgentPills();
  const head = document.getElementById('agent-head');
  if (head) head.innerHTML = '📍 <strong>' + esc(parsed.address) + '</strong>';
  const found = document.getElementById('agent-found');
  if (found) found.textContent = 'Agent found the address — add price + rent and I\'ll run it.';
  if (msg) msg.textContent = '';
  renderAgentIntel();
  const zr = document.getElementById('agent-ziggy-row');
  if (zr) zr.hidden = false;
  try {
    const c = await geocodeAddress(parsed.address);
    agentState.geocoding = false;
    if (c && agentState.parsed === parsed) { agentState.coords = c; renderAgentIntel(); }
  } catch (e) { agentState.geocoding = false; }
}

function wireListingIntake() {
  const btn = document.getElementById('listingurl-pull');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', onAgentParse);
  }
  const loans = document.getElementById('agent-loans');
  if (loans && !loans.dataset.wired) {
    loans.dataset.wired = '1';
    loans.addEventListener('change', e => { if (e.target.name === 'agent-loan') agentState.loan = e.target.value; });
  }
  const strats = document.getElementById('agent-strats');
  if (strats && !strats.dataset.wired) {
    strats.dataset.wired = '1';
    strats.addEventListener('change', e => {
      if (e.target.name === 'agent-strat') { agentState.strategy = e.target.value; syncAgentInputs(); }
    });
  }
  const run = document.getElementById('agent-run');
  if (run && !run.dataset.wired) {
    run.dataset.wired = '1';
    run.addEventListener('click', agentRunAnalysis);
  }
  const zb = document.getElementById('agent-ziggy');
  if (zb && !zb.dataset.wired) {
    zb.dataset.wired = '1';
    zb.addEventListener('click', () => {
      if (!agentState.url) return;
      const text = 'Pull this listing into DealLens: ' + agentState.url;
      const done = () => {
        const h = document.getElementById('agent-ziggy-hint');
        if (h) h.textContent = "Copied — paste that to Ziggy in chat. He'll reply with a link that opens DealLens fully filled in.";
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      else fallbackCopy(text, done);
    });
  }
}
/* ================= Rehab estimator + new-build comp =================
   Treasure Coast rough $/sqft averages — honest ranges, not quotes.
   Pure math functions are node-testable; the cards render in results. */
const REPAIR_TIERS = [
  { key: 'ready', label: 'Move-in ready', rate: 5 },
  { key: 'light', label: 'Light cosmetic', rate: 18 },
  { key: 'moderate', label: 'Moderate rehab', rate: 42 },
  { key: 'gut', label: 'Full gut', rate: 85 },
];
function repairEstimate(sqft, tierKey) {
  const t = REPAIR_TIERS.find(x => x.key === tierKey) || REPAIR_TIERS[2];
  const s = Math.max(0, +sqft || 0);
  return { key: t.key, label: t.label, rate: t.rate, sqft: s, total: Math.round(s * t.rate) };
}
function newBuildEstimate(sqft, rate) {
  const s = Math.max(0, +sqft || 0), r = Math.max(0, +rate || 0);
  return Math.round(s * r);
}
function dealSqft(deal) {
  const it = deal.intel || {};
  return +(it.sqft) || +((deal.rcData && deal.rcData.sqft) || 0) || 0;
}

function rehabEstimateCardHtml(deal) {
  const sqft = dealSqft(deal);
  const strat = deal.strategy || 'buy';
  const pills = REPAIR_TIERS.map((t, i) =>
    '<label class="radio-pill"><input type="radio" name="rehab-tier" value="' + t.key + '"' +
    (i === 2 ? ' checked' : '') + '> ' + esc(t.label) + ' ($' + t.rate + '/sqft)</label>').join('');
  const body = sqft > 0
    ? '<div id="rehab-est-line" style="margin-top:10px"></div>' +
      (strat === 'flip'
        ? '<p style="margin-top:8px"><button type="button" class="btn secondary" id="rehab-use-btn">Use as rehab budget</button> ' +
          '<span class="tip">fills the flip rehab field and re-runs</span></p>'
        : '')
    : '<p class="tip">Add square footage (property intel) to estimate.</p>';
  return '<div class="card no-print"><h3>Rehab estimate ' +
    '<span class="hint" style="font-weight:400;color:var(--muted-fg)">Treasure Coast averages — rough</span></h3>' +
    '<div class="radio-group" role="radiogroup" aria-label="Condition">' + pills + '</div>' + body + '</div>';
}

function renderRehabLine(deal) {
  const line = document.getElementById('rehab-est-line');
  if (!line) return;
  const sel = document.querySelector('input[name="rehab-tier"]:checked');
  const est = repairEstimate(dealSqft(deal), sel ? sel.value : 'moderate');
  line.innerHTML = '<p style="margin:0"><strong>' + esc(est.label) + '</strong> × ' +
    Math.round(est.sqft).toLocaleString('en-US') + ' sqft @ $' + est.rate + ' = <strong>' +
    fmt$(est.total) + '</strong></p>' +
    '<p class="tip" style="margin:4px 0 0">Rough average — get contractor bids before you offer.</p>';
  line.dataset.estTotal = est.total;
}

function newBuildCompCardHtml(deal) {
  const sqft = dealSqft(deal);
  const strat = deal.strategy || 'buy';
  const refPrice = strat === 'build'
    ? ((deal.metrics && deal.metrics.totalCost) || 0)
    : (deal.price || 0);
  const refLabel = strat === 'build' ? 'total project cost' : 'listing price';
  const body = sqft > 0
    ? '<div class="field" style="max-width:240px"><label for="nb-rate">Build cost ($/sqft) ' +
      '<span class="hint">Treasure Coast new-build avg</span></label>' +
      '<input id="nb-rate" type="number" min="1" value="175"></div>' +
      '<div id="nb-line" style="margin-top:8px"></div>'
    : '<p class="tip">Add square footage (property intel) to compare.</p>';
  return '<div class="card no-print" data-nb-ref="' + Math.round(refPrice) + '" data-nb-reflabel="' + esc(refLabel) + '">' +
    '<h3>New construction check</h3>' + body + '</div>';
}

function renderNbLine(deal) {
  const line = document.getElementById('nb-line');
  const rateEl = document.getElementById('nb-rate');
  if (!line || !rateEl) return;
  const rate = Math.max(1, parseFloat(rateEl.value) || 175);
  const sqft = dealSqft(deal);
  const est = newBuildEstimate(sqft, rate);
  const card = line.closest('[data-nb-ref]');
  const ref = card ? +card.dataset.nbRef : 0;
  const refLabel = card ? card.dataset.nbReflabel : 'listing price';
  let cmp = '';
  if (ref > 0 && est > 0) {
    const diff = ref - est;
    cmp = ' ' + esc(refLabel.charAt(0).toUpperCase() + refLabel.slice(1)) + ' ' + fmt$(ref) +
      ' vs ~' + fmt$(est) + ' to build new — ' +
      (diff === 0 ? 'about even.' : 'the ' + refLabel + ' is ' + fmt$(Math.abs(diff)) + (diff < 0 ? ' under' : ' over') + ' new-build cost.');
  }
  line.innerHTML = '<p style="margin:0">Building ' + Math.round(sqft).toLocaleString('en-US') +
    ' sqft new would cost ~<strong>' + fmt$(est) + '</strong> at $' + Math.round(rate) + '/sqft.' + cmp + '</p>' +
    '<p class="tip" style="margin:4px 0 0">No depreciation math — just both numbers side by side.</p>';
}

/* Wire the estimator cards after results render (per-render elements). */
function wireEstimatorCards(deal) {
  renderRehabLine(deal);
  document.querySelectorAll('input[name="rehab-tier"]').forEach(r =>
    r.addEventListener('change', () => renderRehabLine(deal)));
  const useBtn = document.getElementById('rehab-use-btn');
  if (useBtn) useBtn.addEventListener('click', () => {
    const line = document.getElementById('rehab-est-line');
    const total = line ? +line.dataset.estTotal : 0;
    if (!(total > 0)) return;
    deal.flip = deal.flip || {};
    deal.flip.rehab = total;
    analyzeDeal(deal);
    upsertDeal(deal);
    renderResults(deal.id);
  });
  renderNbLine(deal);
  const nbRate = document.getElementById('nb-rate');
  if (nbRate) nbRate.addEventListener('input', () => renderNbLine(deal));
}

/* Explicit opt-in RentCast pull shared by the intake card and the results view.
   Key gate → cache check → native confirm with cost → lookup → usage counted
   by requests actually fired. Cached hits cost 0 calls and skip the confirm.
   Never fires without a saved key AND an explicit confirm. Returns the lookup
   result, or {ok:false, reason:'no-key'|'cancelled'} with zero calls fired.
   opts.force bypasses the cache (re-pull). */
async function gatedRentcastPull(address, opts) {
  opts = opts || {};
  if (!loadRcKey()) return rcErr('no-key', 'Add your free RentCast key in Setup → Property data first.');
  const ckey = 'pull:' + rcCacheNorm(address);
  if (!opts.force) {
    const hit = rcCacheGet(ckey, RC_PULL_TTL_MS);
    if (hit) return Object.assign({ ok: true, cached: true, attempts: 0 }, hit);
  }
  const u = rcUsage();
  const sayYes = (typeof confirm === 'function')
    ? confirm('Pull full property info via RentCast? This uses ~4 of your 50 free calls this month (' + u.used + ' used so far).')
    : true;
  if (!sayYes) return { ok: false, reason: 'cancelled' };
  const res = await rentcastLookup(address);
  rcUsageAdd(res.attempts || 0);
  refreshRcUsageLabels();
  if (res.ok) {
    const { ok, attempts, partial, ...data } = res; // cache normalized data only
    rcCacheSet(ckey, data);
  }
  return res;
}

/* "Re-pull fresh" link — bypasses the cache, same confirm dialog. */
function appendRcRepull(msgEl, onRepull) {
  if (!msgEl || typeof document === 'undefined' || document.getElementById('rc-repull')) return;
  const a = document.createElement('a');
  a.id = 'rc-repull';
  a.href = '#';
  a.textContent = 'Re-pull fresh (uses ~4 calls)';
  a.style.cssText = 'margin-left:8px;color:var(--accent)';
  a.addEventListener('click', async (e) => {
    e.preventDefault();
    a.remove();
    await onRepull();
  });
  msgEl.appendChild(document.createTextNode(' '));
  msgEl.appendChild(a);
}

/* Results-view enrich flow: factored so the "Re-pull fresh" link can reuse it. */
async function enrichDealFromPull(deal, force) {
  const msg = (typeof document !== 'undefined') && document.getElementById('rc-enrich-msg');
  const res = await gatedRentcastPull(deal.addr, { force: !!force });
  if (!res.ok && (res.reason === 'cancelled' || res.reason === 'no-key')) {
    if (msg) {
      if (res.reason === 'no-key') rcGotoSetup(msg);
      else msg.textContent = 'Re-pull cancelled — no calls used.';
    }
    return;
  }
  if (!res.ok) { if (msg) msg.textContent = res.message + ' You can fill in manually instead.'; return; }
  applyRentcastToDeal(deal, res);
  analyzeDeal(deal);
  upsertDeal(deal);
  renderResults(deal.id);
  const m2 = (typeof document !== 'undefined') && document.getElementById('rc-enrich-msg');
  if (m2) {
    if (res.cached) {
      m2.textContent = 'Loaded from cache · 0 calls used.';
      appendRcRepull(m2, () => enrichDealFromPull(deal, true));
    } else {
      m2.textContent = 'Enriched via RentCast · ' + (res.attempts || 4) + ' calls used.';
    }
  }
}

/* No-key gating notice with a button that navigates to Setup. */
function rcGotoSetup(msgEl) {
  if (msgEl) msgEl.innerHTML = 'Add your free RentCast key in Setup → Property data first. <button type="button" class="btn secondary" id="rc-goto-setup" style="margin-left:8px">Open Setup</button>';
  const b = (typeof document !== 'undefined') && document.getElementById('rc-goto-setup');
  if (b) b.addEventListener('click', () => go('setup'));
}

/* Re-render the usage labels wherever they appear (Setup card, intake
   pull button, results enrich button). No-ops in node (no document). */
function refreshRcUsageLabels() {
  if (typeof document === 'undefined') return;
  const u = rcUsage(), low = u.used >= RC_WARN_AT;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; if (el.classList) el.classList.toggle('rc-low', low); }
  };
  set('rc-usage', u.used + ' of ' + RC_FREE_LIMIT + ' free calls used this month.');
  set('rc-enrich-sub', 'Uses ~4 calls · ' + u.used + ' of ' + RC_FREE_LIMIT + ' free used this month');
  set('fd-sub', '1 call per search · ' + u.used + ' of ' + RC_FREE_LIMIT + ' free used this month');
}

/* ================= Results-view enrichment (Buy & Hold) ================= */
/* "Dig deeper" card — RentCast is the deep-dive on GOOD deals, not the entry
   step. Prominent when the deal scores >= 60; for weaker deals a subtle link
   sits under the intel card instead. Reuses the existing gated pull flow
   (key gate → cache → confirm → usage counter) via wireRcEnrich. */
function digDeeperCardHtml(deal) {
  const u = rcUsage();
  return `<div class="card no-print"><h3>Dig deeper with RentCast</h3>
    <p>This one scores <strong>${deal.score}</strong> — pull tax history, AVM, photos and DOM?</p>
    <p><button type="button" class="btn" id="rc-enrich-btn">Pull full info via RentCast</button>
    <span class="tip${u.used >= RC_WARN_AT ? ' rc-low' : ''}" id="rc-enrich-sub">Uses ~4 calls · ${u.used} of ${RC_FREE_LIMIT} free used this month</span></p>
    <p class="tip" id="rc-enrich-msg" role="status"></p></div>`;
}

/* Fill the dig-deeper slot: full card for score >= 60 (or forced), else empty.
   The subtle link under the intel card calls this with force=true. */
function renderDigDeeper(deal, force) {
  const slot = document.getElementById('dig-deeper-slot');
  if (!slot) return;
  if (force || (deal.score || 0) >= 60) {
    slot.innerHTML = digDeeperCardHtml(deal);
    wireRcEnrich(deal);
  } else {
    slot.innerHTML = '';
  }
}

/* Pure: apply normalized RentCast data to a deal object in place. */
function applyRentcastToDeal(deal, res) {
  const fills = rentcastFills(res);
  if (fills.price != null) deal.price = fills.price;
  if (fills.rent != null) deal.rent = fills.rent;
  if (fills.beds != null) deal.beds = fills.beds;
  deal.intel = deal.intel || {};
  if (fills.sqft != null) deal.intel.sqft = fills.sqft;
  if (fills.yearBuilt != null) deal.intel.yearBuilt = fills.yearBuilt;
  if (fills.lastSaleDate) deal.intel.lastSaleDate = fills.lastSaleDate;
  if (fills.lastSalePrice != null) deal.intel.lastSalePrice = fills.lastSalePrice;
  if (fills.dom != null) deal.intel.dom = fills.dom;
  deal.photos = deal.photos || [];
  (fills.photos || []).forEach(u => {
    if (deal.photos.length < 6) deal.photos.push({ src: u, name: 'via RentCast' });
  });
  deal.rcData = res;
  const stats = intelStats(deal.price, deal.intel.lastSalePrice, deal.intel.lastSaleDate);
  deal.intel.yearsSinceSale = stats.yearsSinceSale;
  deal.intel.priceChangePct = stats.priceChangePct;
}

function wireRcEnrich(deal) {
  const btn = document.getElementById('rc-enrich-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const msg = document.getElementById('rc-enrich-msg');
    const addr = (deal.addr || '').trim();
    if (!addr) { if (msg) msg.textContent = 'No address on this deal — add one on the analysis form first.'; return; }
    if (!loadRcKey()) { rcGotoSetup(msg); return; }
    btn.disabled = true;
    if (msg) msg.textContent = 'Pulling listing data via RentCast…';
    await enrichDealFromPull(deal, false);
    const b2 = document.getElementById('rc-enrich-btn');
    if (b2) b2.disabled = false;
  });
}

/* ================= Find deals near me (RentCast listings search) ==========
   Location search over /v1/listings/sale. Each search costs 1 call against
   the same monthly counter; results are cached 24h by query key. No confirm
   modal — the cost is shown on the button. Max price is filtered client-side
   (RentCast's documented sale-listing filters don't include a reliable
   priceMax), noted in the UI copy. */
let fdGeo = null; // {latitude, longitude} from the "Use my location" button
let lastFdListings = [];

function parseLocationInput(s) {
  s = String(s || '').trim();
  if (/^\d{5}$/.test(s)) return { zipCode: s };
  const m = s.match(/^(.+?),\s*([A-Za-z]{2})$/);
  if (m && m[1].trim()) return { city: m[1].trim(), state: m[2].toUpperCase() };
  return null;
}

function normalizeSearchResults(data) {
  const arr = Array.isArray(data) ? data : [];
  return arr.slice(0, 20).map(l => {
    const line1 = rcPick(l, ['addressLine1', 'address']) || '';
    const city = rcPick(l, ['city']) || '', state = rcPick(l, ['state']) || '', zip = rcPick(l, ['zipCode', 'zip']) || '';
    const addr = (line1 + ', ' + city + ', ' + state + ' ' + zip).replace(/^[,\s]+|[,\s]+$/g, '').replace(/,\s*,/g, ',').trim();
    const photosRaw = rcPick(l, ['photos', 'images', 'photoUrls']) || [];
    const photos = (Array.isArray(photosRaw) ? photosRaw : [])
      .map(x => (typeof x === 'string' ? x : (x && (x.url || x.src))) || null).filter(Boolean);
    return {
      address: addr || 'Address not listed',
      price: rcNum(rcPick(l, ['price', 'listPrice'])),
      beds: rcNum(rcPick(l, ['bedrooms', 'beds'])),
      baths: rcNum(rcPick(l, ['bathrooms', 'baths'])),
      sqft: rcNum(rcPick(l, ['squareFootage', 'sqft', 'livingArea'])),
      dom: rcNum(rcPick(l, ['daysOnMarket', 'days_on_market'])),
      photo: photos[0] || null,
    };
  });
}

async function rentcastSearch(p) {
  // p: {zipCode}|{city,state}|{latitude,longitude,radius}, plus propertyType
  const key = loadRcKey();
  if (!key) return rcErr('no-key', 'Add your free RentCast key in Setup → Property data first.');
  const q = {};
  if (p.zipCode) q.zipCode = p.zipCode;
  if (p.city) { q.city = p.city; q.state = p.state; }
  if (p.latitude != null) { q.latitude = String(p.latitude); q.longitude = String(p.longitude); q.radius = String(p.radius || '10'); }
  q.propertyType = p.propertyType || 'Multi-Family';
  q.limit = '20';
  const canon = {};
  Object.keys(q).sort().forEach(k => { canon[k] = q[k]; });
  const ckey = 'search:' + JSON.stringify(canon);
  const hit = rcCacheGet(ckey, RC_SEARCH_TTL_MS);
  if (hit) return { ok: true, cached: true, attempts: 0, listings: hit };
  const res = await rentcastFetch('/listings/sale?' + new URLSearchParams(q).toString(), key);
  if (!res.ok) return res;
  const listings = normalizeSearchResults(res.data);
  rcUsageAdd(1);
  refreshRcUsageLabels();
  rcCacheSet(ckey, listings);
  return { ok: true, listings, attempts: 1 };
}

/* Fill the link-intake from a search result and take the user there. */
function fillIntakeAddress(addr) {
  if (typeof document !== 'undefined') intakeFromAddress(addr);
  if (typeof location !== 'undefined') go('new');
  const card = (typeof document !== 'undefined') && document.getElementById('link-intake-card');
  if (card && card.scrollIntoView) { try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {} }
}

function renderFdResults(listings, note) {
  const box = document.getElementById('fd-results');
  if (!box) return;
  lastFdListings = listings;
  if (!listings.length) {
    box.innerHTML = '<p class="tip">No listings found for that search.' + (note ? ' ' + esc(note) : '') + '</p>';
    return;
  }
  box.innerHTML = (note ? '<p class="tip">' + esc(note) + '</p>' : '') +
    '<div class="match-grid">' + listings.map((l, i) =>
      '<div class="match-card">' +
      (l.photo ? '<img src="' + esc(l.photo) + '" alt="Listing photo" loading="lazy" style="width:100%;border-radius:8px;margin-bottom:8px">' : '') +
      '<div class="match-head"><strong>' + esc(l.address) + '</strong>' +
      (l.price != null ? '<span class="match-price">' + fmtMoney(l.price) + '</span>' : '') + '</div>' +
      '<p class="tip">' + [l.beds != null ? l.beds + ' bd' : null, l.baths != null ? l.baths + ' ba' : null,
        l.sqft != null ? Math.round(l.sqft).toLocaleString('en-US') + ' sqft' : null,
        l.dom != null ? Math.round(l.dom) + ' DOM' : null].filter(Boolean).join(' · ') + '</p>' +
      '<p><button type="button" class="btn secondary" data-fd-analyze="' + i + '">Analyze</button></p>' +
      '</div>').join('') + '</div>';
}

function fdAppendSetupNudge() {
  const errEl = document.getElementById('fd-error');
  if (!errEl || document.getElementById('fd-setup-nudge')) return;
  const a = document.createElement('a');
  a.id = 'fd-setup-nudge';
  a.href = '#/setup';
  a.textContent = 'Add a RentCast key in Setup';
  a.style.cssText = 'margin-left:8px;color:var(--accent)';
  errEl.appendChild(document.createTextNode(' '));
  errEl.appendChild(a);
}

function fdSyncNoKey() {
  const n = document.getElementById('fd-nokey');
  if (n) n.hidden = !!loadRcKey();
}

async function runFindDealsSearch() {
  const errEl = document.getElementById('fd-error');
  const box = document.getElementById('fd-results');
  const setErr = t => { if (errEl) errEl.textContent = t || ''; };
  setErr('');
  if (!loadRcKey()) {
    setErr('Add your free RentCast key in Setup → Property data first.');
    fdAppendSetupNudge();
    return;
  }
  const locRaw = ((document.getElementById('fd-loc') || {}).value || '');
  let loc = parseLocationInput(locRaw);
  if (!loc && fdGeo) {
    loc = { latitude: fdGeo.latitude, longitude: fdGeo.longitude, radius: ((document.getElementById('fd-radius') || {}).value || '10') };
  }
  if (!loc) { setErr('Enter a City, ST (e.g. Fort Pierce, FL) or a 5-digit ZIP — or tap "Use my location".'); return; }
  const maxPrice = Math.round(parseFloat(((document.getElementById('fd-maxprice') || {}).value || '')) || 0);
  const propertyType = ((document.getElementById('fd-proptype') || {}).value || 'Multi-Family');
  if (box) box.innerHTML = '<p class="tip">Searching…</p>';
  const res = await rentcastSearch(Object.assign({}, loc, { propertyType }));
  if (!res.ok) {
    setErr(res.message);
    if (res.reason === 'bad-key') fdAppendSetupNudge();
    if (box) box.innerHTML = '';
    return;
  }
  let listings = res.listings || [];
  const before = listings.length;
  if (maxPrice > 0) listings = listings.filter(l => l.price == null || l.price <= maxPrice);
  renderFdResults(listings, (res.cached ? 'Loaded from cache · 0 calls used.' : '1 call used.') +
    (before !== listings.length ? ' ' + listings.length + ' of ' + before + ' under ' + fmtMoney(maxPrice) + ' (price filtered in-app).' : ''));
}

function wireFindDeals() {
  const sbtn = document.getElementById('fd-search');
  if (sbtn) sbtn.addEventListener('click', runFindDealsSearch);
  const gbtn = document.getElementById('fd-geo');
  if (gbtn) gbtn.addEventListener('click', () => {
    const m = document.getElementById('fd-loc-msg');
    if (!navigator.geolocation) { if (m) m.textContent = 'Location unavailable — type a City, ST or ZIP.'; return; }
    if (m) m.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      pos => {
        fdGeo = { latitude: +pos.coords.latitude.toFixed(4), longitude: +pos.coords.longitude.toFixed(4) };
        if (m) m.textContent = 'Using your location ✓ (' + fdGeo.latitude + ', ' + fdGeo.longitude + ')';
      },
      () => { if (m) m.textContent = 'Location unavailable — type a City, ST or ZIP.'; },
      { timeout: 10000 });
  });
  const mp = document.getElementById('fd-maxprice');
  if (mp) mp.addEventListener('input', () => { mp.dataset.touched = '1'; });
  const box = document.getElementById('fd-results');
  if (box) box.addEventListener('click', e => {
    const t = e.target && e.target.closest ? e.target.closest('[data-fd-analyze]') : null;
    if (!t) return;
    const l = lastFdListings[+t.dataset.fdAnalyze];
    if (l) fillIntakeAddress(l.address);
  });
}

/* ================= Deal Watch =================
   The hunt itself runs via the assistant's cron — this tab is where the user
   sets criteria + interval, then sends the copied settings to Ziggy in chat. */
const LS_WATCH = 'deallens_watch';
const WATCH_RESULTS_URL = './deal-watch-results.json';
const WATCH_INTERVALS = { daily: 'Daily', every3: 'Every 3 days', weekly: 'Weekly' };
const WATCH_PROPTYPES = { multifamily: '2–4 unit multifamily', duplex: 'Duplex', triplex: 'Triplex', fourplex: 'Fourplex' };
const WATCH_STRATS = { buy: 'Buy & Hold', flip: 'Rehab Flip', build: 'New Build' };

function loadWatch() {
  try { return JSON.parse(localStorage.getItem(LS_WATCH) || 'null'); } catch { return null; }
}
function saveWatch(w) { localStorage.setItem(LS_WATCH, JSON.stringify(w)); }
function clearWatch() { localStorage.removeItem(LS_WATCH); }

function fmtMoney(v) { return '$' + Math.round(+v || 0).toLocaleString('en-US'); }

/* Exact copy the user sends to Ziggy in chat to start the cron hunt. */
function watchCopyText(w) {
  return 'Deal Watch settings — ZIPs: ' + w.zips +
    '; Type: ' + (WATCH_PROPTYPES[w.propType] || w.propType) +
    '; Max price: ' + fmtMoney(w.maxPrice) +
    '; Strategy: ' + (WATCH_STRATS[w.strategy] || w.strategy) +
    '; Loan: ' + (LOAN_TYPES[w.loanType] ? LOAN_TYPES[w.loanType].label : w.loanType) +
    '; Min cash flow: ' + fmtMoney(w.minCashFlow) + '/mo' +
    '; Interval: ' + (WATCH_INTERVALS[w.interval] || w.interval) +
    ' — please start the hunt.';
}

function watchSummaryHTML(w) {
  const rows = [
    ['ZIP codes', w.zips],
    ['Property type', WATCH_PROPTYPES[w.propType] || w.propType],
    ['Max price', fmtMoney(w.maxPrice)],
    ['Strategy', WATCH_STRATS[w.strategy] || w.strategy],
    ['Loan type', LOAN_TYPES[w.loanType] ? LOAN_TYPES[w.loanType].label : w.loanType],
    ['Minimum cash flow', fmtMoney(w.minCashFlow) + '/mo'],
    ['Hunt interval', WATCH_INTERVALS[w.interval] || w.interval],
    ['Activated', w.activatedAt ? new Date(w.activatedAt).toLocaleString() : '—'],
  ];
  return '<dl class="watch-summary">' + rows.map(r =>
    '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>').join('') + '</dl>';
}

function readWatchForm() {
  const zips = document.getElementById('w-zips').value.trim();
  const propType = document.getElementById('w-proptype').value;
  const maxPrice = +document.getElementById('w-maxprice').value;
  const strategy = document.getElementById('w-strategy').value;
  const loanType = document.getElementById('w-loantype').value;
  const minCashFlow = +document.getElementById('w-mincf').value;
  const iv = document.querySelector('input[name="w-interval"]:checked');
  return { zips, propType, maxPrice, strategy, loanType, minCashFlow, interval: iv ? iv.value : 'every3' };
}

function fillWatchForm(w) {
  document.getElementById('w-zips').value = w.zips || '';
  document.getElementById('w-proptype').value = w.propType || 'multifamily';
  document.getElementById('w-maxprice').value = w.maxPrice != null ? w.maxPrice : 400000;
  document.getElementById('w-strategy').value = w.strategy || 'buy';
  document.getElementById('w-loantype').value = w.loanType || 'conventional';
  document.getElementById('w-mincf').value = w.minCashFlow != null ? w.minCashFlow : 200;
  const iv = document.querySelector('input[name="w-interval"][value="' + (w.interval || 'every3') + '"]');
  if (iv) iv.checked = true;
}

function renderWatchStatus() {
  const w = loadWatch();
  const formCard = document.getElementById('watch-form-card');
  const activeCard = document.getElementById('watch-active-card');
  if (w) {
    formCard.hidden = true;
    activeCard.hidden = false;
    document.getElementById('watch-summary').innerHTML = watchSummaryHTML(w);
    document.getElementById('watch-copied').textContent = '';
  } else {
    formCard.hidden = false;
    activeCard.hidden = true;
  }
}

function matchCardHTML(m, isNew) {
  const bits = [];
  bits.push('<div class="match-card">');
  bits.push('<div class="match-head"><strong>' + esc(m.address || 'Address not listed') + '</strong>' +
    (isNew ? ' <span class="new-badge">NEW</span>' : '') +
    (m.price != null ? '<span class="match-price">' + fmtMoney(m.price) + '</span>' : '') + '</div>');
  const meta = [];
  if (m.type || m.units) meta.push(esc([m.type, m.units].filter(Boolean).join(' · ')));
  if (m.found) meta.push('found ' + esc(m.found));
  if (meta.length) bits.push('<p class="tip">' + meta.join(' &nbsp;·&nbsp; ') + '</p>');
  const stats = [];
  if (m.score != null) stats.push('<div class="v">' + esc(m.score) + '</div><div class="l">deal score</div>');
  if (m.cashFlow != null) stats.push('<div class="v">' + fmtMoney(m.cashFlow) + '/mo</div><div class="l">cash flow</div>');
  if (m.capRate != null) stats.push('<div class="v">' + esc(m.capRate) + '%</div><div class="l">cap rate</div>');
  if (stats.length) bits.push('<div class="match-stats">' + stats.map(s => '<div class="stat">' + s + '</div>').join('') + '</div>');
  if (m.url) bits.push('<p><a href="' + esc(m.url) + '" target="_blank" rel="noopener" style="color:var(--accent)">View listing</a></p>');
  bits.push('</div>');
  return bits.join('');
}

const WATCH_SEEN_KEY = 'deallens_watch_seen';
function getWatchSeen() {
  const v = parseInt(localStorage.getItem(WATCH_SEEN_KEY) || '0', 10);
  return isFinite(v) ? v : 0;
}
function setWatchSeen(ts) {
  try { localStorage.setItem(WATCH_SEEN_KEY, String(ts)); } catch (err) { /* storage unavailable */ }
}
function matchIsNew(m, seen) {
  if (!m || !m.found) return false;
  const t = Date.parse(m.found);
  return isFinite(t) && t > seen;
}
async function fetchWatchResults() {
  const res = await fetch(WATCH_RESULTS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return data;
}
function setWatchNavPill(count) {
  const btn = document.querySelector('[data-nav="watch"]');
  if (!btn) return;
  let pill = btn.querySelector('.new-pill');
  if (count > 0) {
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'new-pill';
      btn.appendChild(pill);
    }
    pill.textContent = count;
    pill.hidden = false;
  } else if (pill) {
    pill.hidden = true;
  }
}
// Called on app start: flags unseen matches on the Deal Watch nav button.
async function updateWatchBadge() {
  try {
    const data = await fetchWatchResults();
    const matches = Array.isArray(data.matches) ? data.matches : [];
    const seen = getWatchSeen();
    setWatchNavPill(matches.filter(m => matchIsNew(m, seen)).length);
  } catch (err) { /* no results yet — leave nav clean */ }
}

async function renderWatchMatches() {
  const box = document.getElementById('watch-matches');
  try {
    const data = await fetchWatchResults();
    const matches = Array.isArray(data.matches) ? data.matches : [];
    const seen = getWatchSeen();
    if (!matches.length) {
      box.innerHTML = '<p class="tip">No matches yet — set your criteria above, activate, and send the settings to Ziggy.</p>' +
        (data.updated ? '<p class="tip">Last hunt: ' + esc(data.updated) + '</p>' : '');
      setWatchNavPill(0);
      return;
    }
    const newCount = matches.filter(m => matchIsNew(m, seen)).length;
    box.innerHTML = (data.updated ? '<p class="tip">Last hunt: ' + esc(data.updated) +
        (newCount ? ' · <strong>' + newCount + ' new since your last visit</strong>' : '') + '</p>' : '') +
      '<div class="match-grid">' + matches.map(m => matchCardHTML(m, matchIsNew(m, seen))).join('') + '</div>';
    // User has now seen them: mark all as seen and clear the nav pill.
    setWatchSeen(Date.now());
    setWatchNavPill(0);
  } catch (err) {
    box.innerHTML = '<p class="tip">No matches yet — set your criteria above, activate, and send the settings to Ziggy.</p>';
  }
}

function renderWatch() {
  renderWatchStatus();
  renderWatchMatches();
  // Find-deals: prefill max price from watch criteria (until the user edits it)
  const mp = document.getElementById('fd-maxprice');
  const w = loadWatch();
  if (mp && w && w.maxPrice && !mp.dataset.touched) mp.value = w.maxPrice;
  fdSyncNoKey();
  refreshRcUsageLabels();
}

function copyWatchSettings() {
  const w = loadWatch();
  if (!w) return;
  const text = watchCopyText(w);
  const done = () => { document.getElementById('watch-copied').textContent = 'Copied — paste it to Ziggy in chat.'; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (err) { /* clipboard unavailable */ }
  document.body.removeChild(ta);
}

function wireWatch() {
  const form = document.getElementById('watch-form');
  if (!form) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const errEl = document.getElementById('watch-error');
    errEl.textContent = '';
    const w = readWatchForm();
    if (!w.zips) { errEl.textContent = 'Enter at least one ZIP code.'; return; }
    if (!(w.maxPrice > 0)) { errEl.textContent = 'Max price must be greater than 0.'; return; }
    if (!(w.minCashFlow >= 0)) { errEl.textContent = 'Minimum cash flow can\'t be negative.'; return; }
    w.activatedAt = new Date().toISOString();
    saveWatch(w);
    renderWatchStatus();
  });
  document.getElementById('watch-copy-btn').addEventListener('click', copyWatchSettings);
  document.getElementById('watch-change-btn').addEventListener('click', () => {
    const w = loadWatch();
    if (w) fillWatchForm(w);
    document.getElementById('watch-form-card').hidden = false;
    document.getElementById('watch-active-card').hidden = true;
  });
  document.getElementById('watch-deactivate-btn').addEventListener('click', () => {
    if (confirm('Deactivate Deal Watch? Your saved criteria will be cleared.')) {
      clearWatch();
      fillWatchForm({ zips: '34950, 34982, 34947', propType: 'multifamily', maxPrice: 400000, strategy: 'buy', loanType: 'conventional', minCashFlow: 200, interval: 'every3' });
      renderWatchStatus();
    }
  });
}

/* Node-testable exports for the watch helpers (browser bundle unaffected). */
if (typeof module !== 'undefined' && module.exports) {
  Object.assign(module.exports, { watchCopyText, fmtMoney, WATCH_INTERVALS, WATCH_PROPTYPES, WATCH_STRATS, LS_WATCH, WATCH_RESULTS_URL, parseListingUrl, suggestOffer, titleCase,
    rentcastLookup, rentcastFetch, normalizeRentcast, rentcastFills, applyRentcastFills, loadRcKey, saveRcKey, clearRcKey, RC_BASE, LS_RC,
    gatedRentcastPull, applyRentcastToDeal, rcUsage, rcUsageAdd, rcMonthStr, LS_RC_USAGE, RC_FREE_LIMIT, RC_WARN_AT, refreshRcUsageLabels,
    rcCacheNorm, rcCacheRead, rcCacheGet, rcCacheSet, LS_RC_CACHE, RC_PULL_TTL_MS, RC_SEARCH_TTL_MS, RC_CACHE_MAX,
    rentcastSearch, normalizeSearchResults, parseLocationInput, fillIntakeAddress, intakeFromAddress,
    geocodeAddress, repairEstimate, newBuildEstimate, permitLinksHtml, dealSqft, agentPatch, REPAIR_TIERS, renderDigDeeper, digDeeperCardHtml });
}

function init() {
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); go(el.dataset.nav); });
  });
  updateWatchBadge();
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
  });
  document.getElementById('rc-save-btn').addEventListener('click', () => {
    const errEl = document.getElementById('rc-error'), okEl = document.getElementById('rc-success');
    errEl.textContent = ''; okEl.textContent = '';
    const key = document.getElementById('rc-key').value.trim();
    if (!key) { errEl.textContent = 'Paste a key first.'; return; }
    saveRcKey(key);
    okEl.textContent = 'RentCast key saved in this browser only.';
  });
  document.getElementById('rc-clear-btn').addEventListener('click', () => {
    clearRcKey();
    document.getElementById('rc-key').value = '';
    document.getElementById('rc-error').textContent = '';
    document.getElementById('rc-success').textContent = 'RentCast key removed.';
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
  wireWatch();
  wireListingIntake();
  wireFindDeals();
  route();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
