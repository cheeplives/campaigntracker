/* generators.js — the Generators tab's random tables: character names by genre and people, tavern and inn names,
 * company names and whole towns.
 *
 * Plain script, no build step, no server: every word list, syllable table and template below was written for this
 * app. Nothing is copied from other generators. app.js draws the tab and can save a result to the Encyclopedia; this
 * file only makes text. Gen.seed(n) makes the rolls repeatable (the tests use it); Gen.seed() goes back to random.
 *
 * Genres: fantasy, scifi, cyberpunk, modern, western. Each generator returns plain objects:
 *   name()    -> { name }
 *   tavern()  -> { name, note }
 *   company() -> { name, note }
 *   town()    -> { name, kind, population, facts: [[label, text]], places: [{ name, note }], people: [{ name, note }], hooks: [] } */
'use strict';

const Gen = (() => {
  // ------------------------------------------------------------ dice
  let rnd = Math.random;
  /** mulberry32: a small seeded generator, so a seed gives the same rolls in every browser. */
  function seed(n) {
    if (n === undefined || n === null) { rnd = Math.random; return; }
    let a = n >>> 0;
    rnd = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = list => list[Math.floor(rnd() * list.length)];
  const chance = p => rnd() < p;
  const roll = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  /** n different items of list, in random order. */
  const take = (list, n) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
  /** A space-separated list, so the tables below stay compact. Multi-word items use underscores. */
  const w = s => s.trim().split(/\s+/).map(x => x.replace(/_/g, ' '));
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  /** Join syllables, then smooth the seams: no letter three times running, no doubled apostrophe. */
  const glue = (...parts) => cap(parts.join('').toLowerCase().replace(/(.)\1\1+/g, '$1$1').replace(/''+/g, "'"));
  /** n different results from fn (gives up on duplicates after a few tries, for small tables). */
  function many(n, fn) {
    const out = [], seen = new Set();
    for (let tries = 0; out.length < n && tries < n * 8; tries++) {
      const r = fn();
      if (seen.has(r.name)) continue;
      seen.add(r.name); out.push(r);
    }
    return out;
  }

  const GENRES = [['fantasy', 'Fantasy'], ['scifi', 'Science fiction'], ['cyberpunk', 'Cyberpunk'], ['modern', 'Modern day'], ['western', 'Wild West']];

  // ------------------------------------------------------------ names
  // Each people has its own sound: a few syllable tables (start, middle, masculine and feminine endings) or a list of
  // given names, and a way of making family names. gender: 'm', 'f' or '' for either.
  const SYL = {
    human: { a: w('Al Ber Cor Ed Gar Hal Os Ran Wil Ald Bran Dun Ger Leo Mar Tor Ul Wen Ced Har God Eth Rod Sig Wal Mer Bea Ros Is Ma'),
      m: w('ric win bert mund wald ard an ulf ger old red frith helm stan wick'), f: w('a wyn hild eth ina ris elle gyth lin ena ith mild ra ia'), n: w('en is ery el ith ley wen an ly'),
      s: w('Ash Black Brook Cold Fair Green Hart Hollow Iron Marsh Oak Red Stone Thorn White Wolf Ward Mill Hay Wy Brad Lang Under Wether'),
      t: w('field ford wood well more ley ton by wick hurst brook ridge stone combe ham worth'),
      trades: w('Cooper Fletcher Thatcher Mason Chandler Tanner Carter Fowler Webb Salter Turner Sawyer Barker Glover Potter Fuller Brewer Roper Weaver Shepherd') },
    elf: { a: w('Ae Ca Ela Fi Gal Ili Lae Mi Nae Ri Sae Tha Vae Yl Ere Ithi Lu Sy Aru Cel Fae Isi Nil Ola Qui Vel'),
      b: w('la ri the ve si lo na ra e lia ndi ae ri sa'), m: w('dor thil ran rion vel las wyn ndir th aen ril sar'),
      f: w('wen thiel la riel ra wyn sa nae lise ien dra ssa'), n: w('ae ir ian is el yn eth or ven'),
      s: w('Silver Moon Star Dawn Dusk Leaf Mist Song Wind Thorn Willow Sun Frost Bright Glimmer'),
      t: w('bough whisper glade shade water petal bloom river wing brook spire veil'),
      house: w('Aelindor Caelthir Ilivane Nethrael Saevaris Thalorien Vaelith Yllomir Erethiel Quiloran Faelinde Sylvarin') },
    dwarf: { a: w('Bal Bor Dur Grim Kaz Thra Brun Dag Hur Mor Rag Ulf Vond Gor Thal Bof Dva Ok Fen Har Kil Nor Rur Stor'),
      m: w('in ek ar grim dok rak und ur orn ik ald unn bur'), f: w('a ra hild dis ga run da nna ris li va'), n: w('i ri al un is el ka'),
      s: w('Stone Iron Granite Anvil Coal Deep Flint Hammer Copper Ember Gold Rock Slate Bronze Forge Ore Silver'),
      t: w('beard hand fist delver shield brow forge mantle heart helm axe vein mail bellow') },
    halfling: { a: w('Bram Cob Dod Fen Hob Lin Mil Nob Per Tam Wil Ad Bel Cal Dar Gil Hal Lob Mer Rob Sam Tod'),
      m: w('o by kin well rick wise ble ard ert fast an lo'), f: w('ella ie idy wen ry isa ina belle lily o etta'), n: w('y ie by kin ly o well'),
      s: w('Bramble Burrow Butter Clover Honey Kettle Meadow Puddle Tumble Under Apple Thistle Mossy Barley Hazel Pepper Sweet'),
      t: w('foot hill bottle leaf bank brook hedge dale bun cake tree wick top root') },
    orc: { a: w('Brak Drog Gruk Hrak Kor Mog Narz Ruk Shak Thrug Ug Vrak Zug Gash Murz Ozg Bul Grot Krag Lug Skar Urg Yaz'),
      m: w('ash dak gul nak rok ul za gra ok uk dush mak'), f: w('a ka ra sha zha gra uka ash ga lka'), n: w('ug az ak urz ash og'),
      epi: w('Skull-Splitter Bone-Chewer Iron-Tusk One-Ear Blood-Eye Gut-Ripper Wolf-Rider Stone-Fist Ash-Walker Black-Tongue Rot-Tooth Scar-Back Dirt-Eater Fire-Belly Ghost-Killer Head-Taker'),
      clan: w('Broken_Tusk Red_Hand Bleeding_Moon Black_Teeth Burnt_Hill Splintered_Shield Howling_Pit Gnawed_Bone Rusted_Blade Grey_Ash') },
    gnome: { a: w('Bim Dil Fizz Gim Nim Pip Wiz Zan Quib Orl Bel Dab Erk Fon Glim Jeb Lum Nack Pol Rib Sni Tib Wob'),
      m: w('ble wick nock bin dle ry fen pet bert lo mo nik'), f: w('ella i ina bell ly ra wyn sie nella ette ka'), n: w('i bit ly zz pip le wick'),
      s: w('Cog Gear Spark Copper Glitter Fizz Whistle Sprocket Bolt Tumble Puzzle Brass Gizmo Thimble Kettle'),
      t: w('wheel spindle bottom button whistle top nose pocket wiggle tock bang snap fiddle') },
    insectoid: { a: w("K'th Tch Xik Zz Kri Chi Trr Ixa Skr Vik Qek Thx Kz Rrik Tik"), b: w("a i e ' ix ak et ik"),
      m: w('tharr rik kk ssk tchk ka zt kix'), f: w('tharr rik kk ssk tchk ka zt kix'), n: w('tharr rik kk ssk tchk ka zt kix'), hive: w('Amber Hive Seventh_Brood Glass_Mound Deep_Comb Ninth_Swarm Red_Chitin Silent_Hive Spire_Brood') },
    reptilian: { a: w('Ssa Ras Ish Sev Tsal Vash Ksa Zeh Ash Hiss Sith Tal Ves Zor Rhas Ske'),
      b: w('a e i o ra sa ka ri'), m: w('ssk than riss eth ozz ar ess ith ash rak'), f: w('ssa thi ira esh iss ala eth sha ria'), n: w('ss ess iss ath ia eth'),
      clutch: w('Sun-Warmed Stone Long_Tide Cold_Sand Third_Egg Basking_Rock Red_Mire Deep_Burrow Shed_Skin Burning_Dune') },
    synthetic: { pre: w('ARC DEX HALO ION JUNO KAI LUX MAV NOVA ORO PAX REX SOL TESS VEX ECHO ADA CASS MIRA OTTO'),
      title: w('Archivist Custodian Navigator Steward Auditor Warden Courier Tender Quartermaster Surveyor Pilot Medic'),
      ord: w('Second Third Fourth Fifth Sixth Seventh Ninth Eleventh Twelfth') },
  };
  // Real given names and family names, mixed from many places, for humans in the near and far future.
  const SPACER = { m: w('Arjun Kenji Mateo Tomas Idris Rafael Yusuf Anton Kofi Lev Dmitri Jae Emeka Teo Silas Bram Darius Hiro Joaquin Kwame Nikolai Oskar Ravi Soren Tariq Viktor Wen Zane'),
    f: w('Amara Saoirse Mei Noor Zara Ines Yuki Ada Leila Nadia Priya Sana Thandi Vera Ilse Juno Freya Hana Kalinda Lucia Marisol Oksana Rhea Sigrid Tova Yara Esi Ingrid'),
    n: w('Alex Ash Avery Cam Dakota Eden Indigo Jules Kai Kit Lux Morgan Nova Quinn Remy Riley Rowan Sage Sky Tam Wren Ari Noa Robin Sasha'),
    s: w('Okafor Varga Castellanos Nakamura Lindqvist Adeyemi Petrov Kowalski Haddad Reyes Takeda Osei Novak Chen Kaur Moreau Ibarra Sorensen Abara Mensah Halvorsen Quist Rahman Szabo Tanaka Vasquez Wojcik Yilmaz Zhou Achterberg') };
  // Common given names (masculine, feminine, and n: used for anyone) and family names of each language or region.
  const MODERN = {
    english: { m: w('James Ethan Liam Noah Owen Caleb Marcus Daniel Ryan Tyler Henry Jack Luke Simon Grant Neil Adam Cole Wesley Graham Dean Trevor'),
      f: w('Emma Olivia Grace Chloe Hannah Megan Rachel Sarah Laura Claire Jess Abigail Holly Kate Lucy Nora Paige Ruth Tessa Vanessa Fiona Dana'),
      n: w('Alex Avery Casey Charlie Dakota Drew Ellis Emerson Finley Hayden Jamie Jordan Jules Kendall Logan Morgan Parker Quinn Reese Riley Robin Rowan Sam Skyler Taylor'),
      s: w('Walker Hughes Bennett Carter Fletcher Harding Morgan Pearson Reed Sutton Turner Whitaker Lowell Barrett Doyle Ellis Foster Graves Holloway Kendall Mercer Prescott Quinn Sloane') },
    spanish: { m: w('Alejandro Diego Javier Mateo Santiago Rafael Andrés Emilio Joaquín Luis Pablo Ricardo Tomás Héctor Ignacio Marco Óscar Raúl Sergio Víctor'),
      f: w('Lucía Sofía Valentina Camila Isabel Elena Carmen Paula Marisol Inés Gabriela Daniela Rosa Alba Beatriz Julia Lorena Pilar Ximena Adriana'),
      n: w('Alexis Ariel Cruz Guadalupe Noa Paz Rosario Trinidad Sol Reyes'),
      s: w('García Morales Herrera Castillo Vega Navarro Romero Ortega Delgado Ramos Medina Fuentes Guzmán Ibarra Salazar Cortés Aguilar Molina Rojas Serrano') },
    french: { m: w('Antoine Baptiste Bastien Benoît Clément Damien Étienne Fabien Gaspard Guillaume Hugo Julien Laurent Louis Lucien Marcel Mathis Olivier Philippe Quentin Rémi Sébastien Thibault Yves'),
      f: w('Amélie Aurélie Béatrice Céline Chloé Claire Colette Delphine Élodie Émilie Geneviève Hélène Inès Juliette Léa Manon Margaux Mathilde Nathalie Océane Odile Solène Sylvie Agathe'),
      n: w('Camille Claude Dominique Sacha Alix Charlie Lou Eden Céleste Ange Noa Morgan'),
      s: w('Bernard Dubois Durand Fontaine Garnier Girard Lambert Lefèvre Leroy Marchand Mercier Moreau Morel Perrin Roux Rousseau Vincent Fournier Chevalier Blanchard Gauthier Dupont Caron Lacroix') },
    german: { m: w('Lukas Jonas Felix Maximilian Tobias Matthias Stefan Florian Johannes Klaus Dieter Jürgen Wolfgang Rainer Moritz Niklas Sebastian Bernd Uwe Henrik'),
      f: w('Anna Lena Hannah Katharina Johanna Sabine Ursula Petra Monika Greta Ilse Frieda Clara Marlene Heike Birgit Annika Theresa Lotte Svenja'),
      n: w('Kim Luca Robin Toni Sascha Alex Charlie Kai Eike Jo Maxi Ulli'),
      s: w('Becker Hoffmann Schäfer Krüger Richter Wagner Neumann Vogel Lange Fischer Brandt Zimmermann Hartmann Schulte Lorenz Engel Keller Albrecht Winkler Busch') },
    russian: { m: w('Aleksandr Alexei Anatoly Boris Dmitri Fyodor Gennady Grigory Igor Ilya Ivan Kirill Konstantin Leonid Maksim Mikhail Nikolai Oleg Pavel Pyotr Roman Sergei Vadim Viktor Vladimir Yuri'),
      f: w('Alina Anastasia Anna Daria Ekaterina Elena Galina Irina Ksenia Larisa Lyudmila Marina Natalia Nadezhda Oksana Olga Polina Svetlana Tatiana Valentina Vera Yana Yulia Zoya'),
      n: w('Sasha Zhenya Valya Shura Slava Nika'),
      s: w('Ivanov Smirnov Kuznetsov Popov Volkov Sokolov Lebedev Kozlov Novikov Morozov Petrov Orlov Pavlov Fyodorov Mikhailov Belov Tarasov Zaitsev Vinogradov Bogdanov Vorobyov Yegorov Gusev Komarov Medvedev Ilyin') },
    arabic: { m: w('Ahmed Ali Omar Khalid Hassan Hussein Ibrahim Yusuf Karim Tariq Samir Rashid Faisal Hamza Jamal Nabil Walid Ziad Mahmoud Mustafa Bilal Adel Saeed Nasser'),
      f: w('Fatima Aisha Layla Mariam Huda Amira Yasmin Salma Rania Dalia Hala Leila Lina Nadia Samira Zainab Khadija Farah Jamila Rana Sara Zahra Amal Mona'),
      n: w('Noor Iman Salam Wafa Hikmat Ihsan Sabah Nur'),
      s: w('Al-Masri Haddad Khoury Nasser Saleh Hamdan Al-Rashid Mansour Aziz Farouk Hakim Darwish Qasim Suleiman Abboud Najjar Tahan Bakr Hijazi Sabbagh Halabi Al-Amin Shami Khalil Yassin') },
    indian: { m: w('Aarav Arjun Vikram Rohan Rahul Sanjay Anil Amit Deepak Karan Nikhil Pranav Rajesh Ravi Suresh Vivek Aditya Ishaan Kabir Manish Harish Gaurav Siddharth Varun'),
      f: w('Aanya Ananya Priya Pooja Kavya Diya Isha Lakshmi Meera Neha Nisha Riya Sanya Shreya Sunita Divya Anjali Deepika Lata Radha Sita Tara Aditi Rekha'),
      n: w('Kiran Jyoti Ashwini Kanchan Suman Shashi Santosh Gurpreet Harpreet Manpreet Amandeep Navjot Sharan'),
      s: w('Sharma Patel Singh Kumar Gupta Reddy Iyer Nair Rao Mehta Joshi Desai Kapoor Malhotra Banerjee Chatterjee Mukherjee Pillai Menon Bhat Chopra Verma Agarwal Kulkarni Shah') },
    chinese: { m: w('Wei Jun Hao Lei Jie Tao Qiang Bo Yong Gang Jian Peng Kai Long Feng Bin Zhiwei Haoran Yuxuan Zihao Junjie Jianguo Dong Zhen'),
      f: w('Mei Li Na Jing Ying Xia Yan Fang Hui Lan Xiu Ling Yue Qian Jia Ting Hong Xiaoyu Yuting Shuang Lijuan Meiling Ruoxi Xue'),
      n: w('Ming Yu Xin Chen Lin Hua Qing Ning Wen An Le Yi Zihan Yuxi Haiyan'),
      s: w('Wang Li Zhang Liu Chen Yang Huang Zhao Wu Zhou Xu Sun Ma Zhu Hu Guo He Lin Gao Luo Zheng Liang Xie Tang Song Han Feng Deng Cao') },
    japanese: { m: w('Haruto Hiroshi Kenji Takeshi Daiki Sota Yuto Kaito Riku Shota Kazuki Satoshi Yusuke Taro Kenta Naoki Hayato Tatsuya Shin Isamu Kenichi Masato'),
      f: w('Yui Aoi Hina Sakura Mio Rin Haruka Ayaka Emi Kaori Mai Natsuki Saki Yoko Akiko Keiko Megumi Nanami Misaki Chiyo Hanako Asuka Tomoko'),
      n: w('Akira Hikaru Kaoru Makoto Nao Ren Ryo Shinobu Tsubasa Yuki Haru Hinata Sora Izumi Jun Chihiro'),
      s: w('Sato Suzuki Takahashi Tanaka Watanabe Ito Yamamoto Nakamura Kobayashi Kato Yoshida Yamada Sasaki Yamaguchi Matsumoto Inoue Kimura Hayashi Shimizu Mori Ikeda Hashimoto Ishikawa Ogawa Fujita Okada Maeda') },
  };
  const MODERN_KEYS = Object.keys(MODERN);
  // Chinese and Japanese names are written family name first
  const FAMILY_FIRST = new Set(['chinese', 'japanese']);
  const CYBER = { handle: w('Zero Glitch Static Wire Neon Hex Rook Vandal Cipher Ghost Razor Echo Spike Chrome Drift Patch Proxy Hush Byte Jinx Torque Lynx Mantis Volt Nyx Rivet Kilo Sable Vector Wraith'),
    tail: w('wire byte run jack lock kill burn tooth spark dog fox cat lag dust vox') };
  const WEST = { m: w('Amos Eli Silas Jebediah Wyatt Cyrus Ezra Hank Jesse Levi Luther Otis Clayton Virgil Abner Boone Cash Dallas Emmett Gideon Hollis Jasper Thaddeus Wade'),
    f: w('Abigail Clementine Delilah Hattie Josephine Lottie Mae Opal Pearl Ruby Sadie Tillie Ada Beulah Cora Etta Ida Lula Minnie Nell Rosalie Verna Winifred Zelda'),
    s: w('Calloway Dawson Pike McCready Hollister Grimes Whitlock Barlow Cutter Durango Fenwick Garrity Hatch Kincaid Ledbetter Maddox Odell Pruitt Quarles Ruckett Slade Tatum Vance Wheeler Yates'),
    n: w('Billie Frankie Jessie Lee Marion Jo Sam Charlie Ray Dale Clem Tommie Bobbie Ollie'),
    nick: w('Dusty Two-Bit Slim Doc Lucky Red Shorty Deadeye Mad Whiskey Tex Sawbones Snake Ace Calico Cactus Preacher Kid Buckshot Big Three-Finger'), };

  const PEOPLES = {
    fantasy: [['human', 'Human'], ['elf', 'Elf'], ['dwarf', 'Dwarf'], ['halfling', 'Halfling'], ['gnome', 'Gnome'], ['orc', 'Orc']],
    scifi: [['spacer', 'Human spacer'], ['synthetic', 'Synthetic'], ['insectoid', 'Insectoid'], ['reptilian', 'Reptilian']],
    cyberpunk: [['street', 'Street name'], ['handle', 'Netrunner handle'], ['corporate', 'Corporate'], ['ai', 'Rogue AI']],
    modern: [['english', 'English-speaking'], ['spanish', 'Spanish-speaking'], ['french', 'French'], ['german', 'German'], ['russian', 'Russian'], ['arabic', 'Arabic'],
      ['indian', 'Indian'], ['chinese', 'Chinese'], ['japanese', 'Japanese']],
    western: [['settler', 'Settler'], ['outlaw', 'Outlaw'], ['lawman', 'Lawman']],
  };
  /** gender: 'm', 'f', 'n' (a name used for anyone) or '' for any of them, gender-neutral less often. */
  const GENDERS = [['', 'Any'], ['f', 'Feminine'], ['m', 'Masculine'], ['n', 'Gender-neutral']];
  const sex = g => (['m', 'f', 'n'].includes(g) ? g : chance(0.15) ? 'n' : chance(0.5) ? 'm' : 'f');
  /** A given name made from syllables: start + (middle) + ending. */
  const sylName = (t, g, mid = 0) => glue(pick(t.a), chance(mid) ? pick(t.b) : '', pick(t[g]));
  const compound = t => glue(pick(t.s), pick(t.t));
  /** A full name from one of MODERN's cultures, written its own way. */
  function modernName(c, g) {
    const M = MODERN[c];
    let first = pick(M[g]), fam = pick(M.s);
    if (c === 'russian' && g === 'f' && /(ov|ev|yov|in)$/.test(fam)) fam += 'a';
    if (FAMILY_FIRST.has(c)) return `${fam} ${first}`;
    if (c === 'spanish' && chance(0.4)) fam += ` ${pick(M.s.filter(x => x !== fam))}`; // Spanish speakers often carry both family names
    if (c === 'arabic' && g !== 'n' && chance(0.25)) first += ` ${g === 'f' ? 'bint' : 'ibn'} ${pick(M.m)}`;
    return `${first} ${fam}`;
  }
  /** A spacer's or street name: from the far-future mix, or from any modern culture. */
  const spacerName = g => (chance(0.5) ? modernName(pick(MODERN_KEYS), g) : `${pick(SPACER[g])} ${pick(SPACER.s)}${chance(0.15) ? `-${pick(SPACER.s)}` : ''}`);

  /** One person's name. genre and people as in PEOPLES; gender as in GENDERS. */
  function name(genre = 'fantasy', people = '', gender = '') {
    const list = PEOPLES[genre] || PEOPLES.fantasy;
    const p = list.some(([k]) => k === people) ? people : pick(list)[0];
    const g = sex(gender), T = SYL[p];
    if (MODERN[p]) return { name: modernName(p, g) };
    switch (p) {
      case 'human': return { name: `${sylName(T, g)} ${chance(0.35) ? pick(T.trades) : compound(T)}` };
      case 'elf': return { name: `${sylName(T, g, 0.5)} ${chance(0.5) ? compound(T) : pick(T.house)}` };
      case 'dwarf': return { name: chance(0.3) ? `${sylName(T, g)}, ${{ f: 'daughter', m: 'son', n: 'child' }[g]} of ${sylName(T, 'm')}` : `${sylName(T, g)} ${compound(T)}` };
      case 'halfling': return { name: `${sylName(T, g)} ${compound(T)}` };
      case 'gnome': return { name: `${sylName(T, g)}${chance(0.4) ? ` "${pick(T.a)}${pick(T.m)}"` : ''} ${compound(T)}`.replace(/"(\w)/, (m, c) => `"${c.toUpperCase()}`) };
      case 'orc': return { name: chance(0.5) ? `${sylName(T, g)} ${pick(T.epi)}` : `${sylName(T, g)} of the ${pick(T.clan)}` };
      case 'spacer': return { name: spacerName(g) };
      case 'synthetic': return { name: chance(0.5) ? `${pick(T.pre)}-${roll(1, 99)}` : chance(0.5) ? `${cap(pick(T.pre).toLowerCase())} ${roll(2, 9)}` : `${pick(T.ord)} ${pick(T.title)}` };
      case 'insectoid': return { name: `${glue(pick(T.a), pick(T.b), pick(T.m))}${chance(0.4) ? ` of the ${pick(T.hive)}` : ''}` };
      case 'reptilian': return { name: `${sylName(T, g, 0.6)}${chance(0.5) ? ` of the ${pick(T.clutch)} clutch` : ''}` };
      case 'street': return { name: spacerName(g).replace(' ', ` "${pick(CYBER.handle)}" `) };
      case 'handle': {
        const [a, b] = take(CYBER.handle, 2);
        return { name: chance(0.5) ? `${a}${pick(CYBER.tail)}` : `${a} ${b}` };
      }
      case 'corporate': {
        const c = pick(MODERN_KEYS.filter(k => !FAMILY_FIRST.has(k)));
        return { name: `${pick(MODERN[c][g])} ${pick(SPACER.f)[0]}. ${pick(MODERN[c].s)}${chance(0.3) ? `-${pick(SPACER.s)}` : ''}` };
      }
      case 'ai': return { name: pick([() => `${pick(SYL.synthetic.pre)}/${pick(CYBER.handle).toUpperCase()}`, () => `${pick(SYL.synthetic.ord)} ${pick(CYBER.handle)}`,
        () => `${pick(CYBER.handle)}.${pick(['exe', 'sys', 'core', 'mind', 'net'])}`])() };
      case 'settler': return { name: `${pick(WEST[g])} ${pick(WEST.s)}` };
      case 'outlaw': return { name: `"${pick(WEST.nick)}" ${pick(WEST[g])} ${pick(WEST.s)}` };
      case 'lawman': return { name: `${pick(['Marshal', 'Sheriff', 'Deputy', 'Ranger', 'Judge', 'Constable'])} ${pick(WEST[g])} ${pick(WEST.s)}` };
    }
    return { name: sylName(SYL.human, g) };
  }
  /** A given name only, for the people a town or tavern mentions. */
  const personFor = genre => name(genre, genre === 'fantasy' ? pick(['human', 'human', 'human', 'dwarf', 'elf', 'halfling', 'gnome', 'orc']) : genre === 'cyberpunk' ? 'street'
    : genre === 'scifi' ? pick(['spacer', 'spacer', 'spacer', 'synthetic', 'reptilian']) : genre === 'western' ? 'settler' : chance(0.4) ? 'english' : pick(MODERN_KEYS)).name;
  const surnameFor = genre => ({ fantasy: () => chance(0.5) ? pick(SYL.human.trades) : compound(SYL.human), scifi: () => pick(SPACER.s), cyberpunk: () => pick(SPACER.s),
    modern: () => pick(MODERN.english.s), western: () => pick(WEST.s) }[genre] || (() => pick(WEST.s)))();
  const firstFor = genre => ({ fantasy: () => sylName(SYL.human, sex()), western: () => pick(WEST[sex()]), modern: () => pick(MODERN.english[sex()]) }[genre] || (() => pick(SPACER[sex()])))();

  // ------------------------------------------------------------ taverns, inns and pubs
  const TAV = {
    fantasy: { adj: w('Gilded Rusty Drunken Laughing Sleeping Crooked Wandering Silver Black Merry Weary Howling Lucky One-Eyed Golden Broken Jolly Salty Hungry Muddy Thirsty Blind Bold Leaping Grinning Wounded Lost Painted Squinting Toothless Bashful Gallant Restless Tipsy'),
      noun: w('Griffin Stag Boar Kettle Tankard Dragon Goose Wyvern Lantern Barrel Anchor Crown Mermaid Fox Knight Ox Pig Wagon Hound Bishop Swan Hart Sword Cauldron Troll Goblet Hammer Raven Badger Wheel Owl Ferret Mule Pilgrim Jester Harp Plough Bell'),
      thing: w('Rest Head Tail Hoard Tooth Den Eye Folly Hearth Roost Respite Welcome Purse Bargain Retreat Secret'),
      num: w('Two Three Five Seven Nine Twelve'), many: w('Barrels Crowns Ravens Candles Keys Swords Goats Bells Feathers Coins Lanterns Sisters Brothers Kings Hogs'),
      venue: w('Inn Tavern Taproom Alehouse Lodge Hall Brewhouse Hostel'),
      known: w('dark_ale_brewed_in_the_cellar mutton_stew_that_never_runs_out a_bard_who_only_plays_sad_songs dice_games_in_the_back_room honey_mead clean_beds_at_a_fair_price a_haunted_upstairs_room fights_every_market_day its_pickled_eggs a_cat_that_sits_on_the_bar the_best_view_of_the_river quiet_tables_where_no_one_asks_questions an_enormous_fireplace cheap_rooms_and_cheaper_wine a_notice_board_full_of_work_for_sellswords') },
    scifi: { adj: w('Zero-G Red-Shift Last Drifting Broken Dark Hard-Vacuum Lucky Blue Burned-Out Wandering Lonely Second Frozen Quiet Rusty Outbound Sleepless'),
      noun: w('Airlock Nebula Comet Thruster Orbit Quasar Pulsar Rocket Satellite Asteroid Hull Beacon Gantry Hangar Payload Reactor Tether Wormhole Moon Spacer Engineer Starliner'),
      venue: w('Bar Lounge Cantina Galley Mess Canteen Club Bar_&_Grill Saloon Diner'),
      known: w('drinks_mixed_by_an_old_service_droid recycled-water_beer_that_tastes_fine_after_the_second gravity_set_slightly_too_low a_view_straight_down_into_the_gas_giant cards_with_off-shift_dock_workers a_jukebox_older_than_the_station real_meat,_at_a_price fresh_noodles_from_the_hydroponics_deck a_back_booth_where_smugglers_meet a_bartender_who_remembers_every_ship_that_docks a_wall_of_mission_patches') },
    cyberpunk: { adj: w('Neon Chrome Static Electric Velvet Toxic Synthetic Burnt Ghost Glitch Pixel Acid Plastic Midnight Hollow Lucky Dead Rusted Silent Golden'),
      noun: w('Lotus Coffin Halo Circuit Jackal Dragon Kitten Cathedral Pulse Socket Mirror Orchid Tiger Saint Koi Angel Monkey Signal Razor Moth'),
      venue: w('Club Bar Lounge Den Noodle_Bar Arcade Karaoke Bar Capsule_Bar Dive'),
      known: w('a_DJ_who_plays_only_pre-collapse_vinyl synth-sake_and_real_rice_crackers a_no-weapons_policy_enforced_by_a_full-borg_bouncer private_booths_with_jammed_signals braindance_rentals_under_the_counter a_fixer_who_holds_court_every_night cheap_soy_dumplings real_whisky,_if_you_know_to_ask fights_streamed_live_from_the_back_room karaoke_until_the_cops_come') },
    modern: { adj: w('Red White Black Golden Royal Rising Old Crooked Happy Lazy Hungry Jolly Painted Rusty Lucky Noble Wandering Dancing Sleepy Grumpy'),
      noun: w('Lion Fox Swan Hound Bell Plough Ship Anchor Rose Crown Horse Harp Stag Duck Feather Lantern Kettle Goat Otter Heron'),
      venue: w('Pub Bar Tap_House Bar_&_Grill Tavern Inn Brewpub Taproom Lounge Sports_Bar'),
      place: w('Corner Dockside Main_Street Riverside Station Harbour Bridge Market Hilltop Crossroads'),
      known: w('a_rotating_list_of_local_craft_beers trivia_night_on_Tuesdays fish_and_chips the_best_burger_in_town a_quiet_beer_garden live_music_on_weekends a_regular_who_has_sat_on_the_same_stool_for_thirty_years a_pool_table_with_a_famous_lean cheap_pitchers_during_the_game an_owner_who_knows_everyone\'s_business') },
    western: { adj: w('Lucky Golden Dusty Rusty Silver Lonesome Crooked Thirsty Last_Chance Busted Blind Painted Howling Brass Long Lame Proud'),
      noun: w('Horseshoe Spur Nugget Mule Steer Rattler Coyote Buzzard Ace Lantern Pick Saddle Bullet Lasso Wagon Stallion Jackrabbit Spittoon Deuce Garter'),
      many: w('Aces Deuces Jacks Brothers Widows Feathers Bullets Spurs Mules Crows'), num: w('Two Three Four Five Seven'),
      venue: w('Saloon Saloon Hotel House Palace Dance_Hall Bar Hall'),
      known: w('watered-down_whiskey a_piano_nobody_can_tune faro_and_poker_tables_running_all_night rooms_upstairs_by_the_hour a_bullet_hole_in_the_mirror_nobody_explains free_lunch_with_a_beer a_barkeep_with_a_shotgun_under_the_counter a_wanted_poster_wall a_sheriff_who_drinks_for_free cattle_drives_coming_through_every_spring') },
  };
  const TAV_KIND = w('cosy rowdy run-down respectable cramped smoky quiet upmarket notorious busy welcoming shabby');

  /** A tavern, inn, pub or bar for genre, with a line on what it is known for and who runs it. */
  function tavern(genre = 'fantasy') {
    const T = TAV[genre] || TAV.fantasy;
    const forms = {
      fantasy: [() => `The ${pick(T.adj)} ${pick(T.noun)}`, () => `The ${pick(T.adj)} ${pick(T.noun)}`, () => `The ${pick(T.noun)} and ${pick(T.noun)}`,
        () => `The ${pick(T.noun)}'s ${pick(T.thing)}`, () => `${firstFor('fantasy')}'s ${pick(T.venue)}`, () => `The ${pick(T.num)} ${pick(T.many)}`,
        () => `The ${pick(T.adj)} ${pick(T.noun)} ${pick(T.venue)}`],
      scifi: [() => `The ${pick(T.adj)} ${pick(T.noun)}`, () => `${pick(T.noun)} ${pick(T.venue)}`, () => `The ${pick(T.adj)} ${pick(T.noun)} ${pick(T.venue)}`,
        () => `Deck ${roll(2, 40)} ${pick(T.venue)}`, () => `${firstFor('scifi')}'s Last Stop`, () => `The ${pick(T.noun)} & ${pick(T.noun)}`],
      cyberpunk: [() => `${pick(T.adj)} ${pick(T.noun)}`, () => `The ${pick(T.adj)} ${pick(T.noun)} ${pick(T.venue)}`, () => `Club ${pick(T.noun)}`,
        () => `${pick([404, 808, 99, 2077, 13, 47, 1999, 6])} ${pick(T.venue)}`, () => `${pick(T.noun)}${pick(['house', 'land', 'pit', 'box', 'hole'])}`],
      modern: [() => `The ${pick(T.adj)} ${pick(T.noun)}`, () => `The ${pick(T.noun)} & ${pick(T.noun)}`, () => `${surnameFor('modern')}'s ${pick(T.venue)}`,
        () => `${pick(T.place)} ${pick(T.venue)}`, () => `The ${pick(T.adj)} ${pick(T.noun)}`],
      western: [() => `The ${pick(T.adj)} ${pick(T.noun)} ${pick(T.venue)}`, () => `${surnameFor('western')}'s ${pick(T.venue)}`, () => `The ${pick(T.num)} ${pick(T.many)}`,
        () => `The ${pick(T.adj)} ${pick(T.noun)}`, () => `The ${pick(T.noun)} & ${pick(T.noun)} ${pick(T.venue)}`],
    }[genre] || [];
    let n = pick(forms)();
    n = n.replace(/\b(\w+) and \1\b|\b(\w+) & \2\b/, m => m.split(/ (?:and|&) /)[0]); // no "Fox and Fox"
    const kind = pick(TAV_KIND);
    return { name: n, note: `${/^[aeiou]/i.test(kind) ? 'An' : 'A'} ${kind} place known for ${pick(T.known)}. Run by ${personFor(genre)}.` };
  }

  // ------------------------------------------------------------ companies
  const SECTORS = [['', 'Any line of business'], ['finance', 'Banking & finance'], ['transport', 'Shipping & transport'], ['mining', 'Mining & resources'],
    ['tech', 'Technology & invention'], ['arms', 'Arms & security'], ['medicine', 'Medicine & healing'], ['food', 'Food & drink'], ['building', 'Building & trades'], ['media', 'News & entertainment']];
  // For each sector: words to coin names from, what an old-style firm calls itself, and what a modern one does
  const SECTOR = {
    finance: { word: w('Sterling Ledger Crown Vault Coin Mint Ducat Trust Bullion Strongbox'), old: w('Bank Counting_House Moneylenders Exchange Trust'), new: w('Capital Financial Bancorp Holdings Asset_Management Credit Trust Investments'), guild: 'Moneychangers' },
    transport: { word: w('Meridian Tide Compass Wayfarer Courier Harbor Keel Horizon Caravan Drift'), old: w('Shipping_Company Carriers Freight_Company Haulage Packet_Company Caravan_Company'), new: w('Logistics Freight Lines Transit Shipping Express Haulage Orbital_Lines'), guild: 'Carters' },
    mining: { word: w('Deepvein Lode Ore Quarry Bedrock Cobalt Flint Ironside Basalt Seam'), old: w('Mining_Company Delvers Quarrymen Ironworks Smelting_Company'), new: w('Mining Resources Extraction Minerals Metals Energy Drilling'), guild: 'Miners' },
    tech: { word: w('Quanta Vector Lumen Axiom Cog Helix Spark Nexus Prism Circuit'), old: w('Clockworks Instrument_Makers Engine_Works Mechanicals Invention_Company'), new: w('Systems Technologies Dynamics Labs Robotics Computing Cybernetics Devices'), guild: 'Clockmakers' },
    arms: { word: w('Bastion Aegis Bulwark Iron Sentinel Halberd Rampart Talon Vanguard Warden'), old: w('Free_Company Armoury Sellswords Foundry Arms_Company'), new: w('Defense Security Armaments Tactical Arms Protection Solutions'), guild: 'Armourers' },
    medicine: { word: w('Remedy Willow Caduceus Salve Vita Panacea Lotus Balm Aster Mercy'), old: w('Apothecaries Physick_House Herbalists Infirmary Remedy_Company'), new: w('Pharma Biotech Health Medical Life_Sciences Therapeutics Genomics'), guild: 'Apothecaries' },
    food: { word: w('Harvest Orchard Hearth Golden_Grain Meadow Barley Saltwater Honeycomb Larder Vintage'), old: w('Brewers Vintners Victuallers Millers Provisioners Bakehouse'), new: w('Foods Brands Farms Beverages Provisions Kitchens Agritech'), guild: 'Brewers' },
    building: { word: w('Keystone Cornerstone Mortar Timber Granite Arch Beam Plumbline Trowel Spire'), old: w('Masons Builders Joiners Wrights Construction_Company'), new: w('Construction Builders Engineering Development Infrastructure Contractors'), guild: 'Masons' },
    media: { word: w('Herald Beacon Clarion Echo Spotlight Lantern Chronicle Signal Marquee Muse'), old: w('Players Printing_House Broadsheet Theatre_Company Gazette'), new: w('Media Broadcasting Entertainment Studios Networks Pictures Interactive'), guild: 'Players' },
  };
  const COIN = { a: w('Ver Ax Nex Cor Hel Lum Quant Syn Tri Om Zen Kai Vel Orb Astr Nov Prax Tel Vant Gen Kry Ard Mer Sol Tyr Ion Zar Cal'),
    b: w('ion ex a ix ora us ent iq on ara yx ium is ant ova ica eon') };
  const ABSTRACT = w('Apex Meridian Summit Keystone Pinnacle Horizon Vanguard Beacon Cobalt Crescent Harbor Northstar Ironclad Bluewater Redline Silverline Halcyon Obsidian Evergreen Paragon Zenith Granite Cardinal Polaris');
  const CORP = { modern: w('Inc. Group Holdings LLC &_Co. Partners Ltd. International'), scifi: w('Dynamics Interstellar Consolidated Orbital Heavy_Industries Combine Collective Conglomerate'),
    cyberpunk: w('Corporation Corp. Megasystems Holdings Group Zaibatsu Industries Biotech') };

  /** A company, guild or firm for genre; sector is one of SECTORS' keys ('' for any). */
  function company(genre = 'modern', sector = '') {
    const sk = SECTOR[sector] ? sector : pick(Object.keys(SECTOR));
    const S = SECTOR[sk], label = SECTORS.find(([k]) => k === sk)[1];
    const coined = () => glue(pick(COIN.a), pick(COIN.b));
    let n, note = label;
    if (genre === 'fantasy') {
      n = pick([() => `The ${pick(TOWN.fantasy.a)}${pick(TOWN.fantasy.b)} ${pick(S.old)}`, () => `${surnameFor('fantasy')} & ${surnameFor('fantasy')}, ${pick(S.old)}`,
        () => `House ${surnameFor('fantasy')}`, () => `The Worshipful Guild of ${S.guild}`, () => `The ${pick(TAV.fantasy.adj)} ${pick(TAV.fantasy.noun)} ${sk === 'arms' ? 'Company' : pick(S.old)}`,
        () => `${surnameFor('fantasy')} Brothers' ${pick(S.old)}`])();
      if (n.startsWith('House ')) note = `${label}: a merchant house`;
    } else if (genre === 'western') {
      n = pick([() => `${surnameFor('western')} & ${surnameFor('western')} ${pick(S.old)}`, () => `${townName('western')} ${pick(S.old)}`,
        () => `${surnameFor('western')} Brothers ${pick(S.old)}`, () => `The ${pick(ABSTRACT)} ${pick(S.old)}`])();
    } else {
      const sfx = CORP[genre] || CORP.modern;
      const forms = [() => `${coined()} ${pick(sfx)}`, () => `${coined()} ${pick(S.new)}`, () => `${pick(ABSTRACT)} ${pick(S.new)}`, () => `${pick(S.word)} ${pick(S.new)}`,
        () => `${surnameFor(genre)} ${pick(['&', '+', '-'])} ${surnameFor(genre)} ${pick(sfx)}`.replace(' - ', '-'),
        () => { const ws = [pick(ABSTRACT), pick(S.word), pick(S.new)]; note = `${label}. Short for ${ws.join(' ')}`; return `${ws.map(x => x[0]).join('')} ${pick(sfx)}`; }];
      if (genre === 'cyberpunk') forms.push(() => `${surnameFor(genre)}-${coined()} ${pick(sfx)}`);
      if (genre === 'scifi') forms.push(() => `${pick(ABSTRACT)} ${pick(['Orbital', 'Stellar', 'Void', 'Deep_Space', 'Colonial']).replace('_', ' ')} ${pick(S.new)}`);
      n = pick(forms)();
    }
    return { name: n.replace(/\s+/g, ' ').replace(/\b(\w+) & \1\b/, '$1'), note };
  }

  // ------------------------------------------------------------ towns
  const TOWN = {
    fantasy: { a: w('Ash Bram Cold Elder Fox Gold Hart Iron Kings Mill North Oak Raven Salt Stone Thorn Wolf Wych Black Bright Deep Mere Grey Hazel Crow Dun Thistle Wey Briar Lark'),
      b: w('ford bury wick holm stead ham dale mere moor haven bridge fall gate hollow march reach watch crag by thorpe stow well fold barrow'),
      two: [() => `${pick(['Saint', 'Old', 'Low', 'High', 'East', 'West', 'Little', 'Market'])} ${glue(pick(TOWN.fantasy.a), pick(TOWN.fantasy.b))}`, () => `${sylName(SYL.human, 'm')}'s ${pick(w('Rest Crossing Folly Hold Landing Mill Watch'))}`] },
    scifi: { a: w('Kepler Arden Tycho Vesta Halley Cassini Ceres Lyra Orion Proxima Rhea Talos Juno Kestrel Meridian Elara Corvus Hydra Solace Bastion Haven Perseus'),
      b: w('Station Colony Prime Outpost Landing Reach Deep Hab Point Anchorage Ring Spire'), two: [() => `New ${pick(w('Lisbon Kyoto Lagos Odessa Quito Adelaide Bergen Cairo Dakar Havana Mumbai Oslo Seoul Tijuana'))}`,
        () => `${pick(w('Alpha Beta Gamma Delta Epsilon Theta Kappa Sigma Tau Omega'))} ${pick(w('Base Platform Outpost Depot Relay'))} ${roll(2, 19)}`] },
    cyberpunk: { a: w('Rust Neon Glass Ash Coil Slag Static Chrome Smog Iron Copper Acid Lantern Paper Signal Ghost Market Harbor Tower Canal'),
      b: w('water town side gate stack works yard field'), c: w('Heights Flats Stacks Blocks Sprawl Arcology Underside Docks Strip Gardens Spires Pits Terraces Quarter'),
      two: [() => `${pick(TOWN.cyberpunk.a)}${pick(TOWN.cyberpunk.b)} ${pick(TOWN.cyberpunk.c)}`, () => `${pick(TOWN.cyberpunk.a)} ${pick(TOWN.cyberpunk.c)}`,
        () => `${surnameFor('cyberpunk')} ${pick(['Arcology', 'Towers', 'Plaza', 'Estates'])}`, () => `Sector ${roll(3, 99)}`] },
    modern: { a: w('Ash Bel Clay Fair Glen Green Hill Lake Maple Oak Pine River Spring Wood Brook Cedar Elm Fox Mill Stone Silver Ridge Clear Haw Win'),
      b: w('ton ville field dale wood port view ford burg side mont crest bury haven land'),
      two: [() => `${pick(w('Cedar Pine Twin Eagle Clear Rock Cold Elk Willow Bear Silver Grand'))} ${pick(w('Falls Springs Creek Lake Hollow Rapids Bluff Harbor Point Valley Ridge'))}`,
        () => `Port ${surnameFor('modern')}`, () => `${surnameFor('modern')}ville`, () => `North ${glue(pick(TOWN.modern.a), pick(TOWN.modern.b))}`] },
    western: { a: w('Copper Dead_Mule Silver Rattlesnake Dry Bitter Whiskey Lone_Pine Buzzard Red_Rock Sundown Tombstone Gold Coyote Broken_Wheel Hangman\'s Dust Mesa Bone Sulphur Jackrabbit Cottonwood'),
      b: w('Creek Gulch Springs Flats Wells Bend Butte Canyon Junction Ridge Hollow Crossing Bluff'),
      two: [() => `${surnameFor('western')}'s ${pick(w('Crossing Station Well Ferry Landing Rest'))}`, () => `Fort ${surnameFor('western')}`, () => `${surnameFor('western')}ville`] },
  };
  /** A place name for genre. */
  function townName(genre = 'fantasy') {
    const T = TOWN[genre] || TOWN.fantasy;
    if (chance(0.3)) return pick(T.two)();
    if (genre === 'fantasy' || genre === 'modern') return glue(pick(T.a), pick(T.b));
    if (genre === 'scifi') return `${pick(T.a)} ${pick(T.b)}`;
    if (genre === 'cyberpunk') return pick(T.two)();
    return `${pick(T.a)} ${pick(T.b)}`;
  }

  // Sizes: [label, lowest and highest population] for small, medium and large places of each genre.
  const SIZES = {
    fantasy: { small: ['Village', 80, 900], medium: ['Market town', 1000, 6000], large: ['City', 8000, 60000] },
    scifi: { small: ['Outpost', 12, 400], medium: ['Colony', 800, 20000], large: ['Orbital city', 50000, 900000] },
    cyberpunk: { small: ['City block', 2000, 15000], medium: ['District', 40000, 250000], large: ['Arcology', 300000, 2000000] },
    modern: { small: ['Village', 200, 3000], medium: ['Town', 5000, 60000], large: ['City', 100000, 3000000] },
    western: { small: ['Mining camp', 30, 300], medium: ['Frontier town', 400, 3000], large: ['Boomtown', 4000, 20000] },
  };
  const SIZE_KEYS = [['', 'Any size'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']];
  const sizeLabel = (genre, k) => (SIZES[genre] || SIZES.fantasy)[k]?.[0];

  // What each genre's towns are like. ruler: who runs it; trade: what pays for it; guard: who keeps order; look: one
  // thing a visitor notices; places: kinds of shop, named after their owners; temple: a name maker for its place of worship; role: people worth meeting; hook:
  // trouble for the party to walk into. {name} in a hook is a person from the town.
  const TRAITS = w('nervous jovial greedy kind-hearted suspicious gossipy proud tired ambitious pious secretive generous hot-tempered absent-minded cheerful grim honest sly superstitious bored brave cowardly curious')
    .concat(['deeply in debt', 'hiding a past', 'new in town', 'far too helpful', 'never smiles', 'always eating', 'missing two fingers', 'collects odd trinkets', 'related to half the town']);
  const LIFE = {
    fantasy: {
      ruler: ['A hereditary lord who rarely leaves the manor', 'A council of guild masters', 'An elected reeve', 'The abbot of the local temple', 'A retired adventurer who bought the charter',
        'Nobody, since the last reeve vanished', 'A merchant prince', 'The baron\'s bailiff', 'An elderly witch everyone pretends is just a herbalist'],
      trade: ['Wool and weaving', 'Fishing', 'A silver mine', 'River trade', 'Orchards and cider', 'Timber', 'A famous horse fair', 'Pilgrims visiting a shrine', 'Salt pans', 'Quarrying', 'Smuggling, unofficially', 'Peat cutting', 'A toll bridge'],
      guard: ['A wooden palisade and a night watch', 'Stone walls in poor repair', 'A keep on the hill', 'A militia of farmers', 'A garrison of crossbows', 'Nothing to speak of', 'A moat and a drawbridge', 'A watchtower with a signal fire'],
      look: ['Built around an ancient standing stone', 'Half the houses stand on stilts above a marsh', 'Every door is painted blue against bad luck', 'A ruined tower looms over the market square',
        'The streets are steep and stepped', 'A huge old oak grows in the middle of the square', 'Bells ring from the temple at every hour', 'Everything smells of fish and smoke', 'The old walls are carved with faces',
        'Goats wander loose on every street'],
      places: ['Smithy', 'Apothecary', 'Bakery', 'Chandlery', 'General store', 'Stables', 'Bookbinder', 'Tannery', 'Mill'],
      temple: () => `${pick(['Shrine', 'Temple', 'Chapel', 'Sanctuary'])} of the ${pick(['Lantern', 'Harvest', 'Twin', 'Silent', 'Weeping', 'Iron', 'Morning', 'Sleeping'])} ${pick(['Mother', 'Father', 'Saint', 'Watcher', 'Star', 'Shepherd', 'Flame', 'Maiden'])}`,
      role: w('Reeve Innkeeper Priest Blacksmith Merchant Guard_captain Healer Hermit Thief Miller Hunter Ferryman Midwife Tax_collector Retired_soldier'),
      hook: ['Wolves have been taking sheep, and the hunters sent after them haven\'t come back', '{name} is offering good coin to anyone who will escort a cart through the woods', 'The well water has turned red overnight',
        'A stranger paid for a room a month ago and hasn\'t been seen leaving it since', 'Graves in the churchyard have been dug up, and nothing taken but the boots', 'The lord\'s heir has run off with a travelling player',
        '{name} swears the standing stone moved last night', 'A tax collector arrived yesterday with far too many guards', 'Children keep finding old coins in the riverbank', 'The bridge is out and the ferryman is charging ten times the usual fare'] },
    scifi: {
      ruler: ['A corporate administrator on a five-year contract', 'An elected colony council', 'The station AI, with a human figurehead', 'A military governor', 'The founding families',
        'A union of dock workers', 'Whoever controls the air plant', 'A religious mission'],
      trade: ['Ice mining', 'Fuel refining', 'A shipyard', 'Hydroponic farming', 'A research lab', 'Rare-earth mining', 'Being the last stop before the frontier', 'Salvage', 'Customs and tolls', 'Tourism to a nearby nebula'],
      guard: ['A handful of security officers with stun batons', 'A corporate security contract', 'An old patrol frigate parked nearby', 'Point-defence turrets', 'Nothing, and everybody knows it', 'A colonial militia'],
      look: ['Every corridor is painted a different colour for navigation', 'The gravity is a little low and everyone walks with a bounce', 'A huge window looks out on a ringed planet', 'The air smells faintly of ozone',
        'Half the station is sealed off after an old accident', 'Gardens grow in every spare corner', 'Prayer flags hang across the main concourse', 'Announcements run in six languages'],
      places: ['Machine shop', 'Clinic', 'Hydroponics bay', 'Parts dealer', 'Customs office', 'Docking bay', 'Data broker', 'Commissary'],
      temple: () => `${pick(['Chapel', 'Meditation deck', 'Shrine'])} of the ${pick(['Long', 'Quiet', 'Endless', 'First', 'Distant'])} ${pick(['Voyage', 'Light', 'Dark', 'Star', 'Return'])}`,
      role: w('Administrator Dockmaster Chief_engineer Medic Smuggler Security_chief Botanist Bartender Scavenger Comms_officer Preacher Ship_broker'),
      hook: ['The air plant is failing and the replacement part is three weeks out', '{name} needs a pilot who won\'t ask what\'s in the crates', 'A ship docked with no crew aboard',
        'Something is living in the ventilation ducts', 'The colony\'s founding charter expires next week, and the corporation wants it back', '{name} has gone missing on a routine EVA',
        'A distress call is coming from a ship that was destroyed ten years ago', 'Quarantine has been declared, and nobody will say why'] },
    cyberpunk: {
      ruler: ['A megacorp\'s private administration', 'A gang that runs everything below street level', 'A crooked city council', 'A residents\' cooperative, barely', 'An AI the corp says isn\'t self-aware', 'Whoever the fixers say does'],
      trade: ['Black-market cyberware', 'Food vats', 'Data havens', 'Container shipping', 'Entertainment and braindance', 'Chip fabrication', 'Organ clinics', 'Scrap and recycling'],
      guard: ['Corporate security drones', 'Underpaid city police', 'Gang patrols', 'A private security firm on a short contract', 'Automated turrets at the checkpoints', 'Nobody you want to call'],
      look: ['Holographic adverts never stop', 'It rains every night, without fail', 'Nobody has seen the sky from the lower levels in years', 'Vending machines on every corner sell everything',
        'Graffiti covers every surface the drones don\'t clean', 'Food stalls fill every alley', 'Power cuts roll through block by block', 'Prayer shrines sit beside the cyberware clinics'],
      places: ['Ripperdoc clinic', 'Noodle stand', 'Pawn shop', 'Data den', 'Gun shop', 'Capsule hotel', 'Pharmacy', 'Chop shop'],
      temple: () => `${pick(['Church', 'Shrine', 'Temple'])} of the ${pick(['Electric', 'Last', 'Sacred', 'Broken', 'Neon'])} ${pick(['Saint', 'Signal', 'Machine', 'Mother', 'Code'])}`,
      role: w('Fixer Ripperdoc Gang_boss Corp_liaison Netrunner Street_doctor Cop_on_the_take Bartender Info_broker Reporter Smuggler Preacher'),
      hook: ['A corp is buying up the block and residents are disappearing', '{name} needs a package moved across town before midnight', 'Someone is selling chips that wipe the user\'s memory',
        'The gang that keeps order here just lost its boss', 'A rogue AI is broadcasting in the clinic\'s systems', '{name} saw something on a security feed and now people are following them',
        'The water supply has been shut off for a week', 'An entire floor of the arcology went silent overnight'] },
    modern: {
      ruler: ['A long-serving mayor', 'A town council that never agrees', 'A city manager nobody elected', 'One wealthy family, in all but name', 'A newly elected reformer'],
      trade: ['Tourism', 'A factory that is cutting jobs', 'Farming', 'A university', 'Fishing', 'Tech start-ups', 'A port', 'Retirees', 'A military base', 'Logging'],
      guard: ['A small police department', 'The county sheriff', 'A big-city police force', 'Private security in the nicer parts', 'One deputy and a dog'],
      look: ['A big water tower with the town\'s name on it', 'Every other shop is closed down', 'The old town square is lined with trees', 'A highway cuts the town in half', 'Murals on every wall',
        'The church spire is the tallest thing for miles', 'A river runs right through the centre', 'Expensive new flats next to old warehouses'],
      places: ['Diner', 'Hardware store', 'Garage', 'Pharmacy', 'Coffee shop', 'Pawn shop', 'Motel', 'Library', 'Grocery'],
      temple: () => `${pick(['St.', 'First', 'Grace', 'Trinity', 'Our Lady of'])} ${pick(['Michael\'s', 'Baptist', 'Methodist', 'Hope', 'the Valley', 'Mercy'])} ${pick(['Church', 'Chapel'])}`,
      role: w('Mayor Sheriff Doctor Shop_owner Reporter Mechanic Teacher Priest Bartender Developer Retired_detective Teenager'),
      hook: ['A developer is buying up houses on one street, and nobody knows why', '{name} has been missing since the county fair', 'Strange lights have been seen over the reservoir',
        'The factory is about to close, and tempers are short', 'A body was found in the river, and the police are calling it an accident', '{name} found something in the attic of an old house',
        'Someone keeps leaving notes on doorsteps', 'The local election has turned nasty'] },
    western: {
      ruler: ['A sheriff who answers to the mine owner', 'A cattle baron', 'An elected mayor nobody takes seriously', 'The railroad company', 'A preacher and his congregation', 'Nobody: it\'s a lawless camp'],
      trade: ['Silver mining', 'Cattle', 'A railroad stop', 'A stagecoach station', 'Gold panning', 'Horse trading', 'Gambling', 'A fort\'s supply depot', 'Timber'],
      guard: ['A sheriff and two deputies', 'A US Marshal passing through', 'The cattle baron\'s hired guns', 'Nothing but a church bell to ring for help', 'A cavalry fort nearby'],
      look: ['One dusty main street and a lot of false fronts', 'The church burned down and was never rebuilt', 'A gallows stands in the middle of town', 'Everything is half-built', 'The railroad tracks end just past town',
        'Tumbleweeds pile up against the boardwalk', 'A dry riverbed runs through town', 'The bank is the only brick building'],
      places: ['General store', 'Blacksmith', 'Livery stable', 'Bank', 'Assay office', 'Undertaker', 'Telegraph office', 'Barber and bathhouse', 'Jail'],
      temple: () => `${pick(['First', 'Little', 'Frontier', 'Mission'])} ${pick(['Baptist', 'Methodist', 'Mission', 'Gospel'])} ${pick(['Church', 'Chapel', 'Meeting House'])}`,
      role: w('Sheriff Barkeep Mine_owner Undertaker Doctor Gambler Preacher Blacksmith Schoolteacher Rancher Prospector Telegraph_operator'),
      hook: ['The stagecoach is three days late', '{name} is offering a reward for a horse thief', 'The mine has struck something that isn\'t silver', 'A gang rode into town and took over the saloon',
        'The railroad wants the ranchers\' land, and won\'t take no for an answer', '{name} claims to have a map to a lost mine', 'The well has dried up and the water is being sold at a price',
        'A man was hanged last week, and now the witness has taken it back'] },
  };
  const roundPop = n => n < 1000 ? Math.round(n / 10) * 10 : n < 100000 ? Math.round(n / 100) * 100 : Math.round(n / 1000) * 1000;

  /** A whole town: name, size, who runs it, trade, defences, a feature, places to visit, people and trouble. size: small, medium, large or ''. */
  function town(genre = 'fantasy', size = '') {
    const g = LIFE[genre] ? genre : 'fantasy', L = LIFE[g];
    const sk = SIZES[g][size] ? size : pick(['small', 'medium', 'medium', 'large']);
    const [kind, lo, hi] = SIZES[g][sk];
    const pop = roundPop(lo + (hi - lo) * rnd() ** 2); // most places sit near the small end of their size
    const nPlaces = { small: 3, medium: 4, large: 5 }[sk], nPeople = { small: 3, medium: 4, large: 5 }[sk];
    const people = take(L.role, nPeople).map(role => ({ name: personFor(g), note: `${role}, ${pick(TRAITS)}` }));
    const owner = () => (g === 'fantasy' || g === 'western' ? firstFor(g) : surnameFor(g));
    const places = [{ name: tavern(g).name, note: g === 'cyberpunk' || g === 'scifi' ? 'Bar' : g === 'western' ? 'Saloon' : g === 'modern' ? 'Bar' : 'Tavern' },
      ...take(L.places, nPlaces - 2).map(k => ({ name: `${owner()}'s ${k}`, note: k })), { name: L.temple(), note: 'Place of worship' }];
    const hooks = take(L.hook, 2).map(h => h.replace('{name}', () => pick(people).name.replace(/^"[^"]*" /, '')));
    return {
      name: townName(g), kind, population: pop,
      facts: [['Ruled by', pick(L.ruler)], ['Trade', pick(L.trade)], ['Defences', pick(L.guard)], ['Notable', pick(L.look)]],
      places, people, hooks,
    };
  }

  return {
    GENRES, PEOPLES, GENDERS, SECTORS, SIZE_KEYS, sizeLabel, seed, many,
    name, tavern, company, town, townName,
  };
})();
