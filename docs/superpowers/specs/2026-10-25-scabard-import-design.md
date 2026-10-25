# Import from Scabard

A GM moves a campaign's wiki from [Scabard](https://www.scabard.com) into Campaign Chronicle: Scabard's JSON export
becomes Encyclopedia entries with their tags, other names, notes, GM secrets, connections and pictures, and its dated
session logs become Sessions. Built 2026-10-25 from Josh's own export (154 pages, 654 connections).

## What the user sees

- **Where:** *Settings → Tools → ⬆ Import from Scabard…*, GMs only (Settings already is). It asks for the `.json`
  file Scabard's *Export campaign* writes.
- **Before anything is written**, a dialog lists what the file holds, by kind: characters, places, groups, items,
  notes, adventures, events, session logs (events whose name starts with a date, `2025-10-05: Final Preparations`),
  and what will be skipped (Scabard's attributes, categories, folders, tabs and comments, which have no page of their
  own here). Two choices:
  - **Session logs:** *Sessions* (default) or *Encyclopedia entries*.
  - **Copy pictures from Scabard** (default on, shown only when uploads are ready): each page's picture is fetched
    from scabard.com and added to the entry, credited to Scabard with a link to the page.
  And one line of reassurance: an entry that already has this name is kept as it is (a blank one is filled in), so the
  import can be run again after Scabard changes.
- **While it runs**, the dialog's button says what it is doing: entries in batches, then connections, then pictures
  one by one (each is a request of its own, so a slow picture never stalls the rest).
- **When it is done**, a dialog gives the counts: entries added and filled in, kept, sessions added, connections and
  tags added, pictures copied, and what was skipped or couldn't be fetched. *OK* reloads the campaign.

## How Scabard's pages map

| Scabard | Here |
|---|---|
| `Character`, `Place`, `Group`, `Item`, `Note`, `Adventure`, undated `Event` | Encyclopedia entry tagged `Person`, `Location`, `Group`, `Item`, `Note`, `Adventure`, `Event` |
| dated `Event` (`YYYY-MM-DD: Title`) | a Session: *Played on* the date, titled the rest, closed on the campaign's current day, published unless the page was secret; or an entry tagged `Event` when the GM picks that |
| `name` | the entry's name (150 characters at most) |
| `aliases` (comma-separated) | the entry's other names |
| `briefSummary` + `description` | Public notes: the summary as the first paragraph, then the description, cleaned by `rich_html_clean` (Scabard's `<div>` becomes `<p>`, `<span>` is unwrapped, links to Scabard's own pages become plain text, which the app links to the entry anyway) |
| `gmSecrets` (else `secrets`) | GM notes (entries); GM-only `<aside>` paragraphs at the end of the summary (sessions) |
| `isSecret` | GM only |
| `imageURL` / `largeImageURL` | a picture on the entry, fetched from `https://www.scabard.com` (only that host; a picture hosted elsewhere is left out and named in the report) |
| `CCategory` page connected with `*_CATEGORY_OF`, `RACE_OF`, `ROLE_OF` or any other `*_OF` to an entry | a tag named after the category (`City`, `NPC`, `PC`…) |
| `PLAYER_OF` from a user | a `Player: name` line at the end of the character's Public notes |
| `Attribute`, `CCategory`, `Folder`, `FlexTab` pages; `CONCEPT_OF`, `FOLDER_OF`, `CATEGORY_OF`, `TAB_OF`, `COMMENT_OF`, `CLONE_OF` | skipped (the tab's text isn't in the export; a clone is Scabard's template copy) |

## How connections map

A Scabard connection `A RELATION_OF B` means "A is the *relation* of B". It becomes a connection between the two
entries with a kind whose label reads from A and whose inverse reads from B, through `relation_type_id()`, so the
starter kinds are reused where they fit and a kind made here once is reused on every run:

| Scabard | from A | from B |
|---|---|---|
| `PARTICIPANT_OF` | Participant in | Has participant |
| `PROTAGONIST_OF` | Protagonist of | Has protagonist |
| `ANTAGONIST_OF` | Antagonist of | Has antagonist |
| `SETTING_OF` | Setting of | Set in |
| `PROP_OF` | Prop in | Has prop |
| `SUBREGION_OF` | Located in | Contains (starter) |
| `LOCATION_OF` | Has resident | Resident of (starter) |
| `HEADQUARTERS_OF` | Headquarters of | Headquartered at |
| `BIRTHPLACE_OF` | Birthplace of | Born in |
| `LEADER_OF` | Leader of | Led by |
| `OWNER_OF` | Owns | Owned by (starter) |
| `MEMBER_OF` | Member of | Has member (starter) |
| `STEWARD_OF` | Steward of | Has steward |
| `SEEKER_OF` | Seeks | Sought by |
| `MAKER_OF` | Maker of | Made by |
| `AGENT_OF` | Agent of | Has agent |
| `NOTE_OF` | Note on | Has note |
| `BRANCH_OF` | Branch of | Has branch |
| `ENCOUNTER_OF`, `SUB_EVENT_OF` | Part of | Has part |
| `NEXT_EVENT_OF` | Follows | Followed by |
| `NEIGHBOR_OF`, `RIVAL_OF`, `COMPANION_OF`, `ALLY_OF`, `ENEMY_OF`, `RELATED_ITEM_OF`, `RELATED_OF` | symmetric: Neighbor of, Rival of, Companion of, Ally of, Enemy of, Related to |
| anything else `X_OF` | X of / Has x |

A connection Scabard marks secret is GM only; one marked former gets the note *Former*. A connection that touches a
secret entry is GM only, as everywhere.

When one end is a Session rather than an entry, there is no connection to make: the names are written into the
summary instead, as a last paragraph per kind the app's own suggestions read (`Participants: Figol, Chanceux`,
`Setting: Occam`, `Protagonists: …`, `Antagonists: …`, `Props: …`, `Part of: Quest to the Petrified Forest`). Between
two sessions nothing is kept (the dates order them).

