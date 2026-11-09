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
- **hardening**: an exception that isn't a database one still answers JSON (`server_error`), never PHP's HTML page; an
  outbound reply larger than its cap is refused, with or without a Content-Length; `X-Forwarded-For` is believed only
  from the config's `trusted_proxies`, and only its nearest hop that isn't one of them; the API refuses to run on a
  database whose newest migration hasn't run, or with a table missing (`needs_upgrade`), and a fresh install passes.
- **performance**: a campaign load builds each entry's preview from the start of its notes only, and a GM-only paragraph
  the cut runs through never reaches a player; an entry's page asks encyclopedia_sources for only the text naming it.
- **quotas**: an Encyclopedia entry or a day's notes saved from an older copy is refused (`stale`) instead of
  overwriting someone else's save, and a line added from At the Table counts as a save; the weather saves unchecked; an
  account has room for 50 campaigns of its own, a campaign for 40,000 days, and an account for 50 MB of saves a day.
- **access**: every API action (read from api/actions.php, the table the router runs on, which must list every action
  the code answers) refuses anyone signed out or waiting for approval, anyone outside the campaign, and a player on the
  GMs' actions; only site admins manage accounts.
- **calendar-text** (under Node): the Settings tab's calendar boxes read back as the same calendar (festival months,
  leap days, moons, eras, a month's week names), and a box that can't be read says why.
- **cross-campaign**: a GM of two campaigns calls every campaign action on one with every id parameter (read from the
  code) pointing at the other's rows; nothing of the other campaign comes back and none of its rows change.
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
- **campaign-stars**: the campaign list is sorted by name (ignoring case) with starred campaigns first; a star is each
  person's own, kept in their preferences across reloads, and only on a campaign they belong to.
- **reports**: the ! button in the top bar sends a report with a screenshot taken in the browser and the page's details,
  which it lists first; the server takes only a real picture and only site admins read reports or their screenshots; Site
  Admin's Reports tab resolves one unfixed, reopens it, sends it to GitHub (a stub) without who sent it, and deletes it.
- **game-requests** (Chromium only, as the on/off switch is site-wide): Request a game on Sheet templates reaches Site
  Admin's Sheets tab counted once per person per game whatever the spelling; only admins read them; switched off, the
  button goes and the server refuses new ones while the list stays; Clear takes a game off.
- **account**: the name and pronouns set on the account page are what the top bar, Members, Site Admin and
  the account probe call you by, a new Google or GitHub sign-in doesn't undo them, blank goes back to the provider's
  name, and a name over 150 characters is refused; the page no longer lists your campaigns; the None / Imperial / Metric units choice
  sets the travel planner and temperatures, None follows the campaign, an older temperature-only choice
  reads as its system, and anything else is refused; a campaign's Default units in Settings is the same
  Imperial / Metric choice with its own Show temperatures switch, and an older temperature unit there reads as its system.
