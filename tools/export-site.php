<?php
/**
 * export-site.php — copy GM's Almanac's data out of its current database into one .sql file, to load into the
 * database of a new site (see docs/DEPLOY.md, "Moving an existing install"). Run on the OLD server from the
 * deployed directory:
 *
 *   php tools/export-site.php              write the copy to ~/gms-almanac-export-<date>.sql
 *   php tools/export-site.php --check      only say what would be copied, and from which database
 *   php tools/export-site.php --all-users  in a database shared with another app, copy every account, not only ours
 *   php tools/export-site.php --out=/path/file.sql
 *
 * Only GM's Almanac's own tables go (the ones db/schema.sql creates), so a database that was once shared with another
 * app (Sinless) leaves that app's tables behind. In such a database the accounts table is shared too: by default the
 * copy keeps only the accounts GM's Almanac knows (any with access here, from before Google/GitHub sign-in, or that
 * anything of ours points to) and leaves accounts only the other app uses. rate_limits goes empty: its counters are
 * minutes old at most. Nothing in the old database is changed.
 *
 * Reads the same config file the app does (CHRONICLE_CONFIG, then ~/chronicle-config.php, then api/config.php).
 * tools/ is never served (.htaccess), and this refuses to run from the web anyway.
 */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$root = dirname(__DIR__);
require "$root/api/upgrade.php";

$checkOnly = false; $allUsers = false; $out = '';
foreach (array_slice($argv, 1) as $a) {
  if ($a === '--check') $checkOnly = true;
  elseif ($a === '--all-users') $allUsers = true;
  elseif (str_starts_with($a, '--out=')) $out = substr($a, 6);
  else { fwrite(STDERR, "Unknown option $a. Use --check, --all-users or --out=/path/file.sql.\n"); exit(1); }
}
$fail = function (string $msg) { fwrite(STDERR, "Export: $msg\n"); exit(1); };

// --- config: the same places lib.php and migrate.php look --------------------
$home = rtrim((string)(getenv('HOME') ?: ''), '/');
$candidates = array_values(array_filter([
  (string)(getenv('CHRONICLE_CONFIG') ?: ''),
  dirname($root) . '/chronicle-config.php',
  $home !== '' ? "$home/chronicle-config.php" : '',
  "$root/api/config.php",
]));
$path = '';
foreach ($candidates as $c) if (is_file($c)) { $path = $c; break; }
if ($path === '') $fail('no config file found (looked for ' . implode(', ', $candidates) . ').');
$cfg = require $path;
if (!is_array($cfg) || !is_array($d = $cfg['db'] ?? null)) $fail("the config file ($path) has no 'db' settings.");

