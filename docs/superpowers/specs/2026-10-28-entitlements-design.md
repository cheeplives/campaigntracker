# Entitlements: what each account may do

The first piece of taking Campaign Chronicle commercial. Today every approved account can do everything. This adds
one place in the app that answers "what may this account do here?": which plan it is on and that plan's limits,
which features are switched on, and which licensed content it can see. Billing, self-serve sign-up and the move to
a commercial host plug into it later. Agreed with Josh on 2026-10-28; design only, nothing is built yet.

## Where this fits

The commercial plan, agreed in the project thread on 2026-10-28:

- **Hosted service, not self-hosted.** One install, high hundreds to low thousands of users, run solo as a side
  hustle. Stay on PHP 8 + MySQL + plain JavaScript; no rewrite.
- **GMs pay, players are free.** A GM's plan sets size limits (campaigns, players, storage). Every feature is in
  every plan for now, but the design must allow a feature to become paid-only later if it costs too much to give away.
- **Licensed IP stays hidden.** The setting presets and non-open fan-wiki sources stay available to Josh (and anyone
  he grants) and hidden from everyone else until a licence is agreed, when they can be switched on without a deploy.
- **One service.** Josh's own campaigns move onto it. Accounts split from Sinless.

The pieces, each with its own spec, in order:

1. **Entitlements** (this spec).
2. **Accounts:** split users from Sinless, self-serve sign-up instead of admin approval, account export and deletion.
3. **Billing:** a merchant of record (Paddle or Lemon Squeezy) sets an account's plan through webhooks.
4. **Hosting and operations:** a VPS, a migration runner, nightly off-site backups, uptime alerts, object storage
   for uploads if needed.
5. **Legal:** terms, privacy policy, takedown process for user-shared content. Can run alongside the others.

### Direct access to pages (for piece 4)

Knowing the URLs doesn't get anyone data today. `index.html` and `static/` are public, as every web app's are, but
they hold no campaign data. Every data request goes through `api/index.php`. It checks the sign-in and the account's
approval (`me()`), membership of the campaign (`role()`), and GM-only actions (`need_gm()`). The other PHP files in
`api/` only define functions, so opening one directly returns an empty page. Piece 4 tightens this further:

- **A `public/` web root.** Only `index.html`, `static/`, `api/index.php` and `api/auth/` sit under it. The library
  files, `content/`, `db/` and `install.php` move outside it, so the web server can't serve them at all, whatever
  `.htaccess` says.
- **Until then, an `.htaccess` rule** denies every `api/*.php` except `index.php` and `auth/*.php`.
- **An access test for every action.** For each action in `api/index.php`, a CI test asks as a signed-out visitor,
  as a member of another campaign, and as a player for a GM-only action. Each must be refused. It catches a new
  action that forgets its check.
- **Rate limits beyond sign-in**, per account, on the search and import actions that call outside services.
- **The installer off for good** on the commercial site: migrations run from the deploy script, not a web page.

## Goals

- One server-side function decides every "may they?" question. No permission logic is copied into the endpoints.
- Restricted content never reaches a browser that isn't allowed it. That includes the static JavaScript, which
  anyone can read, not just the UI.
- Installing this on Josh's current server changes nothing for him or his players.
- Plans, limits and feature switches live in config, so changing a price tier doesn't need code.
- Switching a licensed item on for everyone is one admin click.

## Non-goals

- Payments, prices, invoices (piece 3). Here a plan is set by an admin, or by a default in the config.
- Sign-up, account deletion, the Sinless split (piece 2).
- User-shared calendar templates and their takedown tool (with piece 5).
- Choosing the actual limits. The numbers below are placeholders for Josh to set.

## The three ideas

### 1. Plans: size limits per account

A plan is a named set of limits and feature switches, defined in config:

