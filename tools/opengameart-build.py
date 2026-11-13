#!/usr/bin/env python3
"""tools/opengameart-build.py — build Find Image's bundled Game art set (static/vendor/opengameart/) from OpenGameArt.

    pip install pillow py7zr
    python3 tools/opengameart-build.py <download folder>

Downloads the packs below from opengameart.org into the download folder (kept, so a second run doesn't fetch them
again), picks the pictures named here, and writes them, shrunk where they are large, to static/vendor/opengameart/
with index.json: each picture's id, title, search words, artist (with their page), licence and the OpenGameArt page
it came from. Only CC0 and CC BY works are used, so every one may be copied into a campaign with its credit
(api/images.php, gameart_*). The titles and words were written by hand from looking at each picture.
"""
import io
import json
import os
import re
import shutil
import sys
import tarfile
import urllib.request
import zipfile

from PIL import Image

OGA = 'https://opengameart.org'
FILES = OGA + '/sites/default/files/'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'static', 'vendor', 'opengameart')

if len(sys.argv) != 2:
    sys.exit('Usage: python3 tools/opengameart-build.py <download folder>')
DL = sys.argv[1]
os.makedirs(DL, exist_ok=True)


def fetch(name):
    """A file from OpenGameArt's files folder, downloaded once into DL."""
    path = os.path.join(DL, name)
    if not os.path.exists(path):
        req = urllib.request.Request(FILES + name, headers={'User-Agent': 'GMsAlmanac-build/1.0'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path + '.part', 'wb') as f:
            shutil.copyfileobj(r, f)
        os.replace(path + '.part', path)
    return path


PEOPLE = 'portrait face person npc character'
items = []


def add(id_, img, title, words, author, author_url, lic, ver, pack, pack_slug, max_side=512, fmt=None):
    """One picture: shrunk to max_side, saved as JPEG when it has no transparency, else PNG."""
    if max(img.size) > max_side:
        img = img.copy()
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    alpha = img.mode in ('RGBA', 'LA', 'P') and img.convert('RGBA').getextrema()[3][0] < 255
    fmt = fmt or ('png' if alpha else 'jpg')
    name = f'{id_}.{fmt}'
    if fmt == 'png':
        img.convert('RGBA' if alpha else 'RGB').save(os.path.join(OUT, name), optimize=True)
    else:
        img.convert('RGB').save(os.path.join(OUT, name), quality=85, optimize=True, progressive=True)
    items.append({'id': id_, 'title': title, 'words': ' '.join(sorted(set(words.lower().split()))), 'author': author,
                  'author_url': author_url, 'license': lic, 'license_version': ver, 'pack': pack,
                  'page': f'{OGA}/content/{pack_slug}', 'file': name, 'width': img.size[0], 'height': img.size[1]})


def gender_words(title):
    t = title.lower()
    w = []
    if re.search(r'\b(woman|lady|girl|maiden|noblewoman|she)\b', t): w += ['woman', 'female']
    if re.search(r'\b(man|gentleman|officer|knight|soldier|monk|archbishop|doge|chief|warrior|boy)\b', t): w += ['man', 'male']
    if re.search(r'\b(old)\b', t): w += ['old', 'elderly', 'elder']
    if re.search(r'\b(girl|boy|child)\b', t): w += ['child', 'young']
    return ' '.join(w)


shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)

