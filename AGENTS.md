# Notes for coding agents

## Screens to design and test for

- **Desktop and iPad come first.** Every layout has to work well on a desktop browser and on an iPad, in portrait
  (about 820 pixels wide) and landscape (about 1180). Check both before calling a change done.
- **A phone is a nice to have.** Keep a phone usable where it's cheap to do (nothing running off the screen), but
  don't let phone layout drive a design, hold up a change, or cost desktop or iPad anything.

## How the site looks

The look is "Lamplight": quiet surfaces, one accent, and type doing most of the work. Keep new screens in it.

- **Type:** headings use Spectral (`--disp`) and everything else uses Atkinson Hyperlegible (`--body`), both served
  from `static/fonts`. Write titles and labels in sentence case, never all capitals.
- **Colour:** use the theme tokens in `static/style.css` (`--bg`, `--panel`, `--panel-2`, `--line`, `--text`, `--dim`,
  `--accent`, `--label`) rather than raw colours, so all five schemes and both modes follow. Don't change `--ok`,
  `--bad` or `--secret` per theme.
- **One accent:** fill a button with the accent only for the page's main action. A picked toggle, tab or row gets an
  accent tint with an accent edge, and its text stays in the text colour. Headings and labels never use the accent
  colour.
- **Edges:** a coloured side or top edge must mean something (GM-only, NPC, GM or player clock). Don't add one for
  decoration. The tapered rule under a title is the one ornament.
- **Surfaces:** keep panels flat, with a 1px `--line` border and the shared `--radius`. Use no gradients and no glow,
  and keep shadows to floating things only (menus, dialogs, the action bar).
- **Icons:** use the drawn icons from `static/icons.js`. `KIT.el()` draws an emoji in a label as its icon, or
  `KIT.icon(name)` makes one directly; never let a raw emoji reach the page.
- **Contrast:** text must pass AA in every scheme and in both light and dark. `tests/browser/accessibility.spec.js`
  checks this with axe, so run it whenever you change a colour.

## Tests before and after opening a pull request

GitHub Actions (`.github/workflows/browser-tests.yml`) runs the whole suite on every pull request: PHP lint, the
database upgrade from the command line, the Playwright suite in all six projects (Chromium, Firefox, WebKit, iPhone,
Pixel, iPad), split across 16 runners, and the check for PHP deprecations, in about 12 minutes. That run is the full
check; the single **Browser tests** check is green only when every part passed. Don't run the whole suite locally
first: on a cloud machine it takes well over an hour and repeats what CI does.

- Before opening or updating a pull request, run the specs you touched (and any spec that covers what you changed) in
  Chromium and the iPad with `tools/test-all.sh`, for example
  `tools/test-all.sh browser/clocks.spec.js --project=chromium --project=ipad`. That also runs the PHP lint, the
  database upgrade and the deprecation check. Say in the pull request what it gave.
- Then wait for the pull request's own CI run and fix anything it finds before calling the change done. A failure
  report is uploaded per shard (`report-<project>-php<version>-<n>of<m>`) with screenshots and traces.
- The first run on a fresh cloud machine installs MySQL 8.0, PHP's extensions and the browsers through
  `tools/test-setup.sh` (a few minutes); later runs skip what is already there.
- Two runs at once must not share a database, a server port or a results folder, or each spoils the other: give the
  second one its own, e.g. `DB_NAME=chronicle_test2 PORT=8756 tools/test-all.sh … --output=/tmp/pw-results-2`.
- A test that fails here and on `main` alike is not yours to hide: say so in the pull request, don't skip it.
- If the browsers fail to download (a 403 from `cdn.playwright.dev`), the cloud environment's network settings no
  longer allow Playwright's download hosts; ask Josh to add `cdn.playwright.dev` and
  `playwright.download.prss.microsoft.com` to the environment's allowed domains.
