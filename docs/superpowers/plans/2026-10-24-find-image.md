# Find Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A *🖼️ Find Image* button on Encyclopedia entries that searches Openverse, two museums and DeviantArt, saves
openly licensed pictures with their credit, and embeds other DeviantArt works without copying them.

**Architecture:** The PHP API searches every source on the browser's behalf (`image_search`), and `image_import`
re-looks a work up by source and id before copying it (or, for DeviantArt, storing an embed). Credits and embeds are
new columns on `attachments`. The browser adds a search panel to the existing Pictures and files box.

**Tech Stack:** PHP 8.3 + MySQL (api/index.php, api/lib.php), vanilla JS (static/app.js), Playwright tests.

**Spec:** `docs/superpowers/specs/2026-10-24-find-image-design.md`

## Global Constraints

- Allowed licences: CC0, public domain (PDM), CC BY, CC BY-SA, any version. Never NC, ND, unknown, all rights reserved.
- Migration file `db/migrations/017_attachment_credits.sql`; columns as the spec lists; schema.sql has them too.
- Outbound calls only through `image_http()`; the browser never sends a URL or licence to save.
- Embeds redirect only to https on `*.wixmp.com` / `*.deviantart.net`; oEmbed rechecked after 6 hours.
- `rate_limit('image_search', (string)me()['id'], 30, 60)` on searches.
- User-facing copy as in the spec ("Use this picture", "View on DeviantArt", "Artist's page", "Embed from DeviantArt",
  "No longer on DeviantArt", "Saving found pictures needs a database upgrade").

## Review Focus

- A search with no results or an empty box: say "Nothing found for "q"." / "Type something to search for." — tested in Task 5.
- A source answering garbage or timing out: that tab says it couldn't be reached; others still work — tested in Task 2.
- An image larger than the upload limit at the source: fall back to the thumbnail-size image, else a clear 413 — tested in Task 3.
- A player importing onto a secret entry or as GM only: refused / secret flag ignored, as `file_upload` does — tested in Task 3.
- An embed whose oEmbed answer points at an unexpected host: refused (no open redirect) — tested in Task 4.

---

### Task 1: Database columns and credit output

**Files:** Create `db/migrations/017_attachment_credits.sql`; modify `db/schema.sql` (attachments), `install.php`
(run 017 when `attachments` has no `credit_license` column), `api/index.php` (`attachment_out`, `has_credits()`),
`api/config.example.php` (`image_search` block), `tests/support/config.test.php` (`image_search.stub`).

**Produces:** `has_credits(): bool`; `attachment_out()` adds `credit: null|{title, author, author_url, license,
license_url, source, source_url}`, `embed: null|{url}`.

- [ ] Test (attachments.spec.js): an uploaded picture's `credit` and `embed` are null.
- [ ] Migration, schema, install step, output; run attachments + install specs: PASS. Commit.

### Task 2: `image_search`

**Files:** Create `api/images.php` (required from index.php: sources, `image_http`, licence check, tokens);
`tests/support/image-stub.php`; test `tests/browser/find-image.spec.js`.

**Produces:** `image_http(string $method, string $url, array $opts = []): array{status,body,error}`;
`image_license_open(string $license): bool`; `image_search(string $source, string $q): array` of
`{source, id, title, author, author_url, license, license_url, landing_url, thumb, open}`;
`image_lookup(string $source, string $id): array` (one work, same shape plus `full` URL); `deviantart_lookup(string $id)`.

- [ ] Tests: openverse/museums/deviantart return stub results with open flags (NC → false, CC BY-SA → true, DA "No
  License" → false); mature DA works dropped; a broken source → 502 with a message, others fine; unknown source → 400;
  player allowed; outsider 403; 31st search in a minute → 429.
- [ ] Implement; run: PASS. Commit.

### Task 3: `image_import` (copy)

**Files:** `api/index.php` (extract `attachment_store(int $cid, string $type, int $pid, array $parent, string $tmp,
string $name, ?string $caption, int $secret, ?array $credit, ?array $embed): array` from `file_upload`), `api/images.php`
(`image_download(string $url, int $max): string` temp path, https only, public IPs only unless stub, ≤3 redirects).

- [ ] Tests: importing an open Openverse work adds a picture with its credit; a non-open one → 403 `not_open`;
  oversized full image falls back to the thumbnail; a player can't import onto a secret entry (404) and their
  `is_secret` is ignored; before migration → 409 `needs_upgrade` (simulated by `has_credits` false is skipped: covered by install spec).
- [ ] Implement; run attachments + find-image: PASS. Commit.

### Task 4: Embeds

**Files:** `api/index.php` (`image_import` `mode=embed`, `file` redirect, `attachment_out` `embed_gone`), `api/images.php`
(`deviantart_oembed(string $pageUrl): ?array`).

- [ ] Tests: embedding a non-CC DA work stores a 0-byte `embed` row; `file` 302s to the wixmp URL; after
  `embed_checked_at` is aged 7 hours, `file` asks oEmbed again (stub serves a new URL); oEmbed 404 → `file` 404 and
  `embed_gone`; an oEmbed URL on another host → refused; mode=embed for a non-DA source → 400.
- [ ] Implement; run: PASS. Commit.

### Task 5: The Find Image panel

**Files:** `static/app.js` (`findImage(parentType, parentId, name, opts)` panel in `attachmentsCard` for
`encyclopedia`; credit line under pictures and in the viewer; embed figures), `static/style.css`, `index.html` +
`.htaccess` (img-src hosts).

- [ ] Tests: the button opens with the name filled in; tabs list results with author/licence/source links; NC result
  has no *Use this picture*; non-CC DA shows View on DeviantArt + Artist's page with the right hrefs and
  `target=_blank`, plus Embed; Use this picture adds the picture and its credit line; Embed adds an *Embedded* picture;
  empty box and no results messages; no console errors. Run on chromium and mobile-chrome.
- [ ] Implement; run: PASS. Commit.

### Task 6: About page, sources and docs

**Files:** `static/app.js` (About: Software and fonts → new "Pictures found with Find Image" list; DeviantArt also
under No open source), `tests/browser/about.spec.js`, `README.md`, `tests/README.md`, `SOURCES-TO-LICENSE.md`
(gitignored, also copied to `/mnt/project-files/`).

- [ ] Test: About lists Openverse, The Met, Art Institute of Chicago and DeviantArt with links.
- [ ] Implement; full chromium run of touched specs: PASS. Commit.