- **campaign**: a GM creates a campaign and every tab renders with no script
  errors; Cancel (or the browser's Back) on the new campaign form goes back to the campaign list,
  for a first campaign and with others already there; a custom calendar is created with its own number of months, each
  with its own length, and a week of its own length and day names; a custom calendar takes leap days in a month and a leap rule
  (every N, except every N), which the year and month lengths and weekdays follow, and
  Settings spells out the next leap years; members are added by sign-in email: an approved account joins at once, any other address is an invitation
  taken up once that person is approved and opens the campaign (or their list), which a GM can cancel; players never
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
- **sessions** (unlinking): a shift chip's ✕ takes a shift the session takes in out of it, and the first shift of its run
  moves its start on one; the last shift moves its end back; a shift in the middle of a run is refused; In-game dates…
  sets the start and end by day and shift; + Add a shift… puts one more in by day and shift.
- **sessions**: sessions open, end and reopen, one open at a time; a session keeps the shift it started and ended on, a day changed by hand takes the shift with it, a title alone leaves them, reopening clears the end, and a session from before keeps whole days; a session's notes save as text through `session_notes_save`, a save from an older copy is refused (`stale`) and the same text sent again passes; the notes box is one text box that saves as you type (Enter and Tab type, Shift+Tab outdents, `@` lists Encyclopedia names, a `>` jump it can't read is named under it, a reload keeps it all, and there is no Add to notes); a session's old note rows and lines typed in the old box and never added go into the box in order, with their indents and a `>` line where a note was on another day, and are saved as text at once; notes the server can't take are kept in the browser across a reload and saved once it can; notes changed in another tab aren't overwritten, and the GM picks Load the saved notes or Keep mine; ⇥ indents on a phone; Import to a session on a day's calendar page adds Public and Secret notes to the end of a new or existing session's box, the secrets under a `$` line the draft keeps GM-only; the Sessions tab sits after Events, has a remembered Wide view, the summary is the wide column with Title and Played on folded under ✎ Details once titled and Include notes and Delete in the ⋯ menu, Session Rewards and Loot Found sit under the summary, save with it, the GM reads a written session as players do with the Encyclopedia's names linked and ✎ Edit opens the editors (Save goes back to reading), reach players only once published (GM-only paragraphs stay out) and go in the export, Build draft (under the notes) fills the summary, gathering the activities, players' notes and GM-only GM notes of the shifts the session ran over and none outside it, asks before replacing or adding below, the summary saves and a stale save is refused; title, date played and Published; players get only published sessions, never the notes, the box or GM-only paragraphs, read the summary with names linked, export it as Markdown (the GM's export can add the notes) and find it in Search; a session deletes with its notes; a phone shows notes and summary as two tabs, opening on the summary once there is one; a session takes in shifts outside its run (one inside it is already covered), the day says which sessions cover each of its shifts (a player only the published ones), a player can't add one, and one is taken out again; a session made with a first and last shift is written up afterwards and leaves the open one open, and one made with a first shift alone starts there as the open one; + Session… on a shift card puts it in the session picked, its chip opens the session, which lists it under Also takes in and says "and 1 other shift", Build draft gathers it before the run it came before, and ✕ takes it out; + New session asks Starting when? with the clock's shift filled in, and Played already makes an ended one while the open session stays open. **sessions-logic** (under Node): the date reader, the notes box's lines and indents, every `>` jump form in four-shift, two-shift and hours mode, the marks, the box's text read as notes stamped by its jumps, old note rows written out as text (and read back on the same days), the shifts a session ran over as notes (activities, the actions and players' notes under them, GM notes as $ lines, no shorthand read in an activity), and the draft's paragraphs, headings, escaping, loose ends, 🔒 blocks and `$` secrets.
- **search**: the box with the tabs (a 🔍 tab on a phone) opens the Search page, which finds Encyclopedia names, aliases, tags and notes, events by title, tag and text, day notes and Library tomes, grouped and with matching titles first; every word must match; a result opens its page and Back keeps the search; a GM's secret results are marked and a player finds none of them; `/` jumps to the box.
- **timeline**: the Events tab's List | Timeline switch is remembered; the timeline draws the events the search, tags and When leave, in lanes by tag (with Untagged) or in one lane, a one-day event as a dot and a longer one as a bar, close up an event with shifts as a bar over just those, secret events with a 🔒 dashed edge, a Sessions band and a line for now; the zoom buttons, arrow keys, wheel and drag move it; ⬇ PNG downloads a picture; an event opens its day (a second tap on touch); a player gets neither the secret event nor an unpublished session. Under Node: where an event runs in days and shifts, the lanes, the row packing, the axis's days, weeks, months, years and counts of years in the campaign's calendar and eras, the zoom buttons, and the season and holiday bands.
- **connection-web**: *🕸 Web* on an entry draws it and its neighbours one step out, *2 steps* adds the next ring, a kind switched off takes with it the entries only it reached, a click lists the entry's connections and *Centre here* moves the web; *🌳 Family* appears only for an entry with family connections and draws children below their parents; the list's ⋯ menu opens the whole campaign's web; a player's web leaves out a GM-only connection. Under Node: the neighbourhood and its depths, kinds and counts, the cut for a large campaign, a layout that is the same every time and stays on the page, and a family in generations with partners side by side.
- **edit-history**: every save of an entry, tome, session summary/notes and day notes is kept as a version (saves by one person within ten minutes join; the newest 50 stay); the *🕘 History* dialog lists them, shows what a save changed and how it differs from now, and Restore puts it back as a new version; something written before history began shows as a "before history" version; a restore of an entry whose name is now taken is refused; only GMs can list, read or restore, and deleting the item forgets its versions. Under Node: the word and paragraph diff.
- **markdown-import**: Settings → Tools → Import from Markdown. Under Node: front matter (title, aliases, tags as a list or inline, category, secret), the first heading as the name, a top folder as a Category or a tag, `[[wikilinks]]` (with `|text` and `#heading`) and links to other notes as connections with a link to a missing note counted and left out, Obsidian comments and pictures dropped, only http(s) links kept and HTML escaped, our own Markdown export read back (its about line, GM notes, Connections with their words and notes, and not its index page), and a zip opened whether stored or compressed. In the browser: the dialog says what is in the files, entries and connections come in, a hand-written entry is kept while a blank one is filled in and tags are added, "Located in" lands on the starter kind, a second run adds nothing, a non-note file is refused, a batch over the limit is refused, and a player gets 403.
- **reveal-all**: *🔓 Reveal entry* makes a whole GM-only entry public (its GM notes and GM-only paragraphs stay hidden), logged as a Revealed event on today or not, and the reveal is a version in its history; an event is revealed from its card; a day's Secret notes join its Public notes (plain text becomes paragraphs) and clear, logged on that day or not; a session's summary, rewards and loot reveal their GM-only paragraphs one run at a time; already public, an unknown id, the wrong kind or field, a stale page and a player are all refused.
- **events**: an event runs from a Shift Start to a Shift End (Shift End follows
  Shift Start) or all day, takes starter and new tags whose colours show in week
  view, an event saved the old way still shows, and Go to today opens today.
- **table-weather**: At the Table's season line leads with the ground and the wind (always said, calm or not, with its
  speed); the GM's ✎ Day sets this shift's weather, temperature, wind and ground by hand, each Auto until set, and a
  player without future weather sees what was set; the Weather forecast button gives today and the next two days, the
  same for a player (from the outlook the GM's browser saves with today's weather) as for the GM.
