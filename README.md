# Campaign Chronicle — RPG campaign tracker

A web-based tracker for tabletop campaigns: in-game calendar, four shifts per day, weather by
region and season, moon phases, visibility, holidays, events with secret GM entries, player notes,
and a travel planner for overland, orbital and interstellar trips.

PHP 8 + MySQL on the server, plain JavaScript in the browser. No build step or frameworks.

## Install on DreamHost

1. **Create a database.** In the DreamHost panel go to *Websites → MySQL Databases*. Create a database, a user and a hostname (e.g. `mysql.yourdomain.com`).
2. **Upload the files.** Put the contents of this folder in your site directory, either the root or a subfolder like `~/yourdomain.com/chronicle/`. Use SFTP or the file manager.
3. **Configure.** Copy `lib/config.sample.php` to `lib/config.php` and fill in the four database values.
4. **Install.** Visit `https://yourdomain.com/chronicle/install.php` and create your admin (GM) account.
5. **Lock the installer.** In `lib/config.php` set `'allow_install' => false`, or delete `install.php`.
6. **Use HTTPS.** Turn on DreamHost's free Let's Encrypt certificate so logins are encrypted.

`lib/.htaccess` blocks web access to the config and library files. DreamHost runs Apache, so it works without further setup.

## Using it

- **Users** (admins only): create accounts for your players.
- **New campaign:** pick a preset (Gregorian for the Northern or Southern Hemisphere, Imperial Calendar, Starship clock, or a blank custom calendar), a starting date, and the seasons. Each season has a name, a climate (spring, summer, autumn, winter or none) and a first month and day; a table shows which season every month falls in. Each campaign has its own calendar, regions, holidays and settings.
- **Members tab:** add players to the campaign, or add a co-GM.
- **Pass time** (GM, top of every campaign page): move ahead by shifts, days, weeks, months or years. You can also label the passed shifts, e.g. "Coach journey". Weather is generated for each day as time passes, and stays fixed once generated.
- **Calendar:** month grid or week view with all four shifts. Click any day to drill down to weather, moons, holidays, per-shift activity, visibility and events.
- **Day page** (GM): change the day's region, edit or re-roll the weather, and write public notes and GM-only notes. For each shift you can enter activity and private notes, override visibility, or make that shift "now".
- **Events:** single-day or multi-day, all day or in one shift. GMs can mark an event **Secret** so players never receive it; this is filtered on the server. Players can add notes to any event they can see.
- **Travel tab:** calculates travel time, then *Depart* passes that much time. It labels the transit shifts, logs a travel event, and can change the region during travel and on arrival. Modes:
  - Overland / sea / air: speed × hours per day × terrain.
  - Hohmann orbital transfer: time, Δv, and how often launch windows repeat. Includes the Sol, Jupiter, Saturn and Earth–Moon systems.
  - Constant-thrust flip-and-burn at any g, with an optional speed cap.
  - Relativistic interstellar: shows ship time and outside-world time.
  - FTL: a fixed jump duration, or a speed in light-years per day.
- **Regions:** each region sets a climate, a hemisphere, a light source (sun and moons, artificial, or none) and a terrain modifier to visibility. The *Party is here* button sets the region used for new days.
- **Holidays:** same date every year, Nth weekday of a month, one-time, or every N days. Each can last several days and can be secret.
- **Settings:** time scale, temperature units, whether players see future weather, whether players may add events, and a full calendar editor. The editor covers months, festival days that sit outside the week, leap rules, seasons (with the hemisphere their dates are for; regions in the other hemisphere get the opposite season), moons (including erratic ones like Morrslieb), shift names, date format and hours per day.

## How visibility is scored (0 Pitch black … 5 Bright)

The score starts from a base value for the shift: overnight 0, dawn 3, noon 5, dusk 3. Artificially lit regions use their own level for each shift instead. Then:

- **Moonlight:** at night, up to +2 depending on how much of the moons is lit, reduced by cloud cover.
- **Weather:** a modifier such as fog −3, or a blizzard −4 by day.
- **Terrain:** the region's modifier.
- **GM override:** if set on that shift, it replaces the result.

Hover over any visibility badge to see this breakdown.

## Files

| File | Purpose |
|---|---|
| `index.html`, `assets/` | The app (`engine.js` = calendar/weather/visibility/travel math, `app.js` = UI) |
| `api.php` | JSON API; enforces GM vs player permissions and secret filtering |
| `install.php` | One-time table setup + first admin |
| `lib/schema.sql` | Database tables |
| `lib/config.sample.php` | Copy to `lib/config.php` |

## Notes

- Every day is stored by an absolute day number. Editing a calendar re-labels existing days instead of moving their data.
- The Imperial preset's weekday alignment and moon starting phases are arbitrary. Adjust them in Settings if your campaign has canon dates.
- Security: passwords are hashed with `password_hash`, and every query uses prepared statements. Each change needs a CSRF token. The session cookie is HttpOnly and SameSite=Strict. Logins are rate-limited. User text is never inserted as HTML.