# --- Public Domain Portraits (qubodup, CC0): faces cropped from public-domain paintings on Wikimedia Commons ---------
PAINTERS = {
    'adelaide_hanscom': 'Adelaide Hanscom', 'alessandro_allori': 'Alessandro Allori', 'alexandre_cabanel': 'Alexandre Cabanel',
    'alexei_harlamov': 'Alexei Harlamoff', 'alexey_petrovich_antropov': 'Alexey Antropov', 'alice_pike_barney': 'Alice Pike Barney',
    'aman_theodor': 'Theodor Aman', 'antonello_messina': 'Antonello da Messina', 'antonio_herrera_toro': 'Antonio Herrera Toro',
    'benjamin-constant': 'Benjamin-Constant', 'benoist_marie-guillemine': 'Marie-Guillemine Benoist',
    'bouguereau_william-adolphe': 'William-Adolphe Bouguereau', 'byron': 'Unknown photographer', 'carl_fredric_breda': 'Carl Fredric von Breda',
    'cramacj_lucas': 'Lucas Cranach the Elder', 'cranach_lucas': 'Lucas Cranach the Elder', 'cristobal_rojas': 'Cristóbal Rojas',
    'delacroix_eugene_ferdinand_victor': 'Eugène Delacroix', 'domenikos_theotokopoulos': 'El Greco', 'edmund_blair_leighton': 'Edmund Blair Leighton',
    'edwin_longsden_long': 'Edwin Long', 'falero_luis_ricardo': 'Luis Ricardo Falero', 'felix_bonfils': 'Félix Bonfils',
    'francesco_hayez': 'Francesco Hayez', 'francisco_goya_lucientes': 'Francisco Goya', 'francisco_zurbaran': 'Francisco de Zurbarán',
    'franz_von_defregger': 'Franz von Defregger', 'frederic_westin': 'Fredric Westin', 'frederic_yates': 'Frederic Yates',
    'frederick_leighton': 'Frederic Leighton', 'gaston_bussiere': 'Gaston Bussière', 'george_henry_hall': 'George Henry Hall',
    'giovanni_battista_tiepolo': 'Giovanni Battista Tiepolo', 'giovanni_bellini': 'Giovanni Bellini', 'hans_holbein': 'Hans Holbein the Younger',
    'hayez_francesco': 'Francesco Hayez', 'henryk_siemiradzki': 'Henryk Siemiradzki', 'ilja_jefimowitsch_repin': 'Ilya Repin',
    'james_carrol_beckwith': 'James Carroll Beckwith', 'jean-baptiste-camille_corot': 'Camille Corot', 'jean-leon_gerome': 'Jean-Léon Gérôme',
    'john_william_godward': 'John William Godward', 'julije_klovic': 'Giulio Clovio', 'juriaen_streek': 'Juriaen van Streeck',
    'kiprenskij_orest_adamovic': 'Orest Kiprensky', 'konstantin_makovsky': 'Konstantin Makovsky', 'lefebvre_jules_joseph': 'Jules Joseph Lefebvre',
    'leon-francois_comerre': 'Léon François Comerre', 'leopold_loffler': 'Leopold Löffler', 'lewis_john_frederick': 'John Frederick Lewis',
    'madrazo_garreta_raimundo': 'Raimundo de Madrazo y Garreta', 'marie_bashkirtseff': 'Marie Bashkirtseff', 'moritz_kellerhoven': 'Moritz Kellerhoven',
    'nathaniel_jocelyn': 'Nathaniel Jocelyn', 'nikolai_alexandrowitsch_jaroschenko': 'Nikolai Yaroshenko', 'nils_johan_olsson_blommer': 'Nils Blommér',
    'paolo_veronese': 'Paolo Veronese', 'parmigianino': 'Parmigianino', 'paul_cesar_helleu': 'Paul César Helleu', 'regnault_henri': 'Henri Regnault',
    'richard_bergh': 'Richard Bergh', 'robert_dampier': 'Robert Dampier', 'robert_lefevre': 'Robert Lefèvre', 'robert_leopold': 'Léopold Robert',
    'sichel_nathanael': 'Nathanael Sichel', 'svetoslav_roerich': 'Svetoslav Roerich', 'velazquez_diego': 'Diego Velázquez',
    'viktor_vasnetsov': 'Viktor Vasnetsov', 'william-adolphe_bouguereau': 'William-Adolphe Bouguereau',
}
# In the pack's own (sorted) order: a title, and extra search words.
PD_TITLES = [
    ('Old man with a white beard and turban', 'sage wizard scholar'), ('Noblewoman with pearls', 'noble renaissance'),
    ('Noblewoman in a jewelled collar', 'noble renaissance'), ('Woman with a gold circlet', 'princess priestess'),
    ('Girl in a red headscarf', 'peasant'), ('Archbishop in a black hat', 'priest cleric bearded'), ('Woman in a fur cape', ''),
    ('Young woman with braids', 'peasant'), ('Woman in a blue veil', 'nun priestess'), ('Soldier in a steel helmet', 'guard conquistador'),
    ('Woman with a gold headdress', 'queen noble'), ('Woman in a white head wrap', ''), ('Pale young woman', ''),
    ('Young woman with gold earrings', ''), ('Smiling young woman', ''), ('Woman with red curls', 'redhead'),
    ('Red-haired maiden', 'redhead elf'), ('Red-haired woman with a necklace', 'redhead noble'), ('Man in a red beret', 'artist moustache'),
    ('Woman in a gold head cloth', ''), ('Gentleman with a ruff', 'noble bearded'), ('Lady with a jewelled headband', 'redhead noble'),
    ('Knight in armour', 'helmet soldier'), ('Young woman with dark curls', ''), ('Woman with a coin headdress', 'dancer'),
    ('Bedouin chief', 'desert nomad bearded man'), ('Old man in a black cap', 'scholar bearded'), ('Young woman with a fringe', ''),
    ('Woman in a black veil', 'widow'), ('Hooded monk', 'priest cleric hood'), ('Brooding young man', ''), ('Fair-haired girl', ''),
    ('Young woman looking aside', ''), ('Officer with a moustache', 'noble uniform'), ('Old woman with white hair', 'grandmother'),
    ('Woman in profile with pearls', 'noble'), ('Girl with a jewelled circlet', 'princess'), ('Woman with a rose in her hair', ''),
    ('Old man in a turban', 'merchant'), ('Doge in a red cap', 'old man noble bearded'), ('Lady in a Tudor headdress', 'noble queen'),
    ('Man in a striped turban', 'merchant bearded'), ('Young woman with earrings', ''), ('Scowling old man in a green hat', 'bearded dwarf'),
    ('Smiling girl', ''), ('Girl in a patterned headscarf', ''), ('Woman with braided hair', ''), ('Woman in a white veil', ''),
    ('Man in a beaded headdress', 'chieftain'), ('Old man with a long white beard', 'wizard sage'), ('Young man in a white turban', ''),
    ('Woman with a leaf crown', 'druid'), ('Woman with a flower crown', 'druid'), ('Woman with dark curls', ''),
    ('Old man with white hair', 'scholar'), ('Man in shadow', ''), ('Woman with curly hair', ''), ('Dark-haired woman', ''),
    ('Girl with white flowers', ''), ('Young woman in a turban', ''), ('Young woman with brown hair', ''), ('Woman in a headscarf', ''),
    ('Woman with a red flower', 'dancer'), ('Short-haired young woman', ''), ('Gentleman in a brown coat', 'noble'),
    ('Young man against a sky', ''), ('Old man with a grey beard', 'bearded'), ('Bearded man', ''), ('Man in a grey turban', ''),
    ('Renaissance lady', 'noble'), ('Red-haired girl', 'redhead'), ('Man in a head wrap', ''), ('Grey-haired man with a moustache', ''),
    ('Bearded young man', ''), ('Girl with a flower circlet', ''), ('Woman with a red veil', ''), ('Dark-haired lady', ''),
    ('Woman in a jewelled headdress', 'queen'), ('Woman with a dark bob', ''), ('Lady in black', 'noble'),
    ('Warrior in a pointed helmet', 'knight soldier bearded viking'), ('Girl in a red headscarf', 'peasant'),
]
with open(fetch('pd-portraits-200x200.7z'), 'rb') as f:
    import py7zr
    tmp = os.path.join(DL, 'pd-portraits')
    if not os.path.isdir(tmp):
        py7zr.SevenZipFile(f).extractall(tmp)
