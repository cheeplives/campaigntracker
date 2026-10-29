# Deploying Campaign Chronicle (SSH + git)

Runbook for an install next to Sinless on the same domain, for example
`https://www.discreteinfinity.com/chronicle/` beside `/sinless/`. It follows
Sinless's [DEPLOY.md](https://github.com/cheeplives/sinless-app-beta/blob/main/docs/DEPLOY.md):
the server pulls from GitHub, and secrets live above the web root.

## Prerequisites

- HTTPS on the domain.
- PHP 8 with `pdo_mysql` and `curl`: `php -m | grep -Ei 'pdo_mysql|curl'`.
- A MySQL database. Either a new one, or **Sinless's database** if you want one
  account list (one sign-in) for both apps. Each app still approves its own users:
  Chronicle's approvals are in `chronicle_access`, apart from Sinless's. The `users` and
  `rate_limits` tables are identical in the two apps, and no other table names
  overlap. Only share it on a **fresh** Chronicle install; an existing install
  keeps its own database (see Upgrading below).

## One-time setup

```sh
cd ~/public_html            # your web root
git clone https://github.com/cheeplives/campaigntracker.git chronicle
cd chronicle
cp api/config.example.php ~/chronicle-config.php
chmod 600 ~/chronicle-config.php
nano ~/chronicle-config.php
```

`api/lib.php` looks for the config in this order: the `$CHRONICLE_CONFIG` env
var, `<one level above the web root>/chronicle-config.php`,
`$HOME/chronicle-config.php`, then `api/config.php`.

Set at minimum:
- `db`: host, name, user, password.
- `base_url`: `https://www.discreteinfinity.com/chronicle` (no trailing slash).
- `oauth.google` / `oauth.github`: client id and secret. Leave one blank to hide its button.
- `admin_identities`: your sign-in email (or `github:<id>`), so your first sign-in is approved as admin.
- Optional: `approval_webhook_url` (Discord/Slack ping on new sign-ups) and
  `approval_email` (email people when approved or revoked), as in Sinless.

### OAuth callback

The callback is `https://www.discreteinfinity.com/chronicle/api/auth/callback.php`.

- **Google:** open Sinless's OAuth client in Google Cloud Console and add this
  URL as a second *Authorized redirect URI*. One client serves both apps.
- **GitHub:** OAuth apps allow one callback each, so register a second OAuth app
  for Chronicle with this callback and use its id and secret.

### Create the tables

From the app folder on the server:

```sh
php tools/migrate.php
```

It reads the same config as the app and creates the tables. Or set
`'allow_install' => true` in the config (it ships off), open
`https://www.discreteinfinity.com/chronicle/install.php` and press
*Install or upgrade*, then set `'allow_install' => false` again. Once a site admin has signed in, install.php
also asks you to be signed in as a site admin, so for a later upgrade sign in to
the app first.

### Web server

Apache: the bundled `.htaccess` forces HTTPS, sets HSTS/CSP/framing headers and
blocks the config, `db/`, `docs/`, `tests/`, `.claude/`, `.git` and `.md/.sql/.sh` files. It
needs `mod_rewrite`, `mod_headers` and `mod_alias`. On nginx, copy the rules from
Sinless's DEPLOY.md and add `location ~ /(db|tests|docs|\.claude)/ { return 404; }`.

### Installable app

Chrome and Edge offer *Install app* only over HTTPS, which the `.htaccess` above
already forces. `sw.js` must stay at the app's root (next to `index.html`) so it
covers the whole app; nothing else needs setting up. It caches only
`offline.html`, so deploys show up straight away as before.

### Pictures and files (Encyclopedia uploads)

Uploaded pictures and files are kept **outside the web root** and only sent
through `api/index.php?a=file`, to members allowed to see the entry. By default
they go in `<parent of the web root>/.chronicle-uploads` (for
`~/public_html/chronicle` that is `~/.chronicle-uploads`), which the app creates
itself when it can. To be sure, create it once:

