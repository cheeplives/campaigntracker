# Secret paragraphs, View as player and @ mentions

Three features picked from the comparison of other campaign trackers (Kanka, LegendKeeper, Realm Works, Campaign
Logger). Agreed with Josh on 2026-10-24.

## Secret paragraphs

- **Where:** the rich-text notes players can read: a day's Public notes, Encyclopedia public notes and Library tomes.
  Plain-text boxes (event details, shift activity) keep Secret events and GM notes instead.
- **Writing:** GMs get a 🔒 button in the editor. It marks the selected lines GM only; each one is saved as `<aside>`
  (a Quill block format, `secret`). A run of them reads as one band labelled "GM only".
- **Allow-list:** `aside` is added to both copies (api/richtext.php, static/richtext.js). An aside inside another is
  unwrapped and never carries attributes, so each one is exactly `<aside>…</aside>`.
- **Filtering:** `rich_open()` removes them from everything a player is sent: `day`, the `days` previews, `encyclopedia`,
  the campaign's entry index (preview and blank), `library` (word count), `tome`, `tome_save`'s reply and
  `encyclopedia_sources` (so Mentioned in, Search and the detector's scan). Only rich text (format `html`) is filtered;
  plain text is shown as typed. GMs' previews show the secret paragraphs with the GM notes.
- **Player saves:** `rich_keep_secrets()` puts the stored copy's secret paragraphs back into a player's save of an entry
  or tome, each run after the top-level paragraph it followed (matched by text), at the start when it came first, or at
  the end when that paragraph is gone. Anything secret a player sends is dropped.
- **Detector:** a name found only in a secret paragraph is offered as GM only (the server splits its sources; the
  browser splits what was just saved, and the connection suggestions).

- **Reveal:** on an entry's or a tome's page, a GM's *🔓 Reveal* on the first of a run of secret paragraphs makes the
  run public (`secret_reveal`: each `<aside>` becomes `<p>`). The request names each paragraph by its index and its text,
  so a note changed since is refused (409). *Reveal and log it today* also adds a public event, *Revealed: name*, tagged
  Revealed, on the campaign's current day; *Just reveal* logs nothing. Day notes are unlocked with the 🔒 button in their
  editor, which is how the GM always sees them.

## View as player

- A GM's 👁 *View as player* button sets a per-tab flag for the campaign (sessionStorage). Every request for that
  campaign then sends `X-View-As: player`, and `role()` answers it as a player, through the same filtering.
- Changes (POST) are refused with 403 `viewing_as_player` while the flag is on. A banner with *Leave player view*
  shows meanwhile. Reminders addressed to one particular player don't show, since they're nobody's in this view.

## @ mentions

- In every rich-text editor, `@` and up to 40 characters (not starting with a space) opens a list of up to eight
  Encyclopedia names or aliases that match (whole name or any word, from the start), from the entries this member can
  see. Arrow keys move, Enter or Tab picks, Escape leaves the `@` as typed; a tap picks too.
- Picking writes the entry's name and a space in place of the `@` and what followed; the note links it the way it links
  every name. The last line adds what was typed as a new entry (`entry_save`) and writes it.

No database change: the secret paragraphs live in the notes' existing columns.