pd_dir = os.path.join(tmp, 'pd-portraits-200x200')
pd_files = sorted(n for n in os.listdir(pd_dir) if n.endswith('.png'))
assert len(pd_files) == len(PD_TITLES), (len(pd_files), len(PD_TITLES))
for n, (title, extra) in zip(pd_files, PD_TITLES):
    stem = n[:-4]
    painter = PAINTERS[re.sub(r'\d+$', '', stem)]
    lic = open(os.path.join(pd_dir, stem + '.license'), encoding='utf-8').read()
    assert 'public domain' in lic, n
    src = re.search(r'Source:\s*(\S+)', lic).group(1).replace('http://', 'https://').replace('/wiki/Image:', '/wiki/File:')
    add('pd-' + stem.replace('_', '-'), Image.open(os.path.join(pd_dir, n)), title,
        f'{PEOPLE} painting historical {gender_words(title)} {extra} {title} {painter}', painter, src, 'cc0', '',
        "qubodup's Public Domain Portraits", 'public-domain-portraits', max_side=256)

# --- 30 painted portraits (farrer, CC0): faces from Diego Velázquez's paintings ------------------------------------
tar = fetch('velazquez_portraits.tar.bz2')
with tarfile.open(tar) as t:
    for m in sorted(t.getmembers(), key=lambda m: m.name):
        if not m.name.endswith('.png'):
            continue
        stem = os.path.basename(m.name)[:-4]                 # male_01, female_child_02…
        kind, num = stem.rsplit('_', 1)
        label = {'male': 'Man', 'female': 'Woman', 'male_child': 'Boy', 'female_child': 'Girl'}[kind]
        title = f'{label} {int(num)}, after Velázquez'
        add('velazquez-' + stem.replace('_', '-'), Image.open(io.BytesIO(t.extractfile(m).read())), title,
            f'{PEOPLE} painting historical baroque spanish noble {gender_words(label)} {title}', 'Diego Velázquez (cropped by farrer)',
            OGA + '/users/farrer', 'cc0', '', '30 painted portraits', '30-painted-portraits', max_side=256)