```php
'plans' => [
  'free' => [
    'label'            => 'Free',
    'campaigns'        => 1,     // campaigns this account owns
    'members'          => 6,     // people in one of its campaigns, GMs included
    'storage_mb'       => 100,   // all uploads across the campaigns it owns
    'upload_mb'        => 10,    // largest single file
    'features'         => '*',   // every feature; or a list such as ['calendar', 'events', 'encyclopedia']
  ],
  'gm' => [
    'label' => 'Game Master', 'campaigns' => 10, 'members' => 12, 'storage_mb' => 2000, 'upload_mb' => 25, 'features' => '*',
  ],
  'unlimited' => [
    'label' => 'Unlimited', 'campaigns' => null, 'members' => null, 'storage_mb' => null, 'upload_mb' => null, 'features' => '*',
  ],
],
'default_plan' => 'unlimited',   // a new account's plan; 'free' on the commercial site
```

`null` means no limit. `default_plan` is what makes this safe to deploy today: on Josh's server it stays
`unlimited`, so nothing changes. The commercial site sets it to `free`.

**The plan that counts is the campaign owner's.** Players are free and have no plan of their own that matters
inside someone else's campaign. When anyone acts in a campaign, the limits and features come from the account that
owns it. An account's own plan only decides things that belong to the account: how many campaigns it may own.

This needs one new idea in the data: **a campaign's owner.** Today a campaign has `created_by` and any number of
GMs. The owner is the one GM whose plan the campaign uses (and who will pay, in piece 3). It starts as `created_by`.
Changing the owner comes with billing. The owner can't be removed from the campaign or made a player.

### 2. Features: the switch for "paid only, later"

Every area of the app gets a feature key:

| Key | Area |
|---|---|
| `calendar` | Calendar, days, weather, shifts, regions, holidays (always on; listed so the list is complete) |
| `events` | Events, the timeline, event notes |
| `travel` | Travel planner |
| `downtime` | Downtime |
| `holdings` | Party holdings, gear, funds, storage |
| `reminders` | Reminders |
| `encyclopedia` | Encyclopedia entries, connections, the Proper Noun Detector |
| `uploads` | Pictures and files on entries, the library and sessions |
| `library` | Library tomes |
| `sessions` | Session notes |
| `generators` | Generators tab |
| `find_image` | Find Image (Openverse, the Met, AIC, Smithsonian) |
| `fan_wikis` | Fan Wiki Summary and Find Image's fan wiki tab (the open wikis) |
| `scabard` | Import from Scabard |

Today every plan has `'features' => '*'`. If a feature turns out to cost too much to give away (Find Image's API
calls or upload storage are the likely ones), it gets removed from the free plan's list. Nothing else changes: the
check is already in place, and the UI already knows how to show a feature as "part of the Game Master plan".

### 3. Content: licensed IP behind a switch

A **content item** is a piece of third-party IP that may need a licence. Each one has a key and a state:

| State | Who sees it |
|---|---|
| `restricted` | Only accounts with a grant for it (or for `*`). The default for every item below. |
| `everyone` | Everyone. Used once a licence is agreed, or the owner's fan policy allows commercial use. |
| `off` | Nobody, not even grant holders. For an owner who has asked us to stop. |

The items, from `SOURCES-TO-LICENSE.md`:

- `preset:<key>` for each setting preset, by its existing key in `PRESETS`: `imperial`, `middleearth`, `glorantha`,
  `harptos`, `eberron`, `exandria`, `golarion`, `galactic`, `greyhawk`, `ironkingdoms`, `darksun`, `rokugan`,
  `traveller`, `witcher` (each preset with its own regions,
  holidays, moons and any data only it uses, such as Glorantha's Red Moon bands or Star Wars' planets and
  hyperdrive classes).
- `fanwiki:<key>` for each wiki in `api/fanwikis-nonopen.php`, and `fanwiki:fair_use` for copying pictures that
  aren't openly licensed.
- `findimage:deviantart`.

The list of items lives in code (`api/content.php`), so a new preset or wiki has to be classified when it's added.
The state and the grants live in the database, so Josh can change them from the admin page without a deploy.
Gregorian (both hemispheres), Starship clock and Custom are the app's own and are not content items.

**Who counts as having a grant, inside a campaign:** the campaign's owner. If Josh owns a campaign that uses the
Glorantha preset, his players see Glorantha's calendar and can use what he can use in that campaign. This is his
private game, so it's personal use. A player with no grant who starts a campaign of their own doesn't see Glorantha.

