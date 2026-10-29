<?php
/**
 * security-check.php — look over a live install for settings that should never be left on in production. Run on the
 * server from the deployed directory (deploy.sh runs it after each pull):
 *
 *   php tools/security-check.php
 *
 * Prints one line per problem and exits 1 when there is any, 0 when all is well. Reads the same config file the app
 * does (CHRONICLE_CONFIG, then ~/chronicle-config.php, then api/config.php). Changes nothing. tools/ is never served
 * (.htaccess), and this refuses to run from the web anyway.
 */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$root = dirname(__DIR__);
$home = rtrim((string)(getenv('HOME') ?: ''), '/');
$candidates = array_values(array_filter([
  (string)(getenv('CHRONICLE_CONFIG') ?: ''),
  dirname($root) . '/chronicle-config.php',          // one level above the site, as lib.php looks when the site is the web root
  $home !== '' ? "$home/chronicle-config.php" : '',
  "$root/api/config.php",
]));
$path = '';
foreach ($candidates as $c) if (is_file($c)) { $path = $c; break; }

$problems = [];
$warn = function (string $msg) use (&$problems) { $problems[] = $msg; };

if ($path === '') {
  $warn('No config file found (looked for ' . implode(', ', $candidates) . ').');
} else {
  $cfg = require $path;
  if (!is_array($cfg)) $cfg = [];
  $real = realpath($path);
  if ($real !== false && str_starts_with($real, realpath($root) . '/'))
    $warn("The config is inside the site's folder ($path). Move it above the web root: mv $path ~/chronicle-config.php");
  if ((fileperms($path) & 0o004) !== 0)
    $warn("The config can be read by every account on the server. Run: chmod 600 $path");
  if (!empty($cfg['debug'])) $warn("'debug' => true sends error details to every visitor. Set it to false.");
  if (!empty($cfg['allow_install'])) $warn("'allow_install' => true leaves install.php open. Set it to false: deploy.sh upgrades the database itself now.");
  if (!empty($cfg['test_login'])) $warn("'test_login' is set: that switch is for the browser tests only. Remove it.");
  if (array_key_exists('rate_limit_enabled', $cfg) && !$cfg['rate_limit_enabled']) $warn("'rate_limit_enabled' => false turns off the sign-in and per-account limits. Set it to true.");
  if (isset($cfg['session']['cookie_secure']) && !$cfg['session']['cookie_secure']) $warn("'cookie_secure' => false lets the sign-in cookie travel over plain http. Set it to true.");
  if (!str_starts_with((string)($cfg['base_url'] ?? ''), 'https://')) $warn("'base_url' doesn't start with https://.");
  if (!empty($cfg['image_search']['stub']) || !empty($cfg['fan_wikis']['stub'])) $warn("An image_search or fan_wikis 'stub' is set: those are for the browser tests only. Remove them.");
  if (empty($cfg['admin_identities'])) $warn("'admin_identities' is empty, so nobody can approve accounts.");
}

// Copies of the config, or of any PHP file, are served as plain text if they end up under the site. .htaccess refuses
// the usual backup names, but a file that isn't needed is best gone.
$it = new RecursiveIteratorIterator(new RecursiveCallbackFilterIterator(
  new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
  fn($f) => !in_array($f->getFilename(), ['.git', 'node_modules'], true)));
foreach ($it as $f) {
  $n = $f->getFilename();
  if (preg_match('/(~|\.(bak|backup|old|orig|save|swp|swo|tmp|dist|zip|tar|gz|tgz|7z|rar|sql))$/i', $n) && !str_starts_with(substr($f->getPathname(), strlen($root) + 1), 'db/'))
    $warn('Leftover file in the site: ' . substr($f->getPathname(), strlen($root) + 1) . '. Delete it.');
  elseif (preg_match('/^(chronicle-)?config\.php/', $n) && $f->getPathname() !== "$root/api/config.php")
    $warn('A copy of the config is in the site: ' . substr($f->getPathname(), strlen($root) + 1) . '. Delete it.');
}

if (!is_file("$root/api/.htaccess") || !is_file("$root/.htaccess")) $warn('An .htaccess file is missing: run git checkout -- .htaccess api/.htaccess');

if ($problems) {
  echo "Security check: " . count($problems) . " thing" . (count($problems) === 1 ? '' : 's') . " to fix\n";
  foreach ($problems as $p) echo "  - $p\n";
  exit(1);
}
echo "Security check: all good\n";
