# Cross-browser tests

Automated checks that Campaign Chronicle behaves the same in **Chromium**
(Chrome, Edge), **Firefox** and **WebKit** (Safari, and every browser on
iPhone/iPad), on desktop, phone and iPad-sized screens. Set up the same way as
Sinless's suite, with PHP and MySQL added because this app has a server.

They run on GitHub Actions on every push and pull request
(`.github/workflows/browser-tests.yml`), one job per project:

| Project | Engine | Emulates |
|---|---|---|
| `chromium` | Chromium | desktop Chrome / Edge |
| `firefox` | Gecko | desktop Firefox |
| `webkit` | WebKit | desktop Safari |
| `mobile-safari` | WebKit | iPhone 13 (touch, 390px) |
| `mobile-chrome` | Chromium | Pixel 7 (touch, 412px) |
| `ipad` | WebKit | iPad, 7th generation (touch, no hover, 810px portrait) |

A failed job uploads a `report-<project>` artifact with the HTML report,
screenshots and a trace (open with `npx playwright show-trace <trace.zip>`).

## What's covered

- **chronicle-access**: Chronicle approves its own users apart from Sinless: an account approved for Sinless asks
  for Chronicle on its first sign-in here and waits; approving, revoking or removing someone in Chronicle leaves
  their Sinless access and shared account alone; migration 020 carries everyone's access over as it was.
- **access**: every API action (read from api/index.php and api/fanwikis.php, so a new one fails until it is
  given a group) refuses anyone signed out or waiting for approval, anyone outside the campaign, and a player on the
  GMs' actions; only site admins manage accounts.
- **signin**: the signed-out screen shows the Google and GitHub buttons and
  keeps the page you were going to; the API refuses anyone signed out; a new
  account waits for approval and gets in once approved; a revoked account is
  locked out; the admin identity is approved as admin; an account from before
  Google/GitHub sign-in is taken over by the email an admin linked to it;
  sign-in starts are rate-limited per IP.