**Existing campaigns keep their calendars.** A campaign stores its own copy of its calendar in `calendar_json`.
Restricting a preset only removes it from the list of presets offered. It never touches a campaign's data. If a user
imports a calendar file they made, that's their content, not ours, and it isn't checked.

## Keeping restricted content out of the browser

Today the presets, their `SOURCES` and data such as `RED_MOON_PHASES` are written into `static/engine.js`. Anyone can
read that file, signed in or not. Hiding a preset in the UI would not hide it.

So the restricted data moves out of `static/` into `content/` next to `api/`. That folder holds one JSON file per
content item, and `.htaccess` blocks it the way it already blocks `db/` and `tests/`. The engine keeps its math
(moon cycles, weekday alignment, how regional moon phases are worked out) and takes the data as input:

- `GET api/index.php?a=presets` returns the presets this person may see, in the campaign they're in, with their
  sources. The new-campaign dialog and *Settings → Calendar* use it instead of `E.PRESETS`. The open presets
  (Gregorian, Starship clock, Custom) stay in `engine.js`, so the app still works before the call returns.
- Data a campaign needs to run, such as the Red Moon bands, is kept in its `calendar_json` when the preset is
  applied, the same way months and moons already are. So a campaign never needs to ask for the preset again.
- **The About page** lists the sources of the app's own and open data, plus the sources of every content item the
  viewer can see. Josh sees them all. *A choice for Josh:* the project rule says to list every source, but listing
  a hidden preset's sources would name content the viewer can't use. This design reads "every source used" as
  "every source used for this viewer".
- A CI check fails the build if any restricted item's name (its `label`, from the content files) appears in
  `static/`. It keeps restricted content from creeping back into the public JavaScript.

The fan wikis already work this way: the non-open list is only in `api/fanwikis-nonopen.php`. They just check the
content item per wiki instead of the global `open_only` switch. That switch and the kill-switch script stay as the
emergency off for everything.

## The one function

`api/entitlements.php`, required by `api/index.php` and the other endpoints:

```php
/** What $user may do; in $campaign when one is given (its owner's plan and grants apply). Cached per request. */
function ent(array $user, ?array $campaign = null): Ent;

final class Ent {
    public function plan(): array;                         // the plan's row from config, with its key
    public function limit(string $key): ?int;              // 'campaigns', 'members', 'storage_mb', 'upload_mb'; null = none
    public function has(string $feature): bool;            // 'encyclopedia', 'find_image', …
    public function sees(string $item): bool;              // 'preset:glorantha', 'fanwiki:memory-alpha', …
    public function need(string $feature): void;           // has() or fail with not_entitled
    public function needRoom(string $key, int $used, int $adding = 1): void;  // under the limit or fail with plan_limit
}
```

Every endpoint states what it needs in one line. For example `campaign_create` calls
`ent($u)->needRoom('campaigns', owned_count($u))`, and `entry_save` calls `ent($u, $camp)->need('encyclopedia')`.
The existing GM-or-player checks stay as they are. Entitlements sit alongside role checks and don't replace them.

**Errors**, in the existing `{"error", "message"}` shape, as 403:

- `{"error": "plan_limit", "limit": "campaigns", "max": 1, "plan": "free", "message": "The Free plan has 1 campaign. …"}`
- `{"error": "not_entitled", "feature": "find_image", "message": "Find Image is part of the Game Master plan."}`
- A restricted content item isn't an error: it simply isn't listed, and a direct request for it is answered as if it
  didn't exist (`unknown_preset`, `unknown_wiki`), so the app never confirms what's hidden.

**The browser's copy.** `api/auth/me.php` adds `plan` (key, label, limits) and the account's own feature list, and
`a=campaign` adds the campaign's (its owner's) features, limits and usage (campaigns owned, members, storage used).
`static/app.js` hides nothing on its own say-so. It uses these only to explain: a disabled *New campaign* button
with "Your Free plan has 1 campaign", a storage bar in Settings, and a feature that's off shown with a short note
naming the plan that has it. Until billing exists, that note says to contact the admin.

## What happens at a limit

Nothing is ever deleted or locked because of a plan. Limits stop *new* things:

