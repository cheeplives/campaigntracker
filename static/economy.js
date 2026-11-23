/* economy.js — the Economy tab's sums, with no page in them: reading and writing coin amounts in a campaign's own
 * coins ("1 sm 5 bits"), what a price is in a region once its shifts apply, what the party's funds and trade goods
 * come to, and reading a price book from a CSV file. static/economy-tab.js draws the tab with these, and
 * tests/browser/economy-logic.spec.js holds them to their word. Plain script, no build step. */
(function (root) {
  'use strict';

  const AVAIL = [['common', 'Common'], ['scarce', 'Scarce'], ['rare', 'Rare'], ['none', 'None here']];
  const SIZES = [[1, 'Small'], [2, 'Significant'], [3, 'Major']];
  const availLabel = a => (AVAIL.find(([k]) => k === a) || AVAIL[0])[1];
  const sizeLabel = n => (SIZES.find(([k]) => k === Number(n)) || ['', ''])[1];
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  /** A name with its plural s taken off, so "Gold crowns" on a funds line is the coin "Gold crown". */
  const stem = s => norm(s).replace(/s$/, '');
  const EPS = 1e-6;

  /** A number as it is shown: whole when it is, a plain fraction under one (1/2, 1/3, 2/3, 1/4, 3/4), else two places. */
  function fmtNum(n) {
    n = Number(n) || 0;
    const neg = n < 0 ? '−' : '';
    const a = Math.abs(n);
    if (Math.abs(a - Math.round(a)) < EPS) return neg + Math.round(a).toLocaleString('en-US');
    if (a < 1) for (const [p, q] of [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4]]) if (Math.abs(a - p / q) < 0.004) return `${neg}${p}/${q}`;
    return neg + (Math.round(a * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  /** A number typed into a box: "3", "2.5", "1/2", "1,200". null when empty, NaN when it isn't one. */
  function parseNum(text) {
    const t = String(text ?? '').trim().replace(/−/g, '-').replace(/,(?=\d{3}\b)/g, '');
    if (t === '') return null;
    const m = /^(-?\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/.exec(t);
    if (!m) return NaN;
    const n = Number(m[1]) / (m[2] !== undefined ? Number(m[2]) : 1);
    return Number.isFinite(n) ? n : NaN;
  }

  // ---------- coins ----------
  /** The campaign's coins, the most valuable first: { name, abbr, worth }, the main coin worth 1. */
  function coinUnits(config) {
    const c = config?.coins || {};
    const all = [{ name: c.base?.name || '', abbr: c.base?.abbr || '', worth: 1 }, ...(c.units || []).map(u => ({ name: u.name, abbr: u.abbr || '', worth: Number(u.worth) || 0 }))];
    return all.filter(u => u.name && u.worth > 0).sort((a, b) => b.worth - a.worth);
  }
  /** How a coin is written after a number: its short name as typed, or its name, with an s for more than one. */
  const coinWord = (u, n) => u.abbr || (Math.abs(n - 1) < EPS || /s$/i.test(u.name) ? u.name : `${u.name}s`);
  /** An amount of the main coin in the campaign's coins, biggest first: 1.5 → "1 sm 5 bits". The smallest coin takes
   * what is left over, to two places. */
  function fmtCoins(config, amount) {
    const units = coinUnits(config);
    if (amount === null || amount === undefined || amount === '') return '';
    if (!units.length) return fmtNum(amount);
    let left = Math.abs(Number(amount) || 0);
    const parts = [];
    units.forEach((u, i) => {
      const last = i === units.length - 1;
      let n = last ? Math.round((left / u.worth) * 100) / 100 : Math.floor(left / u.worth + EPS);
      if (n <= 0) return;
      left = Math.max(0, left - n * u.worth);
      parts.push(`${fmtNum(n)} ${coinWord(u, n)}`);
    });
    if (!parts.length) { const b = units.find(u => u.worth === 1) || units[units.length - 1]; return `0 ${coinWord(b, 0)}`; }
    return (Number(amount) < 0 ? '−' : '') + parts.join(' ');
  }
  /** The coin a word names: its short name, its name, or one word of its name that no other coin has, whatever the
   * capitals, with or without a plural s. */
  function coinNamed(config, word) {
    const w = stem(word);
    if (!w) return null;
    const units = coinUnits(config);
    const exact = units.find(u => stem(u.abbr) === w || stem(u.name) === w);
    if (exact) return exact;
    // "crowns" for "Gold crown": one word of a coin's name, when only one coin has it
    const loose = units.filter(u => norm(u.name).split(' ').some(part => stem(part) === w));
    return loose.length === 1 ? loose[0] : null;
  }
  /** A price typed in the campaign's coins, as a number of the main coin: "2 sm", "12 crowns", "1 sm 5 bits", or a
   * bare number (the main coin). null when empty, NaN when it can't be read. */
  function parseCoins(config, text) {
    const t = String(text ?? '').trim();
    if (t === '') return null;
    const bare = parseNum(t);
    if (bare !== null && !Number.isNaN(bare)) return bare;
    let total = 0, rest = t.replace(/−/g, '-'), any = false;
    const sign = /^-/.test(rest) ? -1 : 1;
    rest = rest.replace(/^-\s*/, '');
    while (rest.trim() !== '') {
      const m = /^[\s,]*(\d[\d,]*(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*([^\d,]+?)\s*(?=[\d]|,|$)/.exec(rest);
      if (!m) return NaN;
      const n = parseNum(m[1]), u = coinNamed(config, m[2]);
      if (n === null || Number.isNaN(n) || !u) return NaN;
      total += n * u.worth;
      any = true;
      rest = rest.slice(m[0].length);
    }
    return any ? sign * total : NaN;
  }
  /** What the party's funds lines come to in the main coin (the lines whose currency is one of the campaign's coins),
   * and the lines that aren't. */
  function partyCoins(config, funds) {
    let total = 0;
    const other = [];
    for (const f of funds || []) {
      const u = coinNamed(config, f.currency);
      if (u) total += (Number(f.amount) || 0) * u.worth; else other.push(f);
    }
    return { total, other };
  }

  // ---------- barter ----------
  /** The campaign's trade goods: the one barter is measured in (worth 1) and the rest. */
  function tradeGoods(config) {
    const b = config?.barter || {};
    return [{ name: b.unit || '', worth: 1 }, ...(b.goods || []).map(g => ({ name: g.name, worth: Number(g.worth) || 0 }))].filter(g => g.name && g.worth > 0);
  }
  /** How many of each trade good the party has in Gear and Loot, and what it all comes to in the barter unit. */
  function partyGoods(config, gear) {
    const stock = [];
    let total = 0;
    for (const g of tradeGoods(config)) {
      const n = (gear || []).filter(r => norm(r.item) === norm(g.name)).reduce((s, r) => s + (Number(r.amount) || 0), 0);
      stock.push({ name: g.name, worth: g.worth, amount: n });
      total += n * g.worth;
    }
    return { stock, total };
  }
  /** A barter price in words: "3 day's food" is written "3 × Day's food" so a long name still reads. */
  const fmtBarter = (config, n) => (n === null || n === undefined ? '' : `${fmtNum(n)} ${config?.barter?.unit || ''}`.trim());

  // ---------- shifts ----------
  /** Whether shift s applies to item on day `today` in region `regionId` (null: no region picked, so only the
   * everywhere shifts apply). */
  function shiftApplies(s, item, regionId, today) {
    if (s.region_id !== null && s.region_id !== undefined && Number(s.region_id) !== Number(regionId)) return false;
    if (s.until_day !== null && s.until_day !== undefined && today !== null && today !== undefined && Number(s.until_day) < Number(today)) return false;
    if (s.item_id) return Number(s.item_id) === Number(item.id);
    return !s.category || norm(s.category) === norm(item.category);
  }
  /** An item's price in a region today: its costs times every shift that applies, and the availability of the most
   * exact one that sets it (one item over a category over everything; the newest of equals).
   * → { coin, barter, availability, shifted, reasons } */
  function priceIn(item, shifts, regionId, today) {
    let mult = 1, avail = item.availability || 'common', rank = -1;
    const reasons = [];
    for (const s of shifts || []) {
      if (!shiftApplies(s, item, regionId, today)) continue;
      mult *= Number(s.multiplier) || 0;
      const r = s.item_id ? 2 : s.category ? 1 : 0;
      if (s.availability && r >= rank) { avail = s.availability; rank = r; }
      if (s.reason) reasons.push(s.reason);
    }
    const times = v => (v === null || v === undefined ? null : Math.round(v * mult * 10000) / 10000);
    return { coin: times(item.coin_cost), barter: times(item.barter_cost), availability: avail,
      shifted: Math.abs(mult - 1) > EPS || avail !== (item.availability || 'common'), priceShifted: Math.abs(mult - 1) > EPS, reasons };
  }
  /** A shift in words: "Food and drink × 1.5, and Scarce". */
  function shiftWords(s, items) {
    const what = s.item_id ? ((items || []).find(i => i.id === s.item_id)?.name || 'One item') : s.category || 'Everything';
    const m = Number(s.multiplier);
    const parts = [];
    if (Math.abs(m - 1) > EPS) parts.push(`× ${fmtNum(m)}`);
    if (s.availability) parts.push(s.availability === 'none' ? 'none to be had' : availLabel(s.availability));
    return `${what} ${parts.join(', and ')}`.trim();
  }

  // ---------- a price book from a file ----------
  /** The rows of a CSV file as arrays of text. Commas, semicolons or tabs (whichever the first line has most of);
   * quotes around a value hold commas and line breaks, and "" inside them is one quote. */
  function parseCSV(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const first = src.split(/\r?\n/, 1)[0] || '';
    const count = ch => first.split(ch).length - 1;
    const sep = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(c => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows.map(r => r.map(c => c.trim()));
  }
  const HEADS = {
    name: ['name', 'item', 'good', 'goods', 'service', 'thing'],
    category: ['category', 'type', 'kind', 'group'],
    coin_cost: ['coins', 'coin', 'cost', 'price', 'money'],
    barter_cost: ['barter', 'trade', 'trade value', 'barter value'],
    wealth_level: ['wealth', 'wealth level', 'level', 'resources'],
    favour_size: ['favour', 'favor', 'favours', 'favors'],
    availability: ['availability', 'available', 'rarity', 'supply'],
    notes: ['notes', 'note', 'description', 'details'],
    is_secret: ['secret', 'gm only', 'gm-only', 'hidden'],
  };
  /** The price book in a CSV's rows (parseCSV): the first row names the columns, in any order. A column called after
   * the campaign's main coin or barter unit is read as that price. → { items, skipped: [{ line, why }], columns } */
  function itemsFromRows(config, rows) {
    if (!rows.length) return { items: [], skipped: [], columns: [] };
    const base = norm(config?.coins?.base?.name), unit = norm(config?.barter?.unit);
    const cols = rows[0].map(h => {
      const k = norm(h);
      if (k && k === base) return 'coin_cost';
      if (k && k === unit) return 'barter_cost';
      return Object.keys(HEADS).find(f => HEADS[f].includes(k)) || null;
    });
    if (!cols.includes('name')) return { items: [], skipped: [{ line: 1, why: 'The first row needs a column called Name or Item' }], columns: [] };
    const levels = (config?.wealth?.levels || []).map(norm);
    const items = [], skipped = [];
    rows.slice(1).forEach((r, i) => {
      const line = i + 2, it = { availability: 'common' };
      let why = '';
      cols.forEach((f, c) => {
        const v = (r[c] || '').trim();
        if (!f || v === '') return;
        if (f === 'name' || f === 'category' || f === 'notes') it[f] = v;
        else if (f === 'coin_cost') { const n = parseCoins(config, v); if (Number.isNaN(n) || n < 0) why = `"${v}" isn't a price in coins`; else it.coin_cost = n; }
        else if (f === 'barter_cost') { const n = parseNum(v.replace(new RegExp(`\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '')); if (n === null || Number.isNaN(n) || n < 0) why = `"${v}" isn't a barter price`; else it.barter_cost = n; }
        else if (f === 'wealth_level') { const at = levels.indexOf(norm(v)); const n = at >= 0 ? at : parseNum(v); if (n === null || Number.isNaN(n) || !Number.isInteger(n) || n < 0 || n > 11) why = `"${v}" isn't a wealth level`; else it.wealth_level = n; }
        else if (f === 'favour_size') { const at = SIZES.find(([k, l]) => norm(l) === norm(v) || String(k) === v); if (!at) why = `"${v}" isn't Small, Significant or Major`; else it.favour_size = at[0]; }
        else if (f === 'availability') { const at = AVAIL.find(([k, l]) => k === norm(v) || norm(l) === norm(v)); if (!at) why = `"${v}" isn't Common, Scarce, Rare or None`; else it.availability = at[0]; }
        else if (f === 'is_secret') it.is_secret = /^(y|yes|true|1|x|gm)$/i.test(v);
      });
      if (!it.name) why = why || 'No name';
      if (why) skipped.push({ line, why }); else items.push(it);
    });
    return { items, skipped, columns: [...new Set(cols.filter(Boolean))] };
  }
  /** The price book as a CSV file, in the columns itemsFromRows reads back. */
  function itemsToCSV(config, items) {
    const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const levels = config?.wealth?.levels || [];
    const head = ['Name', 'Category', 'Coins', 'Barter', 'Wealth', 'Favour', 'Availability', 'Notes', 'Secret'];
    const lines = (items || []).map(i => [i.name, i.category || '', i.coin_cost === null || i.coin_cost === undefined ? '' : fmtCoins(config, i.coin_cost),
      i.barter_cost ?? '', i.wealth_level === null || i.wealth_level === undefined ? '' : (levels[i.wealth_level] || i.wealth_level),
      i.favour_size ? sizeLabel(i.favour_size) : '', availLabel(i.availability).replace(' here', ''), i.notes || '', i.is_secret ? 'yes' : ''].map(q).join(','));
    return [head.join(','), ...lines].join('\r\n') + '\r\n';
  }

  root.Economy = { AVAIL, SIZES, availLabel, sizeLabel, fmtNum, parseNum, coinUnits, fmtCoins, coinNamed, parseCoins, partyCoins, tradeGoods, partyGoods, fmtBarter,
    shiftApplies, priceIn, shiftWords, parseCSV, itemsFromRows, itemsToCSV };
})(typeof window !== 'undefined' ? window : globalThis);
