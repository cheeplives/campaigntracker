# Deploying Campaign Chronicle (SSH + git)

Runbook for an install next to Sinless on the same domain, for example
`https://www.discreteinfinity.com/chronicle/` beside `/sinless/`. It follows
Sinless's [DEPLOY.md](https://github.com/cheeplives/sinless-app-beta/blob/main/docs/DEPLOY.md):
the server pulls from GitHub, and secrets live above the web root.

## Prerequisites

- HTTPS on the domain.
- PHP 8 with `pdo_mysql` and `curl`: `php -m | grep -Ei 'pdo_mysql|curl'`.
- A MySQL database. Either a new one, or **Sinless's database** if you want one
  account list and one approval queue for both apps. The `users` and
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

Open `https://www.discreteinfinity.com/chronicle/install.php` and press
*Install or upgrade* (or run `mysql -u USER -p DB < db/schema.sql`). Then set
`'allow_install' => false` in the config.

### Web server

Apache: the bundled `.htaccess` forces HTTPS, sets HSTS/CSP/framing headers and
blocks the config, `db/`, `docs/`, `tests/`, `.claude/`, `.git` and `.md/.sql/.sh` files. It
needs `mod_rewrite`, `mod_headers` and `mod_alias`. On nginx, copy the rules from
Sinless's DEPLOY.md and add `location ~ /(db|tests|docs|\.claude)/ { return 404; }`.

## Verify

```sh
find api install.php -name '*.php' -exec php -l {} \;
curl -s https://www.discreteinfinity.com/chronicle/api/auth/me.php
#   → {"error":"not_authenticated","providers":["google","github"]}
curl -sI https://www.discreteinfinity.com/chronicle/tests/support/login.php   # → 404
curl -sI https://www.discreteinfinity.com/chronicle/api/config.php            # → 403/404
```

Then sign in with your `admin_identities` account, have a second account sign
in (it should wait for approval), approve it under **Users**, and add it to a
campaign by email from the **Members** tab.

## Upgrading an install from before Google/GitHub sign-in

Back up the database first. Then pull, fill in the new config (it moved from
`lib/config.php` to `~/chronicle-config.php` and gained the OAuth fields), and
open `install.php`: it finds the old users table and runs
`db/migrations/001_oauth_signin.sql`. Or run that file with `mysql` yourself.

Every existing account is kept, approved, with its campaigns, roles and notes.
Passwords are dropped. Sign in with your `admin_identities` email (that creates
a new admin account), open **Users**, and press *Link email* on each old account
to enter the email that player signs in with. Their first sign-in with it takes
over the old account. Your own old account can be linked the same way, or deleted.

## Updates

```sh
cd ~/public_html/chronicle
./deploy.sh        # git pull --ff-only + php -l
```

If an update adds a file under `db/migrations/`, run it once after the pull.