- **table** (layout): the header bar leaves the date and weather to the block; the shift before and after are a row of two
  equal boxes over the full-width big box; the block up top has the shift's weather and a 🔔 badge that lists the reminders; a shift in four
  sessions shows the latest two chips and +2 more; the visibility pill is one dropdown, Auto with its score first, and a pick saves; the actions sit in
  the right-hand column beside the writing, and the big box has no events or + New event; End and Pass time stay on screen in the floating bar as the page scrolls, ↑
  goes back to the top, the bar folds to one button and stays folded after a reload, and Encyclopedia add opens over the bar.
- **table** (actions): a GM picks the party's action and a player's, one each (a second pick replaces it), with the
  description in the hover tip and not on the page, and the activity untouched; a player picks their own, only reads the
  party's, and the API refuses them the party's; + Event and + Reminder on the floating bar open their forms over it and
  save; the session's page lists the actions of its shifts.
- **table** (framing): in another site's frame the panel changes nothing until "Allow changes here" is turned on for that site, which is remembered.
- **table**: At the Table sits first under Play and shows the date, shift, weather and party in one block over the big box; End shift moves the clock, offers to start a session when none is open (Start a session starts one on the new shift; Not now isn't asked again); Pass time… skips ahead by an amount or to a date and shift, labels every shift passed with the activity, refuses a time that isn't after now, and opens the downtime dialog; an Encyclopedia lookup finds names (never a secret entry for a player); a
  player's note goes on the clock's shift from the big box, and an entry note, escaped, at the end of an entry's Public
  notes (a GM's GM-only one in its GM notes, a player never on a secret entry). Panel links: members make and revoke their own, only GMs make public ones and revoke
  anyone's, and only the code's hash is stored; a link reaches only its own campaign (the cid asked for is ignored) and
  its short list of actions, needs no CSRF token, acts as its maker (a player's can't pass time), and stops when its
  member leaves; a public link gets no secret event, entry, GM note, GM reminder or weather seed, changes nothing, and
  stops when its GM stops being one; the Owlbear Rodeo manifest is public with CORS and opens panel.html; only
  panel.html may be framed (.htaccess). panel.html opens with only a link and no cookie in a frame on another origin,
  shows the clock's shift without the GM editor, day boxes or time buttons, catches up when the GM passes time, takes the code out of the address, and asks for a new link once revoked; a
  public overlay link is see-through with only the date, weather, light and moons; the GM makes a link from At the
  Table, sees it once, and revokes it.
- **api-keys**: a read-only key reads only its maker's campaign, with no member's email, and is refused writes, other actions, the panel link's header, both headers at once and revocation; a read/write key does what its maker may (a GM's passes time, a player's can't but adds notes signed as them and events) and stops when its maker leaves, writes included; a GM's key sent with View as player is answered as a player and changes nothing; a key request is open to any site (CORS) and nothing else is; New API key… shows the key once with a curl example and lists it.
- **current-day**: Locations visited offers the Encyclopedia's Locations named on the day's shifts (by name or other name, whole words only, never a Person) that the box doesn't list, and a tap adds one; a campaign opens on At the Table (no Current Day tab): the clock's shift in a big box with the shift
  before and after over it, the GM's browser saves today's shift weather, and today's Shifts, Events and Reminders
  boxes (no Weather box: the block up top has it) come folded under it; what the party does saves as typed; End shift moves the clock
  on one; a click on the shift before looks at it (no End shift there) and Back to now returns; an old Current Day link
  to another day opens its calendar page and Go to today comes back. Players get today's weather only up to the
  current shift (never the forecast), nothing for later days, and everything once allowed, in the big box, the side
  panels, the Shifts box and the days' calendar pages; they can look back but not ahead and get no End shift; there is
  no Notes box under At the Table; ✎ Day in the block opens the day's editor, where Locations visited sits under the
  Region dropdown, saves with Save day, survives a re-roll (the editor staying open) and is shown in the block, to
  players too, who get no ✎ Day.
- **day-notes**: the GM writes bold text and a table in the Public notes and a Secret note, and they save as cleaned HTML and reopen in the editor; tables wait behind ⋯, and ⤢ Focus gives the editor the whole window until Esc; players read the formatted Public notes, never the Secret ones, the month grid previews them as plain text and the export turns them into Markdown; scripts, images, styles, attributes and javascript: links are stripped on the server, and HTML put straight into the database is still rebuilt from the allow-list in the browser; a plain note from before shows as typed; every day box folds and stays folded per account in that browser, and adding an event unfolds Events.
- **encyclopedia**: the Feature Highlighter finds capitalized, bold/italic and quoted names and a day's
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
- **sheet-templates**: a template built by hand saves exactly the layout typed, the library lists A to Z by name, and finds it with its game, use count and forks; forking someone else's (which has no Edit button) makes an editable copy that credits the original, which counts the fork; dragging a field's handle reorders it by mouse, and by a finger through Chromium's touch events on a phone. A field's box is small, medium or large on the sheet (half, the usual and twice its width), a large one still fits a phone (as do a long label in a small box, which wraps, and a list of eight columns, which scrolls inside its box), and a bad size is refused. Sections sit side by side at half width on the template's page, on a desktop and an iPad in portrait, and stack on a phone, a compact section puts each label beside its box, a box can be any number of half-columns (a text box filling it), and bad widths, column counts and compact values are refused. Sections on named pages show as tabs (none without pages), and a sheet keeps its open tab when drawn again. **sheetlayout** (under Node): the layout checker's rules for keys, types, counts, box and section widths, and the optional VTT mapping.
- **sheet-agent** (under Node, the PDF-to-template scripts in `tools/sheet-agent/`): a box's width on the page becomes half-columns, fields at one height are a row, a clear gap down a page is a gutter; extract reads the fillable test PDF's fields, text, headings and page picture with the editor's draft; preview draws a starter at desktop and iPad widths and finds nothing wrong, with a picture of each page; check passes every starter file and names what's wrong with a bad one.
- **sheet-import**: a fillable PDF drafts fields from its form fields with its page shown beside the editor under the notice that it isn't kept, and no request ever carries the PDF; a scan with nothing to read and a text file renamed .pdf each say what to do.
- **sheets**: the database has the new tables and the upgrade finds nothing left to do; anyone makes, lists and forks a template, only its author edits it, an unlisted one can't be opened or forked by id but by its author, a bad layout is refused naming the problem and a save from an older copy is refused; a character's Encyclopedia entry follows its renames, a GM adds a sheet to an existing NPC entry, the active character's name is its player's, PC and NPC switch back and forth and the sheet changes hands; two people change different fields at once, a template change moves a value that no longer fits to old fields, a removed member's sheets stay for the GM; players never receive a secret NPC or a hidden field, and only a PC's player renames it or hides parts of it.
- **characters**: a player makes a character from the Characters tab, fills it in, finds it again and hides a section; quick taps on the Play view end on the last one, on screen and saved; a player sees an NPC's card but not its sheet; the GM hands a sheet to another player; the player and the GM on one sheet see each other and the GM presses Edit first, and an Edit that runs out goes back to reading; a failed save puts the sheet back as the server has it; someone else's change doesn't overwrite a tap still being saved; *Use theirs* keeps the other person's value. The player or a GM deletes a character from its sheet (its Encyclopedia entry stays), and a choice field takes a custom entry that is kept and shown again. A pasted Pathbuilder export fills the sheet after asking (only for its player or a GM); many values at once all fit or none is kept; an import link is fetched only from Pathbuilder or D&D Beyond. A card shows its Summary fields as one line and a few Play fields, a list as its rows' names and never the raw data; a player uploads a portrait on the sheet (it goes on the character's Encyclopedia entry and shows on the card), a GM picks another of the entry's pictures, only a picture on its own entry can be the portrait, removing it goes back to the entry's first picture, and someone else's player can't change it. **sheetimport** (under Node): a Pathbuilder 2e export and a D&D Beyond character read onto the starter templates' fields, only what fits a sheet kept, and which links are read.
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
- **shifts**: a day page's shift editor keeps the activity free text and saves it, and has the actions, one for the party
  (a second pick replaces the first), described on hover; a player names their character on the Members tab, and
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
- **map-styles**: a GM's new pin starts as an Encyclopedia entry and can have its own icon and colour; pins are listed
  under Locations in the side panel, which folds away (and its sections fold) and stays as it was left; a locked pin can't
  be dragged or moved until unlocked; a route has its own colour and line and is drawn on to the pins it starts and ends
  at; a GM places the party anywhere and pins a new location where it stands; the grid's opacity is each person's own;
  picture, rename and delete sit in the ⚙ menu (migration 024).