try {
  $pdo = new PDO(sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $d['host'], (int)($d['port'] ?? 3306), $d['name']),
    $d['user'], $d['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
} catch (Throwable $e) {
  $fail("couldn't connect to database {$d['name']} on {$d['host']} as {$d['user']}: " . $e->getMessage());
}

if ($pending = pending_upgrades($pdo, $root))
  $fail('this database still needs an upgrade (' . implode(', ', $pending) . "). Run php tools/migrate.php first, so the copy is complete.");

// --- what's ours, and what isn't ---------------------------------------------
$ours = schema_tables($root);
$present = array_keys(db_tables($pdo, true));
$tables = array_values(array_intersect($ours, $present));
$others = array_values(array_diff($present, $ours));
$shared = (bool) $others;

echo "Database {$d['name']} on {$d['host']}: " . count($tables) . " GM's Almanac tables";
echo $shared ? ', and ' . count($others) . (count($others) === 1 ? ' that belongs' : ' that belong') . ' to something else (' . implode(', ', array_slice($others, 0, 8))
  . (count($others) > 8 ? ', …' : '') . "), which stay behind.\n" : ", nothing else.\n";

// In a shared database, keep the accounts GM's Almanac knows: any with access here, legacy ones, and any that a column
// of ours points to by a foreign key (a GM who has since left still wrote that entry).
$where = '';
if ($shared && !$allUsers) {
  $refs = $pdo->query("SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE
                       WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'users' AND REFERENCED_COLUMN_NAME = 'id'")->fetchAll();
  $parts = ["provider = 'legacy'"];
  foreach ($refs as $r) if (in_array($r['t'], $tables, true))
    $parts[] = 'id IN (SELECT `' . str_replace('`', '', $r['c']) . '` FROM `' . str_replace('`', '', $r['t']) . '`)';
  $where = implode(' OR ', array_unique($parts));
  $keep = (int) $pdo->query("SELECT COUNT(*) FROM users WHERE $where")->fetchColumn();
  $all = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
  echo "Accounts: $keep of $all are GM's Almanac's and go; " . ($all - $keep) . " only the other app knows stay behind (--all-users copies them too).\n";
} else {
  echo 'Accounts: all ' . (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() . " go.\n";
}
if ($checkOnly) exit(0);

// --- dump ----------------------------------------------------------------------
$file = $out !== '' ? $out : ($home !== '' ? "$home/gms-almanac-export-" . date('Ymd-His') . '.sql' : '');
if ($file === '') $fail('nowhere to put the copy: set HOME, or pass --out=/path/file.sql.');
$dir = realpath(dirname($file));
if ($dir === false) $fail('the folder ' . dirname($file) . " doesn't exist.");
$file = $dir . '/' . basename($file);
if (str_starts_with($file, realpath($root) . '/')) $fail("$file is inside the site, where it could be downloaded. Put it outside.");

// The password goes in an option file only this account can read, never on the command line where `ps` shows it.
$opt = tempnam($dir, '.my-');
chmod($opt, 0600);
$q = fn($v) => '"' . addcslashes((string)$v, "\\\"") . '"';
file_put_contents($opt, "[client]\nhost=" . $q($d['host']) . "\nport=" . (int)($d['port'] ?? 3306)
  . "\nuser=" . $q($d['user']) . "\npassword=" . $q($d['password']) . "\n");
$base = 'mysqldump --defaults-extra-file=' . escapeshellarg($opt)
  . ' --single-transaction --skip-lock-tables --no-tablespaces --default-character-set=utf8mb4 --set-gtid-purged=OFF ';
$db = escapeshellarg((string) $d['name']);
$rest = array_values(array_diff($tables, ['users', 'rate_limits']));
$runs = [
  // users first, so the rest can point to it; filtered when the database is shared
  $base . ($where !== '' ? '--where=' . escapeshellarg($where) . ' ' : '') . "$db users",
  $base . "--no-data $db rate_limits",
  $base . $db . ' ' . implode(' ', array_map('escapeshellarg', $rest)),
];
$old = umask(0077);
file_put_contents($file, "-- GM's Almanac export from {$d['name']}, " . date('c') . "\n-- Load it into an EMPTY database: mysql <new database> < this file\n");
$ok = true; $msgs = [];
foreach ($runs as $cmd) {
  $res = [];
  exec("$cmd 2>&1 >> " . escapeshellarg($file), $res, $status);
  // Old mysqldump builds don't know --set-gtid-purged: try once more without it.
  if ($status !== 0 && preg_grep('/set-gtid-purged/', $res)) {
    $res = [];
    exec(str_replace(' --set-gtid-purged=OFF', '', $cmd) . ' 2>&1 >> ' . escapeshellarg($file), $res, $status);
  }
  if ($status !== 0) { $ok = false; $msgs = array_merge($msgs, $res ?: ["mysqldump exited with $status"]); break; }
}
umask($old);
unlink($opt);
if (!$ok) { @unlink($file); $fail("the copy failed, so nothing was written.\n  " . implode("\n  ", $msgs)); }
chmod($file, 0600);
printf("Export: wrote %s (%.1f MB). Only your account can read it.\n", $file, filesize($file) / 1048576);
echo "Next: copy it and the uploads folder to the new server, then: mysql <new database> < " . basename($file) . "\n";
