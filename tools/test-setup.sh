#!/usr/bin/env bash
# Gets a fresh Ubuntu 24.04 machine (such as a Claude Code cloud container) ready to run the same tests GitHub
# Actions runs (.github/workflows/browser-tests.yml): PHP 8.3 with its extensions, MySQL 8.0 with a test user,
# the Node packages in tests/, and Playwright's Chromium, Firefox and WebKit. Safe to run again: anything already
# in place is left alone, so a second run takes a few seconds. Needs root (the cloud containers run as root).
#
# Network: Ubuntu's apt mirrors and npm, plus Playwright's browser downloads (cdn.playwright.dev and
# playwright.download.prss.microsoft.com), which a cloud environment with limited network access must allow.
#
# tools/test-all.sh runs this first, so there is normally no need to call it by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_USER="${DB_USER:-chronicle}"
DB_PASSWORD="${DB_PASSWORD:-chronicle}"
say() { printf '\n== %s\n' "$*"; }

if [ "$(id -u)" != 0 ]; then echo "test-setup.sh needs root (it installs packages and starts MySQL)" >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

# PHP and MySQL, as CI installs them (CI's MySQL is the mysql:8.0 image; here it is Ubuntu's 8.0 server).
pkgs=(php8.3-cli php8.3-mysql php8.3-curl php8.3-mbstring php8.3-xml mysql-server-8.0 mysql-client-core-8.0)
missing=()
for p in "${pkgs[@]}"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p"); done
if [ ${#missing[@]} -gt 0 ]; then
  say "Installing ${missing[*]}"
  echo 'Acquire::Retries "5"; Acquire::http::Timeout "30";' > /etc/apt/apt.conf.d/80-retries
  apt-get update -q
  apt-get install -y -q --no-install-recommends "${missing[@]}"
fi

# MySQL. Its temporary files go in a folder of its own: the cloud containers' /tmp is root's alone (mode 700), and
# with MySQL's default tmpdir there every query that sorts on disk fails ("Can't create/write to file '/tmp/MY…'"),
# which shows up as a "Database error" from the app partway through a run.
cnf=/etc/mysql/mysql.conf.d/zz-chronicle-tests.cnf
if [ ! -f "$cnf" ]; then
  mkdir -p /var/lib/mysql-tmp && chown mysql:mysql /var/lib/mysql-tmp && chmod 700 /var/lib/mysql-tmp
  printf '[mysqld]\ntmpdir = /var/lib/mysql-tmp\n' > "$cnf"
  if mysqladmin ping --silent 2>/dev/null; then say "Restarting MySQL for its new tmpdir"; mysqladmin -u root shutdown; sleep 2; fi
fi
# Containers have no systemd, so start the server directly and wait for it.
if ! mysqladmin ping --silent 2>/dev/null; then
  say "Starting MySQL"
  mkdir -p /var/run/mysqld && chown mysql:mysql /var/run/mysqld
  (setsid mysqld_safe > /dev/null 2>&1 &)
  for _ in $(seq 60); do mysqladmin ping --silent 2>/dev/null && break; sleep 1; done
  mysqladmin ping --silent || { echo "MySQL did not start; see /var/log/mysql/error.log" >&2; exit 1; }
fi
# A password user for the tests: root signs in through the socket only, and the tests connect over TCP.
# Only the test databases matter, and the server listens on 127.0.0.1 alone.
mysql -u root <<SQL
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON *.* TO '$DB_USER'@'localhost';
GRANT ALL PRIVILEGES ON *.* TO '$DB_USER'@'127.0.0.1';
SQL

# Node packages for the tests, reinstalled when the lockfile changes.
cd "$ROOT/tests"
stamp=node_modules/.lock-sha
want=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  say "npm ci in tests/"
  npm ci --no-audit --no-fund
  echo "$want" > "$stamp"
fi

# Playwright's browsers at the version tests/package-lock.json pins (the copy some machines come with is often
# another version, which this Playwright can't use), and once, the system libraries they need.
say "Playwright browsers"
npx playwright install chromium firefox webkit
deps_stamp=/var/lib/chronicle-playwright-deps
if [ "$(cat "$deps_stamp" 2>/dev/null)" != "$want" ]; then
  npx playwright install-deps chromium firefox webkit
  echo "$want" > "$deps_stamp"
fi

say "Ready: php $(php -r 'echo PHP_VERSION;'), $(mysqld --version | awk '{print $2, $3}'), Playwright $(npx playwright --version)"
