#!/usr/bin/env node
// tools/ui-icons-build.js — writes static/icons.js, the interface's icons, from the game-icons.net set already in
// static/vendor/game-icons/ (CC BY 3.0, credited on the About page) plus a few plain shapes drawn here.
//
//   node tools/ui-icons-build.js
//
// Each icon has a name, the game-icons file it comes from (artist/name) or a path of our own, and the emoji it stands
// in for. The app's code still writes those emoji in its labels ('🔒 GM only', `${def.icon} Overcast`): kit.js's el()
// swaps each one for its icon as it builds the page, so every label in the app gets the same drawn icon on every
// device instead of the device's own emoji. To add one: add a row below and run this again. Files written by the app
// for other programs (exports, Markdown, calendars) keep the emoji, since they never go through el().
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GI = path.join(ROOT, 'static', 'vendor', 'game-icons', 'svg');

// Plain shapes of our own, on the same 512 grid as game-icons.
const OWN = {
  'arrow-down': 'M226 64h60v260l84-84 42 42-156 156-156-156 42-42 84 84z',
  'arrow-up': 'M286 448h-60V188l-84 84-42-42L256 74l156 156-42 42-84-84z',
  plus: 'M226 96h60v130h130v60H286v130h-60V286H96v-60h130z',
  link: 'M210 302l92-92 34 34-92 92zm-30 74a62 62 0 0 1-88-88l64-64-34-34-64 64a110 110 0 0 0 156 156l64-64-34-34zm152-240a62 62 0 0 1 88 88l-64 64 34 34 64-64a110 110 0 0 0-156-156l-64 64 34 34z',
  question: 'M256 32a224 224 0 1 0 0 448 224 224 0 0 0 0-448zm0 360a28 28 0 1 1 0-56 28 28 0 0 1 0 56zm34-118c-14 9-16 14-16 30h-48c0-34 10-50 34-66 17-11 26-18 26-36 0-18-14-30-30-30-18 0-32 13-32 34h-48c0-46 34-80 80-80 44 0 78 30 78 74 0 38-20 58-44 74z',
  exclaim: 'M256 32a224 224 0 1 0 0 448 224 224 0 0 0 0-448zm-30 80h60l-10 190h-40zm30 300a30 30 0 1 1 0-60 30 30 0 0 1 0 60z',
  square: 'M96 96h320v320H96z',
  area: 'M256 40 466 194 386 452H126L46 194zm0 62L104 213l56 177h192l56-177z',   // a pentagon's outline: an area drawn on a map
  cloud: 'M128 400a96 96 0 0 1-12-191 120 120 0 0 1 226-46 100 100 0 0 1 118 98 70 70 0 0 1-12 139z',
  letters: 'M150 112h52l102 288h-54l-24-72H124l-24 72H46zm-12 172h76l-38-116zm218-60c54 0 86 26 86 74v102h-46v-22c-14 18-34 28-60 28-42 0-70-24-70-60 0-40 30-62 86-62h44c0-22-14-34-42-34-20 0-38 6-56 18l-18-34c22-14 48-22 76-22zm-14 140c24 0 44-12 50-32v-20h-38c-28 0-40 8-40 26 0 16 12 26 28 26z',
  clipboard: 'M200 48h112v40h72v376H128V88h72zm24 40v32h64V88zm-56 40v296h176V128h-40v32H208v-32zm40 80h96v32h-96zm0 72h96v32h-96z',
};
// Moon phases, drawn as a lit disc: the shadow edge is an ellipse whose width follows the phase.
function moon(f) {   // f: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter
  const r = 200, c = 256;
  const lit = f <= 0.5 ? f * 2 : (1 - f) * 2;   // 0..1 how much is lit
  const waxing = f < 0.5;
  const rx = Math.abs(1 - 2 * lit) * r;
  // the lit limb, top to bottom round the lit side, then back up the terminator: round the far side when gibbous
  const outer = waxing ? 1 : 0, inner = (lit > 0.5) === waxing ? 1 : 0;
  const ring = `M${c} ${c - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0 ${-2 * r}zm0 24a${r - 24} ${r - 24} 0 1 1 0 ${2 * (r - 24)}a${r - 24} ${r - 24} 0 1 1 0 ${-2 * (r - 24)}z`;
  if (lit < 0.02) return ring;
  if (lit > 0.98) return `M${c} ${c - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0 ${-2 * r}z`;
  return `${ring}M${c} ${c - r}a${r} ${r} 0 0 ${outer} 0 ${2 * r}a${rx.toFixed(1)} ${r} 0 0 ${inner} 0 ${-2 * r}z`;
}
const MOONS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
MOONS.forEach((f, i) => { OWN[`moon-${i}`] = moon(f); });