# --- Cyberpunk portraits (Hyptosis, CC0): three sheets of eight 96-pixel faces, doubled ---------------------------
CYBER = [
    ['Red-haired woman', 'Man with braids', 'Bald cyborg with a beard', 'Woman with earrings',
     'Woman with shaved sides', 'Soldier in a power-armour helmet', 'Red-haired scavenger', 'Woman with red curls'],
    ['Grinning gunslinger in a hat', 'Punk woman with a tattoo', 'Mohawked mechanic', 'Raider in a gas mask',
     'Armoured trooper with a ponytail', 'Pilot in a flight helmet', 'Cyborg with a skull face', 'Alien with blue face paint'],
    ['Bearded mercenary in armour', 'Bald brute with tattoos', 'Nomad with a bandana', 'Cyborg with a pistol',
     'Rock golem', 'Zombie mutant', 'Rat-faced mutant', 'Green-skinned mutant with a topknot'],
]
with zipfile.ZipFile(fetch('cyber_copperhill.zip')) as z:
    for s, titles in enumerate(CYBER, 1):
        sheet = Image.open(io.BytesIO(z.read(f'Cyber_Faces_00{s}.png'))).convert('RGBA')
        for i, title in enumerate(titles):
            face = sheet.crop(((i % 4) * 96, (i // 4) * 96, (i % 4) * 96 + 96, (i // 4) * 96 + 96)).resize((192, 192), Image.LANCZOS)
            add(f'cyber-{s}-{i + 1}', face, title, f'{PEOPLE} cyberpunk scifi sci-fi science fiction future modern post-apocalyptic {gender_words(title)} {title}',
                'Hyptosis', OGA + '/users/hyptosis', 'cc0', '', 'Cyberpunk portraits', 'cyberpunk-portraits')

# --- Creatures --------------------------------------------------------------------------------------------------
with zipfile.ZipFile(fetch('paintedbattlers.zip')) as z:
    for n, title, words in [
        ('Alraune', 'Alraune, a flower monster', 'plant flower mandrake'),
        ('Aquapredateur', 'Aquaprédateur, a sea predator', 'fish sea water aquatic shark'),
        ('Fiellangue', 'Fiellangue, a lightning serpent', 'snake serpent lightning naga'),
        ('Mob-Artwork', 'One-eyed crawler', 'cyclops eye spider aberration'),
        ('Quadrapen-Artwork', 'Quadrapen, a fire beast', 'fire flame elemental demon'),
        ('Terradaemon-artwork', 'Terradaemon, a three-headed beast', 'hydra three heads demon earth'),
        ('Tortue Cyclope', 'Cyclops turtle', 'turtle stone golem eye'),
        ('chevalier-atwork', 'Dark chevalier', 'knight armour armor death warrior undead'),
    ]:
        add('battler-' + re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-'), Image.open(io.BytesIO(z.read(f'paintedbattlers/{n}.png'))), title,
            f'creature monster beast enemy fantasy {words} {title}', 'gilgaphoenixignis', OGA + '/users/gilgaphoenixignis', 'by', '4.0',
            'Painted battlers pack', 'painted-battlers-pack')
for f, id_, title, words in [
    ('demon_portrait_full_-_red_0.png', 'pauliuw-demon', 'Red demon', 'demon devil fiend horns tiefling'),
    ('orc_portrait_full_-_green_0.png', 'pauliuw-orc', 'Orc', 'orc goblin brute green'),
    ('alien_portrait_full_green.png', 'pauliuw-alien', 'Green alien', 'alien scifi sci-fi science fiction space'),
]:
    pack = {'pauliuw-demon': ('Demon Portrait', 'demon-portrait'), 'pauliuw-orc': ('Orc Portrait', 'orc-portrait'),
            'pauliuw-alien': ('Alien Portrait', 'alien-portrait')}[id_]
    add(id_, Image.open(fetch(f)), title, f'portrait face creature monster {words} {title}', 'pauliuw', OGA + '/users/pauliuw',
        'cc0', '', *pack)
add('pocok-dragon', Image.open(fetch('02_0.png')), 'Dragon', 'portrait face creature monster dragon wyrm reptile drake fantasy',
    'pocok', OGA + '/users/pocok', 'by', '3.0', 'Dragon Portrait', 'dragon-portrait')

with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
    json.dump({'source': 'OpenGameArt.org', 'built_by': 'tools/opengameart-build.py', 'items': items}, f, ensure_ascii=False, indent=0)
with open(os.path.join(OUT, 'README.md'), 'w', encoding='utf-8') as f:
    f.write('# Game art from OpenGameArt.org\n\nPictures for Find Image\'s Game art source, built by `tools/opengameart-build.py`. '
            'Each is CC0 or CC BY; `index.json` gives every picture\'s artist, licence and the OpenGameArt page it came from, '
            'and a picture copied into a campaign keeps that credit.\n')
print(len(items), 'pictures,', sum(os.path.getsize(os.path.join(OUT, i['file'])) for i in items) // 1024, 'KB')
