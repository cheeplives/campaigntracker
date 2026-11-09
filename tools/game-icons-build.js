#!/usr/bin/env node
// tools/game-icons-build.js — copy the game-icons.net set into static/vendor/game-icons/ for the Tokens tab's Game icons.
//
//   npm pack game-icons-transparent && tar xzf game-icons-transparent-*.tgz
//   node tools/game-icons-build.js package
//
// The package is an npm copy of the game-icons/icons repository with the black backgrounds taken out: one folder per
// artist, one SVG per icon, each a path filled with currentColor. This keeps the folders and files as they are, copies
// the set's license.txt, and writes index.json: every icon as "artist/name", and each artist's name, link and licence
// (CC BY 3.0, or CC0 for the two the licence names), which the token's picture is credited with (api/maps.php).
'use strict';
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, 'svgs'))) { console.error('Usage: node tools/game-icons-build.js <unpacked package folder>'); process.exit(1); }
const out = path.join(__dirname, '..', 'static', 'vendor', 'game-icons');

// Folder → the artist as license.txt names them. A folder missing here stops the build, so a new artist is noticed.
const ARTISTS = {
  'andymeneely': ['Andy Meneely', 'http://www.se.rit.edu/~andy/'], 'aussiesim': ['Aussiesim'], 'carl-olsen': ['Carl Olsen', 'https://twitter.com/unstoppableCarl'],
  'caro-asercion': ['Caro Asercion'], 'cathelineau': ['Cathelineau'], 'catsu': ['Catsu'], 'darkzaitzev': ['DarkZaitzev', 'http://darkzaitzev.deviantart.com'],
  'delapouite': ['Delapouite', 'https://delapouite.com'], 'faithtoken': ['Faithtoken', 'http://fungustoken.deviantart.com'],
  'felbrigg': ['Felbrigg', 'http://blackdogofdoom.blogspot.co.uk'], 'generalace135': ['GeneralAce135'], 'guard13007': ['Guard13007', 'https://guard13007.com'],
  'heavenly-dog': ['HeavenlyDog', 'http://www.gnomosygoblins.blogspot.com'], 'irongamer': ['Irongamer', 'http://ecesisllc.wix.com/home'],
  'john-colburn': ['John Colburn', 'http://ninmunanmu.com'], 'john-redman': ['John Redman', 'http://www.uniquedicetowers.com'], 'kier-heyl': ['Kier Heyl'],
  'lorc': ['Lorc', 'http://lorcblog.blogspot.com'], 'lord-berandas': ['Lord Berandas', 'http://berandas.deviantart.com'], 'lucasms': ['Lucas'],
  'pepijn-poolman': ['Pepijn Poolman'], 'pierre-leducq': ['Pierre Leducq'], 'priorblue': ['PriorBlue'], 'quoting': ['Quoting'], 'rihlsul': ['Rihlsul'],
  'sbed': ['Sbed', 'http://opengameart.org/content/95-game-icons'], 'seregacthtuf': ['Seregacthtuf'], 'skoll': ['Skoll'],
  'sparker': ['Sparker', 'http://citizenparker.com'], 'spencerdub': ['SpencerDub'], 'starseeker': ['Starseeker'], 'various-artists': ['Various artists'],
  'viscious-speed': ['Viscious Speed', 'http://viscious-speed.deviantart.com', 'CC0'], 'willdabeast': ['Willdabeast', 'http://wjbstories.blogspot.com'],
  'zajkonur': ['Zajkonur'], 'zeromancer': ['Zeromancer', null, 'CC0'],
};

fs.rmSync(path.join(out, 'svg'), { recursive: true, force: true });
const icons = [], artists = {};
for (const folder of fs.readdirSync(path.join(src, 'svgs')).sort()) {
  const a = ARTISTS[folder];
  if (!a) { console.error(`No artist listed for the folder ${folder}: add it to ARTISTS from license.txt`); process.exit(1); }
  artists[folder] = { name: a[0], url: a[1] || null, licence: a[2] || 'CC BY 3.0' };
  fs.mkdirSync(path.join(out, 'svg', folder), { recursive: true });
  for (const f of fs.readdirSync(path.join(src, 'svgs', folder))) {
    if (!/^[a-z0-9-]+\.svg$/.test(f)) continue;
    const svg = fs.readFileSync(path.join(src, 'svgs', folder, f), 'utf8');
    // Only plain paths: nothing that runs or loads anything (the files are served from this site).
    if (/<script|<style|<image|<foreignObject|\bon\w+=|href=/i.test(svg)) { console.error(`Skipped ${folder}/${f}: it has more than paths`); continue; }
    fs.writeFileSync(path.join(out, 'svg', folder, f), svg.trim() + '\n');
    icons.push(`${folder}/${f.slice(0, -4)}`);
  }
}
icons.sort((x, y) => x.split('/')[1].localeCompare(y.split('/')[1]) || x.localeCompare(y));
fs.copyFileSync(path.join(src, 'license.txt'), path.join(out, 'license.txt'));
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ source: 'https://game-icons.net/', artists, icons }) + '\n');
console.log(`${icons.length} icons by ${Object.keys(artists).length} artists in ${out}`);
