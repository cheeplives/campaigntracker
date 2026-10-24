# Find Image for Encyclopedia entries

A button on an Encyclopedia entry that searches openly licensed image libraries (and DeviantArt) for a picture to go
with the entry, shows the candidates with their credits, and saves the one picked as an ordinary entry picture with its
credit kept. Agreed with Josh on 2026-10-24.

## What the user sees

- **Where:** in an entry's *Pictures and files* box, a *🖼️ Find Image* button beside *📎 Add*, on the entry's page and
  in its edit form, for anyone who may add pictures to that entry (the same people `file_upload` lets in). Hidden when
  uploads aren't ready (`upload_info().ready`). (It sits with the pictures rather than beside *📚 Generate Summary*, so
  it shows on the entry's page too and the box redraws with the new picture.)
- **Search box:** opens below the buttons with the entry's name filled in; it can be changed (e.g. "ruined keep") and
  searched again. Three tabs, each searched only when opened:
  - **Open web:** Openverse (Flickr, Wikimedia Commons, museums and others).
  - **Museums:** The Met, the Art Institute of Chicago and, when the config has an api.data.gov key, the Smithsonian
    (added 24 October at Josh's request), searched together, public-domain (CC0) works only.
  - **DeviantArt:** searched by tag (the words joined, lowercased: "ruined keep" → `ruinedkeep`; the tab says so).
- **Results:** a grid of up to 20 thumbnails. Under each: the title, the artist (linked to their page), the licence
  (linked to its deed) and the source (linked to the work's own page). Links open in a new tab (`rel="noopener"`).
- **Use this picture:** on every result whose licence is open (below). It saves the picture to the entry, shows it in
  the entry's pictures, and disables the button. A GM gets the usual *GM only* checkbox beside it.
- **DeviantArt works that aren't openly licensed:** no *Use this picture*. They show *View on DeviantArt* (the
  deviation's page), *Artist's page* (`https://www.deviantart.com/<username>`) and *Embed from DeviantArt*, with a
  short line: "Not openly licensed: embed it from DeviantArt, or ask the artist before copying it." Mature works are
  never shown.
- **Embed from DeviantArt:** adds the work to the entry's pictures without copying it. The app keeps only the link;
  the picture loads from DeviantArt each time it is shown (through DeviantArt's oEmbed), credited "Title by Artist on
  DeviantArt" with both linked. It is marked *Embedded* in the gallery, can't be downloaded, and doesn't show offline.
  If the artist deletes the work, the picture shows "No longer on DeviantArt" instead.
- **Credit on saved pictures:** "Title by Author, Licence, via Source". In the gallery only the picture shows, with a *?* on
  its corner that shows its name, caption, GM only, embed note and credit on hover or tap (changed 24 October at Josh's request, as the lines were too loud); the picture
  viewer shows it in full, each part a link when known. A picture uploaded by hand has no credit.
- **Errors:** a source that can't be reached or isn't set up says so in its tab ("DeviantArt isn't set up on this
  server" for admins, with what to add to the config; "not available" for everyone else). The other tabs still work.

## Which licences count as open

Allowed for *Use this picture*: CC0, Public Domain Mark / public domain, CC BY, CC BY-SA (any version). Never: anything
NC (non-commercial) or ND (no derivatives), "all rights reserved", or unknown. Openverse is asked with
`license_type=commercial,modification`, and the server checks each result's `license` again. Museums: only works the
museum marks public domain (`isPublicDomain` at the Met, `is_public_domain` at the Art Institute), credited as Public
Domain. DeviantArt: the `license` string from `deviation/metadata` is matched against the allowed CC names; anything
else is "ask the artist".

## Server

All searching goes through the app's own API, so keys stay on the server and the browser only talks to the app (plus
the image hosts for thumbnails).

- **`image_search`** (GET: `cid`, `source` = `openverse` | `museums` | `deviantart`, `q`): signed-in members of the
  campaign who may add pictures. Throttled with `rate_limit('image_search', user id, 30, 60)`. Calls the source with
  `http_request()` (timeouts 5 s connect, 10 s total), turns each result into one shape:
  `{source, id, title, author, author_url, license, license_url, landing_url, thumb, open}`, and drops anything without
  a thumbnail. `open` is the server's licence check.
  - Openverse: `GET https://api.openverse.org/v1/images/?q=&license_type=commercial,modification&mature=false&page_size=20`,
    thumbnail `https://api.openverse.org/v1/images/<id>/thumb/`. Works without a key; with `client_id`/`client_secret`
    in the config it gets a token (`/v1/auth_tokens/token/`, client credentials) for the higher rate limit.
  - Museums: the Art Institute's `/api/v1/artworks/search` (public domain only, `AIC-User-Agent` header), image
    `https://www.artic.edu/iiif/2/<image_id>/full/400,/0/default.jpg`; the Met's `/public/collection/v1/search?hasImages=true&q=`
    then the first 10 object ids fetched together (`curl_multi`), keeping public-domain ones with `primaryImageSmall`.
    Results interleaved, 20 at most.
  - DeviantArt: client-credentials token (`https://www.deviantart.com/oauth2/token`), `GET /api/v1/oauth2/browse/tags?tag=&limit=20`
    (mature works dropped), then one `deviation/metadata` call for the licences.
  - Tokens are cached until they expire in a small file in the uploads folder (`.image-search-tokens.json`, mode 0600),
    which is outside the web root already.
- **`image_import`** (POST: `cid`, `parent_type`, `parent_id`, `source`, `id`, `is_secret`): never takes a URL or a
  licence from the browser. The server looks the work up again by source and id, refuses it unless `open`, downloads
  the full image (the largest the source offers up to the upload size limit; redirects not followed; only from that
  source's image hosts), and then runs exactly the `file_upload` checks (parent, count per parent, campaign quota,
  `upload_type`) and stores it with its credit. The shared steps of `file_upload` move into one function both use.
- **`image_import`** with `mode=embed` (DeviantArt only, any licence): the server looks the deviation up
  (`/api/v1/oauth2/deviation/<id>`), refuses mature works, asks oEmbed (`https://backend.deviantart.com/oembed?url=`)
  for the picture, and stores a row with `kind='embed'`, no file (`size_bytes` 0, so it doesn't count to the quota;
  it does count to the 50 per entry), `embed_url` (the deviation's page), `embed_src` and `embed_checked_at`.
- **`file`** for an embed answers with a redirect (302) to `embed_src`, first asking oEmbed again when
  `embed_checked_at` is more than 6 hours old (so DeviantArt's image links can expire safely). When oEmbed says the
  work is gone, it answers 404 (`embed_gone` in `attachment_out`), and the gallery shows the "No longer on DeviantArt"
  line. Only https URLs on `*.wixmp.com` or `*.deviantart.net` are ever redirected to.
- **`attachment_out`** adds `credit` (null, or the stored fields) and, for an embed, `embed_url`.
- **Testing seam:** every outbound call goes through `image_http(string $method, string $url, array $opts): array`.
  When the config sets `image_search.stub` (a PHP file returning a function), it answers instead, so the tests reach
  nothing outside (and the PHP test server never calls itself).

## Database change

Yes. New migration **`db/migrations/017_attachment_credits.sql`**, also folded into `db/schema.sql`; run install.php
(*Install or upgrade*) after deploying. It adds nullable columns to `attachments`:
`credit_title VARCHAR(200)`, `credit_author VARCHAR(200)`, `credit_author_url VARCHAR(500)`,
`credit_license VARCHAR(60)`, `credit_license_url VARCHAR(300)`, `credit_source VARCHAR(60)`,
`credit_source_url VARCHAR(500)`, `embed_url VARCHAR(500)`, `embed_src VARCHAR(1000)`, `embed_checked_at DATETIME`.
Until it has run, *Find Image* still searches but *Use this picture* answers
"Saving found pictures needs a database upgrade" (409 `needs_upgrade`), like the other features.

## Config

`api/config.example.php` gains an `image_search` block: `openverse` (`client_id`, `client_secret`, optional),
`deviantart` (`client_id`, `client_secret`; the tab is off without them), and `contact` (an email or URL sent in the
User-Agent, which the Art Institute and Openverse ask for). Only Josh's real config holds the secrets.

## Security policy

`img-src` in both `.htaccess` and `index.html` adds the thumbnail hosts: `https://api.openverse.org`,
`https://www.artic.edu`, `https://images.metmuseum.org`, `https://*.wixmp.com` and `https://*.deviantart.net` (DeviantArt's image hosts, which embeds redirect to).
`connect-src` doesn't change, since searches go to the app. Saved pictures are served by the app as now.

## About page and sources

- About lists Openverse (and that each picture keeps its own licence and credit), The Met Open Access, the Art
  Institute of Chicago's open access API, and DeviantArt.
- DeviantArt is not an open source, and its API licence speaks mostly of Sta.sh, so it goes in
  `SOURCES-TO-LICENSE.md` (copied to the project files) with its API terms link, what is used (search by tag, metadata
  for licences, thumbnails shown, CC works saved with credit) and where (Find Image), so Josh can ask DeviantArt to
  confirm this use.

## Testing

Playwright, in the existing style. The test config sets `image_search.stub` to `tests/support/image-stub.php`, which
answers each source's URLs with fixed results (thumbnails as `data:` pictures), so no test reaches the internet. Tests: the
button opens with the name filled in; each tab lists stub results with author, licence and source links; an NC result
has no *Use this picture*; a non-CC DeviantArt result shows only the two links, both pointing at the right pages;
*Use this picture* adds the picture with its credit line; *Embed from DeviantArt* adds an embedded picture whose
`file` redirects to DeviantArt's image, refreshed after 6 hours, and shows "No longer on DeviantArt" once it is gone; `image_import` refuses a non-open work and a player saving
to a secret entry; the throttle; a source that fails shows its message while the others work; the About page lists the
new sources. The real services can't be reached from the build machine, so the live shapes are checked against their
documentation and once by hand after deploying.

## Not in this

Wikimedia Commons as its own tab (Openverse covers it), keyed museums (Smithsonian, Rijksmuseum, Europeana),
Unsplash/Pexels/Pixabay, general web search engines, and AI-generated pictures.
