#!/bin/sh
# deploy.sh — pull the latest and syntax-check the PHP. Run on the server from
# inside the deployed directory:  ./deploy.sh
#
# config.php is gitignored, so it is never touched by the pull.
set -e
cd "$(dirname "$0")"

echo "==> git pull"
git pull --ff-only

echo "==> php -l (syntax check every endpoint)"
find api install.php -name '*.php' -print -exec php -l {} \;

echo "==> security check (settings that must not be left on, stray copies of the config)"
php tools/security-check.php || echo "    Fix the lines above; the site is updated either way."

echo "==> done"
echo "    If this update added a file under db/migrations/, run it once now."