- Over the campaign limit (after a downgrade, say): every campaign keeps working, but no new one can be made.
- Over the member limit: nobody new can be added. Everyone already in stays.
- Over the storage limit: no new uploads. Existing files still show.
- A feature switched off for a plan: its data stays and is shown read-only. New entries or changes are refused with
  `not_entitled`. A downgraded GM can always see and export what they made.

Piece 3 may tighten this, for example a grace period followed by read-only, once there's real abuse to answer.

## Data

Migration `db/migrations/019_entitlements.sql`, also folded into `db/schema.sql` and `install.php`. It doesn't touch
`users`, which is still shared with Sinless until piece 2:

```sql
-- the plan an account is on; no row = config default_plan
CREATE TABLE account_plans (
  user_id     BIGINT UNSIGNED PRIMARY KEY,
  plan        VARCHAR(32)  NOT NULL,
  source      ENUM('admin','billing') NOT NULL DEFAULT 'admin',
  until       DATETIME NULL,                       -- null = open-ended; billing sets it
  note        VARCHAR(255) NOT NULL DEFAULT '',
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- a content item's state, when an admin has changed it from the code's default ('restricted')
CREATE TABLE content_states (
  item        VARCHAR(64) PRIMARY KEY,             -- 'preset:glorantha'
  state       ENUM('restricted','everyone','off') NOT NULL,
  note        VARCHAR(255) NOT NULL DEFAULT '',    -- e.g. "Chaosium licence, signed 2027-01-10"
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- who may see a restricted item; item '*' = every item
CREATE TABLE content_grants (
  user_id     BIGINT UNSIGNED NOT NULL,
  item        VARCHAR(64) NOT NULL,
  granted_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, item),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE campaigns ADD COLUMN owner_id BIGINT UNSIGNED NULL AFTER created_by,
  ADD FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
UPDATE campaigns SET owner_id = created_by;
```

The migration also grants `*` to every account in `admin_identities`, so Josh keeps every preset and wiki the moment
it runs. A campaign with no owner (its creator deleted) uses the `default_plan` and sees only `everyone` content
until an admin gives it an owner.

Storage used is worked out from the `attachments` table, which already records each file's size, summed over the
campaigns an account owns. The existing per-campaign `uploads.campaign_mb` config is replaced by the plan's
`storage_mb`.

**Deploy step for Josh:** run `019_entitlements.sql` (or *Install or upgrade* in `install.php`) and add `plans` and
`default_plan` to the config. With `default_plan => 'unlimited'` and his admin grant, nothing changes for anyone.

## Admin

On the existing *Users* page, each account gets a **Plan** drop-down (with an optional end date and note) and a
**Content access** list of its grants. A new **Content** admin page lists every content item, grouped as Presets,
Fan wikis and Find Image, with its state, its note and how many campaigns use it. Turning an item to `everyone`
when a licence arrives is one change there, and it also shows the item's row in `SOURCES-TO-LICENSE.md` to update.

## Testing

Playwright tests, in the existing `tests/browser/` style, with three seeded accounts: an admin with `*`, a GM on
`free`, and a player in the admin's campaign.

- The free GM's new-campaign dialog lists only the open presets. `a=presets` returns no restricted key, and asking
  for `preset:glorantha` by name gets `unknown_preset`.
- The player sees the Glorantha calendar in the admin's campaign but not in a campaign of their own.
- Switching `preset:glorantha` to `everyone` on the Content page makes it show for the free GM without a deploy. Switching it to `off` hides it from the admin too.
- The free GM's second campaign is refused with `plan_limit`, the button says why, and both campaigns still open
  after the admin moves the account down from `gm` to `free`.
- Removing `find_image` from the free plan's features (in a test config) disables the button with its note and
  refuses the API call with `not_entitled`.
- Uploads stop at `storage_mb`, and existing files still show.
- The CI check: no restricted label in `static/`.

## Open questions for later pieces

- Real limits and prices (with piece 3).
- Whether a campaign's ownership can be handed to another GM, and what happens to the plan (with piece 3).
- Whether user-shared calendar templates need their own content state, and the takedown tool (with piece 5).
