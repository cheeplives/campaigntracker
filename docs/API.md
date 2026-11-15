# GM's Almanac API

For programs that sit beside a campaign, such as a Foundry VTT module, a Discord bot or your own script. They can read
the campaign's date, weather, moons, the party's whereabouts and the Encyclopedia. With a read-and-write key, they can
also pass time and add notes and events.

## Keys

A member makes a key in the campaign, under **At the Table → Use in a VTT or on stream → New API key…**, and picks:

- **Read only:** only the read actions below.
- **Read and write:** the write actions too. Each still checks GM or player as GM's Almanac does. For example, only a GM
  can pass time, and a player adds an event only where the GM allows it.

A key acts as the member who made it. It sees exactly what they see in that one campaign, and nothing in their other
campaigns. It stops working when it is revoked (by its maker, or by any GM of the campaign) or when its maker leaves
the campaign. The key is shown once. GM's Almanac keeps only its SHA-256 hash.

## Requests

Send the key in the `X-Chronicle-Key` header. Each action is `api/index.php?a=<action>` under the site's address:

```sh
curl -H "X-Chronicle-Key: $KEY" "https://example.com/chronicle/api/index.php?a=campaign"
curl -H "X-Chronicle-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"abs_day": 120, "shift": 2, "body": "Reached the ford at dusk"}' \
  "https://example.com/chronicle/api/index.php?a=shift_note_add"
```

- Reads are `GET`. Writes are `POST` with a JSON body. No CSRF token or cookie is needed, and none is used: a request
  with a key is signed in by the key alone.
