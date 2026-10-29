<?php
/**
 * lib.php — shared backend: config, PDO, hardened sessions, auth guards,
 * JSON I/O, rate limiting and TLS-verified HTTP helpers.
 *
 * Ported from the Sinless app's api/lib.php so both apps sign in the same way
 * (Google/GitHub OAuth + an admin approval queue). Every endpoint does
 * `require __DIR__ . '/lib.php';` (or '/../lib.php') first. PHP 8.
 *
 * Security posture:
 *  - PDO prepared statements only, emulate_prepares off, utf8mb4.
 *  - Sessions: strict mode, cookie Secure/HttpOnly/SameSite=Lax (Lax so the
 *    OAuth redirect back from the provider still carries the cookie), id
 *    regenerated on login, idle + absolute timeouts enforced.
 *  - CSRF: synchronizer token required on every mutation.
 *  - Sign-in endpoints are rate-limited per IP in the database, so dropping the
 *    session cookie doesn't reset the count.
 *  - Outbound OAuth/webhook calls verify TLS (peer + host).
 */
declare(strict_types=1);

// --- config ----------------------------------------------------------------
// Preference order (first that exists wins), so secrets can live ABOVE the web
// root — no path editing needed, just move the file up:
//   1. $CHRONICLE_CONFIG env var (explicit absolute path)
//   2. <one level above the document root>/chronicle-config.php   (e.g. ~/chronicle-config.php)
//   3. $HOME/chronicle-config.php
//   4. api/config.php  (in-tree fallback — protected by .htaccess, but least ideal)
$__candidates = [];
$__envCfg = getenv('CHRONICLE_CONFIG') ?: ($_SERVER['CHRONICLE_CONFIG'] ?? '');
if ($__envCfg !== '') $__candidates[] = $__envCfg;
if (!empty($_SERVER['DOCUMENT_ROOT']))
  $__candidates[] = dirname($_SERVER['DOCUMENT_ROOT']) . '/chronicle-config.php';
$__home = getenv('HOME') ?: ($_SERVER['HOME'] ?? '');
if ($__home !== '') $__candidates[] = rtrim($__home, '/') . '/chronicle-config.php';
$__candidates[] = __DIR__ . '/config.php';

/** Stop on a setup problem. JSON for the app; for install.php (which defines
 * CHRONICLE_INSTALLER) a readable page that says what is wrong and how to fix
 * it, instead of a bare 500. */
function setup_error(string $code, string $message, array $details = []): void {
  http_response_code(500);
  if (defined('CHRONICLE_INSTALLER')) {
    header('Content-Type: text/html; charset=utf-8');
    $e = fn($t) => htmlspecialchars((string) $t, ENT_QUOTES, 'UTF-8');
    echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
       . '<title>Setup problem — Campaign Chronicle</title><link rel="stylesheet" href="static/fonts.css"><link rel="stylesheet" href="static/style.css">'
       . '<main><div class="card narrow"><h1>Setup problem</h1><p>' . $e($message) . '</p>';
    if ($details) echo '<ul>' . implode('', array_map(fn($d) => '<li>' . $e($d) . '</li>', $details)) . '</ul>';
    echo '<p class="muted small">Error code: ' . $e($code) . '. See docs/DEPLOY.md.</p></div></main>';
    exit;
  }
  header('Content-Type: application/json');
  echo json_encode(['error' => $code, 'message' => $message]);
  exit;
}

