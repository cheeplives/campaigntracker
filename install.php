<?php
/**
 * One-time installer: creates tables and the first admin account.
 * After it succeeds, set 'allow_install' => false in lib/config.php (or delete this file).
 */
declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';
security_headers();
header('Content-Type: text/html; charset=utf-8');

function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
$msg = ''; $ok = false;

if (!cfg('allow_install')) {
    $msg = "Installer is disabled. Set 'allow_install' => true in lib/config.php to run it again.";
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        $pdo = db();
        $sql = file_get_contents(__DIR__ . '/lib/schema.sql');
        foreach (array_filter(array_map('trim', preg_split('/;\s*\n/', $sql))) as $stmt) {
            if (preg_match('/^\s*(--.*\n\s*)*$/', $stmt)) continue;
            $pdo->exec($stmt);
        }
        $count = (int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
        if ($count === 0) {
            $u = trim($_POST['username'] ?? '');
            $pw = $_POST['password'] ?? '';
            if (!preg_match('/^[A-Za-z0-9_.\-]{2,64}$/', $u)) throw new RuntimeException('Username: 2–64 letters, numbers, _ . -');
            if (strlen($pw) < 8) throw new RuntimeException('Password must be at least 8 characters.');
            $pdo->prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?,?,?,1)')
                ->execute([$u, trim($_POST['display_name'] ?? '') ?: $u, password_hash($pw, PASSWORD_DEFAULT)]);
            $msg = 'Tables created and admin account added.';
        } else {
            $msg = 'Tables are up to date. Users already exist, so no admin account was added.';
        }
        $ok = true;
    } catch (Throwable $e) {
        $msg = 'Install failed: ' . $e->getMessage();
    }
}
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install — Campaign Tracker</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;background:#1b1a17;color:#eee}
input,button{font:inherit;padding:8px;width:100%;box-sizing:border-box;margin:4px 0 12px;border-radius:6px;border:1px solid #555;background:#2a2824;color:#eee}
button{background:#b8860b;border:0;color:#111;font-weight:600;cursor:pointer}.msg{padding:10px;border-radius:6px;background:#333}a{color:#e0b450}</style></head>
<body><h1>Campaign Tracker setup</h1>
<?php if ($msg): ?><p class="msg"><?= h($msg) ?></p><?php endif; ?>
<?php if ($ok): ?>
  <p><strong>Next:</strong> open <code>lib/config.php</code> and set <code>'allow_install' => false</code>, then <a href="./">open the tracker</a>.</p>
<?php elseif (cfg('allow_install')): ?>
<form method="post">
  <p>This creates the database tables and your admin (GM) account.</p>
  <label>Admin username<input name="username" required pattern="[A-Za-z0-9_.\-]{2,64}"></label>
  <label>Display name<input name="display_name"></label>
  <label>Password (8+ characters)<input name="password" type="password" required minlength="8"></label>
  <button>Install</button>
</form>
<?php endif; ?>
</body></html>
