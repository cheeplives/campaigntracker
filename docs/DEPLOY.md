# Deploying GM's Almanac at gms-almanac.com

A step-by-step runbook for running GM's Almanac on a server of your own at `https://gms-almanac.com`, as a site of its
own: its own database, its own accounts and approvals, and its own Google and GitHub sign-in apps. Nothing in it is
shared with Sinless or any other app.

It covers a new install and moving an existing install (for example the old one at
`https://www.discreteinfinity.com/chronicle/`) across with all its campaigns, accounts and uploads.

The steps are written for a small Linux server you run yourself (a VPS on Ubuntu 24.04 LTS). If you'd rather put
it on shared hosting such as DreamHost, follow [On shared hosting instead](#on-shared-hosting-instead): the app is
the same, only steps 2 to 5 change.

**Contents**

1. [What you need](#1-what-you-need)
2. [Point the domain at the server (DNS)](#2-point-the-domain-at-the-server-dns)
3. [Install the server software](#3-install-the-server-software)
4. [Get the code](#4-get-the-code)
5. [Apache and HTTPS](#5-apache-and-https)
6. [Create the database](#6-create-the-database)
7. [Register the sign-in apps (Google and GitHub)](#7-register-the-sign-in-apps-google-and-github)
8. [Write the config](#8-write-the-config)
9. [Create the tables, or move your existing data](#9-create-the-tables-or-move-your-existing-data)
10. [Check it works](#10-check-it-works)
11. [After a move: the old address, players and tools](#11-after-a-move-the-old-address-players-and-tools)
12. [Updates](#12-updates)
13. [Backups](#13-backups)
14. [Email (optional)](#14-email-optional)
- [On shared hosting instead](#on-shared-hosting-instead)
- [Behind a CDN or proxy](#behind-a-cdn-or-proxy)
- [Troubleshooting](#troubleshooting)
- [Upgrading an install from before Google/GitHub sign-in](#upgrading-an-install-from-before-googlegithub-sign-in)

Throughout, `josh` is the account you sign in to the server with, and `203.0.113.10` stands for the server's address.
Swap in your own.

---

## 1. What you need

- **The domain** `gms-almanac.com`, at whichever registrar you bought it from, with access to its DNS settings.
- **A server.** Any VPS provider will do (Hetzner, DigitalOcean, Linode, Vultr…). For a handful of tables of players,
  the smallest plan is plenty: 1 vCPU, 1–2 GB of memory, 25 GB of disk, plus room for uploads (each campaign may hold
  up to 500 MB by default). Pick **Ubuntu 24.04 LTS** and add your SSH key when you create it.
- **Software** (installed in step 3): Apache 2.4 with `mod_rewrite`, `mod_headers` and `mod_alias`; PHP 8.1 or newer
  (8.3 on Ubuntu 24.04) with `pdo_mysql`, `curl`, `mbstring` and `xml` (`intl` is optional, for accent-free map
  searches); MySQL 8.0 (or MariaDB 10.3+); `git`; Certbot for the HTTPS certificate.
- **Accounts** at Google Cloud and GitHub, to register the sign-in apps (step 7).

Apache is the web server to use: the app's `.htaccess` files carry its HTTPS redirect, its security headers and the
rules that keep the config, `db/`, `tools/`, `tests/` and `.git` from ever being served.

## 2. Point the domain at the server (DNS)

At your registrar (or wherever the domain's DNS is hosted), add:

| Type    | Name | Value                         | TTL |
|---------|------|-------------------------------|-----|
| `A`     | `@`  | `203.0.113.10` (server IPv4)  | 300 |
| `AAAA`  | `@`  | the server's IPv6, if it has one | 300 |
| `CNAME` | `www`| `gms-almanac.com.`            | 300 |

Remove any parking-page `A` records or URL forwards the registrar added. A short TTL (300 seconds) makes a mistake
quick to fix; raise it to 3600 once all is well.

Check from your own computer (it can take a few minutes, rarely a few hours):

```sh
dig +short gms-almanac.com          # → 203.0.113.10
dig +short www.gms-almanac.com      # → gms-almanac.com. then 203.0.113.10
```

Certbot (step 5) needs these to answer before it can issue the certificate.

## 3. Install the server software

Sign in (`ssh root@203.0.113.10`, or the user your provider set up) and run:

```sh
# Your own login, if the provider only gave you root
adduser josh && usermod -aG sudo josh
rsync --archive --chown=josh:josh ~/.ssh /home/josh     # copy your SSH key across
# from here on, sign in as josh

sudo apt update && sudo apt upgrade -y
sudo apt install -y apache2 libapache2-mod-php php8.3 php8.3-mysql php8.3-curl php8.3-mbstring php8.3-xml \
  php8.3-intl mysql-server git certbot python3-certbot-apache unattended-upgrades
sudo a2enmod rewrite headers alias
sudo usermod -aG www-data josh       # so you can read the config the web server reads; sign out and in again

# Firewall: SSH and the web only. MySQL stays on localhost, which is Ubuntu's default.
sudo ufw allow OpenSSH
sudo ufw allow 'Apache Full'
sudo ufw enable

# Security updates install by themselves
sudo dpkg-reconfigure -plow unattended-upgrades
```

Check PHP: `php -v` (8.1 or newer) and `php -m | grep -Ei 'pdo_mysql|curl|mbstring|xml'` (all four listed).

Then raise PHP's upload limits to match the app's (10 MB a file by default). Ubuntu's are 2 MB:

```sh
sudo tee /etc/php/8.3/apache2/conf.d/90-gms-almanac.ini >/dev/null <<'EOF'
upload_max_filesize = 10M
post_max_size = 12M
expose_php = Off
EOF
```

## 4. Get the code

The site's folder is `/var/www/gms-almanac`, and everything private sits beside it, outside what the web server
serves:

```
/var/www/gms-almanac/          the app (a git checkout), the web root
/var/www/chronicle-config.php  the config, one level above the web root, where the app looks for it
/var/lib/gms-almanac/uploads   pictures and files people upload
/var/lib/gms-almanac/sessions  sign-in sessions
/var/backups/gms-almanac       database copies made before each upgrade
```

```sh
sudo mkdir -p /var/www/gms-almanac
sudo chown josh:www-data /var/www/gms-almanac
git clone https://github.com/cheeplives/campaigntracker.git /var/www/gms-almanac

sudo mkdir -p /var/lib/gms-almanac/uploads /var/lib/gms-almanac/sessions
sudo chown -R www-data:www-data /var/lib/gms-almanac
sudo chmod -R 700 /var/lib/gms-almanac

sudo mkdir -p /var/backups/gms-almanac
sudo chown josh:josh /var/backups/gms-almanac && sudo chmod 700 /var/backups/gms-almanac
```

The checkout is yours (`josh`), readable by Apache through the `www-data` group. Apache never needs to write to it.

## 5. Apache and HTTPS

Create the site:

```sh
sudo tee /etc/apache2/sites-available/gms-almanac.conf >/dev/null <<'EOF'
<VirtualHost *:80>
  ServerName gms-almanac.com
  ServerAlias www.gms-almanac.com
  DocumentRoot /var/www/gms-almanac

  <Directory /var/www/gms-almanac>
    Options -Indexes +FollowSymLinks
    AllowOverride All
    Require all granted
  </Directory>

  ErrorLog ${APACHE_LOG_DIR}/gms-almanac-error.log
  CustomLog ${APACHE_LOG_DIR}/gms-almanac-access.log combined
</VirtualHost>
EOF
sudo a2ensite gms-almanac
sudo a2dissite 000-default
sudo apache2ctl configtest && sudo systemctl reload apache2
```

`AllowOverride All` matters: without it Apache ignores the app's `.htaccess`, and with it the HTTPS redirect, the
headers and the blocked folders.

Then get the certificate. Certbot (Let's Encrypt, free) writes the HTTPS site for you and renews it by itself:

```sh
sudo certbot --apache -d gms-almanac.com -d www.gms-almanac.com --redirect
sudo certbot renew --dry-run          # proves renewal works
```

Last, send `www.` to the bare domain, so there is one address (sign-in cookies and the installed app are tied to
it). Open the HTTPS site Certbot made, `/etc/apache2/sites-available/gms-almanac-le-ssl.conf`, and add inside its
`<VirtualHost *:443>`:

```apache
  RewriteEngine On
  RewriteCond %{HTTP_HOST} ^www\. [NC]
  RewriteRule ^ https://gms-almanac.com%{REQUEST_URI} [R=301,L]
```

then `sudo apache2ctl configtest && sudo systemctl reload apache2`.

## 6. Create the database

```sh
sudo mysql
```

```sql
CREATE DATABASE gms_almanac CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'gms_almanac'@'localhost' IDENTIFIED BY 'a-long-random-password';
GRANT ALL PRIVILEGES ON gms_almanac.* TO 'gms_almanac'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Make the password with `openssl rand -base64 24` and keep it for the config. The app's user needs every privilege on
its own database (the upgrades create and alter tables) and none anywhere else.

## 7. Register the sign-in apps (Google and GitHub)

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

Leave either one out of the config and its button doesn't show.

Accounts are matched by the provider's own id for the person (Google's account id, GitHub's user id), never by the
app that asked, so someone moved from the old install keeps their account and campaigns when they sign in through the
new apps.

## 8. Write the config

```sh
cd /var/www/gms-almanac
cp api/config.example.php /var/www/chronicle-config.php
sudo chown josh:www-data /var/www/chronicle-config.php
chmod 640 /var/www/chronicle-config.php
nano /var/www/chronicle-config.php
```

The app looks for its config in this order: the `$CHRONICLE_CONFIG` environment variable, `chronicle-config.php` one
level above the web root (that's this one), `~/chronicle-config.php`, then `api/config.php`. Every setting is
explained in the file. Set at least:

```php
'db' => [
  'host' => '127.0.0.1', 'port' => 3306,
  'name' => 'gms_almanac', 'user' => 'gms_almanac', 'password' => 'the password from step 6',
  'charset' => 'utf8mb4',
],
'base_url' => 'https://gms-almanac.com',          // no trailing slash
'oauth' => [
  'google' => ['client_id' => '…', 'client_secret' => '…'],
  'github' => ['client_id' => '…', 'client_secret' => '…'],
],
'admin_identities' => ['you@gmail.com'],          // the email you sign in with, or 'github:<your id>'
'session' => [
  // …keep the rest as it is, and set:
  'save_path' => '/var/lib/gms-almanac/sessions',
],
'uploads' => ['path' => '/var/lib/gms-almanac/uploads', 'max_mb' => 10, 'campaign_mb' => 500, 'user_mb' => 1000],
'backups' => ['path' => '/var/backups/gms-almanac'],
'image_search' => ['contact' => 'https://gms-almanac.com', /* …keys as before, if you had any */],
```

If you're moving an existing install, copy across from the old config whatever else you had set: the Find Image keys
(`image_search`), `approval_webhook_url`, `approval_email`, `github_reports`, `fan_wikis` and `limits`. Keep
`debug` and `allow_install` at `false`.

## 9. Create the tables, or move your existing data

### A new, empty site

```sh
cd /var/www/gms-almanac
php tools/migrate.php
```

It creates every table and says *Database: up to date*. Go on to step 10.

### Moving the existing install (with its campaigns, accounts and uploads)

The data comes over as it is: campaigns, days, notes, sheets, maps, Encyclopedia entries, accounts and who is
approved, panel links and API keys. Do it at a quiet time; it takes a few minutes. Anything changed on the old site
after the export would be left behind, so ask your players to stay off it for that while, or do step 11's redirect
first.

**On the old server**, first pull this version, so the export tool is there, and bring that database up to date:

```sh
cd ~/public_html/chronicle        # wherever the old install lives
./deploy.sh
php tools/export-site.php --check
```

`--check` says which database it reads, how many of GM's Almanac's tables it found and how many accounts will go.
If the old database is (or once was) shared with Sinless, it says so too: only GM's Almanac's own tables are copied
(the ones `db/schema.sql` creates), Sinless's stay behind, and of the shared accounts only GM's Almanac's go (anyone
with access here, older accounts from before Google/GitHub sign-in, and anyone something of ours points to). Add
`--all-users` to copy every account instead. Nothing on the old site is changed either way.

Then make the copy:

```sh
php tools/export-site.php
# → Export: wrote /home/you/gms-almanac-export-20261127-180000.sql (4.2 MB). Only your account can read it.
```

**Copy it and the uploads to the new server.** From the old server (its uploads are in `~/.chronicle-uploads` unless
its config's `uploads.path` says otherwise):

```sh
scp ~/gms-almanac-export-*.sql josh@gms-almanac.com:/var/backups/gms-almanac/
rsync -av ~/.chronicle-uploads/ josh@gms-almanac.com:/tmp/almanac-uploads/
```

**On the new server**, load the copy into the empty database, put the uploads in place and run the upgrade (which
does nothing when the two run the same version):

```sh
mysql -u gms_almanac -p gms_almanac < /var/backups/gms-almanac/gms-almanac-export-*.sql
sudo rsync -a /tmp/almanac-uploads/ /var/lib/gms-almanac/uploads/ && rm -rf /tmp/almanac-uploads
sudo chown -R www-data:www-data /var/lib/gms-almanac/uploads
cd /var/www/gms-almanac && php tools/migrate.php
```

Load it only into the new, empty database. Everyone will need to sign in once on the new address: sessions don't
carry over.

## 10. Check it works

```sh
cd /var/www/gms-almanac
php tools/security-check.php        # names anything that must not stay that way on a live site; changes nothing
curl -s https://gms-almanac.com/api/auth/me.php
#   → {"error":"not_authenticated","providers":["google","github"]}
curl -sI http://gms-almanac.com/ | head -1                           # → 301, to https
curl -sI https://www.gms-almanac.com/ | grep -i location             # → https://gms-almanac.com/
curl -sI https://gms-almanac.com/api/config.php | head -1            # → 403 or 404
curl -sI https://gms-almanac.com/api/lib.php | head -1               # → 403 (only index.php and api/auth/ run)
curl -sI https://gms-almanac.com/tests/support/login.php | head -1   # → 404
curl -sI https://gms-almanac.com/.git/config | head -1               # → 404
curl -sI https://gms-almanac.com/manifest.webmanifest | grep -i content-type   # → application/manifest+json
```

Then in a browser:

1. Open `https://gms-almanac.com` and sign in with your `admin_identities` account. You land approved, with
   **Site Admin** under your name. After a move, your campaigns are all there.
2. Open a campaign, a day page, and an Encyclopedia entry with a picture (after a move, this proves the uploads came
   across).
3. Have a second account sign in. On a new site it waits for approval: approve it under **Site Admin → Users**, then
   add it to a campaign from the campaign's **Members** tab.
4. Open **About & sources** to see every data source listed.

## 11. After a move: the old address, players and tools

**Send the old address to the new one.** On the old server, once the new site checks out, replace the old install
with a redirect, so bookmarks, invitations and panel links keep working:

```sh
cd ~/public_html
mv chronicle chronicle-old-$(date +%Y%m%d)       # keep it a while, out of the way
mkdir chronicle
cat > chronicle/.htaccess <<'EOF'
RewriteEngine On
RewriteRule ^(.*)$ https://gms-almanac.com/$1 [R=301,L,QSA]
EOF
```

`https://www.discreteinfinity.com/chronicle/#/c/12` then opens `https://gms-almanac.com/#/c/12`. Move the old
config (`~/chronicle-config.php`) somewhere safe, or delete it once you no longer need it, so nothing on the old site
can reach the database. Once you're sure of the new site (a few weeks), delete `chronicle-old-*` and the old uploads
folder.

**The old database.** If it was GM's Almanac's alone, drop it once you're sure. If it is Sinless's database too,
**don't drop it**: drop only GM's Almanac's tables, and keep `users` and `rate_limits`, which Sinless uses. The list
is in `db/schema.sql` (`grep -oP 'CREATE TABLE IF NOT EXISTS \K\w+' db/schema.sql`); make a backup first.

**Tell your players:**

- The new address, `https://gms-almanac.com`, and that they sign in once there with the same Google or GitHub
  account as before.
- If they installed the app (Chrome's *Install*, or *Add to Home Screen* on an iPad), remove the old one and install
  it again from the new address: an installed app belongs to its address.
- GMs who use **Foundry VTT** with the GM's Almanac Bridge module: change *GM's Almanac address* in the module's
  settings to `https://gms-almanac.com`, then press *Use my key with this address* when it asks. The API key is the
  same; only the address changes. (A redirect can't carry the module's requests across, so this step is needed.)
- GMs who added the panel to **Owlbear Rodeo**: remove the extension and add it again from the new address. Panel
  links in a virtual tabletop's frame or a stream follow the redirect, but are best replaced with the new address.

## 12. Updates

```sh
cd /var/www/gms-almanac
./deploy.sh        # git pull --ff-only, php -l, tools/migrate.php, then tools/security-check.php
```

Database upgrades need nothing from you: after the pull, deploy.sh runs `php tools/migrate.php`, which looks for
anything new under `db/migrations/` (each step checks for its table or column, so it never runs twice) and does
nothing when there isn't. When there is, it first saves a copy of the database with `mysqldump` to
`/var/backups/gms-almanac/` (the config's `backups.path`; only your account can read it; the last 5 are kept), then
runs the migrations and lists what changed. If the backup or a migration fails, deploy.sh ends with *NOT done* and
says why; fix that and run `php tools/migrate.php` again.

The app expects every migration to have run. Until they have, every page answers *This GM's Almanac database needs
an upgrade* instead of half working, so run `php tools/migrate.php` and reload.

- `php tools/migrate.php --check` says what would run, and changes nothing.
- `php tools/migrate.php --no-backup` skips the copy, if you've just made a backup yourself.

`allow_install` can stay `false` for good: install.php is only for hosts where you can't run commands.

## 13. Backups

The upgrade copies only cover upgrades. Back up every night, and keep a copy somewhere other than this server.
Root's crontab can read both the database (Ubuntu's MySQL lets root in without a password) and the uploads:

```sh
sudo crontab -e
```

```cron
# 03:15 every night: the database and the uploads, one copy per weekday (so a week's worth)
15 3 * * * mysqldump --single-transaction --no-tablespaces gms_almanac | gzip > /var/backups/gms-almanac/nightly-$(date +\%a).sql.gz
30 3 * * * tar -czf /var/backups/gms-almanac/uploads-$(date +\%a).tar.gz -C /var/lib/gms-almanac uploads
```

Then copy `/var/backups/gms-almanac` off the server: your VPS provider's backup option, `rclone` to cloud storage, or
`rsync` to a computer at home. To restore: load the `.sql` into an empty database as in step 9
(`gunzip -c nightly-Mon.sql.gz | mysql -u gms_almanac -p gms_almanac`), and unpack the uploads into
`/var/lib/gms-almanac/`.

## 14. Email (optional)

The app can email people when you approve or revoke them, and email campaign invitations (`approval_email` in the
config). It uses PHP's `mail()`, which on a fresh VPS has nothing to send through, and mail sent straight from a VPS
is mostly marked as spam. To turn it on:

1. Sign up with a sending service (Amazon SES, Postmark, Mailgun, Brevo, Fastmail…) and verify `gms-almanac.com`
   there: it gives you the SPF, DKIM and DMARC DNS records to add at your registrar.
2. Install `msmtp-mta` (`sudo apt install msmtp-mta`) and point `/etc/msmtprc` at the service's SMTP server with its
   username and password. PHP's `mail()` then sends through it.
3. In the config: `'approval_email' => ['enabled' => true, 'from' => "GM's Almanac <noreply@gms-almanac.com>", …]`.

Left off, nothing breaks: a GM copies an invitation's link from the Members tab instead. For a ping when someone new
asks for access, `approval_webhook_url` takes a Discord or Slack webhook, with no email set-up at all.

---

## On shared hosting instead

The app runs the same on shared hosting with PHP and MySQL (DreamHost, for example). Instead of steps 2 to 5:

1. In the host's panel, add `gms-almanac.com` as a **fully hosted** domain (DreamHost: *Websites → Add website*).
   The panel gives it a folder, such as `~/gms-almanac.com`. Choose PHP 8.1 or newer.
2. Point the domain's DNS at the host: either use the host's nameservers at your registrar, or add the `A`/`AAAA`
   records the panel shows.
3. Turn on the panel's free Let's Encrypt certificate for the domain, and its *www → non-www* option if it has one.
4. Create a MySQL database and user in the panel (one for GM's Almanac alone), and note the host name it gives
   (DreamHost's is like `mysql.gms-almanac.com`, not `127.0.0.1`).
5. Over SSH, put the code in the domain's folder:

   ```sh
   cd ~ && rm -rf gms-almanac.com && git clone https://github.com/cheeplives/campaigntracker.git gms-almanac.com
   cp gms-almanac.com/api/config.example.php ~/chronicle-config.php && chmod 600 ~/chronicle-config.php
   mkdir -p ~/.chronicle-uploads && chmod 700 ~/.chronicle-uploads
   ```

   The config in your home folder is one level above the web root, where the app looks. Leave `session.save_path`,
   `uploads.path` and `backups.path` blank: the app then uses `~/.chronicle-sessions`, `~/.chronicle-uploads` and
   `~/chronicle-backups`, all outside the site.
6. For the upload limits, put a `.user.ini` in the site's folder (or use the panel's PHP settings):

   ```ini
   upload_max_filesize = 10M
   post_max_size = 12M
   ```

Then carry on from step 6 (skip its commands: the panel made the database) through step 14, with `~/gms-almanac.com`
in place of `/var/www/gms-almanac` and `~/chronicle-config.php` in place of `/var/www/chronicle-config.php`. For
nightly backups use the panel's cron jobs.

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

- **The browser says the connection isn't private.** The certificate isn't there yet: check `dig` (step 2) and run
  Certbot again.
- **Every page is a 500.** Look in `/var/log/apache2/gms-almanac-error.log`. Usually `AllowOverride All` is missing,
  or a module isn't on (`sudo a2enmod rewrite headers alias && sudo systemctl reload apache2`).
- **"redirect_uri_mismatch" from Google, or GitHub's "The redirect_uri is not associated with this application".**
  The callback registered in step 7 doesn't match `base_url` + `/api/auth/callback.php` exactly: same `https`, no
  `www.`, no trailing slash on `base_url`.
- **Signed in, then straight back to the sign-in page.** The session folder isn't writable by Apache
  (`sudo chown www-data:www-data /var/lib/gms-almanac/sessions`), or `cookie_secure` is on while the site is reached
  over plain http.
- **"This GM's Almanac database needs an upgrade".** Run `php tools/migrate.php`.
- **Uploads fail.** Check `upload_max_filesize` and `post_max_size` (step 3) and that the uploads folder belongs to
  `www-data`. install.php's page and the error log say when the folder can't be used.
- **A moved player shows up as a new account waiting for approval.** They signed in with a different Google or GitHub
  account than before. Approve them, or have them sign in with the one they used on the old site.
- **`tools/export-site.php` says the database needs an upgrade.** Run `./deploy.sh` (or `php tools/migrate.php`) on
  the old server first, so the copy is complete.

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