// [name, source (artist/name in game-icons, or a name in OWN), label, the emoji it replaces...]
const ICONS = [
  // the interface
  ['lock', 'lorc/padlock', 'GM only', '🔒'],
  ['unlock', 'delapouite/padlock-open', 'Unlocked', '🔓'],
  ['book', 'lorc/open-book', 'Encyclopedia', '📖'],
  ['dice', 'delapouite/rolling-dices', 'Dice', '🎲'],
  ['place', 'delapouite/position-marker', 'Place', '📍'],
  ['pin', 'delapouite/pin', 'Pin', '📌'],
  ['bell', 'lorc/ringing-bell', 'Reminder', '🔔'],
  ['eye', 'lorc/semi-closed-eye', 'Visibility', '👁'],
  ['hidden', 'skoll/sight-disabled', 'Hidden', '🙈'],
  ['cog', 'lorc/cog', 'Settings', '⚙'],
  ['search', 'lorc/magnifying-glass', 'Search', '🔍'],
  ['download', 'arrow-down', 'Download', '⬇'],
  ['upload', 'arrow-up', 'Upload', '⬆'],
  ['note', 'lorc/quill-ink', 'Note', '📝'],
  ['flag', 'lorc/flying-flag', 'Party', '🚩'],
  ['map', 'lorc/treasure-map', 'Map', '🗺'],
  ['calendar', 'delapouite/calendar', 'Calendar', '📅', '🗓'],
  ['forward', 'delapouite/fast-forward-button', 'Pass time', '⏩'],
  ['history', 'lorc/sands-of-time', 'History', '🕘'],
  ['scroll', 'lorc/scroll-unfurled', 'Scroll', '📜'],
  ['palette', 'delapouite/palette', 'Colours', '🎨'],
  ['clipboard', 'clipboard', 'Copy', '📋'],
  ['people', 'delapouite/three-friends', 'People', '👥'],
  ['person', 'delapouite/person', 'Person', '👤'],
  ['compass', 'lorc/compass', 'Go to', '🧭'],
  ['family', 'delapouite/family-tree', 'Family', '🌳'],
  ['link', 'link', 'Link', '🔗'],
  ['key', 'lorc/key', 'Item', '🗝'],
  ['sun', 'lorc/sun', 'Sun', '☀'],
  ['moon', 'lorc/moon', 'Moon', '🌙'],
  ['bed', 'delapouite/bed', 'Rest', '🛏'],
  ['picture', 'delapouite/mona-lisa', 'Picture', '🖼'],
  ['attach', 'delapouite/paper-clip', 'Attach', '📎'],
  ['web', 'lorc/spider-web', 'Web', '🕸'],
  ['books', 'delapouite/bookshelf', 'Library', '📚'],
  ['tome', 'delapouite/book-cover', 'Book', '📕'],
  ['notebook', 'delapouite/notebook', 'Journal', '📓'],
  ['file', 'lorc/papers', 'File', '📄'],
  ['files', 'delapouite/files', 'Files', '🗂'],
  ['toolbox', 'delapouite/toolbox', 'Tools', '🧰'],
  ['trash', 'delapouite/trash-can', 'Delete', '🗑'],
  ['warning', 'lorc/hazard-sign', 'Warning', '⚠'],
  ['alarm', 'delapouite/alarm-clock', 'Reminder', '⏰'],
  ['plus', 'plus', 'Add', '➕'],
  ['hand', 'lorc/hand', 'Hand up', '🙋'],
  ['ruler', 'delapouite/measure-tape', 'Measure', '📏'],
  ['label', 'delapouite/price-tag', 'Label', '🏷'],
  ['letters', 'letters', 'Labels', '🔤'],
  ['telescope', 'delapouite/telescope', 'Scout', '🔭'],
  // shift actions, holdings and rests
  ['boot', 'lorc/walking-boot', 'Travel', '🥾'],
  ['herbs', 'delapouite/herbs-bundle', 'Forage', '🌿'],
  ['bow', 'delapouite/bow-arrow', 'Hunt', '🏹'],
  ['fishing', 'delapouite/fishing-pole', 'Fish', '🎣'],
  ['log', 'delapouite/log', 'Scrounge', '🪵'],
  ['tent', 'delapouite/camping-tent', 'Camp', '⛺'],
  ['pot', 'delapouite/cooking-pot', 'Cook', '🍲'],
  ['pack', 'lorc/knapsack', 'Provisions', '🎒'],
  ['shield', 'sbed/shield', 'Guard', '🛡'],
  ['fire', 'lorc/campfire', 'Fire', '🔥'],
  ['sleep', 'delapouite/night-sleep', 'Sleep', '💤'],
  ['spanner', 'lorc/spanner', 'Repair', '🔧'],
  ['bandage', 'delapouite/arm-bandage', 'Tend wounds', '🩹'],
  ['talk', 'skoll/talk', 'Talk', '🗣'],
  ['cup', 'delapouite/coffee-cup', 'Short rest', '☕'],
  ['house', 'delapouite/house', 'House', '🏠'],
  ['jeep', 'delapouite/jeep', 'Vehicle', '🚙'],
  ['horse', 'delapouite/horse-head', 'Animal', '🐎'],
  ['castle', 'delapouite/castle', 'Castle', '🏰'],
  ['gem', 'lorc/cut-diamond', 'Gem', '💎'],
  ['box', 'delapouite/cardboard-box', 'Box', '📦'],
  ['ship', 'delapouite/sailboat', 'Ship', '⛵'],
  // weather, light and ground
  ['partly', 'delapouite/sun-cloud', 'Partly cloudy', '⛅'],
  ['cloud', 'cloud', 'Overcast', '☁'],
  ['drizzle', 'lorc/raining', 'Light rain', '🌦️'],
  ['rain', 'lorc/heavy-rain', 'Heavy rain', '🌧'],
  ['storm', 'lorc/lightning-storm', 'Thunderstorm', '⛈'],
  ['fog', 'delapouite/fog', 'Fog', '🌫'],
  ['snow', 'lorc/snowing', 'Snow', '🌨'],
  ['snowflake', 'lorc/snowflake-2', 'Heavy snow', '❄'],
  ['blizzard', 'lorc/whirlwind', 'Blizzard', '🌬'],
  ['ice', 'lorc/ice-cube', 'Ice', '🧊'],
  ['haze', 'lorc/heat-haze', 'Heat haze', '🥵'],
  ['tornado', 'lorc/tornado', 'Sandstorm', '🌪'],
  ['candle', 'lorc/candle-flame', 'Still air', '🕯'],
  ['drops', 'lorc/droplets', 'Damp', '💧'],
  ['draft', 'lorc/wind-hole', 'Drafts', '🍃'],
  ['dust', 'lorc/dust-cloud', 'Dust or smoke', '🌁'],
  ['satellite', 'lorc/satellite', 'Station', '🛰'],
  ['power', 'lorc/power-lightning', 'Power', '⚡'],
  ['siren', 'skoll/siren', 'Alert', '🚨'],
  ['blackout', 'square', 'Blackout', '⬛'],
  ['nebula', 'delapouite/galaxy', 'Nebula', '🌌'],
  ['vortex', 'lorc/vortex', 'Portal', '🌀'],
  ['radiation', 'lorc/radioactive', 'Radiation', '☢'],
  ['flare', 'lorc/sun-radiations', 'Solar flare', '🔆'],
  ['comet', 'lorc/comet-spark', 'Debris', '☄'],
  ['snowman', 'lorc/snowman', 'Snow on the ground', '⛄'],
  ['wind', 'lorc/wind-slap', 'Wind', '💨'],
  // moon phases
  ['moon-new', 'moon-0', 'New moon', '🌑'], ['moon-waxing-crescent', 'moon-1', 'Waxing crescent', '🌒'],
  ['moon-first-quarter', 'moon-2', 'First quarter', '🌓'], ['moon-waxing-gibbous', 'moon-3', 'Waxing gibbous', '🌔'],
  ['moon-full', 'moon-4', 'Full moon', '🌕'], ['moon-waning-gibbous', 'moon-5', 'Waning gibbous', '🌖'],
  ['moon-last-quarter', 'moon-6', 'Last quarter', '🌗'], ['moon-waning-crescent', 'moon-7', 'Waning crescent', '🌘'],
  // map pins (the GM picks one; static/maps.js PIN_ICONS)
  ['fortress', 'delapouite/pagoda', 'Fortress', '🏯'],
  ['temple', 'delapouite/greek-temple', 'Temple or hall', '🏛'],
  ['church', 'delapouite/church', 'Church', '⛪'],
  ['village', 'delapouite/village', 'Village', '🏘'],
  ['city', 'delapouite/modern-city', 'City', '🏙'],
  ['tavern', 'lorc/beer-stein', 'Tavern or inn', '🍺'],
  ['hut', 'delapouite/hut', 'Hut', '🛖'],
  ['tower', 'delapouite/watchtower', 'Tower', '🗼'],
  ['monument', 'delapouite/stone-bust', 'Monument', '🗿'],
  ['ruin', 'delapouite/castle-ruins', 'Ruin', '🏚'],
  ['anchor', 'lorc/anchor', 'Port', '⚓'],
  ['bridge', 'delapouite/stone-bridge', 'Bridge', '🌉'],
  ['door', 'lorc/wooden-door', 'Door or gate', '🚪'],
  ['cave', 'delapouite/mountain-cave', 'Cave or pit', '🕳'],
  ['mine', 'lorc/mining', 'Mine', '⛏'],
  ['forest', 'lorc/pine-tree', 'Forest', '🌲'],
  ['hill', 'delapouite/hills', 'Hill', '⛰'],
  ['mountain', 'lorc/mountaintop', 'Mountain', '🏔'],
  ['volcano', 'lorc/volcano', 'Volcano', '🌋'],
  ['island', 'delapouite/island', 'Island', '🏝'],
  ['water', 'lorc/waves', 'Water', '🌊'],
  ['battle', 'lorc/crossed-swords', 'Battle', '⚔'],
  ['danger', 'sbed/death-skull', 'Danger', '💀'],
  ['death', 'lorc/skull-crossed-bones', 'Death', '☠'],
  ['monster', 'lorc/dragon-head', 'Monster', '🐉'],
  ['crown', 'lorc/crown', 'Royal seat', '👑'],
  ['treasure', 'delapouite/coins', 'Treasure', '💰'],
  ['area', 'area', 'Area', '⬠'],
  ['unknown', 'question', 'Unknown', '❓'],
  ['important', 'exclaim', 'Important', '❗'],
  ['star', 'delapouite/stars-stack', 'Star', '⭐'],
  ['magic', 'delapouite/sparkles', 'Magic', '✨'],
  ['planet', 'lorc/ringed-planet', 'Planet', '🪐'],
  ['rocket', 'lorc/rocket', 'Starship', '🚀'],
];

