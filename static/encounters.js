/* encounters.js — the Generators tab's encounter cards: a situation already under way, for the GM to drop in.
 *
 * Plain script, no build step, no server. Every template, slot table and word below was written for this app; the
 * tone and shape take their cue from published encounter decks, but no card's text is copied from any of them.
 *
 * A template is one hand-written situation with slots in braces ({locals}, {crossing}, {faction}...). Each genre fills
 * the slots from its own tables, and from the campaign's Encyclopedia when it's given names (cast). A card never lists
 * what the party could do about it: that's the game. It gives who is there, roughly how many, what's going on, one
 * twist, two ways it can escalate if the scene runs on, and one thing worth having.
 *
 *   draw({ genre, where, when, tone, cast, n }) -> [card]   n different cards (3 by default)
 *   reroll(card, part)                         -> card     the same card with a new 'twist', 'esc' or 'gain'
 *   text(card)                                 -> string   the card as plain text, for copying and for notes
 *
 * A card is { title, tone, toneLabel, where, who, many, situation, twist, esc: [two], gain }, plus the template and the
 * slot values it used, kept so a reroll reads the same people and places. Enc.seed(n) makes the draws repeatable. */
'use strict';

const Enc = (() => {
  let rnd = Math.random;
  /** mulberry32, as in generators.js: a seed gives the same draws in every browser. */
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
  const shuffle = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // ------------------------------------------------------------ choices
  /** The genres with encounters so far. More follow, each with its own slot tables and templates. */
  const GENRES = [['apoc', 'Post-apocalypse, grounded']];
  const TONES = [['', 'Any tone'], ['hostile', 'Hostile'], ['tense', 'Tense'], ['neutral', 'Neutral'], ['helpful', 'Helpful'], ['strange', 'Strange']];
  const WHEN = [['', 'Any time'], ['dawn', 'Dawn'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']];
  /** Where an encounter can happen, per genre. A template with no where can happen anywhere. */
  const WHERE = {
    apoc: [['road', 'On the road'], ['wilds', 'In the wilds'], ['ruins', 'In ruins'], ['settlement', 'At a settlement'], ['farm', 'At a farmstead'], ['water', 'By water']],
  };
  /** How many, in words relative to the party, so it suits any rules system. */
  const MANY = { one: 'One', two: 'Two or three', few: 'A few', same: 'About as many as the party', double: 'Twice as many as the party', crowd: 'A crowd' };

  // ------------------------------------------------------------ slots
  // Each genre's words for the slots. Groups are plural and take no article; single things carry their own ("a pickup
  // truck"), and the templates write "the {ruin}" where they need it.
  const SLOTS = {
    apoc: {
      locals: ['hill farmers', 'townsfolk from the next valley', 'a family clan', 'fishers from the lake shore', 'former factory hands', 'a church congregation', 'smallholders from a co-op'],
      raiders: ['road raiders', 'deserters in mismatched uniforms', 'a motorcycle gang', 'bandits', 'scavengers turned raiders', 'a warband from the city'],
      authority: ['the last of a garrison', 'a self-appointed militia', 'a sheriff\'s posse', 'an emergency-government unit', 'security guards with no company left to pay them', 'relief-agency guards'],
      scavengers: ['scrappers', 'a salvage crew', 'looters', 'a family of scavengers', 'tinkers with a handcart'],
      travellers: ['refugees', 'a trading caravan', 'pilgrims', 'families on foot', 'farmhands looking for work', 'a travelling medic and helpers'],
      crossing: ['bridge', 'ford', 'causeway', 'road over the pass', 'tunnel', 'ferry'],
      scarce: ['fuel', 'antibiotics', 'clean water', 'salt', 'ammunition', 'batteries', 'seed grain', 'tinned food', 'tobacco'],
      valuable: ['a working radio', 'a doctor\'s bag', 'a set of truck keys', 'a crate of tinned food', 'a map with caches marked on it', 'a solar panel', 'a box of ammunition', 'a water filter'],
      ruin: ['shopping centre', 'hospital', 'school', 'power station', 'grain silo', 'police station', 'motel', 'office block'],
      shelter: ['an empty barn', 'a roadside church', 'a gutted motel', 'a school gym', 'a farmhouse cellar', 'a highway underpass'],
      beast: ['feral dogs', 'wild hogs', 'a bear', 'a wolf pack', 'rats in their thousands'],
      sickness: ['fever', 'cholera', 'a hacking cough', 'radiation sickness', 'infected wounds', 'dysentery'],
      vehicle: ['a pickup truck', 'an old school bus', 'a fuel tanker', 'a horse-drawn cart', 'a farm tractor', 'an army truck'],
      place: ['Cedar Fork', 'Hollis', 'Red Lake', 'Ash Ridge', 'Pine Hollow', 'Dunmore', 'Kettle Creek', 'New Harmony', 'Fort Mercer', 'Saltmarsh'],
      band: ['Militia', 'Co-op', 'Free Company', 'Committee', 'Brotherhood', 'Council', 'Rangers'],
      first: ['Ada', 'Ben', 'Carla', 'Dev', 'Esther', 'Frank', 'Grace', 'Hector', 'Ines', 'Jonah', 'Kemi', 'Lou', 'Marta', 'Nate', 'Odile', 'Pavel', 'Rosa', 'Sol', 'Tamsin', 'Wade'],
      last: ['Abara', 'Brandt', 'Castillo', 'Doyle', 'Eriksen', 'Fenn', 'Garza', 'Holt', 'Ivanova', 'Jessup', 'Kowalski', 'Lam', 'Mercer', 'Novak', 'Osei', 'Price', 'Quinlan', 'Reyes', 'Sato', 'Whitlock'],
    },
  };
  /** Slots made from other slots, and the ones the campaign's own Encyclopedia can fill (cast keys). */
  const MADE = {
    faction: S => `the ${pick(S.place)} ${pick(S.band)}`,
    person: S => `${pick(S.first)} ${pick(S.last)}`,
  };
  const FROM_CAST = { faction: 'group', place: 'place', person: 'person' };

  // ------------------------------------------------------------ templates
  // t title · tone (space-separated, 'any' fits every tone) · where ('' anywhere) · when ('' any time) · g ('*' every
  // genre, else the genres it fits) · who · n how many (a MANY key, "day|night" when the dark changes it) · s the
  // situation · tw twists · esc escalations (things that happen if the scene runs on, never the party's options) · gain.
  // A '*' template uses only the slots every genre fills: locals raiders authority scavengers travellers crossing scarce
  // valuable ruin shelter beast sickness vehicle place faction person.
  const T = [
    { t: 'The toll', tone: 'tense', where: 'road water', g: '*', who: '{locals}', n: 'same|few',
      s: '{Who} have blocked the only {crossing} for miles. They want {scarce} from anyone who wants to pass, and they won\'t take money.',
      tw: ['One of them is wearing something the party would recognise.', 'Their leader is sick, and the toll pays for medicine.', 'Someone is watching from the far side.', 'They say the toll is for the dead, not for them.'],
      esc: ['The watchers on the far side decide to collect as well.', 'The price doubles once they see what the party is carrying.', 'Someone wrecks the {crossing} to close it for good.', '{Raiders} arrive and want the {crossing} for themselves.'],
      gain: ['They saw who passed this way yesterday.', 'A safe place to rest on the far side.', 'The {scarce} they took from the last travellers.'] },
    { t: 'Going the other way', tone: 'neutral', where: 'road', g: '*', who: '{travellers}', n: 'crowd',
      s: 'A long line of {who} passes the party, heading back the way the party came. Ask why and each gives a different answer.',
      tw: ['They\'re fleeing whoever now rules where the party is going.', 'One of them is hiding {sickness}.', 'One of them drops out of the line and starts following the party.'],
      esc: ['Whatever they\'re fleeing comes into view.', 'The column turns on the party for its {scarce}.', 'A child goes missing from the column, and they blame the party.', 'The road behind them is closed.'],
      gain: ['News of what lies ahead.', 'A guide who knows the back ways.', 'A trade for {scarce}.'] },
    { t: 'Smoke on the hill', tone: 'tense', where: 'wilds road', g: '*', who: 'Unknown', n: '',
      s: 'Someone keeps a signal fire burning on a high point nearby, and feeds it every few hours.',
      tw: ['It\'s a lure.', 'It\'s for someone who never came back.', 'It marks a fresh grave.', 'It\'s answered by another fire, further off.'],
      esc: ['The fire goes out while the party watches.', 'Someone on the hill starts signalling to the party.', 'Whoever feeds it comes looking for whoever came close.'],
      gain: ['A clear view of the land for miles.', 'A stash kept dry under the hearthstones.'] },
    { t: 'Picked over', tone: 'neutral', where: 'ruins', g: '*', who: '{scavengers}', n: 'few',
      s: '{Who} are already picking through the {ruin} the party meant to search. There\'s probably enough for both.',
      tw: ['The upper floors are about to give way.', 'One of them is a child.', 'They\'ve already found what the party came for.'],
      esc: ['A floor gives way under someone.', 'A third group arrives.', 'Whoever owned the {ruin} comes back.'],
      gain: ['Half a haul.', 'A hand-drawn map of the {ruin}.', '{Valuable}, overlooked in a corner.'] },
    { t: 'The wedding', tone: 'helpful', where: 'settlement farm', g: '*', who: '{locals}', n: 'crowd',
      s: '{Who} are holding a wedding feast on far too little food, and invite the party in as a good omen.',
      tw: ['The bride doesn\'t want to marry.', 'The groom serves {faction}.', 'The meat on the table was stolen from someone close by.'],
      esc: ['The groom\'s people arrive, armed.', 'The bride asks the party to take her with them.', 'Guests start falling sick from the feast.'],
      gain: ['A night\'s shelter.', 'Goodwill the party can call on later.'] },
    { t: 'The good neighbour', tone: 'helpful', where: 'farm settlement', g: '*', who: 'An old woman living alone', n: 'one',
      s: 'An old woman on a working smallholding offers food and a bed in return for a day\'s work mending her fence.',
      tw: ['Her sons are coming home tonight.', 'The fence keeps something in, not out.', 'She knows exactly who the party are.'],
      esc: ['Her sons come home early, armed.', 'Whatever is behind the fence gets out.', 'Strangers arrive asking for the party by name.'],
      gain: ['Food and real rest.', 'A safe house to come back to.'] },
    { t: 'The handout', tone: 'tense', where: 'settlement', g: '*', who: '{authority}', n: 'crowd',
      s: 'Once a week, at a set hour, {who} hand out {scarce} here. There are too many people and not enough to go round.',
      tw: ['Someone is about to rob it.', 'A guard sells extra out of the back.', 'The party\'s faces are on a notice by the gate.'],
      esc: ['It runs out with the crowd still waiting.', 'A fight breaks out at the front.', 'The guards start checking faces.'],
      gain: ['{Scarce}.', 'A contact on the inside.'] },
    { t: 'Left behind', tone: 'hostile', where: 'road', g: '*', who: 'A stranded crew', n: 'few',
      s: '{Vehicle} has broken down at the tail of a convoy that left it behind. Its crew will guard the cargo until the convoy comes back, and they\'re sure it will.',
      tw: ['The cargo is people.', 'The convoy really is coming back.', 'The party has the part it needs.'],
      esc: ['The convoy comes back and takes the party for thieves.', 'Something starts banging inside the cargo.', '{Raiders} spot it from the hills.'],
      gain: ['{Scarce}.', 'Whatever the convoy was moving.'] },
    { t: 'The checkpoint', tone: 'hostile', where: 'road', g: '*', who: '{authority}', n: 'double|same',
      s: '{Who} have closed the road. No one passes without papers, and the papers they want haven\'t been issued in months.',
      tw: ['One of the guards begs to come with the party.', 'The guards are the sick ones.', 'They still report to someone who never answers.'],
      esc: ['A signal goes up to call for more guards.', 'They decide the party are the people they\'ve been told to look for.', 'A frightened guard starts shooting.'],
      gain: ['{Vehicle}.', '{Valuable}.'] },
    { t: 'Holding on', tone: 'tense', where: '', g: '*', who: 'A badly hurt stranger', n: 'one',
      s: 'A badly hurt stranger sits slumped by the way, holding {valuable} as if their life depends on it.',
      tw: ['The wound was no accident.', 'They\'re the last of {faction}.', 'What they\'re holding isn\'t theirs.'],
      esc: ['Whoever hurt them comes back to finish it.', 'They die before saying where they were going.', 'They\'re burning up with {sickness}.'],
      gain: ['{Valuable}.', 'A name, and a place to take a message.'] },
    { t: 'Keeping pace', tone: 'tense', where: 'wilds road', g: '*', who: 'Unknown', n: '',
      s: 'Fresh tracks join the party\'s trail and stay with it. Someone, or something, is keeping pace just out of sight.',
      tw: ['It\'s {beast}.', 'It\'s a child who wants to join the party.', 'It\'s a scout for {faction}.'],
      esc: ['It gets closer each night.', 'The party\'s supplies start going missing.', 'It stops following, all at once.'],
      gain: ['An ally, if approached the right way.', 'A safer route it seems to know.'] },
    { t: 'Sheltering', tone: 'neutral', where: '', g: '*', who: '{travellers}', n: 'few',
      s: 'Foul weather drives the party into {shelter}, and {who} are already sheltering there.',
      tw: ['One of them is wanted by {faction}.', 'They\'ve been here for days and have run out of food.', 'They aren\'t all from the same group, and it shows.'],
      esc: ['The weather gets worse and nobody can leave.', 'Something goes missing in the night.', 'More people arrive and want in.'],
      gain: ['Shared warmth and news.', 'A trade for {scarce}.'] },
    { t: 'An old debt', tone: 'tense', where: 'settlement', g: '*', who: '{Person}', n: 'one',
      s: '{Person} recognises one of the party, or says so, and insists they\'re owed {scarce} from long ago.',
      tw: ['They\'ve mistaken the party for someone else.', 'The debt is real, and was forgotten.', 'They\'re telling the truth, and others saw it.'],
      esc: ['A crowd gathers to see how it plays out.', '{Faction} take {person}\'s side.', 'They follow the party when it leaves.'],
      gain: ['A story from a party member\'s past.', 'An ally, if it\'s settled fairly.'] },
    { t: 'Exactly what you need', tone: 'neutral', where: 'settlement road', g: '*', who: 'A trader and a guard or two', n: 'two',
      s: 'A trader has exactly what the party needs, and won\'t take anything the party expected to offer for it.',
      tw: ['The goods were stolen from {faction}.', 'The trader wants a favour, not goods.', 'The trader is far more frightened than they look.'],
      esc: ['The rightful owners arrive.', 'Another buyer turns up and the price climbs.', 'The guards decide to take the party\'s goods instead.'],
      gain: ['{Valuable}.', 'A trader who will look out for the party next time.'] },
    { t: 'Aftermath', tone: 'tense', where: 'road wilds', g: '*', who: 'The dead and the dying', n: 'few',
      s: 'The party comes upon the end of a fight: {vehicle} on its side, bodies, and one or two still alive.',
      tw: ['The survivors were the attackers.', 'The attackers are still nearby, watching.', 'One of the dead is someone the party knows.'],
      esc: ['The attackers come back for what they left.', 'A survivor dies before saying who did it.', '{Beast} are drawn by the smell.'],
      gain: ['{Valuable}.', 'The survivors\' gratitude.'] },
    { t: 'Take me home', tone: 'any', where: 'wilds road settlement', g: '*', who: 'A child', n: 'one',
      s: 'A child is alone, too far from anywhere, and asks the party to take them home to {place}.',
      tw: ['Home isn\'t there any more.', 'The child is bait.', 'Someone is paying well for the child\'s return.'],
      esc: ['The child\'s people find the party and assume the worst.', 'The child runs off in the night.', 'Someone else comes asking after the child, too politely.'],
      gain: ['A grateful family.', 'Shelter in {place}.'] },
    { t: 'Come no closer', tone: 'hostile', where: 'ruins settlement farm', g: '*', who: 'Unknown, inside', n: 'one',
      s: 'A voice from inside the {ruin} warns the party off. Whoever it is has a clear view of the whole approach.',
      tw: ['It\'s one frightened person, bluffing.', 'They\'re guarding someone sick with {sickness}.', 'They think the party are {faction}.'],
      esc: ['A warning shot.', 'They call to someone else inside, by name.', 'Part of the {ruin} gives way under them.'],
      gain: ['Whatever they\'ve been guarding.', 'Shelter, if their trust is won.'] },
    { t: 'Market day', tone: 'helpful', where: 'settlement', g: '*', who: '{locals} and traders', n: 'crowd',
      s: '{Place} is holding a market, the first in a long while, and everybody is trying to forget the hard times for a day.',
      tw: ['{Faction} take a cut of every trade.', 'A pickpocket has already chosen the party.', 'Someone is selling things taken from the party\'s friends.'],
      esc: ['A fight breaks out over the last of the {scarce}.', '{Authority} arrive to shut it down.', 'A rumour spreads that a trader brought {sickness}.'],
      gain: ['A chance to trade.', 'News, gossip and a familiar face.'] },
    { t: 'The burial', tone: 'neutral', where: 'road settlement farm', g: '*', who: '{locals}', n: 'few',
      s: '{Who} are burying their dead by the road, and ask the party to stand with them for a moment.',
      tw: ['One of the dead died of {sickness}.', 'The dead were killed by {faction}.', 'One of the graves is empty.'],
      esc: ['The mourners want justice, and want help getting it.', 'The killers come back to watch.', 'A mourner names the party as the ones to blame.'],
      gain: ['Goodwill.', 'A warning about what killed them.'] },
    { t: 'On the run', tone: 'tense', where: '', g: '*', who: 'A runaway', n: 'one',
      s: 'Someone who has run from {faction} begs the party to hide them.',
      tw: ['They took something when they ran.', 'They\'re running from their own crimes, not from {faction}.', 'They were sent to be found.'],
      esc: ['Their pursuers arrive.', 'A reward is posted, with the party\'s description on it.', 'They rob the party and run again.'],
      gain: ['Inside knowledge of {faction}.', '{Valuable}.'] },
    { t: 'Same road, same reason', tone: 'neutral tense', where: 'road', g: '*', who: 'Another band, much like the party', n: 'same',
      s: 'Another band much like the party\'s own is heading the same way, for the same reason.',
      tw: ['They know something the party doesn\'t.', 'One of them knows a member of the party.', 'They\'re being paid by {faction}.'],
      esc: ['They slip away in the night to get there first.', 'Some of the party\'s {scarce} leaves with them.', 'They offer to join forces, then argue about shares.'],
      gain: ['Allies, if it holds.', 'A trade of news.'] },
    { t: 'The way is gone', tone: 'any', where: 'road water', g: '*', who: 'Nobody, at first', n: '',
      s: 'The {crossing} the party meant to use is gone: washed out, collapsed or burned.',
      tw: ['Someone did it on purpose.', 'People are stranded on the far side, calling for help.', 'It went days ago, and others are already camped here, waiting.'],
      esc: ['The way round runs through land held by {faction}.', 'The weather turns.', 'Supplies run low while the party waits.'],
      gain: ['A different road, with something on it nobody has touched.', 'Grateful people from the far side.'] },
    { t: 'Too easy', tone: 'strange tense', where: '', g: '*', who: 'Nobody in sight', n: '',
      s: '{Valuable} sits in plain sight, untouched, where anyone could take it.',
      tw: ['It\'s bait.', 'Its owner lies dead nearby.', 'It\'s marked as belonging to {faction}.'],
      esc: ['Someone saw the party take it.', '{Beast} have made a den close by.', 'The owner comes looking for it.'],
      gain: ['{Valuable}.', 'A clue to where its owner was going.'] },
    { t: 'The walker', tone: 'strange helpful', where: 'road', g: '*', who: 'A lone traveller', n: 'one',
      s: 'A lone traveller walks the road, calmly heading for {place}, which everyone says is gone.',
      tw: ['They\'re right: it\'s still there.', 'They mean to die there.', 'They\'ve been walking for years.'],
      esc: ['They ask the party to come with them.', 'They collapse and need carrying.', 'Others start following them, more each day.'],
      gain: ['A blessing, or luck, if the party believes in it.', 'A story about {place}.'] },

    // ---------------------------------------------------------- post-apocalypse, grounded
    { t: 'The last broadcast', tone: 'strange', where: 'wilds ruins', g: 'apoc', who: 'Nobody, at first', n: '',
      s: 'An old radio somewhere nearby repeats a message on a loop: directions to {place}, and a promise of food and doctors.',
      tw: ['The message was re-recorded recently, in a different voice.', 'The directions run through a minefield.', 'It\'s bait, and someone is waiting at the end of it.'],
      esc: ['The loop stops halfway through a sentence.', 'A second voice cuts in and describes the party exactly.', 'Other survivors are heading for the same place.'],
      gain: ['A working transmitter.', 'A frequency other survivors use.'] },
    { t: 'Keep out', tone: 'strange', where: 'road wilds', g: 'apoc', who: 'Nobody in sight', n: '',
      s: 'Hand-painted signs warn of contamination ahead. The road beyond looks untouched, and full of things worth taking.',
      tw: ['The contamination is real.', 'The signs were put up to keep people away from someone\'s stash.', 'It was real once, years ago.'],
      esc: ['Someone in the party starts to feel sick.', 'The people who painted the signs come back.', '{Beast} live there, unafraid of anyone.'],
      gain: ['Untouched supplies.', 'A road nobody else uses.'] },
    { t: 'The last pump', tone: 'tense', where: 'road', g: 'apoc', who: 'A family', n: 'few',
      s: 'An old fuel station still has a working hand pump, and a family who sell fuel by the litre at a terrible price.',
      tw: ['The fuel is watered down.', 'The family are prisoners of {faction}.', 'The tank is nearly dry, and they\'re hiding it.'],
      esc: ['{Raiders} come for the pump.', 'Fuel catches fire.', 'The family asks the party to take them along.'],
      gain: ['Fuel.', 'A place to refuel next time.'] },
    { t: 'The glasshouse', tone: 'helpful', where: 'farm settlement', g: 'apoc', who: 'A handful of gardeners', n: 'few',
      s: 'A handful of gardeners guard a glasshouse full of seedlings, and will trade cuttings for a day\'s labour.',
      tw: ['The water they use is tainted.', '{Faction} claim the land.', 'One of them was a scientist, and has a past.'],
      esc: ['A blight shows up on the leaves.', '{Raiders} come for the crop.', 'A storm shatters the glass.'],
      gain: ['Seeds, and a food supply that grows.', 'A place to come back to.'] },
    { t: 'The jam', tone: 'neutral', where: 'road', g: 'apoc', who: 'Nobody in sight', n: '',
      s: 'Miles of abandoned cars choke the highway, doors open, everything left in a hurry.',
      tw: ['There are still people in some of the cars.', 'Someone has been searching every car, one by one, and is halfway along.', 'Someone lives in the jam and thinks of it as theirs.'],
      esc: ['The searchers spot the party.', '{Beast} have made a nest in the wrecks.', 'A fire spreads from car to car.'],
      gain: ['Fuel siphoned from the tanks.', 'A working car, buried deep in the jam.'] },
    { t: 'Lights on', tone: 'helpful', where: 'settlement ruins', g: 'apoc', who: 'A small work crew', n: 'few',
      s: 'A small crew is trying to get an old generator running again, and is one part short.',
      tw: ['The lights will draw attention from miles away.', 'It worked once before, and something went wrong.', '{Faction} want it for themselves.'],
      esc: ['The lights come on, and everyone for miles can see them.', 'A bad accident with the wiring.', 'Someone arrives who says the generator is theirs.'],
      gain: ['Power, and a working workshop.', 'A crew who owe the party a favour.'] },
    { t: 'Gone wild', tone: 'neutral', where: 'wilds farm', g: 'apoc', who: 'A herd of cattle gone half wild', n: 'crowd',
      s: 'A herd of cattle gone half wild is grazing an old pasture. The party isn\'t the only one to have noticed.',
      tw: ['They belong to someone who will fight for them.', 'Some of them are sick.', 'A hunter is already stalking them.'],
      esc: ['Something spooks the herd into a stampede.', 'The owners turn up.', '{Beast} close in on the herd at dusk.'],
      gain: ['Meat for weeks.', 'A draught animal.'] },
    { t: 'The last patrol', tone: 'tense', where: 'road wilds', g: 'apoc', who: 'A patrol still in uniform', n: 'few',
      s: 'A patrol still in uniform, still following orders from a command that no longer exists, stops the party for questioning.',
      tw: ['They don\'t know how bad things have got.', 'Their officer is long dead, and they\'re hiding it.', 'They\'re running out of ammunition, and patience.'],
      esc: ['They decide to conscript the party.', 'They ask for news, and won\'t believe it.', 'One of them breaks down.'],
      gain: ['Maps and military supplies.', 'A reliable escort.'] },
    { t: 'Still open', tone: 'helpful', where: 'ruins settlement', g: 'apoc', who: 'A doctor and a helper', n: 'two',
      s: 'A doctor still runs a clinic in a corner of an old hospital, treating anyone who brings something to trade.',
      tw: ['The medicine is running out, and the doctor is choosing who lives.', 'The doctor was struck off, for a reason.', '{Faction} protect the clinic and take a cut.'],
      esc: ['A rush of wounded arrives at once.', '{Raiders} come for the drugs.', 'The doctor falls ill.'],
      gain: ['Treatment.', 'Antibiotics.'] },
    { t: 'The well', tone: 'tense', where: 'settlement farm', g: 'apoc', who: '{locals}', n: 'few',
      s: 'The only well for miles has a sign on it: poisoned. {Who} nearby drink from it anyway.',
      tw: ['It isn\'t poisoned: someone wants it for themselves.', 'It is poisoned, and they don\'t believe it.', 'The sign went up yesterday.'],
      esc: ['Someone falls ill.', 'Whoever put up the sign comes back.', 'A fight breaks out over the water.'],
      gain: ['Clean water.', 'Grateful neighbours.'] },
    { t: 'Collection day', tone: 'hostile', where: 'settlement farm', g: 'apoc', who: '{raiders}', n: 'double|same',
      s: '{Raiders} have come to collect what {place} owes them this month, and the party happens to be there.',
      tw: ['The town paid for protection that never came.', 'One of the raiders grew up here.', 'The town means to fight this time, and wants help.'],
      esc: ['Someone refuses to pay and is beaten.', 'The raiders take a hostage.', 'More raiders are on the way.'],
      gain: ['The town\'s gratitude.', 'The raiders\' stores.'] },
    { t: 'Quiet', tone: 'strange', where: 'wilds', g: 'apoc', who: 'Unknown', n: '',
      s: 'The birds go silent all at once, and the wind brings a smell the party can\'t place.',
      tw: ['A wildfire is coming.', 'A large group is passing close by.', 'Nothing at all, and that\'s what\'s unsettling.'],
      esc: ['Animals run past, all going one way.', 'Smoke on the horizon, getting closer.', 'Voices, and the sound of engines.'],
      gain: ['A warning, in time.', 'Cover to move unseen.'] },
    { t: 'The hatch', tone: 'strange', where: 'ruins wilds', g: 'apoc', who: 'Unknown, below', n: '',
      s: 'A sealed steel door set into the ground, with a keypad that still glows.',
      tw: ['There are people inside, and they won\'t open it.', 'Someone the party knows has the code.', 'It\'s empty, and was emptied from the inside.'],
      esc: ['An alarm starts to sound.', 'The door opens by itself.', 'Others have seen the party here and want in too.'],
      gain: ['Sealed supplies.', 'A safe place to hole up.'] },
    { t: 'The lost boys', tone: 'tense', where: 'ruins settlement', g: 'apoc', who: 'A gang of children', n: 'double',
      s: 'A gang of children runs the {ruin}, with rules of their own and no adults allowed.',
      tw: ['They\'re hiding a sick adult.', 'They were left behind by {faction}.', 'They\'re scouts for {raiders}.'],
      esc: ['They steal from the party.', 'An adult comes looking for one of them.', 'They ask to be taken somewhere safe.'],
      gain: ['A guide who knows every way through the {ruin}.', 'A trade.'] },
  ];

  // ------------------------------------------------------------ drawing
  const words = s => (s || '').split(/\s+/).filter(Boolean);
  const fits = (tpl, genre, f) => (tpl.g === '*' || words(tpl.g).includes(genre))
    && (!f.tone || words(tpl.tone).includes(f.tone) || tpl.tone === 'any')
    && (!f.where || !tpl.where || words(tpl.where).includes(f.where))
    && (!f.when || !tpl.when || words(tpl.when).includes(f.when));

  /** How many, for the time: "double|same" reads "about as many" at night, or both when the time is unknown. */
  function howMany(n, when) {
    if (!n) return '';
    const [day, night] = n.split('|');
    if (!night) return MANY[day];
    if (when === 'night') return MANY[night];
    if (when) return MANY[day];
    return `${MANY[day]} (${MANY[night].toLowerCase()} at night)`;
  }

  /** Fill a line's slots. memo keeps each slot's value for the card, so "{faction}" names the same group every time. */
  function fill(line, card) {
    const S = SLOTS[card.genre];
    const value = key => {
      if (key in card.memo) return card.memo[key];
      const own = (card.cast[FROM_CAST[key]] || []).filter(x => !Object.values(card.memo).includes(x));
      let v;
      if (key === 'who') v = card.who;
      else if (own.length && chance(0.7)) v = pick(own);
      else if (MADE[key]) v = MADE[key](S);
      else v = pick(S[key] || ['someone']);
      return (card.memo[key] = v);
    };
    // A sentence starts with a capital; inside one, a campaign name's leading "The" goes lower case (the Iron Combine).
    const out = line.replace(/\{(\w+)\}/g, (_, k, at) => {
      const v = value(k.toLowerCase());
      if (/^[A-Z]/.test(k)) return cap(v);
      return at ? v.replace(/^The /, 'the ') : cap(v);
    });
    return cap(out);
  }

  /** Two different escalations, or one if that's all there is. */
  const twoOf = (list, not = []) => {
    const fresh = shuffle(list.filter(x => !not.includes(x)));
    return [...fresh, ...shuffle(list.filter(x => not.includes(x)))].slice(0, 2);
  };

  function make(tpl, f) {
    const toneKey = f.tone && words(tpl.tone).includes(f.tone) ? f.tone : tpl.tone === 'any' ? (f.tone || pick(TONES.slice(1))[0]) : pick(words(tpl.tone));
    const placeKey = f.where || words(tpl.where)[0] || '';
    const card = { tpl, genre: f.genre, cast: f.cast || {}, memo: {}, when: f.when || '', title: tpl.t, tone: toneKey,
      toneLabel: (TONES.find(([k]) => k === toneKey) || ['', ''])[1],
      where: placeKey ? (WHERE[f.genre].find(([k]) => k === placeKey) || ['', 'Anywhere'])[1] : 'Anywhere' };
    // Who first: "{Who}" in the situation reads the same group.
    card.who = tpl.who.includes('{') ? fill(tpl.who, { ...card, memo: card.memo }) : tpl.who;
    card.memo.who = card.who.charAt(0).toLowerCase() + card.who.slice(1);
    if (/^[A-Z][a-z]+ [A-Z]/.test(card.who) || card.memo.person === card.memo.who) card.memo.who = card.who; // a name keeps its capital
    card.many = howMany(tpl.n, card.when);
    card.situation = fill(tpl.s, card);
    card.twist = fill(pick(tpl.tw), card);
    card.esc = twoOf(tpl.esc).map(x => fill(x, card));
    card.gain = fill(pick(tpl.gain), card);
    return card;
  }

  /** n cards that fit the choices, each from a different template. If too few fit, the time and then the place are
   * let go, so there's always something to show. f: { genre, where, when, tone, cast, n }. */
  function draw(f = {}) {
    const genre = SLOTS[f.genre] ? f.genre : GENRES[0][0], n = f.n || 3;
    const opts = { ...f, genre };
    let pool = T.filter(t => fits(t, genre, opts));
    if (pool.length < n) pool = T.filter(t => fits(t, genre, { ...opts, when: '' }));
    if (pool.length < n) pool = T.filter(t => fits(t, genre, { ...opts, when: '', where: '' }));
    if (pool.length < n) pool = T.filter(t => fits(t, genre, {}));
    return shuffle(pool).slice(0, n).map(t => make(t, opts));
  }

  /** The card with a new twist ('twist'), new escalations ('esc') or a new reward ('gain'), different from the last. */
  function reroll(card, part) {
    const c = { ...card };
    const other = (list, now) => { const rest = list.filter(x => fill(x, c) !== now); return rest.length ? pick(rest) : pick(list); };
    if (part === 'twist') c.twist = fill(other(card.tpl.tw, card.twist), c);
    else if (part === 'gain') c.gain = fill(other(card.tpl.gain, card.gain), c);
    else if (part === 'esc') {
      const now = card.tpl.esc.filter(x => card.esc.includes(fill(x, c)));
      c.esc = twoOf(card.tpl.esc, now).map(x => fill(x, c));
    }
    return c;
  }

  /** The card as plain text. */
  function text(c) {
    return [`${c.title}`, `${c.toneLabel} · ${c.where}`, `Who: ${c.who}${c.many ? ` · ${c.many}` : ''}`, '', c.situation, '',
      `Twist: ${c.twist}`, 'If it escalates:', ...c.esc.map(x => `- ${x}`), `Worth having: ${c.gain}`].join('\n');
  }

  return { GENRES, TONES, WHEN, WHERE, TEMPLATES: T, SLOTS, seed, draw, reroll, text };
})();
