# Cross-browser tests

Automated checks that Campaign Chronicle behaves the same in **Chromium**
(Chrome, Edge), **Firefox** and **WebKit** (Safari, and every browser on
iPhone/iPad), on desktop and phone-sized screens. Set up the same way as
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
  with its own length; members are added by sign-in email, only once approved; players never
  receive secret events; a GM picks people from the approved accounts not yet in
  the campaign, which only GMs can list.
- **events**: an event runs from a Shift Start to a Shift End (Shift End follows
  Shift Start) or all day, takes starter and new tags whose colours show in week
  view, an event saved the old way still shows, and Go to today opens today.
- **current-day**: a campaign opens on the Current Day tab and the GM's browser
  saves today's shift weather; players get today's weather only up to the current
  shift (never the forecast), nothing for later days, and everything once allowed;
  Previous/Next day and Return to today stay on the tab and keep that rule; the
  day's Locations visited saves, survives a re-roll and is shown to players.
- **shifts**: a GM picks baseline actions into a shift's activity next to
  their own text, and it saves; a player names their character on the Members tab, and
  their shift notes and events are signed with it; the GM adds shift notes too.
- **downtime**: a long rest takes at least half the day, labels the shifts after
  now next to their activity and moves the clock; a short rest of 0 shifts marks the
  current one; downtime covers whole days and its label comes off when deleted; the GM
  picks activities, custom ones and players; players see them and edit only the public
  notes, never the GM notes.
- **holdings**: Party Funds keeps one line per currency, saved as you leave each box, for players and the GM; a player adds Gear and Loot from the last row, ticks its count (never
  below 0) and edits its boxes, and the GM sees and removes it; the Add holding dialog
  shows each type's own fields, takes a custom construction type, a custom holding
  type and tags of its own (apart from the events'), and its card ticks, edits and deletes for GM and players alike.
  Each holding's Storage ledger adds up its items' weights and warns when the total
  is over the holding's Cargo.
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
