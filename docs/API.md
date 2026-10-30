# Campaign Chronicle API

For programs that sit beside a campaign, such as a Foundry VTT module, a Discord bot or your own script. They can read
the campaign's date, weather, moons, the party's whereabouts and the Encyclopedia. With a read-and-write key, they can
also pass time and add notes and events.

## Keys

A member makes a key in the campaign, under **At the Table → Use in a VTT or on stream → New API key…**, and picks:

- **Read only:** only the read actions below.
- **Read and write:** the write actions too. Each still checks GM or player as Chronicle does. For example, only a GM
  can pass time, and a player adds an event only where the GM allows it.

A key acts as the member who made it. It sees exactly what they see in that one campaign, and nothing in their other
campaigns. It stops working when it is revoked (by its maker, or by any GM of the campaign) or when its maker leaves
the campaign. The key is shown once. Chronicle keeps only its SHA-256 hash.

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

Chronicle counts time in **shifts** from the campaign's start. `current_shift` is where the campaign is now. A day has
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

The weather a GM's Chronicle has rolled for a day is stored with it: read it with `day`. A player's key gets only the
shifts that have come round so far, unless the GM lets players see future weather.

## Read actions

| Action | Query | Answer |
| --- | --- | --- |
| `panel_whoami` | | `{ campaign_id, role, name, link }`: who the key acts as (`role` is `gm` or `player`) and the key's label and access. |
| `campaign` | | `{ campaign: { id, name, calendar, settings, current_shift, seed? }, role, regions, holidays, members, encyclopedia, … }`. `seed` (for generating weather) is there for a GM, or when players may see future weather. Members carry no emails. |
| `changed` | | `{ changed }`: a time stamp that moves when a GM changes the campaign, passing time included. Poll it cheaply, then re-read. |
| `day` | `d` (an `abs_day`) | `{ day: { abs_day, region_id, weather, notes, locations, … } \| null, shifts, shift_notes, events, today }`. |
| `days` | `from`, `to` (`abs_day`s) | The days in a range, with their weather, shifts, events and note previews. |
| `events` | | Every event the key's member may see: `{ events: [{ id, abs_day, end_day, shift, shift_end, title, body, … }] }`. |
| `reminders` | | `{ reminders: [{ id, due_shift, title, body, due, dismissed, … }], current_shift }`. |
| `encyclopedia` | | `{ entries: [{ id, name, category, aliases, notes, tags, … }], relations, relation_types, files, … }`. Notes are rich text (HTML). A player's key never gets GM notes, GM-only entries or GM-only paragraphs. |
| `groups` | | The party groups and where each one is: `{ groups: [{ id, name, members, region_id, map_id, x, y, … }] }`. |
| `maps` | | `{ maps: [...] }`. |
| `map` | `id` | One map with its pins and routes. |

## Write actions (read-and-write keys)

| Action | Body | Who | Does |
| --- | --- | --- | --- |
| `set_time` | `{ current_shift }` | GM | Moves the campaign's clock to that shift. To pass time, read `current_shift` and add to it. |
| `shift_note_add` | `{ abs_day, shift, body }` | anyone | Adds a note to a shift, signed as the key's member. |
| `entry_note_add` | `{ id, body, gm_only? }` | anyone | Adds a paragraph at the end of an Encyclopedia entry's public notes, or its GM notes when a GM sends `gm_only: true`. |
| `event_save` | `{ abs_day, title, body?, shift?, end_day?, shift_end?, is_secret? }` (with `id` to change one) | GM, or players where the campaign allows | Adds or changes an event. |

These actions are the same ones Chronicle's own pages use, so new fields may appear in answers. Fields are not renamed
or removed without a note in this file.
