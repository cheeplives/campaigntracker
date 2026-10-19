# Campaign Chronicle — RPG campaign tracker

A web-based tracker for tabletop campaigns: in-game calendar kept in four shifts, two shifts (Day and Night) or hours a day, weather by
region and season, moon phases, visibility, holidays, events with secret GM entries, player notes,
and a travel planner for overland, orbital and interstellar trips.

PHP 8 + MySQL on the server, plain JavaScript in the browser. No build step or frameworks.

Players sign in with **Google or GitHub**, the same way as the Sinless app on the same domain, and new accounts wait for an admin to approve them.

## Install

The full runbook (OAuth apps, config fields, upgrading an older install) is in [docs/DEPLOY.md](docs/DEPLOY.md). In short:

1. **Create a MySQL database** in your host's panel, or reuse the Sinless database so the two apps share accounts and one approval queue (fresh installs only).
2. **Deploy with git:** `git clone https://github.com/cheeplives/campaigntracker.git chronicle` inside your web root. Updates are `./deploy.sh` (pull + PHP syntax check).
3. **Configure:** copy `api/config.example.php` to `~/chronicle-config.php` (above the web root; `api/config.php` also works) and fill in the database, `base_url`, the Google/GitHub client ids and secrets, and your email under `admin_identities`.
4. **Add the callback** `<base_url>/api/auth/callback.php` to your Google OAuth client (as a second redirect URI next to Sinless's) and register a GitHub OAuth app for it.
5. **Install:** open `<base_url>/install.php` and press *Install or upgrade*, then set `'allow_install' => false`.
6. **Sign in** with the email in `admin_identities`. You're approved as admin straight away; everyone else appears under *Users* to approve.

## Using it

- **Users** (admins only): approve or revoke people after their first sign-in. Accounts from before Google/GitHub sign-in show as *not linked yet*; enter the player's email and their first sign-in with it takes over the old account and its campaigns.
- **New campaign:** pick a preset (Gregorian for the Northern or Southern Hemisphere, Imperial Calendar, Middle-earth, Starship clock, or a blank custom calendar), a starting date, and the seasons. Each season has a name, a climate (spring, summer, autumn, winter or none) and a first month and day; a table shows which season every month falls in. Each campaign has its own calendar, regions, holidays and settings. The Gregorian presets start with real-world regions of their hemisphere, and the Imperial and Middle-earth presets with their world's major regions, each set to a Köppen climate you can change on the Regions tab.
- **Members tab:** add an approved player, or a co-GM, by the email they sign in with. Each member can set their character name for the campaign (a GM can set anyone's); events and notes they add are signed with it, or with their own name if they have none.
- **Time tracking** (per campaign, picked on the new-campaign form and changeable under *Settings*): four shifts a day (Dawn, Midday, Dusk, Overnight; the default, and what older campaigns keep), two shifts (Day and Night), or hours from midnight like a normal calendar. Everything below that says "shift" means an hour in hours mode. Weather, light and visibility are still worked out for the day's four quarters: Day takes Midday's and Night takes Overnight's, and each hour takes the quarter it falls in (the hours before dawn take the overnight one). Switching modes moves the clock, shift activities, shift notes, timed events and rests or downtime to the same time of day; going to fewer, longer steps joins activities that land together. In hours mode the day page folds hours with nothing recorded, and the week view lists only hours with an activity.
- **Pass time** (GM, top of every campaign page): move ahead by shifts, days, weeks, months or years. You can also label the passed shifts, e.g. "Coach journey". Weather is generated for each day as time passes, and stays fixed once generated. Each day's weather is its forecast; the four shifts vary within it (cooler overnight, wind easing at night, rain thinning to drizzle, morning fog lifting, afternoon storms), never worse than the forecast except where a colder shift turns rain to snow. Shift weather is worked out from the stored day, so older days get it too.
- **Current Day** (the tab a campaign opens on, for GMs and players alike): today up close, with the current shift's weather, visibility and activity large, the day's four shifts at a glance, then the full day page below it. *Previous day* and *Next day* step through the days without leaving the tab, and *Return to today* comes back. The day page has a *Locations visited* box under the day's region, which players can read.
- **Calendar:** month grid or week view with all four shifts. Click any day to drill down to weather, moons, holidays, per-shift activity, visibility and events.
- **Day page** (GM): change the day's region, edit or re-roll the weather, and write public notes and GM-only notes. For each shift you can enter activity and private notes, override visibility, or make that shift "now". *Export* downloads the day as a Markdown file (events, weather, notes and shifts) laid out like Sinless's Scabard export, for pasting into Scabard or another wiki; a player's file holds only what that player can see. *Add an action* offers 21 common shift tasks (march, navigate, scout ahead, keep watch, forage, hunt, make camp, stand guard, sleep and so on); each one adds its name to the activity, which stays free text, and shows what it involves. The pass-time activity box suggests the same actions.
- **Events:** single-day or multi-day, all day or in one shift. GMs can mark an event **Secret** so players never receive it; this is filtered on the server. Players can add notes to any event they can see. Every shift on the day page also has its own notes box, separate from events, where players and GMs add notes.
- **Travel tab:** calculates travel time, then *Depart* passes that much time. It labels the transit shifts, logs a travel event, and can change the region during travel and on arrival. Modes:
  - Overland / sea / air: speed × hours per day × terrain.
  - Hohmann orbital transfer: time, Δv, and how often launch windows repeat. Includes the Sol, Jupiter, Saturn and Earth–Moon systems.
  - Constant-thrust flip-and-burn at any g, with an optional speed cap.
  - Relativistic interstellar: shows ship time and outside-world time.
  - FTL: a fixed jump duration, or a speed in light-years per day.
- **Downtime tab:** one card per rest or stretch of downtime. *New downtime* (GM) asks for a **Long Rest** (uses up at least half the day: 2 of 4 shifts, 1 of 2, or 8 hours), a **Short Rest** (about an hour; 0 shifts marks the current shift without losing any) or **Downtime** (a start and end date). It writes Long Rest, Short Rest or Downtime into the activity of every shift it covers, after anything already there, and can move the clock to its end. On each card the GM ticks what the party does (rests: Tend to Wounds, Manage Stress, Repair Gear, Prepare, Relax, plus Work on Project on a long rest; downtime: Work on Project, Crafting, Career Pursuits, Research, Recuperate, Train, Networking, Acquire an Asset, Indulge or Carouse), adds custom activities, and puts players on each one. Each card has notes players can read and edit, and GM notes they never receive. Deleting a card takes its label back off those shifts.
- **Reminders:** the day page (and the Current Day tab) has a *Reminders* box. *Add reminder* takes a title, a date and a shift (or hour), and details; it pops up in a window once the campaign clock reaches that shift, on the GM's page when they pass time and on a player's open page at its next check. *Dismiss* stops it popping up for you; *Remind me later* puts it off until the clock moves again or the page is reloaded. Anyone can keep reminders for themselves; a GM can also share one with the GMs or with everyone. Days with a reminder show a 🔔 on the calendar. Moving a reminder to a new time sets it off again for everyone, and switching the time tracking moves it with the clock.
- **Change notices:** a campaign page that is open checks every 30 seconds (and when you come back to the tab) whether a GM has changed the campaign: the calendar, the clock, events, notes, shifts, regions, holidays, downtime or members. If so, a banner under the top bar says *The GM updated the calendar* with a *Refresh* button. The page never reloads on its own, so nothing you are typing is lost; save it first, then press Refresh. Your own saves don't raise the banner.
- **Regions:** each region sets a climate, a hemisphere, a light source (sun and moons, artificial, or none) and a terrain modifier to visibility. The *Party is here* button sets the region used for new days.
- **Climates:** pick any of the 30 Köppen–Geiger classes (Af rainforest through EF ice cap), one of the simple setting climates (temperate, desert, underground, starship…), or build your own: choose the Köppen letters, load that class's baseline, then tune each season's range of daytime highs, precipitation (0–5) and how often storms, fog and dust turn up (0–3). The region form shows the resulting baseline weather and odds for each season. The new-campaign form sets the home region's climate. Each class's highs and wetness come from one representative station's 1991–2020 monthly normals (`tools/climate-normals.json`; `node tools/climate-baselines.js` shows the rules and checks each station's class).
- **Holidays:** same date every year, Nth weekday of a month, one-time, or every N days. Each can last several days and can be secret.
- **About & sources** (footer link, readable signed out too): where every built-in figure comes from: each travel-planner speed and distance, the orbits and star positions, the station behind each Köppen baseline, the calendar presets and holidays, and a plain list of what has no open source (the fictional settings, the game tuning).
- **Settings:** time scale, temperature units, whether players see future weather (when they don't, they get today's weather one shift at a time as the clock reaches it, and never the day's forecast, which would give the later shifts away; the server holds the rest back), whether players may add events, and a full calendar editor. The editor covers months, festival days that sit outside the week, leap rules, seasons (with the hemisphere their dates are for; regions in the other hemisphere get the opposite season), moons (including erratic ones like Morrslieb), shift names, date format and hours per day.

## How visibility is scored (0 Pitch black … 5 Bright)

The score starts from a base value for the shift: dawn 3, midday 5, dusk 1, overnight 0. Each day starts at Dawn and ends with the Overnight shift after it. Artificially lit regions use their own level for each shift instead. Then:

- **Moonlight:** up to +2 overnight (+1 at dusk) depending on how much of the moons is lit, reduced by cloud cover.
- **Weather:** that shift's weather, with a modifier such as fog −3, or a blizzard −4 by day.
- **Terrain:** the region's modifier.
- **GM override:** if set on that shift, it replaces the result.

Hover over any visibility badge to see this breakdown.

## Files

| File | Purpose |
|---|---|
| `index.html`, `static/` | The app: `engine.js` = calendar/weather/visibility/travel math, `app.js` = UI, `day-export.js` = a day as Markdown, `kit.js` = UI kit shared with Sinless (DOM builder, toasts, tooltips, dialogs), `theme-init.js` = light/dark mode and colour theme before first paint, `fonts/` = self-hosted fonts |
| `api/index.php` | JSON API for campaign data; enforces GM vs player permissions and secret filtering |
| `api/auth/` | Google/GitHub sign-in (`login`, `callback`, `me`, `logout`), the same flow as Sinless |
| `api/lib.php` | Shared server library ported from Sinless: config lookup, sessions, CSRF, rate limits, OAuth helpers |
| `api/config.example.php` | Copy to `~/chronicle-config.php` or `api/config.php` |
| `install.php` | Creates tables, or upgrades an older install |
| `db/schema.sql`, `db/migrations/` | Database tables, and one-time upgrades for existing installs |
| `tests/` | Playwright browser tests, run in five browsers on GitHub Actions ([tests/README.md](tests/README.md)) |
| `tools/` | `climate-normals.json` (the station normals behind the Köppen baselines) and `climate-baselines.js`, which works out the baselines from them; not served |
| `deploy.sh` | `git pull` + PHP syntax check, run on the server |

## Notes

- Every day is stored by an absolute day number. Editing a calendar re-labels existing days instead of moving their data.
- The Imperial preset's weekday alignment and moon starting phases are arbitrary. Adjust them in Settings if your campaign has canon dates.
- Shared with Sinless: the sign-in flow, the users and rate-limit tables, the server library, error bodies (`{"error": "code", "message": "…"}`), the UI kit in `static/kit.js` and the CSS token names (`--bg --panel --panel-2 --line --text --dim --accent --on-accent --ok --bad --disp --body --mono`).
- Security: every query uses prepared statements, every change needs a CSRF token, and the session cookie is HttpOnly and SameSite=Lax with idle and absolute timeouts. Sign-in is rate-limited per IP in the database. `.htaccess` forces HTTPS and sends HSTS, CSP and framing headers, and blocks the config, `db/`, `tests/` and `.git`. User text is never inserted as HTML.