## Running it again

Everything is matched by name, which Scabard keeps unique within a campaign and the Encyclopedia does too:

- an entry that exists (by name or other name) is **kept**; one with nothing written in it yet is **filled in** (notes,
  GM notes, other names), so names the Proper Noun Detector added first get their text;
- tags and connections are **added** where missing (the connection table's unique key and a check of both orders for a
  symmetric kind);
- a session with the same date and title is **kept**, and a cast line is appended only when the summary doesn't have it;
- a picture is fetched only for an entry that has no picture yet.

## The pieces

- **`api/scabard.php`** (new, included by `api/index.php` like `images.php`): `scabard_import(int $cid, array $body)`
  behind the action `scabard_import` (GM, POST, in `$touchActions`). The body carries `pages` (up to 300) and/or
  `conns` (up to 3000) and `options` (`sessions`: `sessions` | `entries`), each call one transaction, so the browser
  sends a big export in several calls: all the pages first, then all the connections. Returns the counts. Also
  `scabard_picture` (GM, POST): `name`, `urls` (tried in order), `page_url`; fetches through `image_download()` (https,
  public addresses only), checks it is a picture with `upload_type()`, keeps it with `attachment_store()` credited
  *Scabard*; refuses hosts other than scabard.com; skips an entry that has a picture already.
- **`static/scabard.js`** (new): `Scabard.parse(text)` checks the file is a Scabard export and trims each page and
  connection to what the server needs, with each connection's end concepts filled in from the pages (`fromc`, `toc`);
  `Scabard.plan(data)` gives the counts for the dialog; `Scabard.sessionOf(name)` splits a dated name; `batches()`
  splits for the 2 MB request limit; `pick()` opens the file picker.
- **`static/app.js`**: the button in Settings → Tools and the import dialog, which drives the calls and shows progress.
- **`index.html`** loads `static/scabard.js`.
- **Tests:** `tests/browser/scabard-import.spec.js` imports a small made-up export through the dialog and checks every
  mapping above, that a second run adds nothing twice, that a player is refused, and that pictures come through the
  image stub (which now answers `www.scabard.com` too) with their credit.
- **Docs:** README (Using it), tests/README.

## Out of scope

Scabard's attributes as fields on an entry, its tabs' text (not exported), comments, and moving pictures hosted
elsewhere than Scabard. Nothing is deleted or overwritten here: the import only adds.
