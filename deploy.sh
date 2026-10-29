#!/bin/sh
# deploy.sh — pull the latest, syntax-check the PHP and bring the database up to
# date. Run on the server from inside the deployed directory:  ./deploy.sh
#
# config.php is gitignored, so it is never touched by the pull.
set -e
cd "$(dirname "$0")"

echo "==> git pull"
git pull --ff-only

echo "==> php -l (syntax check every endpoint)"
find api install.php tools -name '*.php' -print -exec php -l {} \;

echo "==> database upgrade (backs up first, and does nothing when there's nothing new)"
migrated=0
php tools/migrate.php || migrated=$?

echo "==> security check (settings that must not be left on, stray copies of the config)"
php tools/security-check.php || echo "    Fix the lines above; the site is updated either way."

if [ "$migrated" -ne 0 ]; then
  echo "==> NOT done: the database upgrade above failed, so parts of the app may not work until it is fixed."
  echo "    Fix what it says, then run: php tools/migrate.php"
  exit 1
fi
echo "==> done"
