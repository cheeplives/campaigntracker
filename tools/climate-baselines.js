#!/usr/bin/env node
/*
 * Works out the temperature and wetness parts of the Köppen baselines in static/engine.js from
 * tools/climate-normals.json: monthly 1991–2020 station normals copied from the climate tables on
 * Wikipedia (CC BY-SA 4.0), which reproduce each country's weather service.
 *
 *   node tools/climate-baselines.js
 *
 * For each station it prints the Köppen class worked out from its normals, the season baselines (to copy into
 * KOPPEN in static/engine.js) and the day-to-night temperature swing, so a change to the normals or the rules
 * below shows up here.
 * Rules (the same ones the About page states):
 *   - Seasons are three-month blocks: Dec–Feb is winter in the north and summer in the south.
 *   - Daytime highs: the lowest to the highest of the season's three monthly mean daily maxima,
 *     widened evenly to at least 4 °C, rounded to whole degrees.
 *   - Wetness 0–5: 1.25 × log2(1 + P / 20), P = the season's mean monthly precipitation in mm, capped at 5.
 */
'use strict';
const path = require('path');
const normals = require(path.join(__dirname, 'climate-normals.json'));

const SEASONS = { winter: [11, 0, 1], spring: [2, 3, 4], summer: [5, 6, 7], autumn: [8, 9, 10] };
const SOUTH = { winter: 'summer', spring: 'autumn', summer: 'winter', autumn: 'spring' };
const r1 = x => Math.round(x * 10) / 10;

function baseline(st) {
  const out = {};
  for (const s of Object.keys(SEASONS)) {
    const months = SEASONS[st.lat < 0 ? SOUTH[s] : s];
    const highs = months.map(m => st.max[m]);
    let lo = Math.min(...highs), hi = Math.max(...highs);
    if (hi - lo < 4) { const mid = (lo + hi) / 2; lo = mid - 2; hi = mid + 2; }
    const p = months.reduce((a, m) => a + st.pr[m], 0) / 3;
    out[s] = { t: [Math.round(lo), Math.round(hi)], wet: r1(Math.min(5, 1.25 * Math.log2(1 + p / 20))) };
  }
  return out;
}

/** Köppen–Geiger class from monthly normals (0 °C C/D line, Beck et al. 2018 rules). */
function koppen(st) {
  const T = st.max.map((x, i) => (x + st.min[i]) / 2), P = st.pr;
  const north = st.lat >= 0;
  const summer = north ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
  const winter = [...Array(12).keys()].filter(i => !summer.includes(i));
  const MAT = T.reduce((a, b) => a + b) / 12, MAP = P.reduce((a, b) => a + b);
  const Ts = Math.max(...T), Tc = Math.min(...T);
  const Ps = summer.reduce((a, i) => a + P[i], 0), Pw = MAP - Ps;
  const Psdry = Math.min(...summer.map(i => P[i])), Pwdry = Math.min(...winter.map(i => P[i]));
  const Pswet = Math.max(...summer.map(i => P[i])), Pwwet = Math.max(...winter.map(i => P[i]));
  const Pth = Pw >= 0.7 * MAP ? 2 * MAT : Ps >= 0.7 * MAP ? 2 * MAT + 28 : 2 * MAT + 14;
  if (Ts < 10) return Ts > 0 ? 'ET' : 'EF';
  if (MAP < 10 * Pth) return 'B' + (MAP < 5 * Pth ? 'W' : 'S') + (MAT >= 18 ? 'h' : 'k');
  if (Tc >= 18) {
    const Pdry = Math.min(...P);
    if (Pdry >= 60) return 'Af';
    if (Pdry >= 100 - MAP / 25) return 'Am';
    return Psdry < Pwdry ? 'As' : 'Aw';
  }
  const g = Tc > 0 ? 'C' : 'D';
  const s = Psdry < 40 && Psdry < Pwwet / 3 ? 's' : Pwdry < Pswet / 10 ? 'w' : 'f';
  const warm = T.filter(x => x >= 10).length;
  const t = Ts >= 22 ? 'a' : warm >= 4 ? 'b' : g === 'D' && Tc < -38 ? 'd' : 'c';
  return g + s + t;
}

const dtr = {};
for (const [code, st] of Object.entries(normals)) {
  const b = baseline(st), k = koppen(st);
  const swing = st.max.reduce((a, x, i) => a + x - st.min[i], 0) / 12;
  if (!code.startsWith('_')) (dtr[code[0] === 'B' ? code.slice(0, 2) : code[0]] ||= []).push(swing);
  const fmt = Object.entries(b).map(([s, v]) => `${s} [${v.t}] wet ${v.wet}`).join(' · ');
  console.log(`${code.padEnd(9)} ${(k === code ? 'ok ' : `≠${k}`).padEnd(5)} swing ${swing.toFixed(1).padStart(4)} °C  ${fmt}  (${st.place})`);
}
console.log('\nMean day-to-night swing by group:');
for (const [g, v] of Object.entries(dtr)) console.log(`  ${g}: ${(v.reduce((a, b) => a + b) / v.length).toFixed(1)} °C (${v.length} stations)`);
