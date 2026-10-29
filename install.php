<?php
/**
 * Installer: creates the tables on a fresh database, or upgrades an older install
 * by running the files in db/migrations/ it still needs.
 * There is no admin to create here: list your email in admin_identities in the
 * config and your first sign-in is approved as admin.
 * After it succeeds, set 'allow_install' => false in the config (or delete this file).
 * Upgrades after a deploy don't need this page: deploy.sh runs tools/migrate.php, which does the same from the
 * command line (the steps themselves are in api/upgrade.php).
 */
declare(strict_types=1);
const CHRONICLE_INSTALLER = true;   // lib.php shows setup problems as a readable page
require __DIR__ . '/api/lib.php';
require __DIR__ . '/api/upgrade.php';
header('Content-Type: text/html; charset=utf-8');

function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

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
    $msg = "The installer is turned off. To upgrade the database, run php tools/migrate.php on the server (deploy.sh does it for you). "
         . "To use this page instead, set 'allow_install' => true in the config.";
} elseif ($locked = installer_locked()) {
    $msg = 'Sign in to Campaign Chronicle as a site admin, then open this page again.';
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        if (!hash_equals(csrf_token(), (string)($_POST['csrf'] ?? ''))) throw new RuntimeException('Security token mismatch. Reload the page.');
        $done = upgrade_database(db(), __DIR__);
        $msg = $done ? implode(' ', $done) : 'The database is already up to date.';
        // Where uploads are kept: say so now if the folder can't be used, rather than at the first upload.
        $up = upload_dir();
        $msg .= $up['dir'] ? '' : ' Pictures and files can\'t be uploaded yet: ' . $up['problem'];
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
