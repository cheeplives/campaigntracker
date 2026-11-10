#!/usr/bin/env bash
# Runs the checks GitHub Actions runs (.github/workflows/browser-tests.yml) on this machine, so a change can be
# tested before it is pushed: PHP lint, the database upgrade from the command line, then the Playwright suite in
# every project (Chromium, Firefox, WebKit desktop, iPhone, Pixel and iPad), then the PHP error log check.
#
#   tools/test-all.sh                          # everything, every project
#   tools/test-all.sh --project=chromium       # extra arguments go to `npx playwright test`
#   tools/test-all.sh browser/clocks.spec.js --project=ipad
#   tools/test-all.sh --workers=4              # all of a 4-core machine: about a quarter faster, every test slower
#
# The whole suite here is about 560 tests in each of six projects, and it is CPU-bound: two browsers at once on a
# 4-core cloud machine take about 9 minutes per project, so close to an hour for all six. GitHub Actions runs the
# same suite split across 16 runners instead.
#
# Runs tools/test-setup.sh first, which installs what is missing (MySQL, PHP extensions, browsers) and is quick
# when everything is already there; set SKIP_SETUP=1 to skip it. Uses its own database, chronicle_test, which
# every run drops and rebuilds. Never point DB_* at a database you want to keep.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-3306}"
export DB_USER="${DB_USER:-chronicle}" DB_PASSWORD="${DB_PASSWORD:-chronicle}" DB_NAME="${DB_NAME:-chronicle_test}"
export PHP_ERROR_LOG="${PHP_ERROR_LOG:-/tmp/chronicle-php-errors.log}"
say() { printf '\n== %s\n' "$*"; }

[ "${SKIP_SETUP:-}" = 1 ] || "$ROOT/tools/test-setup.sh"
cd "$ROOT/tests"

say "PHP lint"
find ../api ../install.php ../tools ../tests/support -name '*.php' -print0 | xargs -0 -n1 php -l > /dev/null

say "Database upgrade from the command line"
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" \
  -e "DROP DATABASE IF EXISTS $DB_NAME; CREATE DATABASE $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
CHRONICLE_CONFIG=support/config.test.php php ../tools/migrate.php --no-backup
CHRONICLE_CONFIG=support/config.test.php php ../tools/migrate.php --check

say "Playwright"
: > "$PHP_ERROR_LOG"
status=0
npx playwright test "$@" || status=$?

say "PHP deprecations and fatal errors"
if grep -E 'PHP (Deprecated|Fatal error)' "$PHP_ERROR_LOG"; then echo "PHP logged the lines above"; status=1; else echo "none"; fi

[ "$status" = 0 ] && say "All passed" || say "FAILED (see above; tests/test-results/ has traces and screenshots)"
exit "$status"