- **campaign-copy**: a GM copies a campaign from the campaign list into a new one they GM alone: everything in it (every
  table, the ids inside pointing at the copy's own rows, and its files copied on disk so they outlive the original), or
  only its setup (calendar, date, settings, regions, holidays, tag and relationship lists); every table with a
  campaign_id must be in the copy, so a new one fails here until it is added; a GM deletes a campaign from the list
  only after typing DELETE; players get neither button, and the API refuses them both.
- **account**: the account page lists only the campaigns you belong to, each with your role, and a
  character name typed there is the one the Members tab shows; the None / Imperial / Metric units choice
  sets the travel planner and temperatures, None follows the campaign, an older temperature-only choice
  reads as its system, and anything else is refused; a campaign's Default units in Settings is the same
  Imperial / Metric choice with its own Show temperatures switch, and an older temperature unit there reads as its system.
- **campaign**: a GM creates a campaign and every tab renders with no script
  errors; Cancel (or the browser's Back) on the new campaign form goes back to the campaign list,
  for a first campaign and with others already there; a custom calendar is created with its own number of months, each
  with its own length, and a week of its own length and day names; a custom calendar takes leap days in a month and a leap rule
  (every N, except every N), which the year and month lengths and weekdays follow, and
  Settings spells out the next leap years; members are added by sign-in email, only once approved; players never
  receive secret events; a GM picks people they already play with from the approved accounts not yet in
  the campaign, which only GMs can list.
- **setting-presets**: the Forgotten Realms preset keeps Harptos's tendays,
  festival days outside them, Shieldmeet every fourth year and Selûne's known
  full moons; Eberron's months all start on Sul, with its twelve moons and
  holidays; Exandria's 328-day year, seasons and holy days; Golarion's Leap
  Day, real-world-aligned weekdays and the last-Sunday Breaching Festival;
  the Galactic Standard Calendar's 365-day year of five-day weeks that always
  starts on Primeday, BBY/ABY years and festival weeks;
  every setting region has a Köppen climate; a GM starts a Forgotten Realms
  campaign with its holidays and regions, and About & sources cites all four; Glorantha's Red Moon goes through its seven
  named phases every week (Black on Clayday, Full on Wildday from Dragon Pass), each region sees the phase of its own land
  (Glamour always Full, chosen in the region's form), a campaign made before keeps it, and it is drawn red and black.
- **holidays**: the last and Nth-from-last weekday of a month, every Nth year,
  moon-phase holidays and limited runs (between two years, or N times) fall on
  the right days; a GM builds them in the holiday form, which shows only the
  fields each rule needs, and the calendar shows them.
- **year-view**: the year view shows every month with today ringed, marks days
  with events and lists them in the tooltip, steps a year at a time, opens a
  month from its name and a day from its number, and never gives a player a
  secret event.
- **inline-secrets**: a GM marks a paragraph of the day's Public notes GM only with the 🔒 button; it is stored as `<aside>` and players never receive it from the day, the previews, the search sources or the Search page; a player's save of an entry or tome keeps the GM's secret paragraphs in place (or at the end when their paragraph is gone) and drops any the player sends; plain-text notes are left as typed; View as player answers the GM as a player and refuses changes until they leave; typing `@` lists matching names and aliases, writes the picked name, Escape leaves the `@`, and the last line adds a new entry; Reveal makes a run of GM-only paragraphs public in an entry or tome, optionally logged as a Revealed event on today, refuses a stale page and refuses players.
- **sessions**: notes start a session through the API, join it in order (five at once each get their own place) and a new one starts after End session; a session's notes box takes a line per note (Enter and Tab only type, Add to notes or Ctrl+Enter saves them, Shift+Tab outdents, `!` and `?` lines show their marks, `@` lists Encyclopedia names, a note's text is changed with a click and deleted with ✕); what is typed waits in the box across a reload; `>` jumps move the notes' day and shift (a bad one names its line and adds nothing), carry on after a reload and only move the campaign's clock with Set the clock here; notes the server can't take stay in the box and a retry after a lost reply adds them once; ⇥ indents on a phone; Import to a session on Current Day copies Public and Secret notes into a new or existing session, the secrets under a 🔒 line the draft keeps GM-only; the Sessions tab sits after Events, has a remembered Wide view, the summary is the wide column with Title and Played on folded under ✎ Details once titled and Include notes and Delete in the ⋯ menu, notes are grouped under a heading per shift (a `>` jump heads its own) with no time on each note, Session Rewards and Loot Found sit under the summary, save with it, the GM reads a written session as players do with the Encyclopedia's names linked and ✎ Edit opens the editors (Save goes back to reading), reach players only once published (GM-only paragraphs stay out) and go in the export, Build draft fills the summary and ticks the notes it used, asks before replacing or adding below, the summary saves and a stale save is refused; title, date played and Published; players get only published sessions, never the notes, the box or GM-only paragraphs, read the summary with names linked, export it as Markdown (the GM's export can add the notes) and find it in Search; notes move between sessions and a session deletes with its notes; a phone shows notes and summary as two tabs, opening on the summary once there is one. **sessions-logic** (under Node): the date reader, the notes box's lines and indents, every `>` jump form in four-shift, two-shift and hours mode, the marks, and the draft's paragraphs, headings, escaping, loose ends and 🔒 blocks.
- **search**: the box with the tabs (a 🔍 tab on a phone) opens the Search page, which finds Encyclopedia names, aliases, tags and notes, events by title, tag and text, day notes and Library tomes, grouped and with matching titles first; every word must match; a result opens its page and Back keeps the search; a GM's secret results are marked and a player finds none of them; `/` jumps to the box.
- **timeline**: the Events tab's List | Timeline switch is remembered; the timeline draws the events the search, tags and When leave, in lanes by tag (with Untagged) or in one lane, a one-day event as a dot and a longer one as a bar, close up an event with shifts as a bar over just those, secret events with a 🔒 dashed edge, a Sessions band and a line for now; the zoom buttons, arrow keys, wheel and drag move it; ⬇ PNG downloads a picture; an event opens its day (a second tap on touch); a player gets neither the secret event nor an unpublished session. Under Node: where an event runs in days and shifts, the lanes, the row packing, the axis's days, weeks, months, years and counts of years in the campaign's calendar and eras, the zoom buttons, and the season and holiday bands.
- **events**: an event runs from a Shift Start to a Shift End (Shift End follows
  Shift Start) or all day, takes starter and new tags whose colours show in week
  view, an event saved the old way still shows, and Go to today opens today.
- **table**: At the Table sits first under Party and shows the date, shift, weather, light, moons and the party's
  region; Pass a shift moves the clock; an Encyclopedia lookup finds names (never a secret entry for a player); a note
  goes on the current shift or, escaped, at the end of an entry's Public notes (a GM's GM-only one in its GM notes, a
  player never on a secret entry). Panel links: members make and revoke their own, only GMs make public ones and revoke
  anyone's, and only the code's hash is stored; a link reaches only its own campaign (the cid asked for is ignored) and
  its short list of actions, needs no CSRF token, acts as its maker (a player's can't pass time), and stops when its
  member leaves; a public link gets no secret event, entry, GM note, GM reminder or weather seed, changes nothing, and
  stops when its GM stops being one; the Owlbear Rodeo manifest is public with CORS and opens panel.html; only
  panel.html may be framed (.htaccess). panel.html opens with only a link and no cookie in a frame on another origin,
  catches up when the GM passes time, takes the code out of the address, and asks for a new link once revoked; a
  public overlay link is see-through with only the date, weather, light and moons; the GM makes a link from At the
  Table, sees it once, and revokes it.
- **current-day**: a campaign opens on the Current Day tab and the GM's browser
  saves today's shift weather; players get today's weather only up to the current
  shift (never the forecast), nothing for later days, and everything once allowed;
  Previous/Next day and Return to today stay on the tab and keep that rule; the
  day's Locations visited saves, survives a re-roll and is shown to players.
- **day-notes**: the GM writes bold text and a table in the Public notes and a Secret note, and they save as cleaned HTML and reopen in the editor; tables wait behind ⋯, and ⤢ Focus gives the editor the whole window until Esc; players read the formatted Public notes, never the Secret ones, the month grid previews them as plain text and the export turns them into Markdown; scripts, images, styles, attributes and javascript: links are stripped on the server, and HTML put straight into the database is still rebuilt from the allow-list in the browser; a plain note from before shows as typed; every day box folds and stays folded per account in that browser, and adding an event unfolds Events.
- **encyclopedia**: the Proper Noun Detector finds capitalized, bold/italic and quoted names and a day's
  Locations visited, leaves out common and calendar words, members' names, shift actions and any lone word that only
  opens a sentence or a Title Case title (unless it is also capitalized mid-sentence, or a region or holiday), keeps runs
  like "Anne of Green Gables" whole, reads each line of a holding's name and place as a name, guesses each name's tag from the words around it, and offers a name that overlaps an entry
  as another name (alias) for it; saving notes offers them to Add (with a tag, and GM only when found only in GM-only
  text), Alias, Ignore or Skip (remembered until the page reloads); entries are linked where players read the names
  (aliases too, with the entry's first line on hover), a link opens the entry, Blank Entries lists the new ones, an
  entry quotes where it was found with Add to notes, players write Public notes but never get GM notes, secret entries
  or the GMs' ignored words; Scan campaign offers every missing name, and entries keep tags of their own; an entry's Category groups the list,
  and the Category, Tags and Connections dropdowns filter it with Select all / Deselect all and counts; migration 018
  turns Location, Person, Item, Group and Vehicle tags into Categories;
  Generate Summary asks (a faked) Wikipedia only when pressed, lists the matching articles with their descriptions,
  and adds the picked summary to the Public notes with a link to the article and CC BY-SA 4.0; a name with several
  meanings is labelled and lists the meanings from its disambiguation page, in its order and without See also; no
  article or no connection says so in a line;
  the Link dialog connects one entry to many with one kind of connection, each page reads it from its own end ("Has
  resident" / "Resident of"), the same fact made from either end or with the labels typed the other way round is one
  row, a symmetric kind is kept once, unticking removes, and deleting an entry takes its connections; players never get
  a GM-only connection, one touching a secret entry, or a label used only by those, can't set GM only and remove only
  their own; the notes suggest connections (a "Residents:" line suggests the label), and the list searches, filters by
  connection chips and "Show in list"; renaming a kind changes every page; the Wide list button swaps the widths of the list and the
  entry and this browser remembers it, and is hidden where the page is one column.
- **sheet-templates**: a template built by hand saves exactly the layout typed, and the library finds it with its game, use count and forks; forking someone else's (which has no Edit button) makes an editable copy that credits the original, which counts the fork; dragging a field's handle reorders it by mouse, and by a finger through Chromium's touch events on a phone. **sheetlayout** (under Node): the layout checker's rules for keys, types, counts and the optional VTT mapping.
- **sheet-import**: a fillable PDF drafts fields from its form fields with its page shown beside the editor under the notice that it isn't kept, and no request ever carries the PDF; a scan with nothing to read and a text file renamed .pdf each say what to do.
- **sheets**: the database has the new tables and the upgrade finds nothing left to do; anyone makes, lists and forks a template, only its author edits it, a bad layout is refused naming the problem and a save from an older copy is refused; a character's Encyclopedia entry follows its renames, a GM adds a sheet to an existing NPC entry, the active character's name is its player's, PC and NPC switch back and forth and the sheet changes hands; two people change different fields at once, a template change moves a value that no longer fits to old fields, a removed member's sheets stay for the GM; players never receive a secret NPC or a hidden field, and only a PC's player renames it or hides parts of it.
- **characters**: a player makes a character from the Characters tab, fills it in, finds it again and hides a section; quick taps on the Play view end on the last one, on screen and saved; a player sees an NPC's card but not its sheet; the GM hands a sheet to another player; the player and the GM on one sheet see each other and the GM presses Edit first, and an Edit that runs out goes back to reading; a failed save puts the sheet back as the server has it; someone else's change doesn't overwrite a tap still being saved; *Use theirs* keeps the other person's value.
- **starter-templates**: every file in `db/starter-templates/` is a valid layout with at least four fields, short labels and its source (under Node); an admin loads them and loading again updates them; About lists each game and the sheet it was built from.
- **find-image**: Find Image's sources answered by `tests/support/image-stub.php` (named as `image_search.stub` in the test
  config, so nothing leaves the machine): Openverse, the museums (the Smithsonian's record without a CC0 picture left out) and DeviantArt list results in one shape with their
  licences, the mature work and anything closed left out of Use this picture; a source that is down says so while the
  others answer; outsiders can't search and members may make 30 searches a minute; Use this picture copies an open
  picture with its credit, refuses a closed one, keeps the thumbnail when the full picture is too big, ignores a
  player's GM only and refuses them on a secret entry; Embed from DeviantArt keeps only the link, redirects to
  DeviantArt's picture, asks oEmbed again after 6 hours, says the work is gone once oEmbed does, and refuses a picture
  on another host; the panel opens with the entry's name, shows credit links, adds a picture with its credit line,
  and a closed DeviantArt work links to the work and the artist in new tabs and embeds.
- **fan-wikis**: the fan wikis answered by `tests/support/fanwiki-stub.php` (named as `fan_wikis.stub` in the test
  config): anyone gets the list with each wiki's licence; members search a wiki and get an article's opening paragraphs
  without its infobox, footnote marks or tables, credited with the licence the wiki states (Fandom's "CC-BY-SA" keeps
  the list's 3.0; CC BY-NC is named non-commercial; a wiki with no licence, whose api.php is found from its main page,
  is personal fair use); pictures list the article's first, leave out sound files, come through the server's thumbnail
  proxy (which refuses other hosts), and copy open ones with their credit and the rest as "Personal fair use"; the GM
  picks the campaign's wiki in Settings, which players get too, an entry adds the summary with its source and licence,
  Find Image has a tab for the wiki; Settings suggests a wiki from the campaign's name but nothing is looked up until it is saved, and None keeps a game of its own wiki-free; About lists every
  wiki, the non-open ones under No open source. Checks that need api/fanwikis-nonopen.php skip once the kill switch
  has removed it.
- **session-pictures**: a GM adds a map to a session and changes its caption; players see it only once the session is published, never a GM-only one, can't add, change or remove pictures there, and see no Pictures box on a session without any; deleting the session deletes its pictures; the viewer zooms a 1200×800 map in with +, to 1:1, back to Fit and with a click, scrolling inside itself while zoomed.
- **attachments**: a GM adds a picture and a PDF to an Encyclopedia entry from the page; the picture shows and opens
  full size with its caption, the PDF downloads; players see both, add and remove their own, but can't change or
  remove the GM's; GM-only files and every file on a secret entry are never listed or sent to players, and making a
  file GM only or its entry secret takes it away at once; nobody outside the campaign, or signed out, gets a file;
  deleting the entry deletes its files from disk; SVG, PHP, HTML, a fake picture, a picture named as another type, an
  empty file, a file over the size limit and one over the campaign's total are refused; file names lose their folders;
  files are sent sandboxed with nosniff, text and PDFs as downloads, and only revalidated from the cache.
- **eras**: era abbreviations label their years, a restart era counts from 1 and
  a "before" era counts back (the Gregorian preset has no year 0); a GM types eras
  in Settings, the month title uses them and the date picker takes a year in an
  era; a second "before" era is refused.
- **shifts**: a GM picks baseline actions into a shift's activity next to
  their own text, and it saves; a player names their character on the Members tab, and
  their shift notes and events are signed with it; the GM adds shift notes too.
- **calendar-notes**: the month grid and week view preview day notes and shift
  notes, and GM notes for GMs only, which the server never sends to players.
- **downtime**: a long rest takes at least half the day, labels the shifts after
  now next to their activity and moves the clock; a short rest of 0 shifts marks the
  current one; downtime covers whole days and its label comes off when deleted; the GM
  picks activities, custom ones and players; players see them and edit only the public
  notes, never the GM notes.
- **holdings**: Party Funds keeps one line per currency with where it is kept, saved as you leave each box, for players and the GM; a player adds Gear and Loot from the last row, ticks its count (never
  below 0) and edits its boxes, and the GM sees and removes it; the Add holding dialog
  shows each type's own fields, takes a custom construction type, a custom holding
  type and tags of its own (apart from the events'), and its card ticks, edits and deletes for GM and players alike.
  Each holding's Storage ledger adds up its items' weights and warns when the total
  is over the holding's Cargo.
- **maps**: the Maps tab sits after Generators; a GM adds a map with its picture (uploaded or from Find Image), scales
  it by two points or grid squares (a `30x20` file name fills in the square size, the Roll20 button 70 px = 5 ft, and the
  grid offset is the first click's position modulo the square), and measures; an unscaled map says so; a 6000 × 4000
  picture opens; a GM-only map, its picture and its pins never reach players; players add public note pins and change
  only their own; GMs pin new or existing entries and events, which link back with 📍, save routes, and turn a player's
  pin into an entry (or link it to the one of that name); replacing or deleting a map's picture leaves no file behind.
- **mapgeo**: `static/mapgeo.js` sets a scale from two points or grid squares, reads square sizes from file names,
  and shows distances in the reader's units, with AU and light-years on space maps.
- **party-groups**: a campaign starts with one main group holding every player, and a late joiner goes into it; GMs
  split and merge groups on the Travel tab; the main group's region is the current region both ways; a side group's
  trip moves the clock but leaves the main party's region and shifts alone; markers move with Depart, are flags or
  their token, and only GMs drag them; members who leave or become GMs drop out of every group.
- **tokens**: GMs upload many tokens at once, named after their files, assign them to characters, entries and the
  party, filter them, and delete them, which clears what used them; players never see the tab, a GM-only token or
  its picture.
- **library**: the Library tab sits just under the Encyclopedia; a player adds a journal with a title, a description and
  formatted contents, the GM opens and changes it and the player sees who changed it; search and the kind buttons narrow the
  list; a save from an older copy is refused naming who saved since, the contents are cleaned of scripts, images and unsafe
  links, a bad kind or empty title is refused, only the author or a GM deletes, and someone outside the campaign gets nothing; saving a tome offers its new names, and Scan campaign finds names in tomes,
  downtime, holdings and Gear and Loot (but not the Long Rest label a rest writes), with an entry quoting the tome it was found in; the 🔍 Scan button on a tome or an entry offers only the names in that one, an entry's GM notes included, and says when none are missing; a player adds a picture to the GM's tome and the GM sees it on the page
  and in the editor, anyone can take a tome's files off, and deleting the tome deletes its files.
- **generators**: every generator gives real text for every genre, people, line of business
  and size, and a seed repeats it; street names, cyberpunk handles and cyberspace handles come in every genre with a real name each, made for the chosen people and gender; rumors use the names they're given; modern names follow each culture's order and forms (Japanese family name first, Russian
  feminine surnames) and gender-neutral names come from their own lists; a GM switches genre (remembered), re-rolls, sees just the names with no family name twice, turns on looks and quirks, and adds a town and one of its people
  to the Encyclopedia as GM only, picks a cyberspace handle as the Names card's Kind and adds one with its real name as notes, then a company for everyone; rumors name the campaign's own tagged entries and one is added as a Rumor; a player has no GM only switch and never sees the GM's.
- **travel**: overland, sea and air each list only their own sample speeds, and
  picking one fills the planner; one Metric/Imperial switch converts every
  distance and speed box; a trip is planned in shifts a day, each a quarter of the calendar's day;
  Determine shifts in the shifts-a-day box gives the whole shifts a trip needs, with terrain;
  star pickers fill the light-years between two systems; hyperspace multiplies a sample
  trip's Class 1 time by the hyperdrive class and route; the campaign's genre
  (Settings) limits the modes and samples, and a campaign with none keeps them all;
  a Custom region typed on the day page or in the travel planner joins the campaign's regions; a trip's From and To join
  the first and last days' Locations visited; the trip's event is tagged Transit, and so is any event running in a shift
  given an On the move action (on the day page or in Pass time), keeping its other tags.
- **time-modes**: four shifts, two shifts (Day and Night) and hours each have
  their slot names, weather quarters and travel maths; switching a campaign's mode
  moves the clock, shift activities, shift notes and timed events to the same time
  of day; in hours mode the day page, pass-time box and travel planner count hours.
- **export**: the day page's Export button downloads the day as Markdown; the
  GM's file has secret events and GM notes, a player's has neither and leaves
  out the weather of shifts that haven't happened yet.
- **calendar-file**: Settings exports the calendar, its holidays and the date reached
  as JSON; importing it into another campaign's Settings replaces the calendar and adds
  the holidays it lacks (only once), a file that isn't a calendar is refused, and the
  new-campaign form starts a campaign on the file's calendar, holidays and date.
- **scabard-import**: Settings → Tools → Import from Scabard refuses a file that isn't JSON or isn't a Scabard export,
  says what the export holds (entries by kind, session logs, connections, pictures, what is left out) and follows the
  Sessions / Encyclopedia entries choice; the import makes entries with their kind and category tags, other names,
  summary-then-description notes (`div` → `p`, `span` unwrapped, Scabard links as text), GM notes, secret pages as GM
  only, a `Player:` line, names cut to 150 characters, fills in a blank entry and keeps one with notes; connections read
  from the right end on the starter kinds and new ones, a former one noted, a secret one or one touching a secret entry
  GM only; dated events become published, closed Sessions with the secrets as GM-only paragraphs and Participants,
  Setting, Protagonists and Part of lines; the picture comes from the image stub's `www.scabard.com` with a Scabard
  credit, while one hosted elsewhere or gone is reported; players get none of the GM's side and can't import; a second
  run keeps everything and doubles nothing. The reader (`static/scabard.js`) splits dated names, plans and batches.
- **reminders**: a GM's reminder, added from today's page on the next shift, pops up for
  the GM when time passes to it and on a player's open page at its next check; Dismiss stops
  it for that person only, Remind me later until the clock moves or the page reloads; moving
  it re-arms it; players keep only their own reminders and never see the GMs' or another
  player's; a time the clock has passed is refused; switching to hours moves reminders with the clock.
- **changes**: a player's open page offers a Refresh banner after the GM saves a
  change, and Refresh loads it on the same tab; a player's own note and the GM's
  own saves don't announce themselves.
- **ui**: deleting asks in the in-page dialog (never a browser `confirm()`),
  and Cancel keeps the item; the light/dark toggle is remembered; a colour theme picked
  from the top bar is remembered and follows the account to a new device; fonts load
  from this site only.
- **touch**: on a touch screen a tooltip opens on tap and closes on a second
  tap or a tap elsewhere, while a tap inside a link still follows it; the theme
  menu closes on a tap or click outside it; every campaign tab is on screen at
  tablet and desktop widths; the Legend's Play, Party, World and Setup groups fold
  and unfold (Setup starts folded), stay as left after a reload, and a folded group
  still shows the open page's tab, while across the top nothing folds; the Legend
  has no heading, and its « button tucks it away to the left (giving the page the
  room), leaving a rail down the window that brings it back from a click anywhere
  on it, as left after a reload.
- **install**: the page links a manifest with the name, start page and 192/512 and maskable icons Chrome needs to offer *Install app*, and every icon loads; the installed window's title bar colour follows the theme and light/dark mode; the service worker (Chromium only) takes control without serving any script or API call itself, caches only the offline page, and shows it when the app is opened with no connection.
- **engine-parity**: `static/engine.js` gives exactly the same calendar, moon,
  season, weather, visibility, travel and star-distance results in the browser as under Node.

Tests sign in through `tests/support/login.php`, which runs the same
`sign_in_identity()` as the real OAuth callback with a made-up identity. It
only works when the config sets `'test_login' => true` and the request comes
from this machine, and `.htaccess` returns 404 for `tests/` on a real site.

## Running locally (needs Node 18+, PHP 8 with pdo_mysql, and MySQL or MariaDB)

```sh
cd tests
npm ci
npx playwright install --with-deps     # first time: downloads the three browsers
DB_USER=root DB_PASSWORD=secret npx playwright test                 # all projects
DB_USER=root DB_PASSWORD=secret npx playwright test --project=firefox
```

Each run drops and recreates the `chronicle_test` database (override with
`DB_NAME`, `DB_HOST`, `DB_PORT`) from `db/schema.sql`, using the `mysql`
command-line client. The config starts `php -S` on port 8755 for the repo root.