- The campaign comes from the key, so leave out `cid` (any `cid` sent is replaced by the key's campaign).
- Any site's page may call the API with a key: CORS is open to requests that carry `X-Chronicle-Key`. Keep the key out
  of anything public.
- Errors come back as `{"error": "<code>", "message": "<for people>"}`. A key that is wrong, revoked, read-only for the
  action, or not allowed it gets `401`. Too many requests (over 240 a minute per key, unless the site changes it) get
  `429`.

## Dates, shifts and weather

GM's Almanac counts time in **shifts** from the campaign's start. `current_shift` is where the campaign is now. A day has
`E.slotsPerDay(calendar)` shifts (4, 2 or the calendar's hours), so the day is `Math.floor(current_shift / spd)`
(`abs_day`) and the shift within it is `current_shift % spd`.

The calendar maths (dates, weekdays, seasons, moons, generated weather) is in `static/engine.js`, a plain script with no
dependencies. It runs in a browser (`window.Engine`) and under Node (`require`). Copy it into your program, or load it
from the site. For example:

```js
const E = require("./engine.js");
const { campaign } = await (await fetch(`${base}/api/index.php?a=campaign`, { headers: { "X-Chronicle-Key": key } })).json();
const cal = E.prep(campaign.calendar), spd = E.slotsPerDay(cal);
const day = Math.floor(campaign.current_shift / spd);
E.fmtDate(cal, day);                       // "Dawn" is E.shiftNames(cal)[campaign.current_shift % spd]
E.moons(cal, day);                         // [{ name, label, icon, illum }]
```

The weather GM's Almanac has rolled for a day is stored with it: read it with `day`. A player's key gets only the
shifts that have come round so far, unless the GM lets players see future weather.

## Read actions

| Action | Query | Answer |
| --- | --- | --- |
| `panel_whoami` | | `{ campaign_id, role, name, link }`: who the key acts as (`role` is `gm` or `player`) and the key's label and access. |
| `campaign` | | `{ campaign: { id, name, calendar, settings, current_shift, seed? }, role, regions, holidays, members, encyclopedia, … }`. `seed` (for generating weather) is there for a GM, or when players may see future weather. Members carry no emails. |
| `changed` | | `{ changed }`: a time stamp that moves when a GM changes the campaign, passing time included. Poll it cheaply, then re-read. |
| `changes` | `since` (a `changed` stamp, `YYYY-MM-DD HH:MM:SS`) | `{ changed, since, current_shift, entries: [{ id, name, category, updated_at }], events: [{ id, title, abs_day, shift, updated_at }], clocks: [{ id, name, updated_at }], sessions: [{ id, number, title, updated_at }] }`: what was added or saved at or after the stamp, as far as the key's member may see it (up to 500 of each). Keep the `changed` it answers as your next `since`. Something deleted is not listed, so re-read a list when you need to notice removals. |
| `day` | `d` (an `abs_day`) | `{ day: { abs_day, region_id, weather, notes, locations, … } \| null, shifts, shift_notes, events, today }`. |
| `days` | `from`, `to` (`abs_day`s) | The days in a range, with their weather, shifts, events and note previews. |
| `events` | | Every event the key's member may see: `{ events: [{ id, abs_day, end_day, shift, shift_end, title, body, … }] }`. |
| `reminders` | | `{ reminders: [{ id, due_shift, title, body, due, dismissed, … }], current_shift }`. |
| `encyclopedia` | | `{ entries: [{ id, name, category, aliases, notes, tags, … }], relations, relation_types, files, … }`. Notes are rich text (HTML). A player's key never gets GM notes, GM-only entries or GM-only paragraphs. |
| `groups` | | The party groups and where each one is: `{ groups: [{ id, name, members, region_id, map_id, x, y, … }], vehicles: [{ id, name, kind, amount, group_id }] }` (the party's vehicles from Holdings, each with the group it travels with, or null). |
| `maps` | | `{ maps: [...] }`. |
| `map` | `id` | One map with its pins and routes. |
| `clocks` | | `{ clocks: [{ id, name, description, segments, filled, visibility, by_gm, entry, archived, ticks, … }] }`. A player's key never gets secret clocks, and gets `filled: null` and no `ticks` on a vague clock someone else made. |
| `dice_rolls` | | The table's dice log as the key's member sees it: `{ rolls: [{ id, expr, seed, engine, visibility, … }], … }`. A roll's dice come from its `expr` and `seed` with `static/dice.js` (`Dice.roll`), the same plain script the pages use. |

## Write actions (read-and-write keys)

| Action | Body | Who | Does |
| --- | --- | --- | --- |
| `set_time` | `{ current_shift, label? }` | GM | Moves the campaign's clock to that shift. To pass time, read `current_shift` and add to it. `label` is the new date in words ("Dusk, 3 Firstmonth 1492", from `E.shiftNames` and `E.fmtDate`); the campaign's Discord channels post it. |
| `shift_note_add` | `{ abs_day, shift, body }` | anyone | Adds a note to a shift, signed as the key's member. |
| `entry_note_add` | `{ id, body, gm_only? }` | anyone | Adds a paragraph at the end of an Encyclopedia entry's public notes, or its GM notes when a GM sends `gm_only: true`. |
| `event_save` | `{ abs_day, title, body?, shift?, end_day?, shift_end?, is_secret? }` (with `id` to change one) | GM, or players where the campaign allows | Adds or changes an event. |
| `clock_tick` | `{ id, by? }` | the clock's maker, or a GM | Fills a clock by `by` segments (1 unless given; negative empties), stopping at empty and full. Answers `{ clock }`. |
| `dice_roll` | `{ expr, visibility? }` | anyone | Rolls in the table's dice log (`2d6+3`, or anything the roller's **?** card lists). The server picks the seed; read the result from `dice_rolls`. `visibility` is `all`, `gm` or `blind`, where the campaign lets the roller choose. |
| `pin_save` | `{ map_id, x, y, label, note? }` (with `id` to change one) | anyone; GMs also `kind` (`note`, `entry`, `event`), `entry_id`, `event_id`, `is_secret` | Adds or changes a pin on a map. `x` and `y` are in the map picture's pixels. A player changes only their own note pins. |

## Discord

A GM can have the campaign post to a Discord channel with no program at all: **At the Table → Use in a VTT or on stream
→ Add Discord channel…** takes the channel's webhook address and posts a line when time passes, an event is added, a
clock everyone can read fills, or a session ends. Only what every player may see is posted.

These actions are the same ones GM's Almanac's own pages use, so new fields may appear in answers. Fields are not renamed
or removed without a note in this file.
