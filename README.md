# Campaign Chronicle — RPG campaign tracker

A web-based tracker for tabletop campaigns: in-game calendar, four shifts per day, weather by
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
- **New campaign:** pick a preset (Gregorian for the Northern or Southern Hemisphere, Imperial Calendar, Starship clock, or a blank custom calendar), a starting date, and the seasons. Each season has a name, a climate (spring, summer, autumn, winter or none) and a first month and day; a table shows which season every month falls in. Each campaign has its own calendar, regions, holidays and settings.
- **Members tab:** add an approved player, or a co-GM, by the email they sign in with.
- **Pass time** (GM, top of every campaign page): move ahead by shifts, days, weeks, months or years. You can also label the passed shifts, e.g. "Coach journey". Weather is generated for each day as time passes, and stays fixed once generated. Each day's weather is its forecast; the four shifts vary within it (cooler overnight, wind easing at night, rain thinning to drizzle, morning fog lifting, afternoon storms), never worse than the forecast except where a colder shift turns rain to snow. Shift weather is worked out from the stored day, so older days get it too.
- **Calendar:** month grid or week view with all four shifts. Click any day to drill down to weather, moons, holidays, per-shift activity, visibility and events.
- **Day page** (GM): change the day's region, edit or re-roll the weather, and write public notes and GM-only notes. For each shift you can enter activity and private notes, override visibility, or make that shift "now". *Export* downloads the day as a Markdown file (events, weather, notes and shifts) laid out like Sinless's Scabard export, for pasting into Scabard or another wiki; a player's file holds only what that player can see. *Add an action* offers 21 common shift tasks (march, navigate, scout ahead, keep watch, forage, hunt, make camp, stand guard, sleep and so on), adapted from the Year Zero Engine and Perilous Wilds travel rules; each one adds its name to the activity, which stays free text, and shows what it involves. The pass-time activity box suggests the same actions.
- **Events:** single-day or multi-day, all day or in one shift. GMs can mark an event **Secret** so players never receive it; this is filtered on the server. Players can add notes to any event they can see.
- **Travel tab:** calculates travel time, then *Depart* passes that much time. It labels the transit shifts, logs a travel event, and can change the region during travel and on arrival. Modes:
  - Overland / sea / air: speed × hours per day × terrain.
  - Hohmann orbital transfer: time, Δv, and how often launch windows repeat. Includes the Sol, Jupiter, Saturn and Earth–Moon systems.
  - Constant-thrust flip-and-burn at any g, with an optional speed cap.
  - Relativistic interstellar: shows ship time and outside-world time.
  - FTL: a fixed jump duration, or a speed in light-years per day.
- **Regions:** each region sets a climate, a hemisphere, a light source (sun and moons, artificial, or none) and a terrain modifier to visibility. The *Party is here* button sets the region used for new days.
- **Climates:** pick any of the 30 Köppen–Geiger classes (Af rainforest through EF ice cap), one of the simple setting climates (temperate, desert, underground, starship…), or build your own: choose the Köppen letters, load that class's baseline, then tune each season's range of daytime highs, precipitation (0–5) and how often storms, fog and dust turn up (0–3). The region form shows the resulting baseline weather and odds for each season. The new-campaign form sets the home region's climate. Baselines are rounded from representative stations' monthly normals (WorldClim, as mapped on openclimatemap.org).
- **Holidays:** same date every year, Nth weekday of a month, one-time, or every N days. Each can last several days and can be secret.
- **Settings:** time scale, temperature units, whether players see future weather, whether players may add events, and a full calendar editor. The editor covers months, festival days that sit outside the week, leap rules, seasons (with the hemisphere their dates are for; regions in the other hemisphere get the opposite season), moons (including erratic ones like Morrslieb), shift names, date format and hours per day.

## How visibility is scored (0 Pitch black … 5 Bright)

The score starts from a base value for the shift: overnight 0, dawn 3, noon 5, dusk 3. Artificially lit regions use their own level for each shift instead. Then:

- **Moonlight:** at night, up to +2 depending on how much of the moons is lit, reduced by cloud cover.
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
| `deploy.sh` | `git pull` + PHP syntax check, run on the server |

## Notes

- Every day is stored by an absolute day number. Editing a calendar re-labels existing days instead of moving their data.
- The Imperial preset's weekday alignment and moon starting phases are arbitrary. Adjust them in Settings if your campaign has canon dates.
- Shared with Sinless: the sign-in flow, the users and rate-limit tables, the server library, error bodies (`{"error": "code", "message": "…"}`), the UI kit in `static/kit.js` and the CSS token names (`--bg --panel --panel-2 --line --text --dim --accent --on-accent --ok --bad --disp --body --mono`).
- Security: every query uses prepared statements, every change needs a CSRF token, and the session cookie is HttpOnly and SameSite=Lax with idle and absolute timeouts. Sign-in is rate-limited per IP in the database. `.htaccess` forces HTTPS and sends HSTS, CSP and framing headers, and blocks the config, `db/`, `tests/` and `.git`. User text is never inserted as HTML.
