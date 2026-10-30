/* sheetimport.js — a character from another tool, read onto a sheet's fields: a Pathbuilder 2e export (its Export
 * JSON) and a D&D Beyond character (its character service's JSON). The values are keyed as the starter templates'
 * fields are (Pathfinder 2e; D&D 5e 2014 and 2024), so they land on those and on forks that keep the keys; fit()
 * keeps only what a sheet has a field for, in a form that field takes. Nothing is worked out beyond what a sheet
 * shows: no rules, only the numbers each tool already has.
 *
 * Plain script, no page needed, so the same file runs under Node in the tests. */
'use strict';
(function (root) {
  const L = root.SheetLayout || (typeof require === 'function' ? require('./sheetlayout.js') : null);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const mod = score => Math.floor((score - 10) / 2);
  const signed = n => (n >= 0 ? `+${n}` : String(n));
  const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

  /** 'pathbuilder', 'dndbeyond', or null for anything else. */
  function detect(json) {
    if (!isObj(json)) return null;
    if (isObj(json.build) && isObj(json.build.abilities)) return 'pathbuilder';
    if (isObj(json.data) && Array.isArray(json.data.stats) && Array.isArray(json.data.classes)) return 'dndbeyond';
    return null;
  }

  /** A link to either, as { source, id }; null for any other. */
  function link(text) {
    const s = String(text || '').trim();
    let m = s.match(/^(?:https?:\/\/)?(?:www\.)?pathbuilder2e\.com\/json\.php\?id=(\d{1,12})$/i);
    if (m) return { source: 'pathbuilder', id: m[1] };
    m = s.match(/^(?:https?:\/\/)?(?:www\.)?dndbeyond\.com\/(?:profile\/[^/?#]+\/)?characters\/(\d{1,12})(?:[/?#].*)?$/i);
    if (m) return { source: 'dndbeyond', id: m[1] };
    return null;
  }

  // ------------------------------------------------------------ Pathbuilder 2e
  const RANKS = { 0: 'Untrained', 2: 'Trained', 4: 'Expert', 6: 'Master', 8: 'Legendary' };
  const PF_SKILLS = ['acrobatics', 'arcana', 'athletics', 'crafting', 'deception', 'diplomacy', 'intimidation', 'medicine', 'nature',
    'occultism', 'performance', 'religion', 'society', 'stealth', 'survival', 'thievery'];

  function pathbuilder(b) {
    const v = {}, rank = n => RANKS[n] ?? null, prof = isObj(b.proficiencies) ? b.proficiencies : {};
    for (const k of ['ancestry', 'heritage', 'background', 'class']) if (str(b[k])) v[k] = str(b[k]);
    if (str(b.deity) && b.deity !== 'Not set') v.deity = str(b.deity);
    if (num(b.level) !== null) v.level = b.level;
    if (num(b.xp) !== null) v.xp = b.xp;
    const ab = b.abilities || {};
    for (const [short, long] of [['str', 'strength'], ['dex', 'dexterity'], ['con', 'constitution'], ['int', 'intelligence'], ['wis', 'wisdom'], ['cha', 'charisma']])
      if (num(ab[short]) !== null) v[`attr_${long}`] = mod(ab[short]);
    if (num(b.acTotal?.acTotal) !== null) v.ac = b.acTotal.acTotal;
    // the best armour rank the character has
    const armor = Math.max(...['unarmored', 'light', 'medium', 'heavy'].map(k => num(prof[k]) ?? -1));
    if (rank(armor)) v.armor_rank = rank(armor);
    for (const [k, key] of [['fortitude', 'fort_rank'], ['reflex', 'reflex_rank'], ['will', 'will_rank'], ['perception', 'perception_rank'], ['classDC', 'class_dc_rank']])
      if (rank(prof[k])) v[key] = rank(prof[k]);
    for (const s of PF_SKILLS) if (rank(prof[s])) v[`sk_${s}`] = rank(prof[s]);
    const at = b.attributes || {};
    if (num(at.ancestryhp) !== null && num(at.classhp) !== null && num(b.level) !== null && num(ab.con) !== null) {
      const max = at.ancestryhp + (num(at.bonushp) ?? 0) + (at.classhp + (num(at.bonushpPerLevel) ?? 0) + mod(ab.con)) * b.level;
      v.hp = { cur: max, max };
    }
    if (num(at.speed) !== null) v.speed = at.speed + (num(at.speedBonus) ?? 0);
    if (Array.isArray(b.languages) && b.languages.length) v.languages = b.languages.filter(str).join(', ');
    const m = b.money || {};
    for (const [k, key] of [['cp', 'money_copper'], ['sp', 'money_silver'], ['gp', 'money_gold'], ['pp', 'money_platinum']]) if (num(m[k]) !== null) v[key] = m[k];
    if (Array.isArray(b.lores)) v.lores = b.lores.filter(l => Array.isArray(l) && str(l[0])).map(l => ({ lore: l[0], rank: rank(l[1]) || 'Untrained' }));
    if (Array.isArray(b.feats)) v.feat_list = b.feats.filter(f => Array.isArray(f) && str(f[0]))
      .map(f => ({ level: f[3] == null ? '' : String(f[3]), type: f[2] == null ? '' : String(f[2]), feat: f[0] }));
    if (Array.isArray(b.equipment)) v.items = b.equipment.filter(e => Array.isArray(e) && str(e[0])).map(e => ({ item: e[0], qty: String(e[1] ?? 1) }));
    if (Array.isArray(b.weapons)) v.strike_list = b.weapons.filter(w => isObj(w) && str(w.display || w.name)).map(w => ({
      weapon: str(w.display) || w.name,
      attack: num(w.attack) === null ? '' : signed(w.attack),
      damage: [w.die ? `1${w.die}${num(w.damageBonus) ? signed(w.damageBonus) : ''}` : '', w.damageType || ''].filter(Boolean).join(' '),
    }));
    return { name: str(b.name), values: v };
  }

  // ------------------------------------------------------------ D&D Beyond
  const DDB_SKILLS = ['acrobatics', 'animal-handling', 'arcana', 'athletics', 'deception', 'history', 'insight', 'intimidation', 'investigation',
    'medicine', 'nature', 'perception', 'performance', 'persuasion', 'religion', 'sleight-of-hand', 'stealth', 'survival'];

  function dndbeyond(d) {
    const v = {};
    const mods = Object.values(isObj(d.modifiers) ? d.modifiers : {}).flat().filter(isObj);
    const has = (types, sub) => mods.some(m => types.includes(m.type) && m.subType === sub);
    const byId = (list, id) => num((Array.isArray(list) ? list : []).find(s => s?.id === id)?.value);
    const scores = ABILITIES.map((a, i) => {
      const over = byId(d.overrideStats, i + 1);
      if (over !== null) return over;
      const base = byId(d.stats, i + 1);
      if (base === null) return null;
      return base + (byId(d.bonusStats, i + 1) ?? 0) + mods.filter(m => m.type === 'bonus' && m.subType === `${a}-score`).reduce((t, m) => t + (num(m.value) ?? 0), 0);
    });
    ABILITIES.forEach((a, i) => { if (scores[i] !== null) v[`ab_${a}`] = scores[i]; });
    const classes = (Array.isArray(d.classes) ? d.classes : []).filter(c => str(c?.definition?.name));
    if (classes.length) {
      v.class = classes.map(c => `${c.definition.name} ${c.level}`).join(' / ');
      v.class_level = classes.map(c => `${c.definition.name}${str(c.subclassDefinition?.name) ? ` (${c.subclassDefinition.name})` : ''} ${c.level}`).join(' / ');
      const subs = classes.map(c => str(c.subclassDefinition?.name)).filter(Boolean);
      if (subs.length) v.subclass = subs.join(' / ');
      v.level = classes.reduce((t, c) => t + (num(c.level) ?? 0), 0);
    }
    if (str(d.race?.fullName)) v.species = v.race = str(d.race.fullName);
    if (str(d.background?.definition?.name)) v.background = str(d.background.definition.name);
    if (num(d.currentXp) !== null) v.xp = d.currentXp;
    if (typeof d.inspiration === 'boolean') v.inspiration = v.heroic_inspiration = d.inspiration;
    ABILITIES.forEach(a => { v[`save_${a}`] = has(['proficiency', 'expertise'], `${a}-saving-throws`); });
    for (const s of DDB_SKILLS) v[`sk_${s.replace(/-/g, '_')}`] = has(['proficiency', 'expertise'], s);
    const con = scores[2];
    const max = num(d.overrideHitPoints) ?? (num(d.baseHitPoints) !== null && con !== null && v.level
      ? d.baseHitPoints + (num(d.bonusHitPoints) ?? 0) + mod(con) * v.level : null);
    if (max !== null) v.hp = { cur: max - (num(d.removedHitPoints) ?? 0), max };
    if (num(d.temporaryHitPoints) !== null) v.temp_hp = d.temporaryHitPoints;
    const c = d.currencies || {};
    for (const k of ['cp', 'sp', 'ep', 'gp', 'pp']) if (num(c[k]) !== null) v[`coin_${k}`] = c[k];
    if (Array.isArray(d.inventory)) v.equipment = d.inventory.filter(i => str(i?.definition?.name)).map(i => ({ item: i.definition.name, qty: String(i.quantity ?? 1) }));
    const t = d.traits || {};
    for (const [k, key] of [['personalityTraits', 'traits'], ['ideals', 'ideals'], ['bonds', 'bonds'], ['flaws', 'flaws'], ['appearance', 'appearance']]) if (str(t[k])) v[key] = str(t[k]);
    if (str(d.notes?.backstory)) v.backstory = str(d.notes.backstory);
    return { name: str(d.name), values: v };
  }

  /** { name, values } from either tool's JSON; throws on anything else. */
  function read(json) {
    const kind = detect(json);
    if (kind === 'pathbuilder') return pathbuilder(json.build);
    if (kind === 'dndbeyond') return dndbeyond(json.data);
    throw new Error("That isn't a Pathbuilder 2e export or a D&D Beyond character");
  }

  /** The values a sheet has a field for, each in a form that field takes; a list keeps only the sheet's columns. */
  function fit(layout, values) {
    const fields = L.fields(layout), out = {};
    for (const [k, raw] of Object.entries(values || {})) {
      const f = fields.get(k)?.field;
      if (!f) continue;
      let val = raw;
      if (f.type === 'list') {
        if (!Array.isArray(raw)) continue;
        const cols = (f.columns || []).map(c => c.key);
        val = raw.map(r => Object.fromEntries(cols.filter(c => r[c] !== undefined && r[c] !== '').map(c => [c, String(r[c])]))).filter(r => Object.keys(r).length);
        if (!val.length) continue;
      } else if (f.type === 'text' || f.type === 'longtext') {
        if (typeof raw === 'number') val = String(raw);
      } else if (f.type === 'number' && typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) val = Number(raw);
      const c = L.coerce(f, val);
      if (c.ok && c.value !== null && c.value !== '') out[k] = c.value;
    }
    return { values: out, count: Object.keys(out).length };
  }

  const SheetImport = { detect, link, read, fit };
  if (typeof module !== 'undefined' && module.exports) module.exports = SheetImport;
  else root.SheetImport = SheetImport;
})(typeof window !== 'undefined' ? window : globalThis);
