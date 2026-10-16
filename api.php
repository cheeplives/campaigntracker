<?php
/**
 * RPG Campaign Tracker — JSON API.
 * Every request: api.php?a=<action>[&cid=<campaign id>...]
 * POST bodies are JSON and must carry the X-CSRF-Token header.
 * All permission checks (GM vs player, secret filtering) happen here, never only in the browser.
 */
declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

security_headers();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
start_session();

// ---------- helpers ----------
function out($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $msg, int $code = 400): void { out(['error' => $msg], $code); }

function body(): array {
    static $b = null;
    if ($b === null) {
        $raw = file_get_contents('php://input') ?: '';
        if (strlen($raw) > 2_000_000) fail('Request too large', 413);
        $b = $raw === '' ? [] : json_decode($raw, true);
        if (!is_array($b)) fail('Invalid JSON body');
    }
    return $b;
}
function p(string $k, $default = null) { $b = body(); return array_key_exists($k, $b) ? $b[$k] : $default; }
function str_in($v, int $max, bool $allowNull = true): ?string {
    if ($v === null || $v === '') return $allowNull ? null : '';
    if (!is_string($v) && !is_numeric($v)) fail('Expected text');
    $v = (string)$v;
    if (mb_strlen($v) > $max) fail("Text too long (max $max characters)");
    return $v;
}
function int_in($v, ?int $min = null, ?int $max = null): int {
    if (!is_numeric($v)) fail('Expected a number');
    $i = (int)$v;
    if (($min !== null && $i < $min) || ($max !== null && $i > $max)) fail('Number out of range');
    return $i;
}
function json_in($v, int $max = 200_000): string {
    if (!is_array($v)) fail('Expected an object');
    $s = $v === [] ? '{}' : json_encode($v, JSON_UNESCAPED_UNICODE);
    if (strlen($s) > $max) fail('Data too large');
    return $s;
}
function dec(?string $s) { return $s === null || $s === '' ? null : json_decode($s, true); }

function me(): ?array {
    static $u = false;
    if ($u === false) {
        $u = null;
        if (!empty($_SESSION['uid'])) {
            $st = db()->prepare('SELECT id, username, display_name, is_admin FROM users WHERE id=?');
            $st->execute([$_SESSION['uid']]);
            $u = $st->fetch() ?: null;
            if ($u) { $u['id'] = (int)$u['id']; $u['is_admin'] = (bool)$u['is_admin']; }
        }
    }
    return $u;
}
function need_login(): array { $u = me(); if (!$u) fail('Not logged in', 401); return $u; }
function need_admin(): array { $u = need_login(); if (!$u['is_admin']) fail('Admins only', 403); return $u; }

/** Returns 'gm' | 'player' for the current user in campaign $cid, or fails. Site admins are GMs everywhere. */
function role(int $cid): string {
    static $cache = [];
    if (isset($cache[$cid])) return $cache[$cid];
    $u = need_login();
    $st = db()->prepare('SELECT id FROM campaigns WHERE id=?');
    $st->execute([$cid]);
    if (!$st->fetch()) fail('Campaign not found', 404);
    if ($u['is_admin']) return $cache[$cid] = 'gm';
    $st = db()->prepare('SELECT role FROM campaign_members WHERE campaign_id=? AND user_id=?');
    $st->execute([$cid, $u['id']]);
    $r = $st->fetchColumn();
    if (!$r) fail('You are not a member of this campaign', 403);
    return $cache[$cid] = $r;
}
function need_gm(int $cid): void { if (role($cid) !== 'gm') fail('Only the GM can do that', 403); }
function cid(): int { $c = $_GET['cid'] ?? p('cid'); if ($c === null) fail('Missing campaign id'); return int_in($c, 1); }

function campaign_row(int $cid): array {
    $st = db()->prepare('SELECT * FROM campaigns WHERE id=?');
    $st->execute([$cid]);
    $c = $st->fetch();
    if (!$c) fail('Campaign not found', 404);
    return $c;
}
function campaign_settings(int $cid): array { return dec(campaign_row($cid)['settings_json']) ?: []; }
function floordiv4(int $n): int { return (int)floor($n / 4); }

// ---------- routing ----------
$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$publicActions = ['me', 'login'];

