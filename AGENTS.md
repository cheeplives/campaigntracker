# Notes for coding agents

## Screens to design and test for

- **Desktop and iPad come first.** Every layout has to work well on a desktop browser and on an iPad, in portrait
  (about 820 pixels wide) and landscape (about 1180). Check both before calling a change done.
- **A phone is a nice to have.** Keep a phone usable where it's cheap to do (nothing running off the screen), but
  don't let phone layout drive a design, hold up a change, or cost desktop or iPad anything.

## Run the full test suite before opening a pull request

Run `tools/test-all.sh` before you open or update a pull request, and say in the pull request what it gave. It runs
what GitHub Actions runs (`.github/workflows/browser-tests.yml`): PHP lint, the database upgrade from the command
line, the Playwright suite in all six projects (Chromium, Firefox, WebKit, iPhone, Pixel, iPad), and the check for PHP
deprecations. The first run on a fresh cloud machine installs MySQL 8.0, PHP's extensions and the browsers through
`tools/test-setup.sh` (a few minutes); later runs skip what is already there.

- The whole suite takes about an hour on a cloud machine. While working, run the specs you touched, in the projects that matter,
  for example `tools/test-all.sh browser/clocks.spec.js --project=chromium --project=ipad`, and the whole suite once
  before the pull request.
- Two runs at once must not share a database, a server port or a results folder, or each spoils the other: give the
  second one its own, e.g. `DB_NAME=chronicle_test2 PORT=8756 tools/test-all.sh … --output=/tmp/pw-results-2`.
- A test that fails here and on `main` alike is not yours to hide: say so in the pull request, don't skip it.
- If the browsers fail to download (a 403 from `cdn.playwright.dev`), the cloud environment's network settings no
  longer allow Playwright's download hosts; ask Josh to add `cdn.playwright.dev` and
  `playwright.download.prss.microsoft.com` to the environment's allowed domains.