```sh
mkdir -p ~/.chronicle-uploads && chmod 700 ~/.chronicle-uploads
```

To use another folder, set `'uploads' => ['path' => '/home/you/somewhere']` in
the config. The app refuses a folder inside the web root. install.php says so
if the folder can't be used.

Each file can be up to `uploads.max_mb` (10 MB by default), and each campaign's
files up to `uploads.campaign_mb` (500 MB). PHP's own limits must be at least
as big, or they win (the default `upload_max_filesize` is often 2M). On
DreamHost and similar hosts put a `.user.ini` in the app folder (or set them
in the panel's PHP settings):

```ini
upload_max_filesize = 10M
post_max_size = 12M
```

Allowed: JPEG, PNG, GIF and WebP pictures (shown on the page), PDF and plain
text (.txt, .md, .csv, always downloaded). SVG and HTML are refused because
they can carry scripts. Back up the uploads folder along with the database.

## Verify

```sh
find api install.php tools -name '*.php' -exec php -l {} \;
curl -s https://www.discreteinfinity.com/chronicle/api/auth/me.php
#   → {"error":"not_authenticated","providers":["google","github"]}
curl -sI https://www.discreteinfinity.com/chronicle/tests/support/login.php   # → 404
curl -sI https://www.discreteinfinity.com/chronicle/api/config.php            # → 403/404
curl -sI https://www.discreteinfinity.com/chronicle/api/lib.php               # → 403 (only index.php and api/auth/ run)
curl -sI https://www.discreteinfinity.com/chronicle/manifest.webmanifest      # → 200, application/manifest+json
```

Then sign in with your `admin_identities` account, have a second account sign
in (it should wait for approval), approve it under **Users**, and add it to a
campaign by typing its sign-in email on the **Members** tab (the list there offers a
GM only people they already play with; a site admin sees everyone).

Then run the security check, which deploy.sh also runs after every pull:

```sh
php tools/security-check.php
```

It reads the same config as the app and names anything that must not be left
that way on a live site: `debug` or `allow_install` on, test-only settings, a
config file other accounts can read or that sits inside the site's folder, and
stray copies of the config (`config.php.bak`, `config.php.save`…). It changes nothing.

## Upgrading an install from before Google/GitHub sign-in

Back up the database first. Then pull, fill in the new config (it moved from
`lib/config.php` to `~/chronicle-config.php` and gained the OAuth fields), and
run `php tools/migrate.php` (or open `install.php`): it finds the old users table and runs
`db/migrations/001_oauth_signin.sql`. Or run that file with `mysql` yourself.

Every existing account is kept, approved, with its campaigns, roles and notes.
Passwords are dropped. Sign in with your `admin_identities` email (that creates
a new admin account), open **Users**, and press *Link email* on each old account
to enter the email that player signs in with. Their first sign-in with it takes
over the old account. Your own old account can be linked the same way, or deleted.

## Updates

```sh
cd ~/public_html/chronicle
./deploy.sh        # git pull --ff-only, php -l, tools/migrate.php, then tools/security-check.php
```

Database upgrades need nothing from you: after the pull, deploy.sh runs
`php tools/migrate.php`, which looks for anything new under `db/migrations/`
(each step checks for its table or column, so it never runs twice) and does
nothing when there isn't. When there is, it first saves a copy of the database
with `mysqldump` to `~/chronicle-backups/` (only your account can read it; the
last 5 are kept; set `'backups' => ['path' => '/home/you/elsewhere']` in the
config to move it), then runs the migrations and lists what changed. If the
backup or a migration fails, deploy.sh ends with *NOT done* and says why; fix
that and run `php tools/migrate.php` again.

- `php tools/migrate.php --check` says what would run, and changes nothing.
- `php tools/migrate.php --no-backup` skips the copy, if `mysqldump` isn't
  available or you've just made a backup yourself.

`allow_install` can stay `false` for good: install.php is only needed if you
can't run commands on the server.