function source(src) {
  if (OWN[src]) return `<path d="${OWN[src]}"/>`;
  const file = path.join(GI, `${src}.svg`);
  if (!fs.existsSync(file)) {
    const [, name] = src.split('/');
    const found = fs.readdirSync(GI).filter(a => fs.existsSync(path.join(GI, a, `${name}.svg`)));
    throw new Error(`No game-icons file ${src}${found.length ? ` (${name} is by ${found.join(', ')})` : ''}`);
  }
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s+fill="currentColor"/g, '');
  if (/<script|on\w+=/i.test(inner)) throw new Error(`${src} has script in it`);
  return inner.trim();
}

const shapes = {}, labels = {}, emoji = {}, credit = {};
for (const [name, src, label, ...chars] of ICONS) {
  if (shapes[name]) throw new Error(`Two icons named ${name}`);
  shapes[name] = source(src);
  labels[name] = label;
  if (!OWN[src]) credit[name] = src.split('/')[0];
  for (const ch of chars) {
    const bare = ch.replace(/️/g, '');
    if (emoji[bare]) throw new Error(`${ch} is already ${emoji[bare]}`);
    emoji[bare] = name;
  }
}

const out = `// static/icons.js — the interface's icons. Written by tools/ui-icons-build.js: change that and run it, not this.
// Drawn from game-icons.net (CC BY 3.0, the artist of each is in ICON_ARTISTS; credited on the About page), plus a
// few plain shapes of our own. Each is a 512 x 512 shape filled with currentColor, so it takes the text colour.
/* eslint-disable */
const ICON_SHAPES = ${JSON.stringify(shapes, null, 0).replace(/","/g, '",\n"')};
const ICON_LABELS = ${JSON.stringify(labels)};
const ICON_ARTISTS = ${JSON.stringify(credit)};
/** The emoji the app's labels are written with, and the icon each one is drawn as (kit.js el()). */
const ICON_FOR_EMOJI = ${JSON.stringify(emoji)};
`;
fs.writeFileSync(path.join(ROOT, 'static', 'icons.js'), out);
console.log(`static/icons.js: ${Object.keys(shapes).length} icons for ${Object.keys(emoji).length} emoji`);
