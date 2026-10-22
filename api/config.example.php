<?php
/**
 * config.example.php — copy to config.php and fill in.
 *
 *   cp api/config.example.php api/config.php
 *
 * config.php holds secrets (DB password, OAuth client secrets) and is
 * gitignored. On Apache the bundled .htaccess denies direct access to it, but
 * the most robust option is to keep it ABOVE the web root. lib.php looks for the
 * config in this order (first match wins), so no path editing is needed:
 *   1. the $CHRONICLE_CONFIG env var (absolute path)
 *   2. <one level above DOCUMENT_ROOT>/chronicle-config.php   (e.g. ~/chronicle-config.php)
 *   3. $HOME/chronicle-config.php
 *   4. api/config.php  (this in-tree location)
 * So to harden: `mv api/config.php ~/chronicle-config.php` and it just works.
 * Never commit the real config.
 *
 * This file returns a plain array; lib.php reads it via require.
 */

return [

  // --- Database (MySQL) -----------------------------------------------------
  'db' => [
    'host'     => '127.0.0.1',
    'port'     => 3306,
    // To share accounts and the approval queue with Sinless, use Sinless's
    // database here: the users and rate_limits tables are identical. Do this
    // only on a fresh install (an existing install keeps its own database).
    'name'     => 'chronicle',
    'user'     => 'chronicle_app',
    'password' => 'CHANGE_ME',
    'charset'  => 'utf8mb4',
  ],

  // --- Where the app lives --------------------------------------------------
  // Absolute base URL of the site (no trailing slash), used to build the OAuth
  // redirect_uri and to validate post-login redirects as same-origin.
  'base_url' => 'https://example.com/chronicle',

  // --- OAuth providers ------------------------------------------------------
  // You can reuse Sinless's OAuth apps: add this app's callback as a second
  // authorized redirect URI (Google) or register a second OAuth app (GitHub
  // allows one callback per app). The callback is:
  //   <base_url>/api/auth/callback.php
  // Leave a provider's client_id empty to hide its sign-in button.
  'oauth' => [
    'google' => [
      'client_id'     => '',
      'client_secret' => '',
    ],
    'github' => [
      'client_id'     => '',
      'client_secret' => '',
    ],
  ],

  // --- First admin(s) -------------------------------------------------------
  // Identities here are auto-approved AND flagged admin on first sign-in, so the
  // owner can get in and approve everyone else. Match either the verified email
  // or the "provider:provider_user_id" form (e.g. "github:1432").
  'admin_identities' => [
    // 'you@gmail.com',
    // 'github:0000000',
  ],

  // --- Signup notification --------------------------------------------------
  // Discord or Slack "incoming webhook" URL. When a NEW user lands in the
  // pending queue, the server POSTs a short alert here (fire-and-forget).
  // Leave empty to disable notifications.
  'approval_webhook_url' => '',

  // --- Account status email -------------------------------------------------
  // When an admin approves (or revokes) a user, email them about it. Uses PHP
  // mail() (fire-and-forget; a failure never blocks the admin action). For
  // deliverability the 'from' MUST be an address on a domain your host is
  // authorized to send for (e.g. your site's domain), so SPF/DKIM align — a
  // gmail.com From from a shared host will be spam-filtered. One switch covers
  // both events: set enabled=false (or leave 'from' empty) to disable. The
  // approval message's sign-in link uses 'base_url' above.
  'approval_email' => [
    'enabled'        => false,
    'from'           => 'Campaign Chronicle <noreply@example.com>',
    'subject'        => 'Your Campaign Chronicle account is approved',
    'revoke_subject' => 'Your Campaign Chronicle access was removed',
    // 'reply_to' => 'you@example.com',   // optional
  ],

  // --- Session / cookie -----------------------------------------------------
  'session' => [
    // Keep this different from Sinless's cookie name so the two apps' sessions
    // don't overwrite each other on the shared domain.
    'name'            => 'chronicle_sid',
    'idle_timeout'    => 60 * 60 * 24 * 14,   // seconds of inactivity before logout (14d)
    'absolute_timeout'=> 60 * 60 * 24 * 60,   // hard cap on a session's life (60d)
    // How long the browser keeps the session cookie. Omit to follow
    // idle_timeout (the window slides on each request, capped by
    // absolute_timeout). Set 0 for a browser-session cookie that dies when the
    // browser closes -- more private on shared machines, but it means users
    // re-login every time they restart the browser.
    // 'cookie_lifetime' => 0,
    // Set false ONLY for local http testing; MUST be true in production (HTTPS).
    'cookie_secure'   => true,
    // Where session FILES live. Leave blank and the app puts them in
    // <parent of web root>/.chronicle-sessions/<session name> -- on shared hosting
    // that's your account home, outside the web root and owned by you. Keeping
    // them off the shared default (/tmp) is what stops another tenant's cleanup,
    // or a cron sweep that ignores gc_maxlifetime, from logging everyone out.
    // Set an absolute path here to override; it must be writable by PHP. If the
    // directory can't be used the app falls back to PHP's default rather than
    // breaking every login, and logs why when the path was set explicitly.
    'save_path'       => '',
  ],

  // --- Pictures and files ---------------------------------------------------
  // Pictures and files attached to Encyclopedia entries. They are kept OUTSIDE
  // the web root and only sent through the app, to people allowed to see them.
  // Leave 'path' blank and the app uses <parent of web root>/.chronicle-uploads
  // (on shared hosting, your account home), creating it if it can. Set an
  // absolute path to put them elsewhere; it must be writable by PHP and must not
  // be inside the web root (the app refuses one that is).
  // max_mb is the largest single file. PHP's own upload_max_filesize and
  // post_max_size (php.ini, or .user.ini on DreamHost-style hosts) must be at
  // least this big, or they win: e.g. upload_max_filesize = 10M, post_max_size = 12M.
  // campaign_mb caps the total of each campaign's files.
  'uploads' => [
    'path'        => '',
    'max_mb'      => 10,
    'campaign_mb' => 500,
  ],

  // --- Limits ---------------------------------------------------------------
  // Per-IP throttling on sign-in and per-admin throttling on user changes (needs
  // the rate_limits table from db/schema.sql). Leave true; set false only to debug.
  'rate_limit_enabled' => true,

  // Set true only while debugging locally — leaks errors to the client. Keep
  // false in production (errors go to the PHP error log instead).
  'debug' => false,

  // Lets install.php create tables and run migrations. Turn it on for an
  // install or upgrade, then set it back to false. Once a site admin has signed
  // in, install.php also needs you signed in as a site admin.
  'allow_install' => false,
];