$__CONFIG_PATH = '';
foreach ($__candidates as $__c) {
  if ($__c !== '' && @is_file($__c)) { $__CONFIG_PATH = $__c; break; }
}
if ($__CONFIG_PATH === '') {
  $__old = dirname(__DIR__) . '/lib/config.php';
  setup_error('server_not_configured',
    is_file($__old)
      ? 'Found the old lib/config.php, but this version reads its config from chronicle-config.php. Copy api/config.example.php to ~/chronicle-config.php (or api/config.php), copy your database details across, add the Google/GitHub sign-in settings, then delete lib/config.php.'
      : 'No config file found. Copy api/config.example.php to ~/chronicle-config.php (or api/config.php) and fill it in.',
    array_map(fn($c) => 'Looked for: ' . $c, array_values(array_filter($__candidates))));
}
try {
  $GLOBALS['__CFG'] = (function ($path) { return require $path; })($__CONFIG_PATH);
} catch (Throwable $e) {
  setup_error('bad_config', 'The config file has a PHP error, often a missing comma or quote.',
    ['Config file: ' . $__CONFIG_PATH, 'PHP said: ' . $e->getMessage() . (stripos($e->getMessage(), 'line') === false ? ' on line ' . $e->getLine() : '')]);
}
if (!is_array($GLOBALS['__CFG'])) {
  setup_error('bad_config', "The config file doesn't return a settings array. It should start with <?php and then return [ ... ]; like api/config.example.php.", ['Config file: ' . $__CONFIG_PATH]);
}
// A config in the old format (db_host, db_name, db_user, db_pass at the top
// level) still reaches the database, so install.php can upgrade it.
if (!isset($GLOBALS['__CFG']['db']) && isset($GLOBALS['__CFG']['db_host'])) {
  $__o = $GLOBALS['__CFG'];
  $GLOBALS['__CFG']['db'] = ['host' => $__o['db_host'], 'port' => (int) ($__o['db_port'] ?? 3306),
    'name' => $__o['db_name'] ?? '', 'user' => $__o['db_user'] ?? '', 'password' => $__o['db_pass'] ?? ''];
}
if (!is_array($GLOBALS['__CFG']['db'] ?? null)) {
  setup_error('bad_config', "The config file has no 'db' settings. Fill in the 'db' block from api/config.example.php.", ['Config file: ' . $__CONFIG_PATH]);
}

function cfg(?string $key = null, $default = null) {
  $c = $GLOBALS['__CFG'];
  if ($key === null) return $c;
  return array_key_exists($key, $c) ? $c[$key] : $default;
}

// --- error handling --------------------------------------------------------
$__debug = (bool) cfg('debug', false);
error_reporting(E_ALL);
ini_set('display_errors', $__debug ? '1' : '0');
ini_set('log_errors', '1');

// --- security headers (also enforced site-wide by .htaccess) ---------------
function send_security_headers(): void {
  // API responses must never be cached by shared caches.
  header('Cache-Control: no-store');
  header('X-Content-Type-Options: nosniff');
  header('Referrer-Policy: strict-origin-when-cross-origin');
  header('X-Frame-Options: DENY');
  // No CORS headers on purpose: the API is same-origin only.
  header_remove('X-Powered-By');
}
send_security_headers();

// --- database (PDO) --------------------------------------------------------
function db(): PDO {
  static $pdo = null;
  if ($pdo instanceof PDO) return $pdo;
  $d = cfg('db');
  $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=%s',
    $d['host'], (int) ($d['port'] ?? 3306), $d['name'], $d['charset'] ?? 'utf8mb4');
  try {
    $pdo = new PDO($dsn, $d['user'], $d['password'], [
      PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
      PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
      PDO::ATTR_EMULATE_PREPARES   => false,   // real prepared statements
    ]);
  } catch (Throwable $e) {
    error_log('DB connect failed: ' . $e->getMessage());
    // The installer shows the driver's reason (wrong password, unknown host…),
    // but only while allow_install is on; the app never does.
    if (defined('CHRONICLE_INSTALLER') && cfg('allow_install')) {
      setup_error('db_unavailable', "Couldn't connect to the database with the 'db' settings in the config.",
        ['Host: ' . $d['host'] . ', database: ' . $d['name'] . ', user: ' . $d['user'], 'MySQL said: ' . $e->getMessage()]);
    }
    json_error(500, 'db_unavailable', 'The database is unavailable.');
  }
  return $pdo;
}

// --- hardened session ------------------------------------------------------

/**
 * A private directory to keep session files in, or null to leave PHP's default
 * alone. The shared default (/tmp or /var/lib/php/sessions) is swept on a
 * schedule we don't control, and on shared hosting another tenant's sweep can
 * delete our files and log everyone out.
 *
 * `session.save_path` in config wins. Otherwise derive one from the parent of
 * the web root, which on shared hosts (DreamHost included) is the account home:
 * outside the web root, and ours. The session name is appended so two apps on
 * one account (Sinless and Chronicle) never share a directory.
 *
 * Falls back to PHP's default whenever the directory can't be used, because a
 * save_path that doesn't exist or isn't writable takes down every login.
 */
