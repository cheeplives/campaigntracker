<?php
/**
 * migrate.php — bring the database up to date from the command line, so an upgrade never needs install.php (or
 * allow_install) turned on. Run on the server from the deployed directory; deploy.sh runs it after each pull:
 *
 *   php tools/migrate.php              back up the database, then run whatever is pending
 *   php tools/migrate.php --check      only say what is pending (exit 0 when nothing is, 2 when something is)
 *   php tools/migrate.php --no-backup  skip the backup (when mysqldump isn't available, say)
 *
 * The steps are the ones install.php runs (api/upgrade.php), and each checks the database before it changes it, so
 * running this when nothing is pending does nothing. Before changing anything it saves a copy of the database with
 * mysqldump to ~/chronicle-backups (or the config's 'backups' => ['path' => ...]), outside the site, keeping the
 * last 5, and stops if that copy can't be made.
 *
 * Reads the same config file the app does (CHRONICLE_CONFIG, then ~/chronicle-config.php, then api/config.php).
 * tools/ is never served (.htaccess), and this refuses to run from the web anyway.
 */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$root = dirname(__DIR__);
require "$root/api/upgrade.php";

$args = array_slice($argv, 1);
foreach ($args as $a) if (!in_array($a, ['--check', '--no-backup'], true)) {
  fwrite(STDERR, "Unknown option $a. Use --check or --no-backup.\n");
  exit(1);
}
$checkOnly = in_array('--check', $args, true);
$noBackup = in_array('--no-backup', $args, true);
$fail = function (string $msg) { fwrite(STDERR, "Database upgrade: $msg\n"); exit(1); };

// --- config: the same places lib.php and security-check.php look ------------
$home = rtrim((string)(getenv('HOME') ?: ''), '/');
$candidates = array_values(array_filter([
  (string)(getenv('CHRONICLE_CONFIG') ?: ''),
  dirname($root) . '/chronicle-config.php',          // one level above the site, as lib.php looks when the site is the web root
  $home !== '' ? "$home/chronicle-config.php" : '',
  "$root/api/config.php",
]));
$path = '';
foreach ($candidates as $c) if (is_file($c)) { $path = $c; break; }
if ($path === '') $fail('no config file found (looked for ' . implode(', ', $candidates) . ').');
$cfg = require $path;
if (!is_array($cfg)) $fail("the config file ($path) doesn't return a settings array.");
$d = $cfg['db'] ?? null;
if (!is_array($d) && isset($cfg['db_host']))   // a config in the old format, as lib.php accepts
  $d = ['host' => $cfg['db_host'], 'port' => (int)($cfg['db_port'] ?? 3306), 'name' => $cfg['db_name'] ?? '',
        'user' => $cfg['db_user'] ?? '', 'password' => $cfg['db_pass'] ?? ''];
if (!is_array($d)) $fail("the config file ($path) has no 'db' settings.");

try {
  $pdo = new PDO(sprintf('mysql:host=%s;port=%d;dbname=%s;charset=%s', $d['host'], (int)($d['port'] ?? 3306), $d['name'], $d['charset'] ?? 'utf8mb4'),
    $d['user'], $d['password'], [
      PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
      PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
      PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
} catch (Throwable $e) {
  $fail("couldn't connect to database {$d['name']} on {$d['host']} as {$d['user']}: " . $e->getMessage());
}

// --- what's pending ----------------------------------------------------------
$pending = pending_upgrades($pdo, $root);
if (!$pending) { echo "Database: up to date\n"; exit(0); }
echo 'Database: to run: ' . implode(', ', $pending) . "\n";
if ($checkOnly) exit(2);

// --- back up first -----------------------------------------------------------
if ($noBackup) {
  echo "Database: skipping the backup (--no-backup)\n";
} else {
  $dir = rtrim(trim((string)($cfg['backups']['path'] ?? '')) ?: ($home !== '' ? "$home/chronicle-backups" : ''), '/');
  if ($dir === '') $fail("nowhere to put the backup: set HOME, or 'backups' => ['path' => ...] in the config. Or run with --no-backup.");
  if (!is_dir($dir) && !@mkdir($dir, 0700, true)) $fail("can't create the backup folder $dir.");
  @chmod($dir, 0700);
  $realDir = realpath($dir);
  if ($realDir === false || str_starts_with($realDir . '/', realpath($root) . '/'))
    $fail("the backup folder $dir is inside the site, where it could be downloaded. Set 'backups' => ['path' => ...] outside it.");

  // The password goes in an option file only this account can read, never on the command line where `ps` shows it.
  $opt = tempnam($realDir, '.my-');
  chmod($opt, 0600);
  $q = fn($v) => '"' . addcslashes((string)$v, "\\\"") . '"';
  file_put_contents($opt, "[client]\nhost=" . $q($d['host']) . "\nport=" . (int)($d['port'] ?? 3306)
    . "\nuser=" . $q($d['user']) . "\npassword=" . $q($d['password']) . "\n");
  $file = "$realDir/chronicle-" . date('Ymd-His') . '.sql';
  $cmd = 'mysqldump --defaults-extra-file=' . escapeshellarg($opt)
    . ' --single-transaction --no-tablespaces --routines --default-character-set=utf8mb4'
    . ' --result-file=' . escapeshellarg($file) . ' ' . escapeshellarg((string)$d['name']) . ' 2>&1';
  $old = umask(0077);
  exec($cmd, $out, $status);
  umask($old);
  unlink($opt);
  if ($status !== 0 || !is_file($file) || filesize($file) === 0) {
    @unlink($file);
    $fail("the backup failed, so nothing was changed.\n  " . (implode("\n  ", $out) ?: "mysqldump exited with $status")
      . "\n  Back up another way, then run: php tools/migrate.php --no-backup");
  }
  chmod($file, 0600);
  echo "Database: backed up to $file\n";
  $old = glob("$realDir/chronicle-*.sql") ?: [];
  sort($old);
  foreach (array_slice($old, 0, max(0, count($old) - 5)) as $f) @unlink($f);
}

// --- upgrade -----------------------------------------------------------------
try {
  $done = upgrade_database($pdo, $root);
} catch (Throwable $e) {
  $fail($e->getMessage() . "\n  The steps before it are done; fix the problem and run php tools/migrate.php again.");
}
foreach ($done as $line) echo "  - $line\n";
echo "Database: up to date\n";
