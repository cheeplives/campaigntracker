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
      locals: ['hill farmers', 'townsfolk from the next valley', 'cousins from one sprawling clan', 'fishers from the lake shore', 'former factory hands', 'churchgoers', 'smallholders from a co-op', 'orchard keepers', 'charcoal burners', 'railway families', 'miners and their families', 'shepherds down from the high pasture', 'villagers'],
      raiders: ['road raiders', 'deserters in mismatched uniforms', 'bikers', 'bandits', 'scavengers turned raiders', 'gangsters out of the city', 'slavers', 'rustlers', 'militia gone rogue', 'a warlord\'s tax collectors'],
      authority: ['garrison holdouts', 'self-appointed militia', 'sheriff\'s deputies', 'emergency-government troops', 'security guards with no company left to pay them', 'relief-agency guards', 'ration board wardens', 'quarantine wardens', 'town constables', 'reservists in their fathers\' uniforms'],
      scavengers: ['scrappers', 'salvagers', 'looters', 'scavenging families', 'tinkers with a handcart', 'copper strippers', 'rag pickers', 'book hunters', 'brick cleaners'],
      travellers: ['refugees', 'caravan traders', 'pilgrims', 'families on foot', 'farmhands looking for work', 'travelling medics', 'drovers with a few thin cattle', 'pedlars', 'evacuees from the coast', 'players from a travelling show', 'miners walking home'],
      crossing: ['bridge', 'ford', 'causeway', 'road over the pass', 'tunnel', 'ferry', 'railway bridge', 'dam road', 'footbridge', 'cable ferry'],
      scarce: ['fuel', 'antibiotics', 'clean water', 'salt', 'ammunition', 'batteries', 'seed grain', 'tinned food', 'tobacco', 'lamp oil', 'painkillers', 'soap', 'flour', 'bandages', 'matches', 'engine parts', 'coffee'],
      valuable: ['a working radio', 'a doctor\'s bag', 'a set of truck keys', 'a crate of tinned food', 'a map with caches marked on it', 'a solar panel', 'a box of ammunition', 'a water filter', 'a pair of binoculars', 'a hand-cranked generator', 'a case of penicillin', 'a hunting rifle with a scope', 'a Geiger counter', 'a set of surgical tools', 'a full jerrycan', 'a sack of seed potatoes', 'a road atlas with notes in the margins'],
      ruin: ['shopping centre', 'hospital', 'school', 'power station', 'grain silo', 'police station', 'motel', 'office block', 'railway depot', 'cannery', 'library', 'waterworks', 'prison', 'supermarket', 'fire station', 'bus garage'],
      shelter: ['an empty barn', 'a roadside church', 'a gutted motel', 'a school gym', 'a farmhouse cellar', 'a highway underpass', 'a railway carriage', 'a boathouse', 'a half-burned library', 'a grain store', 'a signal box', 'a cowshed'],
      beast: ['feral dogs', 'wild hogs', 'black bears', 'wolves', 'half-starved coyotes', 'big cats loose from some zoo'],
      sickness: ['fever', 'cholera', 'a hacking cough', 'radiation sickness', 'infected wounds', 'dysentery', 'typhus', 'measles', 'pneumonia', 'blood poisoning'],
      vehicle: ['a pickup truck', 'an old school bus', 'a fuel tanker', 'a horse-drawn cart', 'a farm tractor', 'an army truck', 'a delivery van', 'an ambulance', 'a flatbed lorry', 'a mule wagon', 'a camper van'],
      place: ['Cedar Fork', 'Hollis', 'Red Lake', 'Ash Ridge', 'Pine Hollow', 'Dunmore', 'Kettle Creek', 'New Harmony', 'Fort Mercer', 'Saltmarsh', 'Mill Bend', 'Harrow', 'Coldwater', 'Stony Cross', 'Elk Landing', 'Marrow Gap', 'Lowfield', 'Tin Cup', 'Bell Farm', 'Graniteville'],
      band: ['Militia', 'Co-op', 'Free Company', 'Committee', 'Brotherhood', 'Council', 'Rangers', 'Assembly', 'Watch', 'Union', 'Volunteers', 'Provisional Authority'],
      first: ['Ada', 'Ben', 'Carla', 'Dev', 'Esther', 'Frank', 'Grace', 'Hector', 'Ines', 'Jonah', 'Kemi', 'Lou', 'Marta', 'Nate', 'Odile', 'Pavel', 'Rosa', 'Sol', 'Tamsin', 'Wade', 'Amos', 'Birdie', 'Cyrus', 'Dolores', 'Imani', 'Joss', 'Mina', 'Tobias'],
      last: ['Abara', 'Brandt', 'Castillo', 'Doyle', 'Eriksen', 'Fenn', 'Garza', 'Holt', 'Ivanova', 'Jessup', 'Kowalski', 'Lam', 'Mercer', 'Novak', 'Osei', 'Price', 'Quinlan', 'Reyes', 'Sato', 'Whitlock', 'Achterberg', 'Bell', 'Calloway', 'Dimitrov', 'Okafor', 'Pike', 'Tran', 'Yarrow'],
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
      s: '{Who} have closed the only {crossing} for miles with a felled tree and a table. The toll is paid in {scarce}, weighed out in front of everyone, and they won\'t take coin or promises.',
      tw: ['One of them is wearing a coat the party last saw on a friend.', 'Their leader is sick, and every toll is traded on for medicine that isn\'t working.', 'They don\'t own the {crossing}. The people who do are tied up in a shed nearby.', 'The toll is honest: it pays for repairs, and the {crossing} would be gone without it.', 'They let the last travellers through for nothing, and those travellers never reached the far side.', 'Half of them want to stop, and are waiting for someone to give them a reason.'],
      esc: ['A queue builds behind the party, and it is not a patient one.', 'The price doubles once they see what the party is carrying.', '{Raiders} arrive and want the {crossing} for themselves.', 'Someone on the far side decides nobody else is getting across today.', 'A traveller who cannot pay tries to rush it, and is hurt.'],
      gain: ['They remember everyone who crossed this week, and which way each went.', 'A safe place to rest on the far side, and a word put in for the party there.', 'The {scarce} they took from the last travellers.', 'Free passage from now on.'] },
    { t: 'Going the other way', tone: 'neutral', where: 'road', g: '*', who: '{travellers}', n: 'crowd',
      s: 'A long line of {who} comes down the road towards the party, heading back the way the party came. Ask why and each gives a different answer, and none of them stops walking.',
      tw: ['They are fleeing whoever now rules the place the party is heading for.', 'Someone in the line is hiding {sickness}, and the others are pretending not to notice.', 'One of them drops out of the line and quietly starts following the party.', 'They were turned away from somewhere ahead, and are ashamed of why.', 'Nothing drove them out. They were promised something better back there, by someone who lied.'],
      esc: ['Whatever they are fleeing comes into view behind them.', 'The hungriest of them start eyeing the party\'s {scarce}.', 'A child goes missing from the column, and the party are the nearest strangers.', 'The tail of the line brings word that the road ahead is now shut.', 'An old man sits down in the road and will not get up, and the column parts around him.'],
      gain: ['News of what lies ahead, pieced together from a dozen half-truths.', 'A guide who knows the back ways and would rather not go where the others are going.', 'A trade for {scarce}, at the price of people in a hurry.'] },
    { t: 'Smoke on the hill', tone: 'tense', where: 'wilds road', g: '*', who: 'Unknown', n: '',
      s: 'A signal fire burns on the high ground nearby. Someone feeds it every few hours, day and night, and has done for long enough to wear a path to the woodpile.',
      tw: ['It is a lure, and the people who answer it are not seen again.', 'It is kept for someone who never came back, by someone who can\'t stop.', 'It marks a fresh grave, and the keeper is making sure nothing digs.', 'It is answered by a second fire, further off, that the keeper has never seen lit before.', 'The keeper is a child, doing exactly what they were told to do before everyone left.'],
      esc: ['The fire goes out while the party is watching, and stays out.', 'Someone on the hill starts signalling straight at the party.', 'Whoever feeds it comes down to find out who came close.', 'Others who saw the smoke arrive from the opposite side.'],
      gain: ['A clear view of the land for miles around.', 'A cache kept dry under the hearthstones.', 'The meaning of the signals, which others nearby also use.'] },
    { t: 'Picked over', tone: 'neutral', where: 'ruins', g: '*', who: '{scavengers}', n: 'few',
      s: '{Who} are already working through the {ruin} the party meant to search. They have a system, they are halfway done, and there is probably enough for both.',
      tw: ['The upper floors are close to giving way, and they have not noticed.', 'The youngest of them is a child, sent into the gaps the others can\'t fit through.', 'They have already found the very thing the party came for, and don\'t know its worth.', 'They aren\'t taking anything. They are looking for one person\'s remains.', 'They are working off a debt to {faction}, and every find is counted.'],
      esc: ['A floor gives way under someone.', 'A third group arrives, less willing to share.', 'Whoever used to hold the {ruin} comes back.', 'Both groups reach for the same find at the same moment.', 'Someone is trapped deep inside, and the light is going.'],
      gain: ['Half a haul, fairly split.', 'A hand-drawn map of the {ruin}, with the dangerous parts marked.', '{Valuable}, overlooked in a corner.'] },
    { t: 'The wedding', tone: 'helpful', where: 'settlement farm', g: '*', who: '{locals}', n: 'crowd',
      s: '{Who} are holding a wedding feast on far too little food, and wave the party in: strangers at a wedding are good luck here.',
      tw: ['The bride does not want this, and a stranger is the only person she can say it to.', 'The groom answers to {faction}, and the match is the price of peace.', 'The meat on the table was taken from a neighbour who has just noticed.', 'It is the second wedding this month. The first groom is buried at the edge of the field.', 'Every guest has given up a week of food for this, and nobody is to mention it.'],
      esc: ['The groom\'s people arrive late, armed and already drinking.', 'The bride asks the party to take her with them when they go.', 'Guests start falling sick from the feast.', 'A toast turns into an old quarrel, and both families look to the strangers to settle it.', 'An uninvited guest walks in and the music stops.'],
      gain: ['A night\'s shelter and a full stomach.', 'Goodwill the party can call on later.', 'A wedding gift pressed on them for luck: {valuable}.'] },
    { t: 'The good neighbour', tone: 'helpful', where: 'farm settlement', g: '*', who: 'An old woman living alone', n: 'one',
      s: 'An old woman on a working smallholding offers a hot meal and a dry bed in return for a day spent mending her fence. She is good company, and she watches the road while she talks.',
      tw: ['Her sons are due home tonight, and she has not said what they do.', 'The fence is there to keep something in, not out.', 'She knows exactly who the party are, and was told to expect them.', 'She cannot manage another winter alone, and the work is her way of finding out who to ask.', 'There are four places laid at her table, and she lives alone.'],
      esc: ['Her sons come home early, armed and suspicious.', 'Whatever is behind the fence gets out.', 'Strangers arrive at the gate asking for the party by description.', 'She takes a bad turn in the night and there is nobody else to sit with her.'],
      gain: ['Food, real rest and clean clothes.', 'A safe house to come back to.', 'Everything she has seen pass along the road this season.'] },
    { t: 'The handout', tone: 'tense', where: 'settlement', when: 'dawn day', g: '*', who: '{authority}', n: 'crowd',
      s: 'Once a week, at a set hour, {who} hand out {scarce} from the back of a cart. Today the queue is twice as long as the cart is full, and everyone in it can count.',
      tw: ['Someone in the crowd is about to rob it.', 'A guard sells extra out of the back to those who can pay.', 'The party\'s descriptions are on a notice by the gate.', 'This is the last handout there will ever be, and only the guards know.', 'The people at the front have been paid to queue by those who will sell it on.'],
      esc: ['It runs out with half the crowd still waiting.', 'A fight breaks out at the front and spreads backwards.', 'The guards start checking faces against a list.', 'Someone shouts that strangers are taking what belongs to locals.', 'A woman holds up a sick child, and the queue has to decide what it is.'],
      gain: ['{Scarce}.', 'A contact on the inside.', 'A friend in the crowd who knows how this town really runs.'] },
    { t: 'Left behind', tone: 'hostile', where: 'road', g: '*', who: 'A stranded crew', n: 'few',
      s: '{Vehicle} sits broken at the roadside where its convoy left it. The crew have orders to guard the cargo until someone comes back for them, and they have been saying "any hour now" for days.',
      tw: ['The cargo is people.', 'The convoy really is coming back, and is closer than anyone thinks.', 'The fault is a small one, and someone in the party knows how to mend it.', 'The crew have already opened the cargo, and are terrified of being found out.', 'Nobody is coming. One of the crew knows, and has not told the others.'],
      esc: ['The convoy comes back and takes the party for thieves.', 'Something starts knocking from inside the cargo.', '{Raiders} spot the wreck from the high ground.', 'The crew fall out among themselves over whether to stay.', 'The crew\'s water runs out.'],
      gain: ['{Scarce}.', 'Whatever the convoy was moving.', 'A crew with nowhere to go and every reason to be grateful.'] },
    { t: 'The checkpoint', tone: 'hostile', where: 'road', g: '*', who: '{authority}', n: 'double|same',
      s: '{Who} have closed the road with a barrier and a brazier. Nobody passes without papers, and the papers they want have not been issued in months.',
      tw: ['One of the guards quietly begs to leave with the party.', 'The guards are the sick ones, and the barrier is to keep themselves in.', 'They still send reports to someone who never answers.', 'The papers can be had from a clerk a day back, who splits the fee with the guards.', 'They are looking for one particular person, and everything else is theatre.'],
      esc: ['A signal goes up to call more guards.', 'They decide the party are the people they were told to look for.', 'A frightened guard looses a shot.', 'They begin searching the party\'s packs, item by item, and keeping what they like.', 'Travellers held here for days decide to push through all at once.'],
      gain: ['Their transport: {vehicle}.', 'Stamped papers that will open other barriers.', '{Valuable}, confiscated from someone earlier.'] },
    { t: 'Holding on', tone: 'tense', where: '', g: '*', who: 'A badly hurt stranger', n: 'one',
      s: 'A badly hurt stranger sits propped up by the way, both arms wrapped round {valuable}. They will talk, but they will not let go of it.',
      tw: ['The wound was no accident, and they know who did it.', 'They are the last of {faction}.', 'What they are holding is not theirs, and they were taking it back to its owner.', 'They are not as badly hurt as they look, and they are not alone.', 'They are less afraid of dying than of what they are holding going to waste.'],
      esc: ['Whoever hurt them comes back to finish it.', 'They slip away before saying where they were going.', 'It becomes clear the wound is the least of it: they are far gone with {sickness}.', 'They press it into the nearest pair of hands and make that person swear to something.'],
      gain: ['{Valuable}.', 'A name, and a place to carry a message to.', 'A debt owed by the stranger\'s people, if they ever hear of this.'] },
    { t: 'Keeping pace', tone: 'tense', where: 'wilds road', g: '*', who: 'Unknown', n: '',
      s: 'Fresh tracks join the party\'s trail and stay with it. Someone, or something, is keeping pace just out of sight, and stops whenever the party stops.',
      tw: ['The tracks belong to {beast}, patient and hungry.', 'It is a child who wants to join the party and has not found the nerve to ask.', 'It is a scout for {faction}, counting heads.', 'It is someone the party wronged without knowing it.', 'It is a stray animal that has decided the party are its people.'],
      esc: ['It comes closer each night.', 'Small things start going missing from the party\'s packs.', 'It stops following, all at once, and the silence is worse.', 'A second set of tracks joins the first.'],
      gain: ['An ally, if approached the right way.', 'A safer route it seems to know.', 'Warning of what else is moving in these parts.'] },
    { t: 'Sheltering', tone: 'neutral', where: '', g: '*', who: '{travellers}', n: 'few',
      s: 'Foul weather drives the party into {shelter}, where {who} got there first. There is one fire, not much floor and a long wait ahead.',
      tw: ['One of them is wanted by {faction}, and another of them knows it.', 'They have been stuck here for days and finished their food yesterday.', 'They are two groups, not one, and were close to blows before the party came in.', 'One of them is very near to giving birth.', 'They are carrying their dead with them, wrapped, in the corner.', 'They are taking a dowry to {place}, and are already a week late for the wedding.'],
      esc: ['The weather worsens and nobody can leave.', 'Something goes missing in the night.', 'More people arrive at the door and want in.', 'The roof starts to go.'],
      gain: ['Shared warmth and a night of news.', 'A trade for {scarce}.', 'Companions for the next stretch of the way.'] },
    { t: 'An old debt', tone: 'tense', where: 'settlement', g: '*', who: '{Person}', n: 'one',
      s: '{Person} stops one of the party in the open, names a place and a year, and says they are owed {scarce} from back then. They say it loudly.',
      tw: ['They have mistaken the party for someone else, and half know it.', 'The debt is real, and was forgotten.', 'The debt is real, and it was owed by someone the party buried.', 'They don\'t want paying. They want an excuse to talk to someone from the old days.', 'Someone put them up to it, to see how the party reacts.'],
      esc: ['A crowd gathers to see how it plays out.', '{Faction} take {person}\'s side.', 'They follow the party when it leaves, still talking.', 'They produce a witness.', 'The sum grows each time they tell it.'],
      gain: ['A story from a party member\'s past, told by someone who was there.', 'An ally, if it is settled fairly.', 'An introduction to everyone in town worth knowing.'] },
    { t: 'Exactly what you need', tone: 'neutral', where: 'settlement road', g: '*', who: 'A trader and a guard or two', n: 'two',
      s: 'A trader has exactly what the party needs, laid out as if expecting them, and turns down everything the party thought to offer for it.',
      tw: ['The goods were taken from {faction}, who are still looking.', 'The trader wants a favour, not goods, and it involves {person}.', 'The trader is far more frightened than they look.', 'The trader was told what the party would need, by someone who wants the party in debt.', 'It is the trader\'s last sale. They are giving up the road and want it to end well.'],
      esc: ['The rightful owners arrive.', 'Another buyer turns up and the price climbs.', 'The guards decide the party\'s goods are worth more than the trader\'s wages.', 'The trader starts packing up in a hurry, eyes on the road.'],
      gain: ['{Valuable}.', 'A trader who will look out for the party next time.', 'Word of where such things still come from.'] },
    { t: 'Aftermath', tone: 'tense', where: 'road wilds', g: '*', who: 'The dead and the dying', n: 'few',
      s: 'The party comes upon the end of a fight: {vehicle} on its side, goods across the road, bodies, and one or two people still breathing.',
      tw: ['The survivors were the attackers.', 'The victors are still close by, watching to see who comes.', 'One of the dead is someone the party knows.', 'Nothing was taken. Whoever did this wanted these people, not their goods.', 'It was a mistake: each side took the other for {raiders}.'],
      esc: ['The attackers come back for what they left.', 'A survivor dies before saying who did it.', '{Beast} are drawn by the smell.', 'The dead\'s own people arrive and find the party standing over them.'],
      gain: ['{Valuable}.', 'The survivors\' gratitude, and their people\'s.', 'A clear account of who is raiding this road, and how.'] },
    { t: 'Take me home', tone: 'any', where: 'wilds road settlement', g: '*', who: 'A child', n: 'one',
      s: 'A child, alone and much too far from anywhere, falls in beside the party and asks to be taken home to {place}. They know the way, more or less.',
      tw: ['Home is not there any more, and the child half knows.', 'The child is bait.', 'Someone is paying well for the child\'s return, and it is not family.', 'The child ran away, with good reason.', 'The child was sent out to fetch help and is too proud to say so.'],
      esc: ['The child\'s people find the party first and assume the worst.', 'The child runs off in the night.', 'Someone else comes asking after the child, too politely.', 'The child falls ill on the way.'],
      gain: ['A grateful family.', 'Shelter in {place}.', 'A small, fierce friend who notices everything.'] },
    { t: 'Come no closer', tone: 'hostile', where: 'ruins settlement farm', g: '*', who: 'Unknown, inside', n: 'one',
      s: 'A voice from inside the {ruin} tells the party to stop where they are. Whoever it is has a clear view of the whole approach and sounds as if they have not slept.',
      tw: ['It is one frightened person, bluffing.', 'They are guarding someone sick with {sickness}.', 'They think the party are {faction}.', 'They are stalling: the others have not finished carrying everything out the back.', 'They have been waiting for relief that is a week overdue, and want badly to believe the party is it.'],
      esc: ['A warning shot strikes the ground at the party\'s feet.', 'They call to someone else inside, by name, and nobody answers.', 'Part of the {ruin} gives way under them.', 'They begin to count down from ten.'],
      gain: ['Whatever they have been guarding.', 'Shelter, if their trust is won.', 'One more pair of steady hands, once they have slept.'] },
    { t: 'Market day', tone: 'helpful', where: 'settlement', when: 'day', g: '*', who: '{locals} and traders', n: 'crowd',
      s: '{Place} is holding a market, the first in a long while. There is music, the stalls are thin, and everybody is working hard at forgetting the bad year for one day.',
      tw: ['{Faction} take a cut of every trade, and their collectors are easy to spot.', 'A pickpocket has already marked the party.', 'One stall is selling things that belonged to friends of the party.', 'The market is a farewell. Half the town leaves tomorrow and has not told the other half.', 'Someone here is selling {scarce} far too cheaply, and nobody is asking why.'],
      esc: ['A fight breaks out over the last of the {scarce}.', '{Authority} arrive to shut it down.', 'A rumour runs through the stalls that a trader brought {sickness}.', 'A cheated buyer starts shouting, and people take sides.', 'The strangers are asked, pleasantly, to judge the baking, and the town takes the result very seriously.'],
      gain: ['A chance to trade for nearly anything.', 'News, gossip and a familiar face.', 'One good day, which is worth more than it sounds.'] },
    { t: 'The burial', tone: 'neutral', where: 'road settlement farm', g: '*', who: '{locals}', n: 'few',
      s: '{Who} are burying their dead beside the road. They have run short of people to carry, and ask the party to take a corner and to stand with them a moment after.',
      tw: ['One of the dead died of {sickness}, and the mourners have not said so.', 'The dead were killed by {faction}.', 'One of the graves is empty, and only the gravedigger knows.', 'There is nobody left who knew the right words, and they ask whether the party does.', 'The dead were strangers here too. These people simply would not leave them lying.'],
      esc: ['The mourners want justice, and start asking who will help them get it.', 'The killers come back to watch.', 'A mourner, wild with grief, names the party as the ones to blame.', 'The rain comes before the graves are filled.'],
      gain: ['Goodwill, quietly given.', 'A warning about what killed them.', 'The belongings of the dead, offered because nobody here can bear to keep them.'] },
    { t: 'On the run', tone: 'tense', where: '', g: '*', who: 'A runaway', n: 'one',
      s: 'Someone out of breath and out of road has run from {faction}, and begs the party to hide them. They have perhaps a quarter of an hour.',
      tw: ['They took something when they ran.', 'They are running from their own crimes, not from {faction}.', 'They were sent to be found, so the party would be blamed.', 'They left someone behind, and mean to go back.', 'They are running with a warning that nobody in {faction} would listen to.'],
      esc: ['Their pursuers arrive.', 'A reward is posted, and the party\'s description is on it too.', 'They take what they can carry from the party and run again.', 'Locals who saw everything decide which side they are on.'],
      gain: ['Inside knowledge of {faction}.', '{Valuable}.', 'A loyal friend with a great deal to prove.'] },
    { t: 'Same road, same reason', tone: 'neutral tense', where: 'road', g: '*', who: 'Another band, much like the party', n: 'same',
      s: 'Another band, much like the party\'s own, is heading the same way for the same reason. They are friendly about it, and a little too interested in the party\'s pace.',
      tw: ['They know something about the destination that the party does not.', 'One of them knows a member of the party from before.', 'They are being paid by {faction}.', 'They are worse off than they let on: short of food and carrying wounded.', 'They have been told the party are the ones to watch out for.', 'Their reason is not the same at all: one of them is going home to make peace with a dying parent.'],
      esc: ['They slip away in the night to get there first.', 'Some of the party\'s {scarce} leaves with them.', 'They propose joining forces, then start arguing about shares.', 'One of them asks, privately, to change sides.'],
      gain: ['Allies, if it holds.', 'A trade of news.', 'Someone to share the watches with.'] },
    { t: 'The way is gone', tone: 'any', where: 'road water', g: '*', who: 'Nobody, at first', n: '',
      s: 'The {crossing} the party was counting on is gone: washed out, collapsed or burned. The far side is close enough to shout to.',
      tw: ['Someone did it on purpose, and not long ago.', 'People are stranded on the far side, calling for help.', 'It went days ago, and a camp of the stuck has grown up here, with its own rules.', 'A local offers a way across for a price that seems far too low.', 'It was destroyed to stop something following, by people who are now watching to see what comes.'],
      esc: ['The only way round runs through land held by {faction}.', 'The weather turns.', 'Supplies run low while everyone waits.', 'Somebody tries the gap anyway and gets into trouble halfway.'],
      gain: ['A different road, with something on it nobody has touched.', 'Grateful people from the far side.', 'Time to rest, mend and take stock.'] },
    { t: 'Too easy', tone: 'strange tense', where: '', g: '*', who: 'Nobody in sight', n: '',
      s: '{Valuable} sits in plain sight where anyone could take it, clean, dry and plainly set down with care.',
      tw: ['It is bait.', 'Its owner lies dead a short walk away.', 'It carries the mark of {faction}.', 'It is an offering, left for someone dead, and locals leave such things alone.', 'It was left for the party, by someone who knew they would pass.'],
      esc: ['Someone saw the party touch it.', '{Beast} have made a den close by.', 'The owner comes looking for it.', 'A second gift appears further on.'],
      gain: ['{Valuable}.', 'A clue to where its owner was going.', 'The thanks of whoever it was truly meant for.'] },
    { t: 'The walker', tone: 'strange helpful', where: 'road', g: '*', who: 'A lone traveller', n: 'one',
      s: 'A lone traveller walks the road at an easy pace, bound for {place}. Everyone says {place} is gone. The traveller smiles at that and keeps walking.',
      tw: ['They are right: it is still there.', 'They mean to die there.', 'They have been walking for years, and have been there twice already.', 'They carry letters for the dead, and deliver them anyway.', 'They are leading someone away from somewhere else.'],
      esc: ['They ask the party to walk with them a while, and a while becomes days.', 'They collapse and need carrying.', 'Others start following them, more each day.', 'They give the last of their food to the party and will not hear of taking it back.'],
      gain: ['A blessing, or luck, if the party believes in such things.', 'A story about {place} that turns out to be useful.', 'A letter addressed to someone the party knows.'] },
    { t: 'The judgement', tone: 'tense', where: 'settlement farm', g: '*', who: '{locals}', n: 'crowd',
      s: '{Who} have caught a thief with a sack of their {scarce} and cannot agree what to do with him. Strangers have no side, they say, so the strangers shall judge, and the town will abide by it.',
      tw: ['The thief is one of their own, stealing for a family the town cut off.', 'The thief did not do it, and knows who did.', 'The loudest voice for hanging belongs to the one who profits if he is gone.', 'The town has done this before and regretted it. Nobody will say what happened last time.', 'The thief was stealing it back.'],
      esc: ['The crowd grows tired of waiting and starts to settle it without anyone\'s leave.', 'The thief\'s kin arrive to take him home by force.', 'The thief bolts.', 'Someone asks, loudly, what the strangers will do if the town dislikes the answer.'],
      gain: ['The trust of a town that keeps its word.', 'A thief who owes his neck to the party.', 'A share of the recovered {scarce}.'] },
    { t: 'Light fingers', tone: 'tense', where: '', when: 'night', g: '*', who: 'A thief in the dark', n: 'one',
      s: 'In the small hours someone is in among the party\'s packs: slow, careful and very nearly silent. They are taking food and nothing else.',
      tw: ['It is a child, feeding younger ones hidden close by.', 'It is one of the {travellers} the party passed earlier, too proud to beg.', 'They are leaving something in exchange for each thing they take.', 'They are the distraction, and the real theft is happening on the other side of camp.', 'They have done this every night for three nights.'],
      esc: ['They knock something over, and whoever is on watch has a heartbeat to react.', 'They run, straight towards a drop they cannot see.', 'Their friends, waiting in the dark, decide it has gone wrong and come in.', 'They are caught, and will not say a word.'],
      gain: ['A light-footed guide who knows this country in the dark.', 'What was left in exchange: {valuable}.', 'The thanks of the people the food was for.'] },
    { t: 'The ferryman', tone: 'helpful neutral', where: 'water', g: '*', who: 'A ferryman', n: 'one',
      s: 'A ferryman poles a raft back and forth across the water and takes no payment but news. He wants to hear everything, and swears he repeats none of it.',
      tw: ['He is waiting for word of one particular person, and has been for years.', 'He sells what he hears to {faction}.', 'He will not land anyone on the far bank after dark, and will not say why.', 'He is going blind and knows the water by feel.', 'He decides who crosses. Some people he leaves standing on the bank, and he is rarely wrong about them.'],
      esc: ['The water rises fast, with the raft in midstream.', 'Someone the ferryman refused comes back with friends.', 'A rope parts.', 'Halfway over he stops poling and asks the party to carry a message for him.'],
      gain: ['A crossing nobody else knows is here.', 'A season of other people\'s news.', 'A friend on the water who never forgets a face.'] },
    { t: 'Downstream', tone: 'strange', where: 'water', g: '*', who: 'Nobody, at first', n: '',
      s: 'Things are coming down the river: a hat, a chair, a door, then a child\'s toy boat with a folded note for a sail. More follows, in ones and twos.',
      tw: ['Someone upstream is throwing in everything they own, one piece at a time.', 'A settlement upstream has flooded, and nobody downstream knows yet.', 'The note is a list of names, and one of them is known to the party.', 'It is a signal between people who cannot meet, and the party has just read their post.', 'It all belonged to one household, and none of it is damaged.'],
      esc: ['A body comes down.', 'A raft comes down with someone on it, not moving.', 'The water changes colour.', 'People arrive on the bank, hooking things out and hiding them quickly.'],
      gain: ['{Valuable}, snagged in the reeds.', 'Early warning of trouble upstream.', 'An address, of sorts, for whoever wrote the note.'] },
    { t: 'The gate at dusk', tone: 'tense', where: 'settlement', when: 'dusk', g: '*', who: '{travellers}', n: 'crowd',
      s: 'The gate of {place} shuts at dusk, and {who} are still outside it with the light going. The guards are letting in a few at a time, picking by some rule nobody can work out.',
      tw: ['The rule is {sickness}: they are looking for the signs.', 'The rule is a bribe, paid earlier in the day.', 'There is no rule. The guards are as frightened as the crowd.', 'There is plenty of room inside. Someone in there wants the crowd desperate.', 'What the crowd fears out here in the dark is real, and the guards know it.'],
      esc: ['The gate shuts with half the crowd still outside.', 'A family is split by the gate, and the ones inside start screaming.', 'The crowd pushes.', 'A guard offers the party a way in, for a price that is not goods.'],
      gain: ['A night behind walls.', 'The gratitude of whoever got in on the party\'s account.', 'A guard who owes the party a quiet favour.'] },
    { t: 'Not for you', tone: 'hostile tense', where: 'road wilds', g: '*', who: '{raiders}', n: 'same',
      s: '{Who} have laid an ambush where the way narrows, and the party has blundered into the back of it. It was set for someone else, who is due any moment.',
      tw: ['The ones they are waiting for are friends of the party.', 'The ones they are waiting for deserve it.', 'They were hired by {faction}, and half of them want out.', 'They have waited two days. Whoever was coming has been warned.', 'Their leader recognises one of the party, and not kindly.'],
      esc: ['The intended victims come round the bend.', 'Someone decides the party has seen too much.', 'A nervous hand lets fly too early.', 'They offer the party a share to keep quiet and stand with them.'],
      gain: ['Whatever the ambush was meant to take.', 'A debt owed by those who were warned in time.', 'Their camp, close by and well stocked.'] },
    { t: 'Treed', tone: 'hostile', where: 'wilds farm', g: '*', who: '{beast} and one unlucky stranger', n: '',
      s: '{Beast} have someone trapped up a tree, off the ground since yesterday and hoarse from shouting. The animals are in no hurry.',
      tw: ['The stranger took one of their young, and still has it inside their coat.', 'The animals are sick, and bolder than they should be.', 'The stranger is a tracker for {faction}, and was hunting the party.', 'The animals were driven here by their keeper, who is watching.', 'The stranger dropped {valuable} at the foot of the tree, and the animals are lying on it.'],
      esc: ['The branch starts to crack.', 'The animals notice the party.', 'The stranger passes out and begins to slip.', 'More of them arrive.'],
      gain: ['A grateful stranger who knows this country.', 'Meat and hides.', '{Valuable}.'] },
    { t: 'Breakfast', tone: 'helpful strange', where: '', when: 'dawn', g: '*', who: 'Nobody in sight', n: '',
      s: 'The party wakes to find food set out at the edge of camp: still warm, neatly covered, and enough for everyone. Whoever was on watch saw nothing.',
      tw: ['It is a custom here: feed strangers and they pass on in peace.', 'It is an apology, from someone who robbed the party once.', 'It is a test, and someone is watching to see who eats first and who shares.', 'It was meant for someone else who camps here, and they are on their way.', 'There is a message under the dish, asking for help with something.'],
      esc: ['The same thing happens the next morning, further along.', 'Someone in the party feels ill by noon, though perhaps not from the food.', 'Footprints lead away from the camp, small and unhurried.', 'A local arrives, furious, asking who has been eating the offerings.'],
      gain: ['A good meal nobody had to carry.', 'A shy friend somewhere close.', 'The dish it came in, which is worth more than the food.'] },
    { t: 'All hands', tone: 'helpful', where: 'farm', when: 'day dusk', g: '*', who: '{locals}', n: 'crowd',
      s: '{Who} are racing to bring a crop in ahead of the weather, and are losing. Every pair of hands gets a share of what is saved, and nobody has time to ask strangers their business.',
      tw: ['The field belongs to someone else, who is away.', 'A third of the crop is promised to {faction}, saved or not.', 'Two families are working the same field and not speaking.', 'The best worker in the field is someone the party was told was dead.', 'There will not be enough even if every ear comes in, and the elders know it.'],
      esc: ['The weather breaks early.', 'A cart overturns with someone under it.', 'Collectors arrive to take their share before the work is done.', 'Dark comes with a third of the field still standing.'],
      gain: ['A fair share of the crop.', 'Friends who have seen the party work.', 'A harvest supper, and a place at it every year after.'] },
    { t: 'A light in the window', tone: 'strange', where: 'farm wilds', when: 'night', g: '*', who: 'Unknown', n: '',
      s: 'A lamp burns in the window of a house that every local says has stood empty for years. It moves from room to room, slowly, as if someone were looking for something.',
      tw: ['The owner has come home after years away and is ashamed to be seen.', 'Someone is searching for what the last owner hid, and is getting close.', 'It is a signal, and the party is not who it is meant for.', 'A child has been living there alone since the adults died.', 'The locals know perfectly well who it is, and have agreed not to.'],
      esc: ['The light goes out, and a door opens.', 'A second light appears, outside, coming towards the house.', 'A voice inside begins calling a name.', 'Smoke starts to rise from the roof.'],
      gain: ['A dry house with a stocked cellar.', 'What was hidden there: {valuable}.', 'The truth of a story the locals tell wrongly.'] },
    { t: 'Bucket chain', tone: 'tense helpful', where: 'settlement farm', g: '*', who: '{locals}', n: 'crowd',
      s: 'The store where {place} keeps its winter food is on fire, and {who} are passing buckets hand to hand. There is a gap in the line where two more people ought to be, and the fire is winning.',
      tw: ['Someone is still inside.', 'The fire was set, and the one who set it is in the line.', 'The stores were already gone, sold off, and the fire hides it.', 'The wind is about to carry it to the houses.', 'The water is running low, and some are quietly saving their own.'],
      esc: ['The roof comes down.', 'The fire jumps to the next building.', 'Someone runs in after what is left.', 'Blame starts before the flames are out, and it lands on strangers.'],
      gain: ['The thanks of a whole town.', 'First pick of what was saved.', 'A bed for as long as the party wants one.'] },
    { t: 'Able bodies', tone: 'hostile', where: 'settlement road', g: '*', who: '{authority}', n: 'double|same',
      s: '{Who} are sweeping through, taking anyone fit to work for a labour gang: a month on the walls, they say, and then home. The party looks fit to work.',
      tw: ['Nobody taken last month has come home.', 'The work is real and needed: without it {place} will not last the winter.', 'A list of exemptions exists, and it is for sale.', 'Their officer hates the job and is looking for a reason to stop.', 'They were sent by {faction}, whatever badge they wear.'],
      esc: ['They close off the ways out.', 'A local points the party out to save a son.', 'Someone resists and is clubbed down as an example.', 'They begin roping the taken together in a line.'],
      gain: ['Their ledger of names, and where each was sent.', 'The gratitude of those who got away.', 'Honest pay, if the work is real.'] },

    // ---------------------------------------------------------- post-apocalypse, grounded
    { t: 'The last broadcast', tone: 'strange', where: 'wilds ruins', g: 'apoc', who: 'Nobody, at first', n: '',
      s: 'A radio left running on a car battery repeats one message: directions to {place}, a promise of food and doctors, and a date that passed long ago.',
      tw: ['The message was re-recorded recently, in a different voice.', 'The directions lead through a minefield.', 'It is bait, and someone is waiting at the end of it.', 'The battery is fresh. Someone comes here to change it.', 'It is all true, or was: {place} is still taking people in, on terms.'],
      esc: ['The loop stops halfway through a sentence.', 'A second voice cuts in and describes the party exactly.', 'Other survivors arrive, following the same signal.', 'The voice begins reading out names.'],
      gain: ['A working transmitter.', 'A frequency other survivors use.', 'A good battery with charge left in it.'] },
    { t: 'Keep out', tone: 'strange', where: 'road wilds', g: 'apoc', who: 'Nobody in sight', n: '',
      s: 'Hand-painted signs warn of contamination ahead. Beyond them the road is clear, the houses are unlooted and washing still hangs on a line.',
      tw: ['The contamination is real.', 'The signs were painted to keep people away from someone\'s stash.', 'It was real once, years ago, and nobody came back to check.', 'The people inside painted them, and want only to be left alone.', 'The washing is fresh.'],
      esc: ['Someone in the party starts to feel sick.', 'The sign painters come back.', '{Beast} live there, unafraid of anyone.', 'A face appears at a window and is gone.'],
      gain: ['Untouched supplies.', 'A road nobody else uses.', 'Certainty about which ground is safe, which is rare.'] },
    { t: 'The last pump', tone: 'tense', where: 'road', g: 'apoc', who: 'A family', n: 'few',
      s: 'An old fuel station still has a working hand pump, and a family who sell by the litre at a price that makes people laugh, then pay.',
      tw: ['The fuel is watered down.', 'The family are held here by {faction}, who take everything they earn.', 'The tank is nearly dry, and they are hiding it.', 'They are not selling to live. They are saving to buy back a daughter.', 'The grandfather built the pump and is the only one who can keep it working.'],
      esc: ['{Raiders} come for the pump.', 'Spilled fuel catches.', 'The family ask the party to take them along.', 'A customer who was cheated last week returns with company.'],
      gain: ['Fuel.', 'A place to fill up next time, at a friend\'s price.', 'Tools and a pit to work in for an afternoon.'] },
    { t: 'The glasshouse', tone: 'helpful', where: 'farm settlement', g: 'apoc', who: 'A handful of gardeners', n: 'few',
      s: 'A handful of gardeners keep a patched glasshouse full of seedlings, and trade cuttings for a day of digging. They talk to the plants more than to each other.',
      tw: ['The water they use is tainted, and the crop with it.', '{Faction} claim the land and have set a date.', 'One of them was a scientist, with a past that matters to someone.', 'They are growing medicine as well as food, and keeping quiet about it.', 'The seed stock was taken from a relief store, and people went hungry for it.'],
      esc: ['A blight shows on the leaves.', '{Raiders} come for the crop.', 'A storm starts breaking the glass.', 'A gardener asks the party to carry seedlings somewhere safer, at once.'],
      gain: ['Seeds, and a food supply that grows.', 'A place to come back to.', 'Dried herbs that do the work of medicine.'] },
    { t: 'The jam', tone: 'neutral', where: 'road', g: 'apoc', who: 'Nobody in sight', n: '',
      s: 'Abandoned cars choke the highway for miles, doors open, cases spilled, everything left in one bad hour. Grass is growing through the bonnets.',
      tw: ['There are still people in some of the cars, where they were left.', 'Someone has been searching every car, one by one, and is halfway along.', 'Someone lives in the jam and thinks of it as theirs.', 'One lane has been cleared, recently, with heavy machinery.', 'Every car has had the same one thing removed.'],
      esc: ['The searchers spot the party.', '{Beast} have nested in the wrecks.', 'A fire spreads from car to car.', 'An engine starts somewhere up the line.'],
      gain: ['Fuel siphoned from the tanks.', 'A car that still runs, boxed in deep in the jam.', 'A glovebox map marked with where one family meant to go.'] },
    { t: 'Lights on', tone: 'helpful', where: 'settlement ruins', g: 'apoc', who: 'A small work crew', n: 'few',
      s: 'A small crew has spent a month coaxing an old generator back to life, and is one part short. They have promised the town lights by the end of the week.',
      tw: ['The lights will be seen for miles, and not everyone out there is friendly.', 'It ran once before, and somebody died.', '{Faction} want it for themselves.', 'The missing part sits in a place the crew are forbidden to go.', 'The town has enough fuel for three nights, and has not thought past that.'],
      esc: ['The lights come on, and everyone for miles can see them.', 'The wiring bites someone badly.', 'A claimant arrives with papers saying the generator is theirs.', 'The town gathers to watch, and the crew dare not fail in front of them.'],
      gain: ['Power, and the use of a workshop.', 'A crew who owe the party a favour.', 'A night of electric light and old music.'] },
    { t: 'Gone wild', tone: 'neutral', where: 'wilds farm', g: 'apoc', who: 'A herd of cattle gone half wild', n: 'crowd',
      s: 'Cattle gone half wild graze an overgrown pasture, sleek and wary. Old fences still stand and old brands still show, and the party is not the first to notice.',
      tw: ['They belong to someone who will fight for them.', 'Some of them are sick.', 'A hunter is already stalking them.', 'The bull has killed before, and the locals have a name for him.', 'Somebody has been quietly tending them: salt set out, a gate mended.'],
      esc: ['Something spooks the herd into a run.', 'The owners turn up.', '{Beast} close in on the herd as the light fails.', 'A calf is stuck in a ditch and the herd will not leave it.'],
      gain: ['Meat for weeks.', 'A draught animal.', 'Milk, for the first time in a long while.'] },
    { t: 'The last patrol', tone: 'tense', where: 'road wilds', g: 'apoc', who: 'A patrol still in uniform', n: 'few',
      s: 'A patrol still in uniform, still following orders from a command that stopped answering long ago, halts the party for questioning. Their kit is immaculate and they are plainly starving.',
      tw: ['They do not know how bad things have got.', 'Their officer is long dead, and the sergeant signs in his name.', 'They are down to a few rounds each, and less patience.', 'They have orders to shoot looters, and a wide idea of what looting is.', 'They would stand down gladly if anyone with a scrap of authority told them to.'],
      esc: ['They decide to conscript the party.', 'They ask for news, and will not believe it.', 'One of them breaks down.', 'They find something in the party\'s kit that was army issue.'],
      gain: ['Maps and military supplies.', 'A reliable escort.', 'Soldiers who will remember being treated like people.'] },
    { t: 'Still open', tone: 'helpful', where: 'ruins settlement', g: 'apoc', who: 'A doctor and a helper', n: 'two',
      s: 'A doctor still runs a clinic in one corner of a dead hospital, treating anyone who brings something to trade. The waiting room is a corridor, and it is full.',
      tw: ['The medicine is running out, and the doctor is deciding who gets it.', 'The doctor was struck off, for a reason.', '{Faction} protect the clinic and take a cut.', 'The doctor is a vet, and has never said otherwise because nobody asked.', 'The helper does the real work. The doctor\'s hands shake too much.'],
      esc: ['A rush of wounded arrives at once.', '{Raiders} come for the drugs.', 'The doctor falls ill.', 'Someone in the corridor is recognised by someone else in the corridor.'],
      gain: ['Treatment.', 'Antibiotics.', 'A doctor who will come when sent for.'] },
    { t: 'The well', tone: 'tense', where: 'settlement farm', g: 'apoc', who: '{locals}', n: 'few',
      s: 'The only well for miles has a board nailed to it: poisoned. {Who} draw from it anyway, because the next water is a day\'s walk.',
      tw: ['It is not poisoned: someone wants it for themselves.', 'It is poisoned, slowly, and they do not believe it.', 'The board went up yesterday.', 'Something is dead at the bottom, and they would rather not look.', 'It is fine for adults. It is the children who are sickening.'],
      esc: ['Someone collapses at the well head.', 'Whoever put up the board comes back.', 'A fight breaks out over the water.', 'The bucket comes up with something in it.'],
      gain: ['Clean water.', 'Grateful neighbours.', 'The whereabouts of a second spring, kept secret until now.'] },
    { t: 'Collection day', tone: 'hostile', where: 'settlement farm', g: 'apoc', who: '{raiders}', n: 'double|same',
      s: '{Who} have come to collect what {place} owes them this month. They are relaxed about it, they know everyone\'s name, and the party is standing in the square when they ride in.',
      tw: ['The town paid for protection that never came.', 'One of the raiders grew up here, and his mother is watching.', 'The town means to fight this time, and is counting on the strangers.', 'The town has nothing left to give and has decided to offer people.', 'The collectors are skimming, and their boss would kill them for it.'],
      esc: ['Someone refuses to pay and is beaten in front of everyone.', 'The raiders take a hostage against next month.', 'More raiders are on the way.', 'The raiders notice the party\'s gear and add it to the bill.'],
      gain: ['The town\'s gratitude.', 'The raiders\' stores.', 'A month of peace, which is all anyone here asks.'] },
    { t: 'Quiet', tone: 'strange', where: 'wilds', g: 'apoc', who: 'Unknown', n: '',
      s: 'The birds stop all at once. The wind swings round and brings a smell that nobody can put a name to, and the hair stands up on every arm.',
      tw: ['A wildfire is coming.', 'A large group is passing close by, trying hard to be silent.', 'Nothing at all, and that is what unsettles.', 'The smell is chemical: something has split open upwind.', 'A storm is building, of a kind the old forecasts never had a name for.'],
      esc: ['Animals run past, all going one way.', 'Smoke shows on the horizon, getting closer.', 'Voices carry on the wind, and then engines.', 'Ash begins to fall.'],
      gain: ['A warning, in time.', 'Cover to move unseen.', 'Game driven straight into the party\'s path.'] },
    { t: 'The hatch', tone: 'strange', where: 'ruins wilds', g: 'apoc', who: 'Unknown, below', n: '',
      s: 'A steel door is set into the ground under a drift of leaves, sealed, with a keypad that still glows green.',
      tw: ['There are people inside, and they will not open it.', 'Someone the party knows has the code.', 'It is empty, and was emptied from the inside.', 'The people inside do not know that anything has happened up here.', 'The leaves were put there by hand.'],
      esc: ['An alarm starts to sound.', 'The door opens by itself.', 'Others have seen the party here and want in too.', 'A voice from a grille asks what year it is.'],
      gain: ['Sealed supplies.', 'A safe place to hole up.', 'Clean air, hot water and a locked door for one night.'] },
    { t: 'No grown-ups', tone: 'tense', where: 'ruins settlement', g: 'apoc', who: 'A gang of children', n: 'double',
      s: 'A gang of children runs the {ruin}. They have rules chalked on the wall, a court, a larder and lookouts, and no adult has been allowed past the door since the last one left.',
      tw: ['They are hiding a sick adult, and are frightened of losing her.', 'They were left behind by {faction}.', 'They scout for {raiders}, who pay in food.', 'The eldest is nearly grown, and by their own rules will have to go.', 'They are doing better than most towns, and know it.'],
      esc: ['They steal from the party.', 'An adult comes looking for one of them.', 'The smallest ones ask to be taken somewhere safe, and the eldest overhears.', 'They put one of the party on trial.'],
      gain: ['A guide who knows every way through the {ruin}.', 'A trade, driven hard.', 'Lookouts on every roof who now count the party as friends.'] },
    { t: 'The drop', tone: 'strange tense', where: 'wilds farm', g: 'apoc', who: 'Nobody, yet', n: '',
      s: 'A relief crate hangs by its parachute from a pylon, swinging gently. The markings are official, the stencilled date is last week, and nobody has flown anything over here in years.',
      tw: ['Someone is flying again, and this was meant for someone in particular.', 'The date is wrong. The crate has hung there since the first winter.', 'It was dropped as bait, to see who comes out of hiding.', 'It holds medicine for {sickness}, which nobody round here has yet.', 'Half the district saw it come down.', 'The stencil on the crate is the mark of {faction}.'],
      esc: ['An engine drones overhead, circling.', '{Scavengers} arrive with ropes and a ladder.', 'The parachute lines start to tear.', '{Authority} turn up to claim it as theirs by right.'],
      gain: ['Rations and medical stores.', 'Parachute silk and good cord.', 'Proof that someone, somewhere, still has aircraft.'] },
    { t: 'End of the line', tone: 'neutral helpful', where: 'wilds road', g: 'apoc', who: 'Carriage dwellers', n: 'same',
      s: 'A passenger train stands where it stopped on the day everything did. People have lived in the carriages ever since, with curtains up, stovepipes through the roofs and beans growing along the embankment.',
      tw: ['They are waiting for the line to reopen, and some of them truly believe it will.', 'The driver is still among them and still decides everything.', 'First class and third class have not spoken in a year.', 'The goods wagons at the back are sealed, and nobody will say what is in them.', 'They could get the engine moving, and are afraid of where they would have to go.'],
      esc: ['A carriage vote is called on whether strangers may stay.', '{Raiders} have noticed the smoke.', 'A child offers to show the party the sealed wagons.', 'Someone decides today is the day to try the engine.'],
      gain: ['A berth for the night and a hot meal.', 'Coal.', 'A handcar, and clear track for miles.'] },
    { t: 'The count', tone: 'strange neutral', where: 'settlement farm', g: 'apoc', who: 'A clerk with a ledger', n: 'one',
      s: 'A clerk in a worn suit is going from door to door with a ledger, taking a census: names, ages, trades, losses. He says the government sent him, and he asks the party to step up and be counted.',
      tw: ['There is a government, of a kind, and the ledger decides where it sends food.', 'There is no government. He started counting because somebody should.', 'The ledger goes to {faction}, who want to know who can work and who can fight.', 'He is looking for his own family, one page at a time.', 'People he counts have been disappearing.'],
      esc: ['Locals decide he is a spy and take his ledger.', 'He asks a question about the party that he should not have known to ask.', 'He reads back a name from an earlier page, and someone in the party knows it.', 'He falls ill and begs someone to carry the ledger on.'],
      gain: ['A look through the ledger, with every settlement for a hundred miles in it.', 'The party\'s names set down somewhere that might matter.', 'News of a missing person.'] },
    { t: 'The wind from the east', tone: 'hostile tense', where: '', g: 'apoc', who: '{raiders}', n: 'same',
      s: 'A wall of dust is coming up the valley, the kind that leaves people coughing blood. The only cover in reach is {shelter}, and {who} got there first and have barred the way in.',
      tw: ['They are as frightened as anyone and will bargain, fast.', 'They have prisoners inside.', 'There is room for everyone. They simply do not care.', 'One of them is outside too, shut out by their own side.', 'The dust is only dust this time, and nobody can know that.'],
      esc: ['The first grit starts to sting.', 'Others caught in the open come running for the same door.', 'Someone inside loses their nerve and opens up.', 'The light goes brown, then black.'],
      gain: ['Shelter from the storm.', 'What the storm uncovers when it has passed.', 'Their stores, left behind in the scramble.'] },
    { t: 'Lessons', tone: 'helpful', where: 'settlement ruins', when: 'day', g: 'apoc', who: 'A teacher and a dozen children', n: '',
      s: 'A teacher is holding class in the shell of a school: slates, one shared book and a map of a world that is not there any more. She asks whether one of the party would tell the children what is over the hills.',
      tw: ['The parents think school is a waste of hands, and this may be the last week.', 'She is teaching them to read so they can use what is in the locked cupboard: manuals, for everything.', 'One child has not spoken since arriving, and draws the same thing every day.', 'She was never a teacher. She was the caretaker.', 'The children know far more about what is over the hills than she does.'],
      esc: ['A child asks a question that has no answer both honest and kind.', 'A parent arrives to drag a pupil back to the fields.', 'The children follow the party when it leaves.', '{Authority} arrive to requisition the building.'],
      gain: ['A meal cooked by grateful parents.', 'A book the party has needed without knowing it.', 'An hour of feeling that the world might carry on.'] },
    { t: 'Headlights', tone: 'hostile tense', where: 'road', when: 'night', g: 'apoc', who: 'Unknown, in a truck', n: 'few',
      s: 'Headlights on the road, coming slowly. A lamp on the cab sweeps the verges on both sides, and now and then the truck stops and somebody gets down to look at something.',
      tw: ['They are collecting the dead.', 'They are hunting one person, and it is not the party.', 'They are slavers, working the roads while travellers sleep.', 'They are searching for their own lost child, and have not slept in three days.', 'They are {faction}, laying claim to this road one marker post at a time.'],
      esc: ['The lamp swings across the party\'s camp and comes back.', 'The truck stops, and the engine is switched off.', 'A second set of lights appears from the other direction.', 'Someone runs out of the dark, straight towards the party, with the lamp following.'],
      gain: ['A truck, fuelled and running.', 'Whoever they were looking for, and what that person knows.', 'A powerful lamp and the battery to drive it.'] },
    { t: 'Low water', tone: 'strange neutral', where: 'water', g: 'apoc', who: '{scavengers}', n: 'few',
      s: 'Drought has dropped the reservoir further than anyone has seen, and a drowned village stands in the mud: roofs, a steeple, a bus. {Who} are out there already, sinking to the knee.',
      tw: ['The village was flooded in living memory, and someone here was born in it.', 'Things were dumped in the deep end after the collapse, by people who wanted them never found.', 'The mud is not safe, and has already taken one of them.', 'The dam is cracked, which is the real reason for the low water.', 'The church bell is still up there, and a town nearby would give a great deal for it.'],
      esc: ['Someone goes in up to the chest.', 'Rain begins in the hills, and the water starts creeping back.', 'A find comes up that sets the diggers against each other.', 'People from below the dam arrive, wanting to know what has happened to their river.'],
      gain: ['Salvage nobody has touched in fifty years.', 'Sound timber and good slate.', 'Fish, stranded in the shallows by the hundred.'] },
    { t: 'The line is live', tone: 'strange', where: 'ruins settlement', g: 'apoc', who: 'Unknown', n: '',
      s: 'A telephone is ringing inside the {ruin}. There is no power for miles. It rings eleven times, stops, and a few minutes later starts again.',
      tw: ['Someone has strung field wire between a handful of buildings and is checking who is still alive.', 'The caller is a child working down a list of numbers.', 'The caller is trapped, not far away, and this is the only line that still connects.', 'It is how {faction} pass orders, and the party was not meant to hear.', 'Whoever answers is asked a question from before the collapse, as if nothing had happened.'],
      esc: ['It stops ringing, for good.', 'The voice says it can see the party from where it is.', 'A second telephone starts up, in the next building.', 'Someone else arrives to answer it, and is alarmed to find company.'],
      gain: ['A length of good wire and two working handsets.', 'A voice on the line who knows this district street by street.', 'A way to speak to someone a day\'s walk off.'] },
    { t: 'The siren', tone: 'strange tense', where: 'settlement ruins', when: 'dusk', g: 'apoc', who: 'Unknown', n: '',
      s: 'At dusk an air-raid siren winds up somewhere among the rooftops, howls for a full minute and dies away. Shutters close all along the street before it has finished.',
      tw: ['An old warden cranks it by hand every evening, as he was told to on the last day anyone told him anything.', 'It is a curfew, and those who break it answer to {faction}.', 'It warns of {beast}, which come in from the edges after dark.', 'It means the gangs are out, and it is the gangs who sound it.', 'Nobody here knows who sounds it. They only know what happened the night it did not.'],
      esc: ['The siren sounds a second time, which it never does.', 'A door opens a crack and a hand beckons the party in.', 'Many footsteps turn into the far end of the street.', 'The last open door on the street shuts.'],
      gain: ['A room behind shutters, and the local rules explained.', 'The siren itself, which can be heard for miles.', 'A warden\'s logbook of every night since the collapse.'] },
    { t: 'Under siege', tone: 'hostile', where: 'ruins settlement', g: 'apoc', who: '{raiders}', n: 'double|same',
      s: '{Who} have a chemist\'s shop surrounded. Someone inside has barricaded the door and is answering every demand by smashing another bottle.',
      tw: ['The one inside is the chemist, and would sooner destroy the stock than see it sold by the dose.', 'The one inside is a raider who changed sides.', 'The besiegers have {sickness} in their camp and are desperate, not greedy.', 'There is a back way in that only the neighbours know.', 'The shelves are nearly bare, and the smashing is a bluff with empty bottles.'],
      esc: ['The besiegers fetch fire.', 'The smashing stops, and nobody knows why.', 'They seize a neighbour and threaten harm unless the door opens.', 'The besiegers decide the party are with the one inside.'],
      gain: ['Medicine, whatever is left unbroken.', 'A chemist who can make more.', 'The besiegers\' goodwill, for what that is worth.'] },
    { t: 'Stand still', tone: 'tense', where: 'wilds farm road', g: 'apoc', who: 'A stranger, standing very still', n: 'one',
      s: 'Someone is standing alone in the middle of a field, feet together, not moving. They call out, quite calmly, that the party should stay exactly where it is.',
      tw: ['They are standing on a mine and felt it click.', 'The whole field is mined, and the party is already twenty paces into it.', 'They laid the mines themselves and have lost count.', 'There are no mines. They are keeping the party in the open for someone else.', 'They have stood there for hours, and their legs are going.'],
      esc: ['Their knees start to shake.', 'A dog trots out across the field towards them.', 'Someone on the far side starts walking in to help, not having heard the warning.', 'The light begins to go.'],
      gain: ['A map of the minefield, which is also a map of what it protects.', 'A sapper, alive and deeply obliged.', 'A safe lane through, known to almost nobody.'] },
    { t: 'Picture night', tone: 'helpful', where: 'settlement', when: 'night', g: 'apoc', who: '{locals}', n: 'crowd',
      s: 'Someone in {place} has a projector, a sheet and a car battery, and the whole town is sitting in the dark watching a film from before. Nobody asks strangers for anything but quiet.',
      tw: ['It is the only reel they have. Everyone knows every line, and says them.', 'The projectionist is charging the battery from {faction}\'s supply without asking.', 'With every guard in the audience, someone is using the evening to settle something.', 'A face on the screen belongs to someone sitting in the third row.', 'The bulb is the last one, and it is flickering.'],
      esc: ['The film snaps, and in the sudden dark somebody starts to cry.', 'A shout goes up outside: something is burning.', 'An argument about the ending comes to blows.', 'The beam picks out armed figures at the back who did not come for the film.'],
      gain: ['Two hours of peace.', 'A town that has seen the party laugh at the same things.', 'An invitation to come back, and to bring a new reel.'] },
    { t: 'Good dog', tone: 'helpful strange', where: '', g: 'apoc', who: 'A dog with a collar', n: 'one',
      s: 'A well-fed dog with a collar trots up to the party, sits, and waits. There is a tin tube on the collar, and the dog plainly expects it to be opened.',
      tw: ['The note inside asks for help, and gives a place half a day off.', 'The note inside is a week old, and the dog has been trying everyone.', 'The note is a shopping list, with payment promised. Someone trades this way and never shows their face.', 'The note is addressed to one of the party by name.', 'The tube is empty, and there is blood dried on the collar.'],
      esc: ['The dog sets off, looks back, and waits to be followed.', 'The dog starts to growl at something behind the party.', 'Someone whistles from far off, and the dog is torn.', 'Other travellers decide the dog would make a meal.'],
      gain: ['A working dog\'s loyalty.', 'A go-between who can reach someone unseen.', 'Payment, left under a stone exactly as promised.'] },
    { t: 'The chain', tone: 'hostile', where: 'water', g: 'apoc', who: '{raiders}', n: 'same|few',
      s: '{Who} have strung a chain across the river and moored a raft beside it. Every boat pays, and so does anyone on the bank who looks as if they might have crossed elsewhere.',
      tw: ['They are holding boat crews who could not pay, and working them on the chain.', 'The villages upstream are starving because nothing gets through.', 'They are careful, fair in their way, and keep the river clear of worse.', 'The chain is rusted through in one place, and one of them knows.', 'Their chief drowned last week, and they are pretending he is ill.'],
      esc: ['A boat tries to run the chain in plain view.', 'They send men along the bank to bring the watchers in.', 'The river rises and the raft begins to drag.', 'A prisoner goes over the side and swims for the party\'s bank.'],
      gain: ['A boat.', 'The river open again, and every village on it grateful.', 'Their takings: {scarce} by the sackful.'] },
    { t: 'Something gives', tone: 'neutral tense', where: 'road wilds', g: 'apoc', who: 'Nobody, at first', n: '',
      s: 'Something gives way under the party\'s load with a crack: an axle, a wheel, a pack frame, a boot sole. Nothing moves again until it is mended, and this is an exposed place to sit.',
      tw: ['It was tampered with at the last stop.', 'There is a wreck of the same make a short walk off, already half stripped.', 'The break shows up something hidden in the load that nobody in the party put there.', '{Travellers} bound for {place} stop to help, though they are late for something and keep looking at the sun.', 'The mend will hold for a day, and no longer.'],
      esc: ['Rain sets in.', 'Figures gather on a rise to watch, and do not come down.', 'The repair fails under the first real strain.', 'Dark comes with the job half done.'],
      gain: ['A better repair than the original.', 'Parts from the wreck, with some to spare.', 'A friend made of whoever stopped to help.'] },
    { t: 'Spoiled', tone: 'neutral', where: '', when: 'dawn', g: 'apoc', who: 'Nobody', n: '',
      s: 'The morning check finds that the party\'s food has turned: damp got in, or weevils, or a seal failed. Most of it is past saving, and the next sure meal is days off.',
      tw: ['Only the food bought at the last settlement has gone, and it went all at once.', 'Someone in the party has been eating it for two days already.', 'Something was at the packs in the night, and fouled what it did not take.', 'The water has gone bad too.', 'A smokehouse chimney shows over the next rise, on land held by {faction}.'],
      esc: ['The first stomach cramps begin.', 'Tempers shorten with every hungry mile.', 'Game is thin here, and somebody else is already hunting it.', 'Carrion birds start to follow.'],
      gain: ['A hard lesson in who sells honest goods.', 'A hungry day that ends at a stranger\'s table.', 'What little can be saved, boiled twice.'] },
    { t: 'Something fell', tone: 'strange', where: '', when: 'night', g: 'apoc', who: 'Unknown', n: '',
      s: 'A light crosses the night sky, slow and steady, too low for a star. It breaks into pieces that burn all the way down and come to earth somewhere beyond the next ridge.',
      tw: ['It was a satellite, and part of it is intact.', 'It was an aircraft, and someone got out.', 'Every settlement within a day\'s walk saw it, and each has its own idea of what it means.', 'It has started a fire where it fell.', '{Faction} have been waiting for exactly this, and already have people moving.'],
      esc: ['A glow rises over the ridge and spreads.', 'Riders pass in the dark, heading for the place it fell.', 'A preacher is on the road by morning, calling it a sign.', 'A flare goes up from where it came down.'],
      gain: ['Rare metals and wiring.', 'A survivor with news from very far away.', 'A story that will buy supper anywhere for a year.'] },
    { t: 'Cloudburst', tone: 'tense neutral', where: 'wilds road farm water', g: 'apoc', who: 'Nobody, at first', n: '',
      s: 'The sky goes the colour of slate and opens. Within minutes every ditch is a stream and every stream a river, and the party is standing on the lowest ground around.',
      tw: ['The rain tastes of metal.', 'The flood is uncovering things: fence lines, bones, the roof of a buried car.', 'A family is stuck on a roof downstream, waving a sheet.', 'The high ground belongs to {locals} who do not welcome company.', 'It is the first rain in months, and people are out dancing in it.'],
      esc: ['The road goes under.', 'Something big comes down on the current, straight at the party.', 'Lightning strikes close enough to smell.', 'The party\'s gear starts to float away.'],
      gain: ['Every container full of water.', 'Whatever the flood leaves on the bank.', 'A debt owed by whoever was pulled out.'] },
    { t: 'Wrong label', tone: 'neutral strange', where: 'road ruins', g: 'apoc', who: 'Nobody in sight', n: '',
      s: 'A shipping container lies on its side where a lorry shed it, doors still sealed. The paperwork in the cab says tinned fruit. The smell coming through the seals says otherwise.',
      tw: ['It is medical waste.', 'It is banknotes, tonnes of them, worth nothing and oddly hard to walk away from.', 'It is seed, treated with something that must never be eaten.', 'It is exactly what the label says, and the smell is the driver.', 'It was meant for {faction}, who have been searching for it ever since.'],
      esc: ['The seals give.', '{Scavengers} arrive with cutting gear and a claim of their own.', 'Whatever is leaking reaches the ditch, and the ditch runs down to a farm.', 'A second container is spotted further down the bank, and this one is open.'],
      gain: ['A cargo worth a fortune to the right buyer.', 'The lorry\'s battery, tyres and tools.', 'A manifest listing where the rest of the shipment went.'] },
    { t: 'Never sent', tone: 'neutral', where: 'road wilds', g: 'apoc', who: 'One of the dead', n: 'one',
      s: 'A body sits against a milepost, long dead, boots gone. Inside the coat is a letter, sealed and addressed to someone in {place}, and a photograph of a house.',
      tw: ['The letter is a confession.', 'The letter says where something was buried.', 'The letter is for {person}.', 'Under the coat the dead traveller wore the badge of {faction}.', 'There are a dozen more letters in the bag, in a dozen hands: this was a courier.'],
      esc: ['Someone else has been following the same trail, and catches up.', 'Whoever took the boots comes back for the coat.', 'The next person the party meets recognises the house in the photograph.', 'The seal comes loose in the damp, and the first line is hard to forget.'],
      gain: ['A reason to be welcome in {place}.', 'A courier\'s route notes, with safe houses marked.', 'The quiet satisfaction of finishing something for a stranger.'] },
    { t: 'Her ground', tone: 'hostile', where: 'wilds farm', g: 'apoc', who: 'A wild sow and her litter', n: '',
      s: 'The path runs between a wild sow and her litter before anyone sees either. She is the size of a small car, and she has stopped eating to look at the party.',
      tw: ['One piglet is caught in old fence wire, which is why she will not leave.', 'She is somebody\'s escaped breeding stock, ear tag and all, and worth a herd.', 'A boar is somewhere in the brush behind.', 'A hunter has tracked her for days and is lining up a shot.', 'She has already been wounded once today.'],
      esc: ['She charges.', 'The piglets scatter, squealing, through the party\'s legs.', 'The squealing carries, and something else in the brush answers.', 'Someone loses their footing.'],
      gain: ['Pork, if it comes to that.', 'A piglet to raise or trade.', 'A farmer\'s thanks for stock returned.'] },
    { t: 'Crows', tone: 'strange neutral', where: 'wilds road', when: 'day dusk', g: 'apoc', who: 'Crows', n: 'crowd',
      s: 'Crows have been following the party since morning, a few at first and now dozens, settling ahead and waiting. Locals say they follow whatever is about to feed them.',
      tw: ['They are following something else, which is following the party.', 'Someone in the party is sicker than they have admitted.', 'A hermit feeds them, and uses them to know who is coming.', 'There was a battle near here, and the birds have learned what armed people mean.', 'They have simply learned that travellers drop crumbs.'],
      esc: ['The birds all rise at once and wheel towards something ahead.', 'They begin to mob the party\'s food.', 'People who watch the crows come to see what they have found.', 'One lands on a pack and will not be shooed.'],
      gain: ['Warning of anything dead or dying for a mile around.', 'A hermit\'s hospitality.', 'An unsettling reputation that travels ahead of the party.'] },
    { t: 'Fires on the far hill', tone: 'helpful strange', where: 'wilds road', when: 'night', g: 'apoc', who: 'Unknown, far off', n: '',
      s: 'From the night camp a string of fires can be seen along a far hillside and, when the wind is right, singing can be heard. It goes on for hours.',
      tw: ['It is {travellers}, keeping a feast day they refuse to give up.', 'It is a funeral, and by custom anyone who hears is welcome.', 'It is {faction}, celebrating something the party will hear about tomorrow.', 'It is one person with many fires, who wants to seem like more.', 'The song is one that someone in the party knows from home.'],
      esc: ['The singing stops in the middle of a verse.', 'One fire starts moving down the hill towards the party.', 'A shot carries across the valley.', 'An answering fire is lit on the hill behind the party.'],
      gain: ['A welcome at a stranger\'s fire.', 'Knowledge of who else is in this country, and how many.', 'A good night, cheaply had.'] },
    { t: 'The permit office', tone: 'neutral tense', where: 'settlement', when: 'day', g: 'apoc', who: '{authority} and a long queue', n: 'crowd',
      s: 'In {place} nothing may be bought, sold or carried out of the gate without a stamped chit. The office that stamps them has one clerk, one stamp and a queue that goes round the square.',
      tw: ['The clerk is the most powerful person in town, and knows it.', 'Forged chits are sold in the queue itself, and the guards know which are which.', 'The system works: nobody here has gone hungry in a year.', 'The stamp was carved from a potato after {faction} made off with the real one.', 'The queue is where the town does its real business, and nobody minds the wait.'],
      esc: ['The office closes for the day with the party three from the front.', 'A guard asks to see the chit for the party\'s own gear.', 'Somebody is dragged out of the queue with a forgery.', 'The clerk takes a personal interest in the party\'s business.'],
      gain: ['A stamped chit, good in three towns.', 'A clerk who can make problems disappear.', 'An hour of gossip from the best-informed queue in the district.'] },
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
