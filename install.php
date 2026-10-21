<?php
/**
 * Installer: creates the tables on a fresh database, or upgrades an older install
 * by running the files in db/migrations/ it still needs.
 * There is no admin to create here: list your email in admin_identities in the
 * config and your first sign-in is approved as admin.
 * After it succeeds, set 'allow_install' => false in the config (or delete this file).
 */
declare(strict_types=1);
const CHRONICLE_INSTALLER = true;   // lib.php shows setup problems as a readable page
require __DIR__ . '/api/lib.php';
header('Content-Type: text/html; charset=utf-8');

function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

/** Run a .sql file statement by statement, skipping comment-only chunks. */
function run_sql_file(PDO $pdo, string $file): void {
    $sql = file_get_contents($file);
    foreach (array_filter(array_map('trim', preg_split('/;\s*\n/', $sql))) as $stmt) {
        if (preg_match('/^\s*(--.*\n\s*)*(--.*)?$/', $stmt)) continue;
        $pdo->exec($stmt);
    }
}

/** Once someone has signed in as a site admin, only a signed-in site admin may run the installer, so leaving
 * allow_install on doesn't let a stranger start an upgrade. Before that (a fresh database, or one from before
 * Google/GitHub sign-in, where nobody can sign in yet) it stays open, as allow_install is all there is. */
function installer_locked(): bool {
    $pdo = db();
    if (!$pdo->query("SHOW TABLES LIKE 'users'")->fetchColumn()) return false;
    if (!$pdo->query("SHOW COLUMNS FROM users LIKE 'provider'")->fetchColumn()) return false;
    if (!$pdo->query("SELECT 1 FROM users WHERE is_admin=1 AND status='approved' AND provider<>'legacy' LIMIT 1")->fetchColumn()) return false;
    $u = current_user();
    return !$u || !(int)$u['is_admin'] || $u['status'] !== 'approved';
}

$msg = ''; $ok = false; $locked = false;
if (!cfg('allow_install')) {
    $msg = "The installer is turned off. Set 'allow_install' => true in the config to run it again.";
} elseif ($locked = installer_locked()) {
    $msg = 'Sign in to Campaign Chronicle as a site admin, then open this page again.';
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        if (!hash_equals(csrf_token(), (string)($_POST['csrf'] ?? ''))) throw new RuntimeException('Security token mismatch. Reload the page.');
        $pdo = db();
        $hasUsers = (bool)$pdo->query("SHOW TABLES LIKE 'users'")->fetchColumn();
        $oldUsers = $hasUsers && (bool)$pdo->query("SHOW COLUMNS FROM users LIKE 'password_hash'")->fetchColumn();
        if ($oldUsers) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/001_oauth_signin.sql');
            $msg = 'Upgraded to Google/GitHub sign-in. Existing accounts kept their campaigns. '
                 . 'Sign in, then enter each player\'s email under Users so their first sign-in takes over their old account.';
        } else {
            run_sql_file($pdo, __DIR__ . '/db/schema.sql');
            $msg = 'Tables are ready.';
        }
        // Event shift ranges and tags. schema.sql already made the new tables,
        // so on an older install this only adds the events.shift_end column.
        if (!$pdo->query("SHOW COLUMNS FROM events LIKE 'shift_end'")->fetchColumn()) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/002_event_shifts_tags.sql');
            $msg .= ' Events now have Shift Start/End and tags; existing events are unchanged.';
        }
        // schema.sql only creates missing tables, so columns added later come from their migration.
        if (!$pdo->query("SHOW COLUMNS FROM campaign_members LIKE 'character_name'")->fetchColumn()) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/003_shift_notes_characters.sql');
            $msg .= ' Added character names and shift notes.';
        }
        if (!$pdo->query("SHOW COLUMNS FROM days LIKE 'locations'")->fetchColumn()) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/004_day_locations.sql');
            $msg .= ' Days now have a Locations visited box.';
        }
        if (!$pdo->query("SHOW TABLES LIKE 'downtimes'")->fetchColumn()) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/005_downtime.sql');
            $msg .= ' Added the Downtime tab.';
        }
        if (!$pdo->query("SHOW TABLES LIKE 'holdings'")->fetchColumn()) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/006_party_holdings.sql');
            $msg .= ' Added the Party Holdings tab.';
        }
        if (!$pdo->query("SHOW TABLES LIKE 'reminder_dismissals'")->fetchColumn()) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/007_reminders.sql');
            $msg .= ' Added calendar reminders.';
        }
        if (!$pdo->query("SHOW TABLES LIKE 'party_funds'")->fetchColumn()) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/008_party_funds.sql');
            $msg .= ' Added Party Funds.';
        }
        if (!$pdo->query("SHOW COLUMNS FROM party_funds LIKE 'location'")->fetchColumn()) {
            run_sql_file($pdo, __DIR__ . '/db/migrations/009_party_funds_location.sql');
            $msg .= ' Party Funds now have a Location.';
        }
        $ok = true;
    } catch (Throwable $e) {
        $msg = 'Install failed: ' . $e->getMessage();
    }
}
$admins = (array)cfg('admin_identities', []);
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install — Campaign Chronicle</title>
<link rel="icon" href="static/icons/favicon.svg" type="image/svg+xml"><link rel="icon" href="favicon.ico" sizes="48x48">
<link rel="stylesheet" href="static/fonts.css"><link rel="stylesheet" href="static/style.css"></head>
<body><main><div class="card narrow">
<h1>Campaign Chronicle setup</h1>
<?php if ($msg): ?><p class="result"><?= h($msg) ?></p><?php endif; ?>
<?php if ($ok): ?>
  <p><strong>Next:</strong> set <code>'allow_install' => false</code> in the config, then <a href="./">open Campaign Chronicle</a> and sign in.</p>
<?php elseif (cfg('allow_install') && !$locked): ?>
<form method="post">
  <p>This creates the database tables, or upgrades an older install that used usernames and passwords. Back up the database before upgrading.</p>
  <?php if (!$admins): ?><p class="bad">No admin_identities are set in the config, so nobody will be able to approve accounts. Add your email there first.</p><?php endif; ?>
  <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
  <button class="primary">Install or upgrade</button>
</form>
<?php endif; ?>
</div></main></body></html>
