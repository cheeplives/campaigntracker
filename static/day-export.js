/* day-export.js — one day as a Markdown file, laid out like Sinless's Scabard
 * export: a # title, an italic byline, bold-label stat lines joined with " · ",
 * ## sections and an italic footer. Paste it into Scabard or any wiki.
 *
 * Plain script, no build step. It only formats what the day page already
 * received from the API, so a player's file holds exactly what that player can
 * see: the server leaves out secret events, GM notes and hidden future weather,
 * and later shifts of today lose their weather here unless the GM lets players
 * see future weather. */
'use strict';

const DayExport = (() => {
  const E = window.Engine;
  const has = v => v !== null && v !== undefined && String(v).trim() !== '';
  const text = v => String(v ?? '').replace(/\r\n?/g, '\n').trim();
  /** A day note: rich text (the Public and Secret notes' editor) becomes Markdown. */
  const note = (v, format) => format === 'html' ? RichText.toMarkdown(v) : text(v);
  /** Who wrote something: the character's name when the API sends one, else the player's. */
  const who = x => x.character_name || x.author || 'unknown';

  /** ctx: { camp, role, regions, holidays, tempUnit, d, data }, where data is the
   * 'day' API response ({ day, shifts, shift_notes, events }) and camp has calendar,
   * settings, seed and current_shift. Returns the Markdown text. */
  function build(ctx) {
    const { camp, d, data } = ctx;
    const c = camp.calendar, s = camp.settings || {}, gm = ctx.role === 'gm';
    const unit = ctx.tempUnit, names = E.shiftNames(c);
    const row = data.day || {};
    const region = ctx.regions.find(r => r.id === Number(row.region_id))
      || ctx.regions.find(r => r.id === Number(s.current_region)) || ctx.regions[0] || null;
    const w = row.weather || null;
    const spd = E.slotsPerDay(c), hours = E.timeMode(c) === 'hours';
    const now = Number(camp.current_shift), today = Math.floor(now / spd);
    const sea = E.season(c, d, region?.settings?.hemisphere);
    const sun = E.sunTimes(c, d, region?.settings?.hemisphere);
    const hol = E.holidaysOn(c, ctx.holidays, d);
    // a player's today comes as the shifts so far (w.partial), without the forecast
    const sws = E.slotsFromQuarters(c, w?.partial ? w.shifts : E.shiftWeather(c, camp.seed, region, d, w));
    const shifts = {}; (data.shifts || []).forEach(x => (shifts[x.shift] = x));
    // Players don't learn the weather of a shift that hasn't happened yet.
    const hideWx = i => !gm && !s.players_see_future_weather && d * spd + i > now;
    const L = [];

    L.push(`# ${E.fmtDate(c, d)}`);
    L.push('');
    L.push(`*${[camp.name, region?.name, sea.name].filter(Boolean).join(' · ')}*`);
    L.push('');
    const wxDef = w ? E.WEATHER[w.type] || {} : null;
    L.push([
      `**${w?.partial ? 'Weather now' : 'Forecast'}** ${w ? `${wxDef.icon || ''} ${E.weatherLabel(w, unit)}`.trim() : 'not known'}`,
      sun ? `**Sun** rises ${E.fmtClock(sun.sunrise)}, sets ${E.fmtClock(sun.sunset)}` : null,
      ...E.moons(c, d).map(m => `**${m.name}** ${m.icon} ${m.label} (${Math.round(m.illum * 100)}%)`),
      d === today ? `**Now** ${names[E.mod(now, spd)]}` : null,
    ].filter(Boolean).join(' · '));
    L.push('');
    if (hol.length) {
      L.push('**Holidays:** ' + hol.map(h => h.name + (h.is_secret ? ' (secret)' : '')).join(' · '));
      for (const h of hol) if (has(h.description)) L.push(`- *${h.name}:* ${text(h.description)}`);
      L.push('');
    }

    if (has(row.locations)) {
      L.push('## Locations visited');
      L.push('');
      L.push(text(row.locations));
      L.push('');
    }
    if (has(row.notes)) {
      L.push('## Public notes');
      L.push('');
      L.push(note(row.notes, row.notes_format));
      L.push('');
    }
    if (gm && has(row.gm_notes)) {
      L.push('## Secret notes 🔒');
      L.push('');
      L.push(note(row.gm_notes, row.gm_notes_format));
      L.push('');
    }

    L.push(hours ? '## Hours' : '## Shifts');
    L.push('');
    for (let i = 0; i < spd; i++) {
      const sh = shifts[i] || {};
      // In hours mode only the hours with something recorded, and the current one, get a section.
      if (hours && d * spd + i !== now && !has(sh.activity) && !(gm && has(sh.gm_notes)) && !(data.shift_notes || []).some(n => Number(n.shift) === i)) continue;
      const hidden = hideWx(i), sw = hidden ? null : sws[i] || null;
      const v = E.visibility(c, region, sw, d, i, sh.visibility_override);
      L.push(`### ${names[i]}${d * spd + i === now ? ' (now)' : ''}`);
      L.push('');
      L.push([
        `**Weather** ${sw ? `${E.WEATHER[sw.type]?.icon || ''} ${E.weatherLabel(sw, unit)}`.trim() : hidden ? 'not known yet' : 'not recorded'}`,
        hidden ? null : `**Visibility** ${v.score} ${v.label} (${v.parts.join(', ')})`,
      ].filter(Boolean).join(' · '));
      L.push('');
      if (has(sh.activity)) { L.push(`**Activity:** ${text(sh.activity)}`); L.push(''); }
      // Shift notes from players and GM, each signed like event notes.
      const sn = (data.shift_notes || []).filter(n => Number(n.shift) === i);
      for (const n of sn) L.push(`- ${text(n.body).replace(/\n/g, '\n  ')} — *${who(n)}, ${n.created_at}*`);
      if (sn.length) L.push('');
      if (gm && has(sh.gm_notes)) { L.push(`> 🔒 ${text(sh.gm_notes).replace(/\n/g, '\n> ')}`); L.push(''); }
    }

    const evs = data.events || [];
    if (evs.length) {
      L.push('## Events');
      L.push('');
      for (const e of evs) {
        const span = has(e.end_day) ? `${E.fmtDate(c, Number(e.abs_day), { noWeekday: true })} → ${E.fmtDate(c, Number(e.end_day), { noWeekday: true })}` : null;
        L.push(`### ${e.title}${Number(e.is_secret) ? ' 🔒' : ''}`);
        L.push('');
        const shifts = !has(e.shift) ? 'All day'
          : has(e.end_day) || (has(e.shift_end) && Number(e.shift_end) !== Number(e.shift)) ? `${names[e.shift]} → ${names[has(e.shift_end) ? e.shift_end : e.shift]}` : names[e.shift];
        const tags = (e.tags || []).length ? `Tags: ${e.tags.map(t => t.name).join(', ')}` : null;
        L.push(`*${[shifts, span, tags, Number(e.is_secret) ? 'Secret (GM only)' : null, `added by ${who(e)}`].filter(Boolean).join(' · ')}*`);
        L.push('');
        if (has(e.body)) { L.push(text(e.body)); L.push(''); }
        for (const n of e.notes || []) L.push(`- ${text(n.body).replace(/\n/g, '\n  ')} — *${who(n)}, ${n.created_at}*`);
        if ((e.notes || []).length) L.push('');
      }
    }

    L.push(`*Exported from Campaign Chronicle · ${gm ? 'GM' : 'player'} view · ${new Date().toISOString().slice(0, 10)}*`);
    return L.join('\n') + '\n';
  }

  /** A file name like "campaign-12-firstmonth-1.md". */
  function fileName(camp, d) {
    const slug = `${camp.name || 'campaign'} ${E.fmtDate(camp.calendar, d, { noWeekday: true })}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    return `${slug || 'day'}.md`;
  }

  function download(ctx) {
    const blob = new Blob([build(ctx)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(ctx.camp, ctx.d);
    document.body.append(a);
    a.click();
    a.remove();
    // iPad Safari reads the file only once its "Download?" prompt is answered, so keep it for a minute, not a second
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }

  return { build, fileName, download };
})();