if ($method === 'POST') {
    $tok = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!hash_equals($_SESSION['csrf'], $tok)) fail('Security token mismatch — reload the page', 419);
} elseif ($method !== 'GET') {
    fail('Method not allowed', 405);
}

$readActions = ['me', 'campaigns', 'campaign', 'days', 'day', 'users'];
if ($method === 'GET' && !in_array($action, $readActions, true)) fail('Use POST for this action', 405);
if ($method === 'POST' && in_array($action, $readActions, true) && $action !== 'me') fail('Use GET for this action', 405);

try {
    switch ($action) {

    // ===== auth =====
    case 'me':
        out(['user' => me(), 'csrf' => $_SESSION['csrf']]);

    case 'login':
        $now = time();
        $_SESSION['fails'] = array_values(array_filter($_SESSION['fails'] ?? [], fn($t) => $t > $now - 600));
        if (count($_SESSION['fails']) >= 8) fail('Too many attempts. Wait 10 minutes.', 429);
        $st = db()->prepare('SELECT id, password_hash FROM users WHERE username=?');
        $st->execute([str_in(p('username'), 64, false)]);
        $row = $st->fetch();
        if (!$row || !password_verify((string)p('password', ''), $row['password_hash'])) {
            $_SESSION['fails'][] = $now;
            usleep(600000);
            fail('Wrong username or password', 401);
        }
        session_regenerate_id(true);
        $_SESSION['uid'] = (int)$row['id'];
        $_SESSION['fails'] = [];
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        out(['user' => me(), 'csrf' => $_SESSION['csrf']]);

    case 'logout':
        $_SESSION = [];
        session_destroy();
        out(['ok' => true]);

    case 'password':
        $u = need_login();
        $st = db()->prepare('SELECT password_hash FROM users WHERE id=?');
        $st->execute([$u['id']]);
        if (!password_verify((string)p('current', ''), (string)$st->fetchColumn())) fail('Current password is wrong', 403);
        $new = (string)p('new', '');
        if (strlen($new) < 8) fail('New password must be at least 8 characters');
        db()->prepare('UPDATE users SET password_hash=? WHERE id=?')->execute([password_hash($new, PASSWORD_DEFAULT), $u['id']]);
        out(['ok' => true]);

    // ===== user admin =====
    case 'users':
        need_admin();
        out(['users' => db()->query('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY username')->fetchAll()]);

    case 'user_save':
        $admin = need_admin();
        $id = p('id') ? int_in(p('id'), 1) : null;
        $username = trim((string)str_in(p('username'), 64, false));
        $display = trim((string)str_in(p('display_name'), 100, false)) ?: $username;
        $isAdmin = p('is_admin') ? 1 : 0;
        $pw = (string)p('password', '');
        if (!preg_match('/^[A-Za-z0-9_.\-]{2,64}$/', $username)) fail('Username: 2–64 letters, numbers, _ . -');
        if ($pw !== '' && strlen($pw) < 8) fail('Password must be at least 8 characters');
        if ($id) {
            if ($id === $admin['id'] && !$isAdmin) fail("You can't remove your own admin rights");
            db()->prepare('UPDATE users SET username=?, display_name=?, is_admin=? WHERE id=?')->execute([$username, $display, $isAdmin, $id]);
            if ($pw !== '') db()->prepare('UPDATE users SET password_hash=? WHERE id=?')->execute([password_hash($pw, PASSWORD_DEFAULT), $id]);
        } else {
            if ($pw === '') fail('Password required for a new user');
            db()->prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?,?,?,?)')
                ->execute([$username, $display, password_hash($pw, PASSWORD_DEFAULT), $isAdmin]);
            $id = (int)db()->lastInsertId();
        }
        out(['ok' => true, 'id' => $id]);

    case 'user_delete':
        $admin = need_admin();
        $id = int_in(p('id'), 1);
        if ($id === $admin['id']) fail("You can't delete yourself");
        db()->prepare('DELETE FROM users WHERE id=?')->execute([$id]);
        out(['ok' => true]);

    // ===== campaigns =====
    case 'campaigns':
        $u = need_login();
        if ($u['is_admin']) {
            $rows = db()->query("SELECT id, name, description, 'gm' AS role FROM campaigns ORDER BY name")->fetchAll();
        } else {
            $st = db()->prepare('SELECT c.id, c.name, c.description, m.role FROM campaigns c JOIN campaign_members m ON m.campaign_id=c.id WHERE m.user_id=? ORDER BY c.name');
            $st->execute([$u['id']]);
            $rows = $st->fetchAll();
        }
        out(['campaigns' => $rows]);

    case 'campaign':
        $cid = cid();
        $role = role($cid);
        $c = campaign_row($cid);
        $isGm = $role === 'gm';
        $camp = [
            'id' => (int)$c['id'], 'name' => $c['name'], 'description' => $c['description'],
            'calendar' => dec($c['calendar_json']), 'settings' => (object)(dec($c['settings_json']) ?: []),
            'current_shift' => (int)$c['current_shift'], 'seed' => (int)$c['seed'],
        ];
        $st = db()->prepare('SELECT id, name, settings_json, description FROM regions WHERE campaign_id=? ORDER BY name');
        $st->execute([$cid]);
        $regions = array_map(fn($r) => ['id' => (int)$r['id'], 'name' => $r['name'], 'settings' => (object)(dec($r['settings_json']) ?: []), 'description' => $r['description']], $st->fetchAll());
        $st = db()->prepare('SELECT id, name, rule_json, description, color, is_secret FROM holidays WHERE campaign_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY name');
        $st->execute([$cid]);
        $holidays = array_map(fn($h) => ['id' => (int)$h['id'], 'name' => $h['name'], 'rule' => dec($h['rule_json']), 'description' => $h['description'], 'color' => $h['color'], 'is_secret' => (bool)$h['is_secret']], $st->fetchAll());
        $members = [];
        $st = db()->prepare('SELECT u.id, u.username, u.display_name, m.role FROM campaign_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=? ORDER BY m.role, u.display_name');
        $st->execute([$cid]);
        $members = $st->fetchAll();
        if (!$isGm) $members = array_map(fn($m) => ['id' => $m['id'], 'display_name' => $m['display_name'], 'role' => $m['role']], $members);
        out(['campaign' => $camp, 'role' => $role, 'regions' => $regions, 'holidays' => $holidays, 'members' => $members]);

    case 'campaign_create':
        $u = need_login();
        $name = trim((string)str_in(p('name'), 150, false));
        if ($name === '') fail('Name required');
        $cal = json_in(p('calendar'));
        $settings = json_in(p('settings') ?: []);
        $pdo = db();
        $pdo->beginTransaction();
        $pdo->prepare('INSERT INTO campaigns (name, description, calendar_json, settings_json, current_shift, seed, created_by) VALUES (?,?,?,?,?,?,?)')
            ->execute([$name, str_in(p('description'), 5000), $cal, $settings, int_in(p('current_shift', 0)), random_int(1, 2_000_000_000), $u['id']]);
        $cid = (int)$pdo->lastInsertId();
        $pdo->prepare("INSERT INTO campaign_members (campaign_id, user_id, role) VALUES (?,?,'gm')")->execute([$cid, $u['id']]);
        foreach ((array)p('regions', []) as $r) {
            $pdo->prepare('INSERT INTO regions (campaign_id, name, settings_json, description) VALUES (?,?,?,?)')
                ->execute([$cid, str_in($r['name'] ?? 'Region', 150, false), json_in($r['settings'] ?? []), str_in($r['description'] ?? null, 5000)]);
            if (!empty($r['current'])) {
                $rid = (int)$pdo->lastInsertId();
                $s = dec($settings) ?: [];
                $s['current_region'] = $rid;
                $pdo->prepare('UPDATE campaigns SET settings_json=? WHERE id=?')->execute([json_in($s), $cid]);
            }
        }
        foreach ((array)p('holidays', []) as $h) {
            $pdo->prepare('INSERT INTO holidays (campaign_id, name, rule_json, description, color, is_secret) VALUES (?,?,?,?,?,?)')
                ->execute([$cid, str_in($h['name'] ?? 'Holiday', 150, false), json_in($h['rule'] ?? []), str_in($h['description'] ?? null, 5000), str_in($h['color'] ?? '#b8860b', 16, false), !empty($h['is_secret']) ? 1 : 0]);
        }
        $pdo->commit();
        out(['ok' => true, 'id' => $cid]);

    case 'campaign_update':
        $cid = cid(); need_gm($cid);
        $c = campaign_row($cid);
        $name = p('name') !== null ? trim((string)str_in(p('name'), 150, false)) : $c['name'];
        if ($name === '') fail('Name required');
        $desc = p('description', $c['description']);
        $cal = p('calendar') !== null ? json_in(p('calendar')) : $c['calendar_json'];
        $settings = p('settings') !== null ? json_in(p('settings')) : $c['settings_json'];
        db()->prepare('UPDATE campaigns SET name=?, description=?, calendar_json=?, settings_json=? WHERE id=?')
            ->execute([$name, str_in($desc, 5000), $cal, $settings, $cid]);
        out(['ok' => true]);

    case 'campaign_delete':
        $cid = cid(); need_gm($cid);
        if (p('confirm') !== 'DELETE') fail('Confirmation missing');
        db()->prepare('DELETE FROM campaigns WHERE id=?')->execute([$cid]);
        out(['ok' => true]);

    case 'set_time':
        $cid = cid(); need_gm($cid);
        $shift = int_in(p('current_shift'));
        db()->prepare('UPDATE campaigns SET current_shift=? WHERE id=?')->execute([$shift, $cid]);
        out(['ok' => true, 'current_shift' => $shift]);

    // ===== members =====
    case 'member_add':
        $cid = cid(); need_gm($cid);
        $st = db()->prepare('SELECT id FROM users WHERE username=?');
        $st->execute([str_in(p('username'), 64, false)]);
        $uid = $st->fetchColumn();
        if (!$uid) fail('No user with that username. Ask the site admin to create the account first.', 404);
        $role = p('role') === 'gm' ? 'gm' : 'player';
        db()->prepare('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES (?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)')->execute([$cid, $uid, $role]);
        out(['ok' => true]);

    case 'member_remove':
        $cid = cid(); need_gm($cid);
        $uid = int_in(p('user_id'), 1);
        $st = db()->prepare("SELECT COUNT(*) FROM campaign_members WHERE campaign_id=? AND role='gm' AND user_id<>?");
        $st->execute([$cid, $uid]);
        $isGmTarget = db()->prepare("SELECT role FROM campaign_members WHERE campaign_id=? AND user_id=?");
        $isGmTarget->execute([$cid, $uid]);
        if ($isGmTarget->fetchColumn() === 'gm' && (int)$st->fetchColumn() === 0) fail('A campaign needs at least one GM');
        db()->prepare('DELETE FROM campaign_members WHERE campaign_id=? AND user_id=?')->execute([$cid, $uid]);
        out(['ok' => true]);

    // ===== regions =====
    case 'region_save':
        $cid = cid(); need_gm($cid);
        $id = p('id') ? int_in(p('id'), 1) : null;
        $args = [str_in(p('name'), 150, false), json_in(p('settings', [])), str_in(p('description'), 5000)];
        if ($id) {
            db()->prepare('UPDATE regions SET name=?, settings_json=?, description=? WHERE id=? AND campaign_id=?')->execute([...$args, $id, $cid]);
        } else {
            db()->prepare('INSERT INTO regions (name, settings_json, description, campaign_id) VALUES (?,?,?,?)')->execute([...$args, $cid]);
            $id = (int)db()->lastInsertId();
        }
        out(['ok' => true, 'id' => $id]);

    case 'region_delete':
        $cid = cid(); need_gm($cid);
        db()->prepare('DELETE FROM regions WHERE id=? AND campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        out(['ok' => true]);

    // ===== holidays =====
    case 'holiday_save':
        $cid = cid(); need_gm($cid);
        $id = p('id') ? int_in(p('id'), 1) : null;
        $color = (string)str_in(p('color', '#b8860b'), 16, false);
        if (!preg_match('/^#[0-9a-fA-F]{3,8}$/', $color)) $color = '#b8860b';
        $args = [str_in(p('name'), 150, false), json_in(p('rule', [])), str_in(p('description'), 5000), $color, p('is_secret') ? 1 : 0];
        if ($id) {
            db()->prepare('UPDATE holidays SET name=?, rule_json=?, description=?, color=?, is_secret=? WHERE id=? AND campaign_id=?')->execute([...$args, $id, $cid]);
        } else {
            db()->prepare('INSERT INTO holidays (name, rule_json, description, color, is_secret, campaign_id) VALUES (?,?,?,?,?,?)')->execute([...$args, $cid]);
            $id = (int)db()->lastInsertId();
        }
        out(['ok' => true, 'id' => $id]);

    case 'holiday_delete':
        $cid = cid(); need_gm($cid);
        db()->prepare('DELETE FROM holidays WHERE id=? AND campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        out(['ok' => true]);

    // ===== days (range for calendar views) =====
    case 'days':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $from = int_in($_GET['from'] ?? 0);
        $to = int_in($_GET['to'] ?? 0);
        if ($to < $from || $to - $from > 1500) fail('Range must be 0–1500 days');
        $c = campaign_row($cid);
        $settings = dec($c['settings_json']) ?: [];
        $today = floordiv4((int)$c['current_shift']);
        $hideFuture = !$isGm && empty($settings['players_see_future_weather']);

        $st = db()->prepare('SELECT abs_day, region_id, weather_json, notes, gm_notes FROM days WHERE campaign_id=? AND abs_day BETWEEN ? AND ?');
        $st->execute([$cid, $from, $to]);
        $days = [];
        foreach ($st->fetchAll() as $d) {
            $ad = (int)$d['abs_day'];
            $days[] = [
                'abs_day' => $ad,
                'region_id' => $d['region_id'] !== null ? (int)$d['region_id'] : null,
                'weather' => ($hideFuture && $ad > $today) ? null : dec($d['weather_json']),
                'has_notes' => ($d['notes'] ?? '') !== '' || ($isGm && ($d['gm_notes'] ?? '') !== ''),
            ];
        }
        $st = db()->prepare('SELECT abs_day, shift, activity, visibility_override' . ($isGm ? ', gm_notes' : '') . ' FROM shifts WHERE campaign_id=? AND abs_day BETWEEN ? AND ?');
        $st->execute([$cid, $from, $to]);
        $shifts = $st->fetchAll();
        $st = db()->prepare('SELECT id, abs_day, end_day, shift, title, is_secret FROM events WHERE campaign_id=? AND abs_day <= ? AND COALESCE(end_day, abs_day) >= ?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY abs_day, shift');
        $st->execute([$cid, $to, $from]);
        $events = $st->fetchAll();
        out(['days' => $days, 'shifts' => $shifts, 'events' => $events, 'today' => $today]);

    // ===== single day drill-down =====
    case 'day':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $ad = int_in($_GET['d'] ?? 0);
        $c = campaign_row($cid);
        $settings = dec($c['settings_json']) ?: [];
        $today = floordiv4((int)$c['current_shift']);
        $st = db()->prepare('SELECT abs_day, region_id, weather_json, notes, gm_notes FROM days WHERE campaign_id=? AND abs_day=?');
        $st->execute([$cid, $ad]);
        $d = $st->fetch() ?: null;
        $day = null;
        if ($d) {
            $hide = !$isGm && empty($settings['players_see_future_weather']) && $ad > $today;
            $day = ['abs_day' => $ad, 'region_id' => $d['region_id'] !== null ? (int)$d['region_id'] : null,
                'weather' => $hide ? null : dec($d['weather_json']), 'notes' => $d['notes']];
            if ($isGm) $day['gm_notes'] = $d['gm_notes'];
        }
        $st = db()->prepare('SELECT shift, activity, visibility_override' . ($isGm ? ', gm_notes' : '') . ' FROM shifts WHERE campaign_id=? AND abs_day=? ORDER BY shift');
        $st->execute([$cid, $ad]);
        $shifts = $st->fetchAll();
        $st = db()->prepare('SELECT e.id, e.abs_day, e.end_day, e.shift, e.title, e.body, e.is_secret, e.created_by, u.display_name AS author FROM events e LEFT JOIN users u ON u.id=e.created_by WHERE e.campaign_id=? AND e.abs_day <= ? AND COALESCE(e.end_day, e.abs_day) >= ?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY e.shift IS NULL DESC, e.shift, e.id');
        $st->execute([$cid, $ad, $ad]);
        $events = $st->fetchAll();
        if ($events) {
            $ids = array_column($events, 'id');
            $in = implode(',', array_fill(0, count($ids), '?'));
            $st = db()->prepare("SELECT n.id, n.event_id, n.user_id, n.body, n.created_at, u.display_name AS author FROM event_notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.event_id IN ($in) ORDER BY n.created_at");
            $st->execute($ids);
            $notes = [];
            foreach ($st->fetchAll() as $n) $notes[$n['event_id']][] = $n;
            foreach ($events as &$e) $e['notes'] = $notes[$e['id']] ?? [];
            unset($e);
        }
        out(['day' => $day, 'shifts' => $shifts, 'events' => $events, 'today' => $today]);

    case 'days_save': // GM: batch upsert generated weather (+ region) — never touches notes
        $cid = cid(); need_gm($cid);
        $rows = p('days', []);
        if (!is_array($rows) || count($rows) > 1500) fail('Send 1–1500 days at a time');
        $st = db()->prepare('INSERT INTO days (campaign_id, abs_day, region_id, weather_json) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE region_id=VALUES(region_id), weather_json=VALUES(weather_json)');
        $valid = db()->prepare('SELECT id FROM regions WHERE campaign_id=?');
        $valid->execute([$cid]);
        $regionIds = array_map('intval', $valid->fetchAll(PDO::FETCH_COLUMN));
        db()->beginTransaction();
        foreach ($rows as $r) {
            $rid = isset($r['region_id']) && in_array((int)$r['region_id'], $regionIds, true) ? (int)$r['region_id'] : null;
            $st->execute([$cid, int_in($r['abs_day'] ?? null), $rid, isset($r['weather']) ? json_in($r['weather'], 5000) : null]);
        }
        db()->commit();
        out(['ok' => true, 'count' => count($rows)]);

    case 'day_update':
        $cid = cid(); need_gm($cid);
        $ad = int_in(p('abs_day'));
        $rid = p('region_id');
        if ($rid !== null) {
            $chk = db()->prepare('SELECT id FROM regions WHERE id=? AND campaign_id=?');
            $chk->execute([int_in($rid, 1), $cid]);
            $rid = $chk->fetchColumn() ? (int)$rid : null;
        }
        $weather = p('weather') !== null ? json_in(p('weather'), 5000) : null;
        db()->prepare('INSERT INTO days (campaign_id, abs_day, region_id, weather_json, notes, gm_notes) VALUES (?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE region_id=VALUES(region_id), weather_json=COALESCE(VALUES(weather_json), weather_json), notes=VALUES(notes), gm_notes=VALUES(gm_notes)')
            ->execute([$cid, $ad, $rid, $weather, str_in(p('notes'), 20000), str_in(p('gm_notes'), 20000)]);
        out(['ok' => true]);

    case 'shift_save':
        $cid = cid(); need_gm($cid);
        $vo = p('visibility_override');
        $vo = ($vo === null || $vo === '') ? null : int_in($vo, 0, 5);
        db()->prepare('INSERT INTO shifts (campaign_id, abs_day, shift, activity, gm_notes, visibility_override) VALUES (?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE activity=VALUES(activity), gm_notes=VALUES(gm_notes), visibility_override=VALUES(visibility_override)')
            ->execute([$cid, int_in(p('abs_day')), int_in(p('shift'), 0, 3), str_in(p('activity'), 5000), str_in(p('gm_notes'), 5000), $vo]);
        out(['ok' => true]);

    case 'shifts_fill': // GM: label a span of shifts (e.g. "Travelling to Altdorf") without overwriting existing activity
        $cid = cid(); need_gm($cid);
        $from = int_in(p('from_shift')); $to = int_in(p('to_shift'));
        if ($to < $from || $to - $from > 6000) fail('Too many shifts at once (max 6000)');
        $act = str_in(p('activity'), 5000, false);
        if ($act === '') fail('Activity text required');
        $st = db()->prepare("INSERT INTO shifts (campaign_id, abs_day, shift, activity) VALUES (?,?,?,?)
            ON DUPLICATE KEY UPDATE activity=IF(activity IS NULL OR activity='', VALUES(activity), activity)");
        db()->beginTransaction();
        for ($s = $from; $s <= $to; $s++) $st->execute([$cid, floordiv4($s), $s - 4 * floordiv4($s), $act]);
        db()->commit();
        out(['ok' => true]);

    // ===== events & notes =====
    case 'event_save':
        $cid = cid();
        $role = role($cid);
        $u = me();
        $settings = campaign_settings($cid);
        $id = p('id') ? int_in(p('id'), 1) : null;
        if ($role !== 'gm') {
            if (empty($settings['players_can_add_events'])) fail('Only the GM can add events in this campaign', 403);
            if ($id) {
                $st = db()->prepare('SELECT created_by, is_secret FROM events WHERE id=? AND campaign_id=?');
                $st->execute([$id, $cid]);
                $e = $st->fetch();
                if (!$e || (int)$e['created_by'] !== $u['id']) fail('You can only edit events you created', 403);
            }
        }
        $ad = int_in(p('abs_day'));
        $end = p('end_day');
        $end = ($end === null || $end === '') ? null : int_in($end);
        if ($end !== null && $end < $ad) fail('End day is before start day');
        if ($end === $ad) $end = null;
        $shift = p('shift');
        $shift = ($shift === null || $shift === '') ? null : int_in($shift, 0, 3);
        $secret = ($role === 'gm' && p('is_secret')) ? 1 : 0;
        $title = trim((string)str_in(p('title'), 200, false));
        if ($title === '') fail('Title required');
        $args = [$ad, $end, $shift, $title, str_in(p('body'), 20000), $secret];
        if ($id) {
            db()->prepare('UPDATE events SET abs_day=?, end_day=?, shift=?, title=?, body=?, is_secret=? WHERE id=? AND campaign_id=?')->execute([...$args, $id, $cid]);
        } else {
            db()->prepare('INSERT INTO events (abs_day, end_day, shift, title, body, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?)')->execute([...$args, $cid, $u['id']]);
            $id = (int)db()->lastInsertId();
        }
        out(['ok' => true, 'id' => $id]);

    case 'event_delete':
        $cid = cid();
        $role = role($cid);
        $id = int_in(p('id'), 1);
        if ($role !== 'gm') {
            $st = db()->prepare('SELECT created_by FROM events WHERE id=? AND campaign_id=?');
            $st->execute([$id, $cid]);
            if ((int)$st->fetchColumn() !== me()['id']) fail('You can only delete events you created', 403);
        }
        db()->prepare('DELETE FROM events WHERE id=? AND campaign_id=?')->execute([$id, $cid]);
        out(['ok' => true]);

    case 'note_add':
        $cid = cid();
        $role = role($cid);
        $eid = int_in(p('event_id'), 1);
        $st = db()->prepare('SELECT is_secret FROM events WHERE id=? AND campaign_id=?');
        $st->execute([$eid, $cid]);
        $sec = $st->fetchColumn();
        if ($sec === false || ($role !== 'gm' && (int)$sec === 1)) fail('Event not found', 404);
        $text = trim((string)str_in(p('body'), 5000, false));
        if ($text === '') fail('Note is empty');
        db()->prepare('INSERT INTO event_notes (event_id, user_id, body) VALUES (?,?,?)')->execute([$eid, me()['id'], $text]);
        out(['ok' => true]);

    case 'note_delete':
        $cid = cid();
        $role = role($cid);
        $nid = int_in(p('id'), 1);
        $st = db()->prepare('SELECT n.user_id FROM event_notes n JOIN events e ON e.id=n.event_id WHERE n.id=? AND e.campaign_id=?');
        $st->execute([$nid, $cid]);
        $owner = $st->fetchColumn();
        if ($owner === false) fail('Note not found', 404);
        if ($role !== 'gm' && (int)$owner !== me()['id']) fail('You can only delete your own notes', 403);
        db()->prepare('DELETE FROM event_notes WHERE id=?')->execute([$nid]);
        out(['ok' => true]);

    default:
        fail('Unknown action', 404);
    }
} catch (PDOException $e) {
    if (db()->inTransaction()) db()->rollBack();
    if ($e->getCode() === '23000') fail('That conflicts with existing data (duplicate name?)', 409);
    error_log('rpg-tracker: ' . $e->getMessage());
    fail('Database error', 500);
}