- **map-scan**: Scan for names offers two readers. Read with Claude sends the picture (as a JPEG, with its size in the
  prompt) to Anthropic with the GM's own API key, in the headers a browser call needs, and asks for JSON by schema;
  the names come back in the map's own pixels, are checked with no confidence shown and pinned; a key Anthropic
  refuses says so; with no key the dialog points to the account page, where the key is checked, saved in the browser
  only (never sent to the server), not shown again, and removable. Read here (Tesseract) joins a line's words into names,
  splits labels side by side, drops noise and unsure words, keeps the surest of a repeated name, and puts boxes back in
  the map's pixels; a GM scans a printed map in the browser, fixes a name, pins the approved ones as entries (reusing one
  of the same name, else a new Location), and a second scan shows them already pinned; players get no Scan button;
  .htaccess serves every scanner file and deploy.sh's security check calls none of them a leftover to delete (none ends
  in .gz), and a file the server refuses ends the scan with a message instead of loading for ever. Quick label pins a
  place per click (its name typed, an entry of that name reused, else a new Location) until the GM presses it again.
- **maps**: the Maps tab sits after Generators; a GM adds a map with its picture (uploaded or from Find Image), scales
  it by two points or grid squares (a `30x20` file name fills in the square size, the Roll20 button 70 px = 5 ft, and the
  grid offset is the first click's position modulo the square), and measures; an unscaled map says so; a 6000 × 4000
  picture opens; a GM-only map, its picture and its pins never reach players; players add public note pins and change
  only their own; GMs pin new or existing entries and events, which link back with 📍, save routes, and turn a player's
  pin into an entry (or link it to the one of that name); replacing or deleting a map's picture leaves no file behind.
  The page's layout: the stage fills the window to its bottom edge and never shrinks under 320px; the toolbar floats on
  the map in two groups with every control's old name; a map with no picture has no picture-only tools and its keys
  don't throw; Set scale, Scan for names, Export, Change picture, Rename and Delete sit in ⚙ in that order, and players
  have no ⚙ or lock; the pin form floats under the toolbar and scrolls inside the stage; the drawer slides over the map
  without resizing it and its search filters the rows; pin labels show by zoom, hover, an open card and the Labels
  toggle (remembered), and the party is always named; the legend sits bottom-left (not on a phone) and P, L, M, T and
  Escape drive the modes except while typing, and stop when the page is left; on a phone the toolbar is icons only and
  the drawer a bottom sheet, closed at first, that a pin's card opens above. At the Table's party card shows the map around the party with the pins near it, and a GM's new event there can be pinned at the party's marker; moving the main group offers Log it, which adds "Moved to" the nearest pin to the clock's shift and keeps the rest of it; a session's page shows the pinned places it names on their map (a player only those in the published summary); the shift before At the Table says where the trail had the party, for players too, and the day's Locations visited offers the entries pinned where the trail passed; a stop on or after the clock is refused.
- **mapgeo**: `static/mapgeo.js` sets a scale from two points or grid squares, reads square sizes from file names,
  and shows distances in the reader's units, with AU and light-years on space maps.
- **party-groups**: a campaign starts with one main group holding every player, and a late joiner goes into it; GMs
  split and merge groups on the Travel tab; the main group's region is the current region both ways; a side group's
  trip moves the clock but leaves the main party's region and shifts alone; markers move with Depart, are flags or
  their token, and only GMs drag them; members who leave or become GMs drop out of every group. A move leaves a
  point on the group's trail (a second move in the same shift replaces it), players get the trail on maps they can
  open, only GMs clear it, and the map draws it, hides it from the legend (remembered) and clears it from the card.
- **tokens**: GMs upload many tokens at once, named after their files, assign them to characters, entries and the
  party, filter them, and delete them, which clears what used them; players never see the tab, a GM-only token or
  its picture.
- **clocks**: the Clocks tab sits after Sessions; a GM makes a clock with a name, a description and 6 segments, fills it by pressing a segment and +, and its History lists the fills; a player sees it and its count but can't fill or delete it; a player makes their own clock (no Secret for them), drawn in the player colour, and fills it; the API refuses a player a secret clock; players never get a secret clock, and get no count or history for a vague one they didn't make (the card shows ? and "how full is hidden"); the GM fills a player's clock and filters to player clocks; At the Table's folded Clocks box lists the running clocks, fills one by + and by a segment and counts the full ones; a player's box has no +; a clock put away leaves the box and shows under Put away.
- **dice**: the 🎲 button opens the dice panel; a GM rolls a d20 from the quick dice and `4d6kh3 + 2 # strength` from the free-roll box, and the page shows the result the stored seed rolls, with the dropped die marked; success counting says successes; a roll that can't be read says why and isn't sent; the ? card fills the box with an example; the panel opens again after a reload as it was left. Who sees a roll: a second player sees only the open rolls; the roller sees their own, and their blind roll without its seed ("Rolled for the GM", no dice); the GM sees all, seeds included, and a GM's blind roll is GMs only; the change check gives a player the newest roll they may see; a player's choice of who sees it sticks. Settings → Dice: a locked choice wins over what a player asks for, and their page says the GM set it; GM rolls start hidden; the log keeps the newest 100; a player can't clear the log and the GM can. The server refuses an empty or multi-line roll, one too long, an unknown engine or visibility, and anyone outside the campaign.
- **dice** (dice systems): the GM starts from Pathfinder 2e in Settings → Dice, which picks the d20 system with its DC and 10-point margin, shows the odds and tries a roll; the server hands players the system. The player's roller opens on the Game roll with the DC, + and − change the modifier and the dice on the Roll button, the odds bar shows, and the log reads the roll as the stored seed and system say (beat or missed the DC by so much), the same on the GM's page. Saved rolls: a game roll saved by name comes back with its numbers and label after a reload; a free roll saves and loads into the free box; Forget drops it; the server refuses saved rolls for a campaign the person isn't in, a name over 60 characters and over 100 rolls. Back to free dice only, the roller has no Game roll and old game rolls still read. The 📌 pins the panel (the page moves over) or floats it (nothing moves), and a reload remembers which. Your dice: a player picks Emerald and Wood on the 🎨 card; their roll's result waits while 3D dice are in the air, then matches the seed, in their colours; the GM sees the player's dice in those colours and their own in the theme's; with 3D off on the device no dice are thrown.
- **dice-systems** (under Node): every system and preset builds dice the engine rolls and reads back its numbers from the `@`; numbers out of range are put right; each system reads its dice as its rules say (d20 naturals and Pathfinder 2e degrees, 2d6 bands, the action die, Hope and Fear, Fate shifts, Call of Cthulhu and Warhammer percentiles, GURPS, d20 roll-under, success pools with botches, glitches, doubles and exceptional successes, highest die, roll-offs, roll and keep with raises, matching sets, narrative symbols, step dice, the oracle, result tables); the odds add up and match the maths for a d20 and 2d6.
- **dice** (rerolling by hand): a player rolls `5d6kh3`, presses ↻ Reroll, picks two dice (by click and by keyboard) and rerolls them; the same roll shows the result the stored seeds give, with those dice marked, and the GM sees it too. The GM may reroll it as well, and the player's page picks that up; a member can't reroll someone else's roll, nobody can type a `~` roll, an empty pick is refused, and a player can't reroll their blind roll.
- **dice** (at the table, tags and sessions): Settings → Dice turns players' free rolls off (the roller has only the Game roll, and the server refuses a free roll), hides the odds from players, and makes the dice flat; dice tagged `[Strength]` and `[Athletics]` show each source over its dice; a session's page lists the rolls made during it, the GM's secret roll for the GM only.
- **dice** (rolling from a character sheet): a player's sheet has a 🎲 beside Strength but none beside Age, and one beside a text field only once dice are written in it; an empty number says to fill it in; with free dice Strength 3 rolls 1d20+3, dice in text roll as written, and an attack row rolls its damage named for the row; with Pathfinder 2e, Strength 16 rolls the game roll with +3; the GM's roll from the player's sheet carries the character's name.
- **dice-systems** (sheet numbers): which number a sheet's number fills in for each kind of system, D&D and Pathfinder ability scores read as modifiers, and dice found in a field's text.
- **dice-3d** (under Node, and the server): each 3D shape has a real die's faces with opposite faces adding to one more than the sides; turning a die to land on any value of any shape (and Fudge, d3, tens and units dice) puts that value on top and upright; a roll's dice become the right 3D dice (a d100 as tens and units that read back as the roll, bonus dice, d66, d3, dropped dice dimmed, nothing for a d2 or d7 or over 30 dice). The server keeps only a real colour pair and a known pattern as a player's dice, sends it with their rolls, and drops it when they go back to the theme's.
- **dice-engine** (under Node): every line of the ? card rolls as it says (matching sets read width × height, widest then highest, and the dice in a set marked; dice rerolled by hand change only the picked dice, from their own seed, before keep, drop, sets and totals, and stack in order; sums, maths signs typed or from a keyboard, keep and drop, adv and dis, exploding and compounding, rerolls, success counting with failures, d100 bonus and penalty dice, flip and swap, d66, Fudge, repeats, labels); the same roll and seed give the same dice; each face of a d6, d20 and d100 comes up evenly (chi-squared); a roll that can't be read says why, and one that would draw thousands of dice stops.
- **library**: the Library tab sits just under the Encyclopedia; a player adds a journal with a title, a description and
  formatted contents, the GM opens and changes it and the player sees who changed it; search and the kind buttons narrow the
  list; a save from an older copy is refused naming who saved since, the contents are cleaned of scripts, images and unsafe
  links, a bad kind or empty title is refused, only the author or a GM deletes, and someone outside the campaign gets nothing; saving a tome offers its new names, and Scan campaign finds names in tomes,
  downtime, holdings and Gear and Loot (but not the Long Rest label a rest writes), with an entry quoting the tome it was found in; the 🔍 Scan button on a tome or an entry offers only the names in that one, an entry's GM notes included, and says when none are missing; a player adds a picture to the GM's tome and the GM sees it on the page
  and in the editor, anyone can take a tome's files off, and deleting the tome deletes its files.
- **list-pane**: the « on the Encyclopedia's and the Library's list tucks it to a rail and gives the item picked the width,
  with Wide view on too; each tab remembers it on its own, the rail brings the list back, and one column has no «. (The
  Sessions tab's « is in **sessions**, along with an old Wide view setting carrying over as a tucked list.)
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
  given an On the move party action (on the day page or in Pass time), keeping its other tags. A trip along a route leaves a trail stop for each shift on the way, in order along the road, ending at the route's end on the clock's shift.
- **time-modes**: four shifts, two shifts (Day and Night) and hours each have
  their slot names, weather quarters and travel maths; switching a campaign's mode
  moves the clock, shift activities, shift notes, timed events, sessions' first and
  last shifts and the shifts they take in outside their run (two landing on one slot become one), and the party's
  trail to the same time of day; in hours mode the day page, pass-time box and travel planner count hours.
- **export**: the day page's Export button downloads the day as Markdown; the
  GM's file has secret events and GM notes, a player's has neither and leaves
  out the weather of shifts that haven't happened yet.
- **calendar-file**: Settings exports the calendar, its holidays and the date reached
  as JSON; importing it into another campaign's Settings replaces the calendar and adds
  the holidays it lacks (only once), a file that isn't a calendar is refused, and the
  new-campaign form starts a campaign on the file's calendar, holidays and date.
- **vtt-export**: the Encyclopedia's Export downloads a zip of linked Markdown pages with their pictures (credited) or a Foundry journal with a page per entry, linked, its pictures under the folder it names; a GM's leaves out GM-only entries, paragraphs, GM notes, connections and pictures unless asked, a player's never has them; Copy as handout puts an entry on the clipboard as HTML and Markdown without its GM-only paragraphs; Settings' For Foundry downloads the calendar for Seasons & Stars and says the date to set. **vtt-export-logic** (under Node): every preset calendar gives the same dates, weekdays and new and full moons in Seasons & Stars (its date maths copied into the test), leap rules, festival days, seasons and holidays carry over and what can't is listed; the export's pick, Markdown, Foundry journal, zip (read back by its central directory, CRCs checked) and handout.
- **scabard-import**: Settings → Tools → Import from Scabard refuses a file that isn't JSON or isn't a Scabard export,
  says what the export holds (entries by kind, session logs, connections, pictures, what is left out) and follows the
  Sessions / Encyclopedia entries choice; the import makes entries with their kind and category tags, other names,
  summary-then-description notes (`div` → `p`, `span` unwrapped, Scabard links as text), GM notes, secret pages as GM
  only, a `Player:` line, names cut to 150 characters, fills in a blank entry and keeps one with notes; connections read
  from the right end on the starter kinds and new ones, a former one noted, a secret one or one touching a secret entry
  GM only; dated events become published, closed Sessions with no in-game dates (so the import day's shifts show no
  session chips) and with the secrets as GM-only paragraphs and Participants,
  Setting, Protagonists and Part of lines; the picture comes from the image stub's `www.scabard.com` with a Scabard
  credit, while one hosted elsewhere or gone is reported; players get none of the GM's side and can't import; a second
  run keeps everything and doubles nothing. The reader (`static/scabard.js`) splits dated names, plans and batches.
- **reminders**: a GM's reminder, added from today's page on the next shift, pops up for
  the GM when time passes to it and on a player's open page at its next check; Dismiss stops
  it for that person only, Remind me later until the clock moves or the page reloads; moving
  it re-arms it; players keep only their own reminders and never see the GMs' or another
  player's; a time the clock has passed is refused; switching to hours moves reminders with the clock.
  The Events tab's Reminders half (`#/c/<id>/events/reminders`) lists every reminder the person can see by when it
  is due, narrowed by a search, by waiting / due / dismissed and (for a GM) by who sees it; one is edited, added and
  deleted there; a player gets no who-sees-it filter and can't edit the GM's.
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
- **weather-tuning**: a campaign's weather tuning (storm, fog and dust per Köppen class, the simple climates' weather mix,
  visibility by weather, how shifts ease off, the ground model) lays over the built-in values and comes off again; out-of-range
  values are pulled in and only real changes are stored; Settings → Weather tuning highlights changed values, refuses ground
  steps out of order, saves, changes the day page's ground, and Reset all puts the built-in values back; the ground rates
  are shown a shift, or an hour in a campaign kept in hours, and stored a quarter of the day; Settings is split into
  Campaign, Calendar, Weather tuning and Tools tabs, each with its own address.
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
