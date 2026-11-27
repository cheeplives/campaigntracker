# Deploying GM's Almanac at gms-almanac.com (DreamHost shared hosting)

A step-by-step runbook for running GM's Almanac at `https://gms-almanac.com` on DreamHost shared hosting, as a site of
its own: its own address, its own Google and GitHub sign-in apps, and a database that holds only GM's Almanac. Nothing
in it is shared with Sinless or any other app.

It covers moving the existing install (`https://www.discreteinfinity.com/chronicle/`) across with all its campaigns,
accounts and uploads, and a new, empty install. Other shared hosts with PHP 8, MySQL, SSH and Apache work the same
way; only the panel's menus differ.

**The short version.** If gms-almanac.com is added under the **same DreamHost website user** as the old site, both
sites' folders sit in that user's home folder. The config (`~/chronicle-config.php`), the uploads
(`~/.chronicle-uploads`) and the sign-in sessions are already where the new site looks for them, so nothing has to be
copied. You clone the code into the new folder, change a few lines of the config, and turn the old folder into a
redirect. The database is kept as it is too, unless it is shared with Sinless (step 4 tells you which).

**Contents**

1. [Before you start](#1-before-you-start)
2. [Add the website, its DNS and its certificate](#2-add-the-website-its-dns-and-its-certificate)
3. [Put the code in the new folder](#3-put-the-code-in-the-new-folder)
4. [The database: keep it, or copy GM's Almanac out of a shared one](#4-the-database-keep-it-or-copy-gms-almanac-out-of-a-shared-one)
5. [Register the sign-in apps (Google and GitHub)](#5-register-the-sign-in-apps-google-and-github)
6. [Switch over](#6-switch-over)
7. [Check it works](#7-check-it-works)
8. [Tell your players](#8-tell-your-players)
9. [Tidy up, a few weeks later](#9-tidy-up-a-few-weeks-later)
10. [Updates](#10-updates)
11. [Backups](#11-backups)
12. [Email (optional)](#12-email-optional)
- [A new, empty site](#a-new-empty-site)
- [If the new site is under a different DreamHost user](#if-the-new-site-is-under-a-different-dreamhost-user)
- [Behind a CDN or proxy](#behind-a-cdn-or-proxy)
- [Troubleshooting](#troubleshooting)

Throughout, `you` stands for the DreamHost website user the old site runs under (the one you SSH in as), and the old
install is `~/discreteinfinity.com/chronicle` (DreamHost's usual folder is named after the domain; use whatever yours
is called, such as `~/www.discreteinfinity.com/chronicle` or `~/public_html/chronicle`).

---

## 1. Before you start

- **Merge this version** and update the old site to it, so the export tool is there and the database is current:

  ```sh
  ssh you@discreteinfinity.com
  cd ~/discreteinfinity.com/chronicle
  ./deploy.sh
  ```

- **The domain** `gms-almanac.com`, registered at DreamHost or elsewhere, with access to its DNS settings.
- **SSH access.** In the panel, *Websites → SFTP Users & Files*: the website user must be a *Shell* user (not SFTP
  only) for `git`, `php` and `mysql` on the command line.
- **Accounts** at Google Cloud and GitHub, to register the new sign-in apps (step 5).
- **A note of the old config's database settings:** `grep -A6 "'db'" ~/chronicle-config.php` (host, name, user).

Nothing in steps 1 to 5 affects the old site: players can keep using it until the switch in step 6, which takes a
few minutes.

## 2. Add the website, its DNS and its certificate

1. In the panel, **Websites → Manage Websites → Add Website**. Domain `gms-almanac.com`, hosting type *Fully hosted*
   (on your shared plan). Under *Run this site as user*, pick **the same user as the old site**. Leave the web
   directory as DreamHost suggests: `/home/you/gms-almanac.com`.
2. On the new site's *Manage* page: set **PHP** to the newest 8.x DreamHost offers (8.1 or newer). If there's a
   *www* setting, choose **Remove www** (`gms-almanac.com`), so there is one address: sign-in cookies and the
   installed app are tied to it.
3. **DNS.**
   - Registered at DreamHost: nothing to do; its DNS is set up when you add the website.
   - Registered elsewhere: at your registrar, change the domain's nameservers to `ns1.dreamhost.com`,
     `ns2.dreamhost.com` and `ns3.dreamhost.com`. (Or keep your registrar's DNS and add the `A` and `AAAA` records the
     panel shows under *Websites → DNS* for gms-almanac.com, plus a `CNAME` from `www` to `gms-almanac.com`.)

   It can take a few hours to reach everyone. Check from your computer: `dig +short gms-almanac.com` gives the same
   address the panel shows.
4. **HTTPS.** *Websites → Secure Certificates*: add the free **Let's Encrypt** certificate for gms-almanac.com (it is
   often added by itself with the website). It needs the DNS from step 3 working first, and renews itself.

The app's `.htaccess` forces HTTPS itself, so there's no need to turn on the panel's "force HTTPS" option as well
(leaving it on does no harm).

## 3. Put the code in the new folder

DreamHost puts a placeholder page in the new folder. Replace it with a checkout of the app:

```sh
ssh you@discreteinfinity.com          # the same user; the new domain works too once its DNS is through
cd ~
ls gms-almanac.com                     # only DreamHost's placeholder (index.html, maybe favicon.ico)
rm -rf gms-almanac.com
git clone https://github.com/cheeplives/campaigntracker.git gms-almanac.com
```

For larger uploads, put a `.user.ini` in the new folder (DreamHost reads it; the default limit is often 2 MB, and
the app allows 10 MB a file):

```sh
cat > ~/gms-almanac.com/.user.ini <<'EOF'
upload_max_filesize = 10M
post_max_size = 12M
EOF
```

If the old folder has a `.user.ini` or `phprc` of its own, copy what's in it instead. Nothing else is needed yet: the
new folder finds `~/chronicle-config.php` (one level above it) by itself, and with it the old database, uploads and
sessions. Until step 6, the config still says the old address, so leave the new site alone until then.

## 4. The database: keep it, or copy GM's Almanac out of a shared one

Find out which case you're in, on the old site:

```sh
cd ~/discreteinfinity.com/chronicle
php tools/export-site.php --check
```

**It says "…GM's Almanac tables, nothing else."** The database is GM's Almanac's alone. **Keep it**: the new site
uses it as it is, so there's no data to move, and nothing made on the old site before the switch is lost. Skip to
step 5.

**It lists tables "that belong to something else".** The database is shared with Sinless (or something else). Give
GM's Almanac a database of its own:

1. In the panel, **Advanced → MySQL Databases → Add new database**. Database name `gms_almanac`, a hostname such as
   `mysql.gms-almanac.com` (pick it from the list or make a new one), a new user `gms_almanac` and a long password
   (`openssl rand -base64 24`). It takes a few minutes before the hostname answers.
2. Leave the copy itself for the switch in step 6, so nothing made on the old site in the meantime is left behind.
   It's two commands there.

The tool copies only GM's Almanac's own tables (the ones `db/schema.sql` creates), so Sinless's tables stay behind.
The accounts table is shared too: by default only GM's Almanac's accounts go (anyone with access here, older accounts
from before Google/GitHub sign-in, and anyone something of ours points to). Add `--all-users` to copy every account.
Nothing in the shared database is changed.

## 5. Register the sign-in apps (Google and GitHub)

GM's Almanac gets sign-in apps of its own, named GM's Almanac, so the consent screen people see says so. The
callback for both is:

```
https://gms-almanac.com/api/auth/callback.php
```

**Google** ([Google Cloud Console](https://console.cloud.google.com/)):

1. Create a project named *GM's Almanac* (the project picker at the top, then *New project*).
2. *APIs & Services → OAuth consent screen* (in newer consoles, *Google Auth Platform → Branding*): app name
   *GM's Almanac*, your support email, home page `https://gms-almanac.com`, privacy policy
   `https://gms-almanac.com/#/about`, authorized domain `gms-almanac.com`. User type *External*.
   Scopes: `openid`, `email` and `profile` only (nothing that needs Google's review).
3. *Audience*: press *Publish app* so anyone with a Google account can sign in. (In *Testing*, only the test users
   you list can, and their sign-in expires every 7 days.)
4. *Credentials → Create credentials → OAuth client ID*: type *Web application*, name *GM's Almanac*, authorized
   redirect URI `https://gms-almanac.com/api/auth/callback.php`. Copy the client ID and secret.

**GitHub** ([Settings → Developer settings → OAuth Apps → New OAuth App](https://github.com/settings/applications/new)):

- Application name *GM's Almanac*, homepage `https://gms-almanac.com`, authorization callback URL
  `https://gms-almanac.com/api/auth/callback.php`. Then *Generate a new client secret*, and copy the client ID and
  secret.

Accounts are matched by the provider's own id for the person (Google's account id, GitHub's user id), never by the
app that asked, so everyone keeps their account and campaigns when they sign in through the new apps. Keep the old
apps until the switch is done; delete them in step 9 (unless Sinless uses them).

## 6. Switch over

Pick a quiet time. Everything here takes a few minutes, and the old address sends people to the new one as soon as
it's done.

**a. Back up the config first:**

```sh
cp ~/chronicle-config.php ~/chronicle-config.php.before-move && chmod 600 ~/chronicle-config.php.before-move
```

**b. Only if the database is shared (step 4): copy GM's Almanac into its new database.**

```sh
cd ~/discreteinfinity.com/chronicle
php tools/export-site.php
# → Export: wrote /home/you/gms-almanac-export-20261127-180000.sql (4.2 MB). Only your account can read it.
mysql -h mysql.gms-almanac.com -u gms_almanac -p gms_almanac < ~/gms-almanac-export-*.sql
```

Load it only into the new, empty database.

**c. Edit the config** (`nano ~/chronicle-config.php`):

```php
'base_url' => 'https://gms-almanac.com',          // no trailing slash
'oauth' => [
  'google' => ['client_id' => 'the new Google client id', 'client_secret' => '…'],
  'github' => ['client_id' => 'the new GitHub client id', 'client_secret' => '…'],
],
```

and, only if you made a new database in step 4:

```php
'db' => [
  'host' => 'mysql.gms-almanac.com', 'port' => 3306,
  'name' => 'gms_almanac', 'user' => 'gms_almanac', 'password' => 'the new password',
  'charset' => 'utf8mb4',
],
```

While you're there, check these say GM's Almanac's own things: `approval_email.from` (an address on
gms-almanac.com; see step 12), `image_search.contact` (`https://gms-almanac.com`) and `approval_webhook_url`. Keep
`debug` and `allow_install` at `false`, and everything else as it was.

**d. Turn the old folder into a redirect.** Old bookmarks, invitation links and panel links then open the same page
on the new site:

```sh
cd ~/discreteinfinity.com
mv chronicle chronicle-old
mkdir chronicle
cat > chronicle/.htaccess <<'EOF'
RewriteEngine On
RewriteRule ^(.*)$ https://gms-almanac.com/$1 [R=301,L,QSA]
EOF
chmod 700 chronicle-old              # nothing in it is served any more
```

`https://www.discreteinfinity.com/chronicle/#/c/12` now opens `https://gms-almanac.com/#/c/12`.

**e. Bring the new site up to date** (it does nothing when it already is) and run the security check:

```sh
cd ~/gms-almanac.com
php tools/migrate.php
php tools/security-check.php
```

## 7. Check it works

```sh
curl -s https://gms-almanac.com/api/auth/me.php
#   → {"error":"not_authenticated","providers":["google","github"]}
curl -sI http://gms-almanac.com/ | head -1                           # → 301, to https
curl -sI https://www.gms-almanac.com/ | grep -i location             # → https://gms-almanac.com/
curl -sI https://www.discreteinfinity.com/chronicle/ | grep -i location   # → https://gms-almanac.com/
curl -sI https://gms-almanac.com/api/config.php | head -1            # → 403 or 404
curl -sI https://gms-almanac.com/api/lib.php | head -1               # → 403 (only index.php and api/auth/ run)
curl -sI https://gms-almanac.com/tests/support/login.php | head -1   # → 404
curl -sI https://gms-almanac.com/.git/config | head -1               # → 404
curl -sI https://gms-almanac.com/manifest.webmanifest | grep -i content-type   # → application/manifest+json
```

Then in a browser:

1. Open `https://gms-almanac.com` and sign in with your `admin_identities` account. Your campaigns are all there,
   and **Site Admin** is under your name.
2. Open a campaign, a day page, and an Encyclopedia entry with a picture (proving the uploads are found).
3. Open **About & sources** to see every data source listed.

**If something's wrong**, put the old site back while you look: `cd ~/discreteinfinity.com && rm -rf chronicle &&
mv chronicle-old chronicle && cp ~/chronicle-config.php.before-move ~/chronicle-config.php`. Nothing in the
database was changed by the move.

## 8. Tell your players

- The new address, `https://gms-almanac.com`, and that they sign in once there with the same Google or GitHub
  account as before (sessions don't carry over to a new address).
- If they installed the app (Chrome's *Install*, or *Add to Home Screen* on an iPad), remove the old one and install
  it again from the new address: an installed app belongs to its address.
- GMs who use **Foundry VTT** with the GM's Almanac Bridge module: change *GM's Almanac address* in the module's
  settings to `https://gms-almanac.com`, then press *Use my key with this address* when it asks. The API key is the
  same; only the address changes. (A redirect can't carry the module's requests across, so this step is needed.)
- GMs who added the panel to **Owlbear Rodeo**: remove the extension and add it again from the new address. Panel
  links in a virtual tabletop's frame or a stream follow the redirect, but are best replaced with the new address.

## 9. Tidy up, a few weeks later

Once you're sure of the new site:

- Delete `~/discreteinfinity.com/chronicle-old` and `~/chronicle-config.php.before-move`. Keep the redirect folder
  for as long as old links may be about (a year costs nothing).
- Delete the old Google redirect URI or GitHub OAuth app GM's Almanac used, **unless Sinless uses them**.
- **If you made a new database in step 4:** delete `~/gms-almanac-export-*.sql`, and drop GM's Almanac's tables from
  the shared database, keeping `users` and `rate_limits`, which Sinless uses. Back that database up first (the
  panel, or `mysqldump`). The list of GM's Almanac's tables:
  `grep -oP 'CREATE TABLE IF NOT EXISTS \K\w+' ~/gms-almanac.com/db/schema.sql | grep -vx 'users\|rate_limits'`.
  **Never drop the shared database itself.**

## 10. Updates

```sh
cd ~/gms-almanac.com
./deploy.sh        # git pull --ff-only, php -l, tools/migrate.php, then tools/security-check.php
```

Database upgrades need nothing from you: after the pull, deploy.sh runs `php tools/migrate.php`, which looks for
anything new under `db/migrations/` (each step checks for its table or column, so it never runs twice) and does
nothing when there isn't. When there is, it first saves a copy of the database with `mysqldump` to
`~/chronicle-backups/` (only your account can read it; the last 5 are kept; set `'backups' => ['path' => ...]` in the
config to move it), then runs the migrations and lists what changed. If the backup or a migration fails, deploy.sh
ends with *NOT done* and says why; fix that and run `php tools/migrate.php` again.

The app expects every migration to have run. Until they have, every page answers *This GM's Almanac database needs
an upgrade* instead of half working, so run `php tools/migrate.php` and reload.

- `php tools/migrate.php --check` says what would run, and changes nothing.
- `php tools/migrate.php --no-backup` skips the copy, if you've just made a backup yourself.

`allow_install` can stay `false` for good: install.php is only for hosts where you can't run commands.

## 11. Backups

DreamHost keeps its own backups of your files and databases, but they're for its emergencies, not a promise. Keep
copies of your own, and somewhere other than DreamHost now and then.

In the panel, **Advanced → Cron Jobs → Add new cron job**, as your user, daily, with this command (one line):

```sh
cd ~ && mysqldump --defaults-extra-file=$HOME/.gms-almanac.cnf --single-transaction --no-tablespaces gms_almanac | gzip > ~/chronicle-backups/nightly-$(date +\%a).sql.gz && tar -czf ~/chronicle-backups/uploads-$(date +\%a).tar.gz .chronicle-uploads
```

with the database's login in a file only you can read (use the old database's host, name, user and password if you
kept it in step 4, and put that name in place of `gms_almanac` in the command):

```sh
mkdir -p ~/chronicle-backups && chmod 700 ~/chronicle-backups
cat > ~/.gms-almanac.cnf <<'EOF'
[client]
host=mysql.gms-almanac.com
user=gms_almanac
password="the database password"
EOF
chmod 600 ~/.gms-almanac.cnf
```

That keeps one copy for each weekday. Now and then download `~/chronicle-backups` to your computer (SFTP, or
`rsync -av you@gms-almanac.com:chronicle-backups/ ./almanac-backups/`). To restore: load a `.sql` into an empty
database (`gunzip -c nightly-Mon.sql.gz | mysql -h … -u … -p …`), and unpack the uploads into your home folder.

## 12. Email (optional)

The app can email people when you approve or revoke them, and email campaign invitations (`approval_email` in the
config). On DreamHost, PHP's `mail()` works, but mail is only delivered reliably when it comes from the site's own
domain:

1. In the panel, **Mail → Manage Email**: create `noreply@gms-almanac.com` (or just make sure the domain's mail is
   hosted at DreamHost, which sets up SPF and DKIM for it).
2. In the config: `'approval_email' => ['enabled' => true, 'from' => "GM's Almanac <noreply@gms-almanac.com>", …]`.

Left off, nothing breaks: a GM copies an invitation's link from the Members tab instead. For a ping when someone new
asks for access, `approval_webhook_url` takes a Discord or Slack webhook.

---

## A new, empty site

For a fresh install with no data to bring over, follow steps 2, 3 and 5, then:

1. Make a database in the panel (step 4's *Add new database*).
2. Write the config, one level above the site's folder:

   ```sh
   cp ~/gms-almanac.com/api/config.example.php ~/chronicle-config.php && chmod 600 ~/chronicle-config.php
   nano ~/chronicle-config.php
   ```

   Set `db` (the panel's hostname, not `127.0.0.1`), `base_url` (`https://gms-almanac.com`), the `oauth` ids and
   secrets, and your sign-in email under `admin_identities`. Every setting is explained in the file. Leave
   `session.save_path`, `uploads.path` and `backups.path` blank: the app then uses `~/.chronicle-sessions`,
   `~/.chronicle-uploads` and `~/chronicle-backups`, all outside the site.
3. `cd ~/gms-almanac.com && php tools/migrate.php` creates the tables.
4. Check it as in step 7. A second account that signs in waits for approval under **Site Admin → Users**; approve it,
   then add it to a campaign from the campaign's **Members** tab.

The app looks for its config in this order: the `$CHRONICLE_CONFIG` environment variable, `chronicle-config.php` one
level above the web root, `~/chronicle-config.php`, then `api/config.php`.

## If the new site is under a different DreamHost user

Then its home folder is a different one, and the new site doesn't see the old config, uploads or database login. Do
steps 2, 3 and 5, then, before the switch:

1. Copy the config across and fix its permissions: as the old user, `scp ~/chronicle-config.php
   newuser@gms-almanac.com:` then, as the new user, `chmod 600 ~/chronicle-config.php`.
2. Copy the uploads: as the old user, `rsync -av ~/.chronicle-uploads/ newuser@gms-almanac.com:.chronicle-uploads/`,
   and again just before the switch for anything added since.
3. In step 6, run the export as the old user (`php tools/export-site.php`, which works for a database of its own as
   well as a shared one), copy the file across with `scp`, and load it into a database the new site has (a new
   one, step 4). Then carry on with 6c to 6e as the new user.

## Behind a CDN or proxy

Sign-in starts are limited per IP address (20 per 5 minutes). Behind Cloudflare or any other proxy, every visitor
reaches PHP from the proxy's few addresses, so that limit would soon lock a whole table of players out. List the
proxy's addresses in the config and the app uses the address the proxy passes on in `X-Forwarded-For` instead:

```php
'trusted_proxies' => ['173.245.48.0/20', '103.21.244.0/22', /* ... */],
```

For Cloudflare, copy its published ranges from <https://www.cloudflare.com/ips/> (both IPv4 and IPv6), and set its
SSL mode to *Full (strict)* so it talks to the server over HTTPS. The header is read only from those addresses, and
only its last hop that isn't one of them, so a visitor can't pick their own address by sending the header
themselves. Leave the list empty when PHP is reached directly.


## Troubleshooting

- **The browser says the connection isn't private.** The certificate isn't there yet. Check `dig +short
  gms-almanac.com` gives the panel's address, then add (or retry) the Let's Encrypt certificate under *Websites →
  Secure Certificates*.
- **DreamHost's placeholder page shows instead of the app.** The folder still has DreamHost's `index.html`, or the
  website's web directory isn't `~/gms-almanac.com`. Check step 3, and the web directory on the site's *Manage* page.
- **Every page is a 500.** Look at `~/logs/gms-almanac.com/https/error.log`. Usually the PHP version is too old (set
  8.1 or newer on the site's *Manage* page), or a `.user.ini` line is mistyped.
- **"redirect_uri_mismatch" from Google, or GitHub's "The redirect_uri is not associated with this application".**
  The callback registered in step 5 doesn't match `base_url` + `/api/auth/callback.php` exactly: same `https`, no
  `www.`, no trailing slash on `base_url`.
- **Sign-in goes back to the old address.** `base_url` in `~/chronicle-config.php` still says the old one (step 6c).
- **"This GM's Almanac database needs an upgrade".** Run `php tools/migrate.php` in `~/gms-almanac.com`.
- **Can't connect to the database.** On DreamHost the host is the panel's MySQL hostname (like
  `mysql.gms-almanac.com`), never `localhost` or `127.0.0.1`; a new hostname can take a few minutes to answer.
- **Pictures are missing.** The uploads folder isn't where the new site looks. With the same user and a blank
  `uploads.path` it is `~/.chronicle-uploads`; check `ls -a ~` and the config's `uploads.path`.
- **Uploads fail.** Check the `.user.ini` from step 3. install.php's page and the error log say when the uploads
  folder can't be used.
- **A player shows up as a new account waiting for approval.** They signed in with a different Google or GitHub
  account than before. Approve them, or have them sign in with the one they used on the old site.
- **`tools/export-site.php` says the database needs an upgrade.** Run `./deploy.sh` (or `php tools/migrate.php`) on
  the old site first, so the copy is complete.

## Installable app

Chrome and Edge offer *Install app* only over HTTPS, which the `.htaccess` already forces. `sw.js` must stay at the
app's root (next to `index.html`) so it covers the whole app; nothing else needs setting up. It caches only
`offline.html`, so deploys show up straight away.

## Pictures and files

Uploaded pictures and files are kept **outside the web root** and only sent through `api/index.php?a=file`, to
members allowed to see the entry. The app refuses an uploads folder inside the web root. Each file can be up to
`uploads.max_mb` (10 MB by default), each campaign's files up to `uploads.campaign_mb` (500 MB) and each person's up
to `uploads.user_mb` (1000 MB). PHP's own limits must be at least as big, or they win.

Allowed: JPEG, PNG, GIF and WebP pictures (shown on the page), PDF and plain text (.txt, .md, .csv, always
downloaded). SVG and HTML are refused because they can carry scripts. Back up the uploads folder along with the
database.

## Upgrading an install from before Google/GitHub sign-in

Back up the database first. Then pull, fill in the new config (it moved from `lib/config.php` to
`~/chronicle-config.php` and gained the OAuth fields), and run `php tools/migrate.php` (or open `install.php`): it
finds the old users table and runs `db/migrations/001_oauth_signin.sql`. Or run that file with `mysql` yourself.

Every existing account is kept, approved, with its campaigns, roles and notes. Passwords are dropped. Sign in with
your `admin_identities` email (that creates a new admin account), open **Site Admin**, and press *Link email* on each
old account to enter the email that player signs in with. Their first sign-in with it takes over the old account.
Your own old account can be linked the same way, or deleted.