function session_dir(array $s): ?string {
  $configured = trim((string) ($s['save_path'] ?? ''));
  $dir = $configured;
  if ($dir === '') {
    $root = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), '/');
    if ($root === '') return null;
    $parent = dirname($root);
    if ($parent === '' || $parent === '/' || $parent === '.' || !is_dir($parent)) return null;
    $name = (string) preg_replace('/[^A-Za-z0-9_.-]/', '', (string) ($s['name'] ?? 'chronicle_sid'));
    if ($name === '') $name = 'chronicle_sid';
    $dir = $parent . '/.chronicle-sessions/' . $name;
  }

  if (!is_dir($dir)) @mkdir($dir, 0700, true);
  if (!is_dir($dir) || !is_writable($dir)) {
    if ($configured !== '')
      error_log("session.save_path '$dir' is not a writable directory — falling back to the PHP default.");
    return null;
  }
  @chmod($dir, 0700);
  $ht = $dir . '/.htaccess';
  if (!file_exists($ht)) @file_put_contents($ht, "Require all denied\n");
  return $dir;
}

function boot_session(): void {
  if (session_status() === PHP_SESSION_ACTIVE) return;
  $s = cfg('session', []);
  $ownDir = session_dir($s);
  if ($ownDir !== null) {
    session_save_path($ownDir);
    // Once the files are ours, PHP's own GC is the only thing that will clean
    // them. Hosts that sweep from cron ship gc_probability=0, so make sure GC runs.
    if ((int) ini_get('session.gc_probability') < 1) {
      ini_set('session.gc_probability', '1');
      ini_set('session.gc_divisor', '100');
    }
  }

  ini_set('session.use_strict_mode', '1');   // reject attacker-supplied session ids
  ini_set('session.use_only_cookies', '1');
  ini_set('session.cookie_httponly', '1');

  $idle = (int) ($s['idle_timeout'] ?? 1209600);
  $abs  = (int) ($s['absolute_timeout'] ?? 5184000);
  // How long the browser keeps the cookie. Defaults to the idle window so the
  // declared policy is the one that applies; 0 gives a browser-session cookie.
  $cookieLife = array_key_exists('cookie_lifetime', $s) ? (int) $s['cookie_lifetime'] : $idle;
  // Keep session files at least as long as the idle window.
  ini_set('session.gc_maxlifetime', (string) max($idle, 1440));

  session_name($s['name'] ?? 'chronicle_sid');
  session_set_cookie_params([
    'lifetime' => $cookieLife,
    'path'     => '/',
    'secure'   => (bool) ($s['cookie_secure'] ?? true),
    'httponly' => true,
    'samesite' => 'Lax',
  ]);
  session_start();

  // Idle + absolute timeout enforcement.
  $now = time();
  if (isset($_SESSION['user_id'])) {
    $expired = ($now - ($_SESSION['last_seen'] ?? $now)) > $idle
            || ($now - ($_SESSION['created'] ?? $now)) > $abs;
    if ($expired) { destroy_session(); }
  }
  if (isset($_SESSION['user_id'])) {
    $_SESSION['last_seen'] = $now;
    // PHP only sends the cookie when it creates or regenerates a session, so
    // re-send it to slide the window, but not past the absolute deadline.
    if ($cookieLife > 0) {
      $deadline = ($_SESSION['created'] ?? $now) + $abs;
      $life = min($cookieLife, max(0, $deadline - $now));
      if ($life > 0) {
        setcookie(session_name(), session_id(), [
          'expires'  => $now + $life, 'path' => '/',
          'secure'   => (bool) ($s['cookie_secure'] ?? true),
          'httponly' => true, 'samesite' => 'Lax',
        ]);
      }
    }
  }
  if (!isset($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

function destroy_session(): void {
  $_SESSION = [];
  if (ini_get('session.use_cookies')) {
    $p = session_get_cookie_params();
    setcookie(session_name(), '', [
      'expires' => time() - 42000, 'path' => $p['path'],
      'secure' => $p['secure'], 'httponly' => true, 'samesite' => 'Lax',
    ]);
  }
  session_destroy();
}

/** Call right after establishing privilege (login) to prevent fixation. */
function session_login(int $userId): void {
  session_regenerate_id(true);
  $_SESSION['user_id'] = $userId;
  $_SESSION['created'] = time();
  $_SESSION['last_seen'] = time();
  $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

// --- JSON I/O --------------------------------------------------------------
function json_out($data, int $status = 200): void {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
/** Error body shared with Sinless: a stable machine `error` code the client can
 * branch on, plus a human `message` it can show as-is. */
function json_error(int $status, string $code, string $message = '', string $detail = ''): void {
  $body = ['error' => $code];
  if ($message !== '') $body['message'] = $message;
  if ($detail !== '' && cfg('debug', false)) $body['detail'] = $detail;
  json_out($body, $status);
}

function require_method(string ...$allowed): void {
  $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
  if (!in_array($m, $allowed, true)) {
    header('Allow: ' . implode(', ', $allowed));
    json_error(405, 'method_not_allowed', 'Method not allowed.');
  }
}

// --- auth guards -----------------------------------------------------------
/** Whether migration 020 has been run: Chronicle keeps its own approvals in chronicle_access. Until it has, the shared
 * users.status (Sinless's) still decides, as before. */
function has_access_table(): bool {
  static $has = null;
  return $has ??= (bool) db()->query("SHOW TABLES LIKE 'chronicle_access'")->fetchColumn();
}
/** A user's standing in Chronicle: 'approved', 'revoked', or 'pending' (also for someone who never asked). */
function chronicle_status(array $user): string {
  if (!has_access_table()) return (string) $user['status'];
  $st = db()->prepare('SELECT status FROM chronicle_access WHERE user_id = ?');
  $st->execute([$user['id']]);
  return (string) ($st->fetchColumn() ?: 'pending');
}

/** Current user row (or null), its status being their standing in Chronicle. Cached per request. */
function current_user(): ?array {
  static $u = false;
  if ($u !== false) return $u;
  // A panel link (api/panel.php) signs the request in as its member instead of the session.
  if (isset($GLOBALS['panel_user'])) return $u = $GLOBALS['panel_user'];
  if (empty($_SESSION['user_id'])) return $u = null;
  $st = db()->prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
  $st->execute([$_SESSION['user_id']]);
  $row = $st->fetch();
  if ($row) $row['status'] = chronicle_status($row);
  return $u = ($row ?: null);
}

function require_login(): array {
  $u = current_user();
  if (!$u) json_error(401, 'not_authenticated', 'Not signed in.');
  return $u;
}
function require_approved(): array {
  $u = require_login();
  if ($u['status'] !== 'approved') json_error(403, 'not_approved', 'Your account is waiting for approval.');
  return $u;
}
function require_admin(): array {
  $u = require_approved();
  if (!(int) $u['is_admin']) json_error(403, 'not_admin', 'Admins only.');
  return $u;
}

function csrf_token(): string {
  return $_SESSION['csrf'] ?? '';
}
/** Mutations must present the session CSRF token in the X-CSRF-Token header. */
function require_csrf(): void {
  $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
  if ($sent === '' || !hash_equals(csrf_token(), $sent)) json_error(403, 'bad_csrf', 'Security token mismatch. Reload the page.');
}

/** Reduce a caller-supplied post-login target to a safe same-origin path. */
function safe_return_path(?string $p): string {
  $home = (string) (parse_url((string) cfg('base_url', ''), PHP_URL_PATH) ?: '') . '/';
  if (!is_string($p) || $p === '') return $home;
  // Only allow a site-relative path; reject anything scheme/host-like.
  // Browsers drop tabs and newlines from a URL, so "/<tab>/evil.com" would become "//evil.com": refuse every
  // control character, then anything that isn't under the app's own path.
  if (preg_match('/[\x00-\x1F\x7F\\\\]/', $p)) return $home;
  if ($p[0] !== '/' || (isset($p[1]) && $p[1] === '/')) return $home;
  if (strncmp($p, $home, strlen($home)) !== 0) return $home;
  return $p;
}

// --- rate limiting (DB-backed fixed window) --------------------------------
/** Best-effort client IP. Uses REMOTE_ADDR only — X-Forwarded-For is spoofable. */
function client_ip(): string {
  $ip = $_SERVER['REMOTE_ADDR'] ?? '';
  return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '0.0.0.0';
}

/** Fixed-window limiter: allow up to $max hits per $windowSec for (bucket,id);
 * on exceed, respond 429 and exit. Fails OPEN on any DB error — a limiter glitch
 * must never lock the whole app out. Toggle off with 'rate_limit_enabled' => false. */
function rate_limit(string $bucket, string $id, int $max, int $windowSec): void {
  if (!cfg('rate_limit_enabled', true)) return;
  $now = time();
  $win = (int) (floor($now / $windowSec) * $windowSec);
  try {
    $pdo = db();
    $pdo->prepare(
      'INSERT INTO rate_limits (bucket, id, window_start, hits) VALUES (:b, :i, :w1, 1)
       ON DUPLICATE KEY UPDATE hits = IF(window_start = :w2, hits + 1, 1), window_start = :w3'
    )->execute([':b' => $bucket, ':i' => $id, ':w1' => $win, ':w2' => $win, ':w3' => $win]);
    $sel = $pdo->prepare('SELECT hits FROM rate_limits WHERE bucket = ? AND id = ? LIMIT 1');
    $sel->execute([$bucket, $id]);
    $hits = (int) $sel->fetchColumn();
    if (random_int(1, 100) === 1) {
      $pdo->prepare('DELETE FROM rate_limits WHERE window_start < ?')->execute([$now - 86400]);
    }
  } catch (Throwable $e) {
    error_log('rate_limit error: ' . $e->getMessage());
    return;   // fail open
  }
  if ($hits > $max) {
    header('Retry-After: ' . $windowSec);
    json_error(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  }
}

// --- sign-in ---------------------------------------------------------------
/**
 * Find or create the user for a verified provider identity
 * ['provider_user_id','email','name','avatar'] and return their id.
 *
 * Order: an existing row for this provider identity; else a pre-OAuth
 * ("legacy") account whose email an admin entered, which this sign-in claims so
 * its campaigns and notes carry over; else a new account, pending approval
 * unless the identity is listed in admin_identities.
 */
function sign_in_identity(string $provider, array $identity): int {
  $pdo = db();
  $admins = array_map('strtolower', (array) cfg('admin_identities', []));
  $isAdmin = in_array(strtolower($identity['email']), $admins, true)
          || in_array(strtolower($provider . ':' . $identity['provider_user_id']), $admins, true);

  $sel = $pdo->prepare('SELECT * FROM users WHERE provider = ? AND provider_user_id = ? LIMIT 1');
  $sel->execute([$provider, $identity['provider_user_id']]);
  $user = $sel->fetch();
  if ($user) {
    $pdo->prepare('UPDATE users SET email = ?, display_name = ?, avatar_url = ?, last_login_at = NOW() WHERE id = ?')
        ->execute([$identity['email'], $identity['name'], $identity['avatar'], $user['id']]);
    // Someone with an account from Sinless asks for Chronicle the first time they sign in here.
    chronicle_access_request((int) $user['id'], $isAdmin || (int) $user['is_admin'], $provider, $identity);
    return (int) $user['id'];
  }

  $legacy = $pdo->prepare("SELECT id FROM users WHERE provider = 'legacy' AND email <> '' AND LOWER(email) = LOWER(?) ORDER BY id LIMIT 1");
  $legacy->execute([$identity['email']]);
  $legacyId = $legacy->fetchColumn();
  if ($legacyId) {
    $pdo->prepare('UPDATE users SET provider = ?, provider_user_id = ?, email = ?,
        display_name = IF(? <> \'\', ?, display_name), avatar_url = ?, last_login_at = NOW()' . ($isAdmin ? ', is_admin = 1, status = \'approved\'' : '') . ' WHERE id = ?')
        ->execute([$provider, $identity['provider_user_id'], $identity['email'],
                   $identity['name'], $identity['name'], $identity['avatar'], $legacyId]);
    // An account from before Google/GitHub sign-in was always a Chronicle account: it keeps the access it had.
    if (has_access_table())
      $pdo->prepare("INSERT IGNORE INTO chronicle_access (user_id, status, approved_at) SELECT id, status, approved_at FROM users WHERE id = ?")->execute([$legacyId]);
    chronicle_access_request((int) $legacyId, $isAdmin, $provider, $identity);
    return (int) $legacyId;
  }

  $status = $isAdmin ? 'approved' : 'pending';
  $pdo->prepare(
    'INSERT INTO users (provider, provider_user_id, email, display_name, avatar_url, status, is_admin, approved_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ' . ($isAdmin ? 'NOW()' : 'NULL') . ', NOW())')
      ->execute([$provider, $identity['provider_user_id'], $identity['email'],
                 $identity['name'], $identity['avatar'], $status, $isAdmin ? 1 : 0]);
  $userId = (int) $pdo->lastInsertId();
  chronicle_access_request($userId, $isAdmin, $provider, $identity, !has_access_table());
  return $userId;
}

/**
 * Make sure user $userId has a say in Chronicle: an admin is approved; anyone else with no chronicle_access row gets a
 * 'pending' one, and the signup alert goes out, naming Campaign Chronicle, so it can't be mistaken for a Sinless
 * request. Someone already approved, waiting or revoked here is left as they are. $alert forces the alert (a brand
 * new account before migration 020, when there is no table to tell by).
 */
function chronicle_access_request(int $userId, bool $isAdmin, string $provider, array $identity, bool $alert = false): void {
  $pdo = db();
  if (has_access_table()) {
    if ($isAdmin) {
      $pdo->prepare("INSERT INTO chronicle_access (user_id, status, approved_at) VALUES (?, 'approved', NOW())
                     ON DUPLICATE KEY UPDATE status = 'approved', approved_at = COALESCE(approved_at, NOW())")->execute([$userId]);
      return;
    }
    $ins = $pdo->prepare("INSERT IGNORE INTO chronicle_access (user_id, status) VALUES (?, 'pending')");
    $ins->execute([$userId]);
    $alert = $ins->rowCount() > 0;
  }
  if ($alert && !$isAdmin) {
    post_signup_webhook(sprintf(
      "🆕 Campaign Chronicle access request\nName: %s\nEmail: %s\nProvider: %s\nApprove it under Users in Campaign Chronicle (not Sinless).",
      $identity['name'] !== '' ? $identity['name'] : '(none)', $identity['email'], $provider));
  }
}

/** Sign-in buttons to show: providers with a client id configured. */
function configured_providers(): array {
  $out = [];
  foreach ((array) cfg('oauth', []) as $name => $conf) {
    if (!empty($conf['client_id'])) $out[] = $name;
  }
  return $out;
}

// --- outbound HTTP (TLS-verified) -----------------------------------------
function http_request(string $method, string $url, array $opts = []): array {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_SSL_VERIFYPEER => true,     // never disable — MITM of the token exchange = full compromise
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_CONNECTTIMEOUT => (int) ($opts['connect_timeout'] ?? 5),
    CURLOPT_TIMEOUT        => (int) ($opts['timeout'] ?? 10),
    CURLOPT_HTTPHEADER     => $opts['headers'] ?? [],
  ]);
  if (isset($opts['post_fields'])) curl_setopt($ch, CURLOPT_POSTFIELDS, $opts['post_fields']);
  if (!empty($opts['compress'])) curl_setopt($ch, CURLOPT_ENCODING, '');   // accept gzip and the like
  $body = curl_exec($ch);
  $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $err = curl_error($ch);
  // No curl_close(): it has done nothing since PHP 8.0 (the handle is freed when $ch goes) and 8.5 deprecates it.
  return ['status' => $status, 'body' => (string) $body, 'error' => $err];
}

/** Email a user that an admin approved ('approved') or removed ('revoked') their
 * access. Off unless 'approval_email' has enabled=true and a 'from'. Never throws;
 * the address is validated and never placed in a header. */
function send_account_email(string $kind, string $toEmail, string $displayName): void {
  $cfg = (array) cfg('approval_email', []);
  if (empty($cfg['enabled']) || empty($cfg['from'])) return;
  $toEmail = trim($toEmail);
  if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) return;

  $from   = (string) $cfg['from'];
  $appUrl = rtrim((string) cfg('base_url', ''), '/') . '/';
  $name   = trim($displayName) !== '' ? trim($displayName) : 'there';

  if ($kind === 'revoked') {
    $subject = (string) ($cfg['revoke_subject'] ?? 'Your Campaign Chronicle access was removed');
    $body = "Hi $name,\n\n"
          . "Your access to Campaign Chronicle has been removed by an administrator. "
          . "Your notes are kept and will be there again if your access is restored.\n";
  } else {
    $subject = (string) ($cfg['subject'] ?? 'Your Campaign Chronicle account is approved');
    $body = "Hi $name,\n\n"
          . "Your Campaign Chronicle account has been approved. Sign in here:\n\n"
          . "  $appUrl\n";
  }

  $envelope = $from;
  if (preg_match('/<([^>]+)>/', $from, $m)) $envelope = $m[1];
  $headers = [
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'From: ' . $from,
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
  ];
  if (!empty($cfg['reply_to'])) $headers[] = 'Reply-To: ' . (string) $cfg['reply_to'];

  try {
    $params = filter_var($envelope, FILTER_VALIDATE_EMAIL) ? '-f' . $envelope : '';
    if (@mail($toEmail, $subject, $body, implode("\r\n", $headers), $params) === false) {
      error_log("account email ($kind): mail() returned false for " . $toEmail);
    }
  } catch (Throwable $e) {
    error_log("account email ($kind) failed: " . $e->getMessage());
  }
}

/** Fire-and-forget signup alert to a Discord/Slack incoming webhook. */
function post_signup_webhook(string $text): void {
  $url = (string) cfg('approval_webhook_url', '');
  if ($url === '') return;
  try {
    http_request('POST', $url, [
      'headers'     => ['Content-Type: application/json'],
      // allowed_mentions: a new user's name could be "@everyone"; Discord pings nobody from this message
      'post_fields' => json_encode(['content' => $text, 'text' => $text, 'allowed_mentions' => ['parse' => []]]),
      'connect_timeout' => 2,
      'timeout'         => 3,
    ]);
  } catch (Throwable $e) {
    error_log('signup webhook failed: ' . $e->getMessage());
  }
}

// --- uploads ---------------------------------------------------------------
/**
 * The folder uploaded pictures and files are kept in: ['dir' => absolute path, or null when it can't be used,
 * 'problem' => why not]. `uploads.path` in config wins; otherwise <parent of web root>/.chronicle-uploads, which on
 * shared hosting is the account home. A folder inside the web root is refused, so an uploaded file can never be
 * fetched, or run, by its own URL: files only go out through api/index.php?a=file, after the access checks.
 */
function upload_dir(): array {
  static $res = null;
  if ($res !== null) return $res;
  $configured = trim((string) (cfg('uploads', [])['path'] ?? ''));
  $dir = $configured;
  $root = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), '/');
  if ($dir === '') {
    $parent = $root !== '' ? dirname($root) : '';
    if ($parent === '' || $parent === '/' || $parent === '.' || !is_dir($parent))
      return $res = ['dir' => null, 'problem' => "set 'uploads' => ['path' => '/absolute/folder/outside/the/web/root'] in the config."];
    $dir = $parent . '/.chronicle-uploads';
  }
  if (!is_dir($dir)) @mkdir($dir, 0700, true);
  if (!is_dir($dir) || !is_writable($dir))
    return $res = ['dir' => null, 'problem' => "the folder $dir doesn't exist or PHP can't write to it. Create it (chmod 700) or set 'uploads' => ['path' => ...] in the config."];
  $real = realpath($dir);
  $realRoot = $root !== '' ? realpath($root) : false;
  if ($realRoot && $real !== $realRoot && strncmp($real . '/', $realRoot . '/', strlen($realRoot) + 1) === 0)
    return $res = ['dir' => null, 'problem' => "the folder $dir is inside the web root, where anyone could fetch it. Pick a folder outside it in 'uploads' => ['path' => ...]."];
  if ($realRoot && $real === $realRoot)
    return $res = ['dir' => null, 'problem' => "the uploads folder can't be the web root. Pick a folder outside it in 'uploads' => ['path' => ...]."];
  // In case the folder is ever served after all: Apache refuses everything in it.
  $ht = $real . '/.htaccess';
  if (!file_exists($ht)) @file_put_contents($ht, "Require all denied\n");
  return $res = ['dir' => $real, 'problem' => ''];
}

/** A php.ini size ("8M", "1G", "512K") in bytes; 0 for none. */
function ini_bytes(string $v): int {
  $v = trim($v);
  if ($v === '') return 0;
  $n = (int) $v;
  return match (strtolower(substr($v, -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
}
/** The largest file one upload may be: the config's uploads.max_mb (10 by default), and never more than PHP's own
 * upload_max_filesize and post_max_size let through. */
function upload_max_bytes(): int {
  $limits = [max(1, (int) (cfg('uploads', [])['max_mb'] ?? 10)) << 20];
  foreach (['upload_max_filesize', 'post_max_size'] as $k) if (($b = ini_bytes((string) ini_get($k))) > 0) $limits[] = $b;
  return min($limits);
}

// Every endpoint runs inside a session.
boot_session();
