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

- **signin**: the signed-out screen shows the Google and GitHub buttons and
  keeps the page you were going to; the API refuses anyone signed out; a new
  account waits for approval and gets in once approved; a revoked account is
  locked out; the admin identity is approved as admin; an account from before
  Google/GitHub sign-in is taken over by the email an admin linked to it;
  sign-in starts are rate-limited per IP.
- **campaign**: a GM creates a campaign and every tab renders with no script
  errors; a custom calendar is created with its own number of months, each
  with its own length, and a week of its own length and day names; a custom calendar takes leap days in a month and a leap rule
  (every N, except every N), which the year and month lengths and weekdays follow, and
  Settings spells out the next leap years; members are added by sign-in email, only once approved; players never
  receive secret events; a GM picks people from the approved accounts not yet in
  the campaign, which only GMs can list.
- **setting-presets**: the Forgotten Realms preset keeps Harptos's tendays,
  festival days outside them, Shieldmeet every fourth year and Selûne's known
  full moons; Eberron's months all start on Sul, with its twelve moons and
  holidays; Exandria's 328-day year, seasons and holy days; Golarion's Leap
  Day, real-world-aligned weekdays and the last-Sunday Breaching Festival;
  every setting region has a Köppen climate; a GM starts a Forgotten Realms
  campaign with its holidays and regions, and About & sources cites all four.
- **holidays**: the last and Nth-from-last weekday of a month, every Nth year,
  moon-phase holidays and limited runs (between two years, or N times) fall on
  the right days; a GM builds them in the holiday form, which shows only the
  fields each rule needs, and the calendar shows them.
- **year-view**: the year view shows every month with today ringed, marks days
  with events and lists them in the tooltip, steps a year at a time, opens a
  month from its name and a day from its number, and never gives a player a
  secret event.
- **events**: an event runs from a Shift Start to a Shift End (Shift End follows
  Shift Start) or all day, takes starter and new tags whose colours show in week
  view, an event saved the old way still shows, and Go to today opens today.
- **current-day**: a campaign opens on the Current Day tab and the GM's browser
  saves today's shift weather; players get today's weather only up to the current
  shift (never the forecast), nothing for later days, and everything once allowed;
  Previous/Next day and Return to today stay on the tab and keep that rule; the
  day's Locations visited saves, survives a re-roll and is shown to players.
- **day-notes**: the GM writes bold text and a table in the Public notes and a Secret note, and they save as cleaned HTML and reopen in the editor; players read the formatted Public notes, never the Secret ones, the month grid previews them as plain text and the export turns them into Markdown; scripts, images, styles, attributes and javascript: links are stripped on the server, and HTML put straight into the database is still rebuilt from the allow-list in the browser; a plain note from before shows as typed; every day box folds and stays folded per account in that browser, and adding an event unfolds Events.
- **encyclopedia**: the Proper Noun Detector finds capitalized, bold/italic and quoted names and a day's
  Locations visited, leaves out common and calendar words, members' names and everyday words that only open a
  sentence or a title, guesses each name's tag from the words around it, and offers a name that overlaps an entry
  as another name (alias) for it; saving notes offers them to Add (with a tag, and GM only when found only in GM-only
  text), Alias, Ignore or Skip (remembered until the page reloads); entries are linked where players read the names
  (aliases too, with the entry's first line on hover), a link opens the entry, Blank Entries lists the new ones, an
  entry quotes where it was found with Add to notes, players write Public notes but never get GM notes, secret entries
  or the GMs' ignored words; Scan campaign offers every missing name, and entries keep tags of their own;
  the Link dialog connects one entry to many with one kind of connection, each page reads it from its own end ("Has
  resident" / "Resident of"), the same fact made from either end or with the labels typed the other way round is one
  row, a symmetric kind is kept once, unticking removes, and deleting an entry takes its connections; players never get
  a GM-only connection, one touching a secret entry, or a label used only by those, can't set GM only and remove only
  their own; the notes suggest connections (a "Residents:" line suggests the label), and the list searches, filters by
  connection chips and "Show in list"; renaming a kind changes every page.
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
- **generators**: every generator gives real text for every genre, people, line of business
  and size, and a seed repeats it; a GM switches genre (remembered), re-rolls, and adds a town and one of its people
  to the Encyclopedia as GM only, then a company for everyone; a player has no GM only switch and never sees the GM's.
- **travel**: overland, sea and air each list only their own sample speeds, and
  picking one fills the planner; one Metric/Imperial switch converts every
  distance and speed box; a trip is planned in shifts a day, each a quarter of the calendar's day;
  star pickers fill the light-years between two systems; the campaign's genre
  (Settings) limits the modes and samples, and a campaign with none keeps them all;
  a Custom region typed on the day page or in the travel planner joins the campaign's regions.
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
  tablet and desktop widths.
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
