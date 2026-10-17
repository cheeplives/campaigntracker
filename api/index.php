<?php
/**
 * Campaign Chronicle — JSON API for campaign data.
 * Every request: api/index.php?a=<action>[&cid=<campaign id>...]
 * POST bodies are JSON and must carry the X-CSRF-Token header.
 * Sign-in lives in api/auth/ (Google/GitHub, shared with Sinless); every action
 * here needs an approved account.
 * All permission checks (GM vs player, secret filtering) happen here, never only in the browser.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

// ---------- helpers ----------
function out($data, int $code = 200): void { json_out($data, $code); }
const ERROR_CODES = [400 => 'bad_request', 403 => 'forbidden', 404 => 'not_found', 405 => 'method_not_allowed',
    409 => 'conflict', 413 => 'payload_too_large', 500 => 'server_error'];
/** Fail with a human message; the machine code follows the HTTP status unless given. */
function fail(string $msg, int $code = 400, ?string $err = null): void {
    json_error($code, $err ?? (ERROR_CODES[$code] ?? 'error'), $msg);
}

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

/** The signed-in, approved user, with id and is_admin typed. */
function me(): array {
    static $u = null;
    if ($u === null) {
        $u = require_approved();
        $u['id'] = (int)$u['id'];
        $u['is_admin'] = (bool)(int)$u['is_admin'];
    }
    return $u;
}
function user_prefs(int $uid): array {
    $st = db()->prepare('SELECT prefs_json FROM user_prefs WHERE user_id=?');
    $st->execute([$uid]);
    $p = dec($st->fetchColumn() ?: null);
    return is_array($p) ? $p : [];
}
const TEMP_UNITS = ['C', 'F', 'K', 'R', 'Re', 'none'];
/** Colour themes (data-scheme blocks in static/style.css, SCHEMES in static/app.js). */
const SCHEMES = ['parchment', 'nightsky', 'console', 'arctic', 'wildwood'];
function need_admin(): array { $u = me(); if (!$u['is_admin']) fail('Admins only', 403, 'not_admin'); return $u; }

/** Returns 'gm' | 'player' for the current user in campaign $cid, or fails. Site admins are GMs everywhere. */
function role(int $cid): string {
    static $cache = [];
    if (isset($cache[$cid])) return $cache[$cid];
    $u = me();
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
function cid(): int {
    $c = $_GET['cid'] ?? p('cid');
    if ($c === null) fail('Missing campaign id');
    $cid = int_in($c, 1);
    dawn_first($cid);
    return $cid;
}

/** Mark a calendar as storing its shifts Dawn first (see dawn_first()). */
function stamp_cal(string $json): string {
    $cal = dec($json);
    if (!is_array($cal)) return $json;
    $cal['shiftOrder'] = 'dawn';
    return json_encode($cal, JSON_UNESCAPED_UNICODE);
}
/** [a, b, c, d] in Overnight-first order -> [b, c, d, a] in Dawn-first order. */
function rotate_shift_list($a) {
    if (!is_array($a) || !$a) return $a;
    return array_map(fn($i) => $a[($i + 1) % 4] ?? null, [0, 1, 2, 3]);
}
/**
 * Days used to run Overnight (0), Dawn, Midday, Dusk; now they run Dawn (0), Midday, Dusk, Overnight (3),
 * the overnight shift being the night after the day. Every absolute shift moves back by one, so the
 * night that came before day d is now the last shift of day d-1, and Dawn of day d stays on day d.
 * Runs once per campaign, the first time it is used after the change, and marks the calendar when done.
 */
function dawn_first(int $cid): void {
    static $done = [];
    if (isset($done[$cid])) return;
    $done[$cid] = true;
    $pdo = db();
    $st = $pdo->prepare('SELECT calendar_json FROM campaigns WHERE id=?');
    $st->execute([$cid]);
    $cal = dec((string)$st->fetchColumn());
    if (!is_array($cal) || ($cal['shiftOrder'] ?? '') === 'dawn') return;
    $pdo->beginTransaction();
    try {
        $st = $pdo->prepare('SELECT calendar_json FROM campaigns WHERE id=? FOR UPDATE');
        $st->execute([$cid]);
        $cal = dec((string)$st->fetchColumn());
        if (!is_array($cal) || ($cal['shiftOrder'] ?? '') === 'dawn') { $pdo->commit(); return; }
        foreach (['shiftNames', 'lightLevels'] as $k) if (isset($cal[$k])) $cal[$k] = rotate_shift_list($cal[$k]);
        $cal['shiftOrder'] = 'dawn';
        $pdo->prepare('UPDATE campaigns SET calendar_json=?, current_shift=current_shift-1 WHERE id=?')
            ->execute([json_encode($cal, JSON_UNESCAPED_UNICODE), $cid]);
        $st = $pdo->prepare('SELECT id, settings_json FROM regions WHERE campaign_id=?');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $r) {
            $s = dec($r['settings_json']);
            if (!is_array($s) || empty($s['light_levels'])) continue;
            $s['light_levels'] = rotate_shift_list($s['light_levels']);
            $pdo->prepare('UPDATE regions SET settings_json=? WHERE id=?')->execute([json_encode($s, JSON_UNESCAPED_UNICODE), $r['id']]);
        }
        // Park every row at shift+10 first so no remapped row lands on a key that hasn't moved yet.
        foreach (['shifts', 'events'] as $t) {
            $pdo->prepare("UPDATE $t SET shift=shift+10 WHERE campaign_id=? AND shift IS NOT NULL")->execute([$cid]);
        }
        $pdo->prepare('UPDATE shifts SET abs_day=abs_day-1, shift=3 WHERE campaign_id=? AND shift=10')->execute([$cid]);
        // A one-day overnight event moves to the day before; a longer one starts a day earlier and ends where it did.
        $pdo->prepare('UPDATE events SET end_day=IF(end_day=abs_day, end_day-1, end_day), abs_day=abs_day-1, shift=3 WHERE campaign_id=? AND shift=10')->execute([$cid]);
        foreach (['shifts', 'events'] as $t) {
            $pdo->prepare("UPDATE $t SET shift=shift-11 WHERE campaign_id=? AND shift BETWEEN 11 AND 13")->execute([$cid]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function campaign_row(int $cid): array {
    $st = db()->prepare('SELECT * FROM campaigns WHERE id=?');
    $st->execute([$cid]);
    $c = $st->fetch();
    if (!$c) fail('Campaign not found', 404);
    return $c;
}
/** SQL for how a writer is labelled in campaign $cid: their character name, else their account name.
 * Needs the users row joined as u and their campaign_members row LEFT JOINed as m. */
const AUTHOR_SQL = "COALESCE(NULLIF(m.character_name, ''), u.display_name)";
function campaign_settings(int $cid): array { return dec(campaign_row($cid)['settings_json']) ?: []; }
function floordiv4(int $n): int { return (int)floor($n / 4); }
/** The calendar's shift order: 'dawn' once a day runs Dawn first, 'overnight' for the original order. */
function shift_order(array $campaign): string { return (string)((dec($campaign['calendar_json']) ?: [])['shiftOrder'] ?? 'overnight'); }

/**
 * A day's weather as this user may see it. Players without future weather get nothing for days after
 * today, and for today only the shifts up to the current one: the weather fields are the current
 * shift's, never the day's forecast (which is the worst the day brings, so it would give later shifts
 * away). The shifts come from the copy the GM's browser saves with the forecast, and only count if it
 * was saved in the calendar's current shift order ($shiftOrder); otherwise players get nothing.
 */
function visible_weather(?string $json, int $ad, int $currentShift, bool $hideFuture, string $shiftOrder) {
    $w = dec($json);
    $today = floordiv4($currentShift);
    if (!$hideFuture || $w === null || $ad < $today) return $w;
    if ($ad > $today) return null;
    $shifts = is_array($w['shifts'] ?? null) ? array_values($w['shifts']) : [];
    $seen = array_slice($shifts, 0, $currentShift - 4 * $today + 1);
    $now = end($seen);
    if (count($shifts) !== 4 || !is_array($now) || ($w['shift_order'] ?? null) !== $shiftOrder) return null;
    return ['type' => $now['type'] ?? null, 'temp' => $now['temp'] ?? null, 'wind' => $now['wind'] ?? 0,
        'season' => $w['season'] ?? null, 'shifts' => $seen, 'partial' => true];
}

/** Tags every campaign is offered before anyone creates their own: name => colour. */
const STARTER_TAGS = [
    'Holiday' => '#b8860b', 'Battle' => '#b91c1c', 'Party' => '#db2777', 'Banquet' => '#c2410c',
    'Service' => '#4b5563', 'Ritual' => '#7c3aed', 'Festival' => '#d97706', 'Fair' => '#65a30d',
    'Coronation' => '#a16207', 'Wedding' => '#be185d', 'Birth' => '#0d9488', 'Catastrophe' => '#7f1d1d',
];
const TAG_COLOR = '/^#[0-9a-fA-F]{6}$/';
/** The campaign's tags plus any starter tag it hasn't used yet (id null), by name. */
function campaign_tags(int $cid): array {
    $st = db()->prepare('SELECT id, name, color FROM tags WHERE campaign_id=?');
    $st->execute([$cid]);
    $tags = [];
    foreach ($st->fetchAll() as $t) $tags[mb_strtolower($t['name'])] = ['id' => (int)$t['id'], 'name' => $t['name'], 'color' => $t['color']];
    foreach (STARTER_TAGS as $name => $color) $tags[mb_strtolower($name)] ??= ['id' => null, 'name' => $name, 'color' => $color];
    $tags = array_values($tags);
    usort($tags, fn($a, $b) => strcasecmp($a['name'], $b['name']));
    return $tags;
}
/** Add each event's tags ([{id, name, color}]) as $e['tags']. */
function attach_tags(array &$events): void {
    if (!$events) return;
    $ids = array_column($events, 'id');
    $in = implode(',', array_fill(0, count($ids), '?'));
    $st = db()->prepare("SELECT et.event_id, t.id, t.name, t.color FROM event_tags et JOIN tags t ON t.id=et.tag_id WHERE et.event_id IN ($in) ORDER BY t.name");
    $st->execute($ids);
    $by = [];
    foreach ($st->fetchAll() as $t) $by[$t['event_id']][] = ['id' => (int)$t['id'], 'name' => $t['name'], 'color' => $t['color']];
    foreach ($events as &$e) $e['tags'] = $by[$e['id']] ?? [];
    unset($e);
}
/** Replace an event's tags with $list ([{name, color?}]); a name the campaign
 * hasn't used yet becomes a new tag, coloured as sent (or its starter colour). */
function save_event_tags(int $cid, int $eid, $list): void {
    if (!is_array($list) || count($list) > 20) fail('Send up to 20 tags');
    $find = db()->prepare('SELECT id FROM tags WHERE campaign_id=? AND name=?');
    $add = db()->prepare('INSERT INTO tags (campaign_id, name, color) VALUES (?,?,?)');
    $ids = [];
    foreach ($list as $t) {
        $name = trim((string)str_in(is_array($t) ? ($t['name'] ?? '') : $t, 40, false));
        if ($name === '') continue;
        $find->execute([$cid, $name]);
        $id = $find->fetchColumn();
        if ($id === false) {
            $starter = null;
            foreach (STARTER_TAGS as $n => $c) if (strcasecmp($n, $name) === 0) { $starter = $c; $name = $n; }
            $color = is_array($t) ? (string)($t['color'] ?? '') : '';
            if (!preg_match(TAG_COLOR, $color)) $color = $starter ?? '#6b7280';
            $add->execute([$cid, $name, $color]);
            $id = db()->lastInsertId();
        }
        $ids[(int)$id] = true;
    }
    db()->prepare('DELETE FROM event_tags WHERE event_id=?')->execute([$eid]);
    $link = db()->prepare('INSERT INTO event_tags (event_id, tag_id) VALUES (?,?)');
    foreach (array_keys($ids) as $id) $link->execute([$eid, $id]);
}

// ---------- downtime (the Downtime tab) ----------
const DOWNTIME_KINDS = ['long_rest' => 'Long Rest', 'short_rest' => 'Short Rest', 'downtime' => 'Downtime'];
/** Shifts in a day of campaign row $c: four, or what its time tracking mode gives once campaigns have one. */
function downtime_spd(array $c): int { return function_exists('camp_spd') ? camp_spd($c) : 4; }
/** The fewest shifts a long rest uses up: half the day's shifts (2 of 4, 1 of 2), or 8 when time is kept in hours. */
function long_rest_min(array $c): int {
    $hours = function_exists('time_mode') && time_mode(dec($c['calendar_json'])) === 'hours';
    return $hours ? min(8, downtime_spd($c)) : max(1, intdiv(downtime_spd($c), 2));
}
/** A downtime's activities, checked: [{name, members: [user ids in the campaign]}], each name once. */
function downtime_activities($list, int $cid): string {
    if (!is_array($list)) fail('Expected a list of activities');
    if (count($list) > 40) fail('Too many activities (max 40)');
    $st = db()->prepare('SELECT user_id FROM campaign_members WHERE campaign_id=?');
    $st->execute([$cid]);
    $ids = array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
    $out = []; $seen = [];
    foreach ($list as $a) {
        $name = trim((string)str_in(is_array($a) ? ($a['name'] ?? '') : '', 100, false));
        $k = mb_strtolower($name);
        if ($name === '' || isset($seen[$k])) continue;
        $seen[$k] = true;
        $m = array_map('intval', is_array($a['members'] ?? null) ? $a['members'] : []);
        $out[] = ['name' => $name, 'members' => array_values(array_unique(array_filter($m, fn($i) => in_array($i, $ids, true))))];
    }
    return json_encode($out, JSON_UNESCAPED_UNICODE);
}
/**
 * Add $label to the activity of absolute shifts $from..$to (a day has $spd of them), after what is
 * there already ("Make camp; Long Rest"), or take it back out ($add false). A shift that already
 * lists it is left alone.
 */
function label_shifts(int $cid, int $spd, int $from, int $to, string $label, bool $add): void {
    $st = db()->prepare('SELECT abs_day, shift, activity FROM shifts WHERE campaign_id=? AND abs_day BETWEEN ? AND ?');
    $st->execute([$cid, (int)floor($from / $spd), (int)floor($to / $spd)]);
    $have = [];
    foreach ($st->fetchAll() as $r) $have[(int)$r['abs_day'] * $spd + (int)$r['shift']] = (string)$r['activity'];
    $up = db()->prepare('INSERT INTO shifts (campaign_id, abs_day, shift, activity) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE activity=VALUES(activity)');
    for ($s = $from; $s <= $to; $s++) {
        $cur = trim($have[$s] ?? '');
        $parts = array_values(array_filter(array_map('trim', preg_split('/[;\n]/', $cur)), 'strlen'));
        $has = in_array($label, $parts, true);
        if ($add === $has) continue;
        $new = $add ? ($cur === '' ? $label : rtrim($cur, " \t\n;,") . "; $label")
            : implode('; ', array_filter($parts, fn($x) => $x !== $label));
        $d = (int)floor($s / $spd);
        $up->execute([$cid, $d, $s - $spd * $d, $new === '' ? null : $new]);
    }
}

// ---------- routing ----------
$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
require_method('GET', 'POST');
if ($method === 'POST') require_csrf();

$readActions = ['campaigns', 'campaign', 'days', 'day', 'downtimes', 'users', 'member_candidates'];
if ($method === 'GET' && !in_array($action, $readActions, true)) fail('Use POST for this action', 405);
if ($method === 'POST' && in_array($action, $readActions, true)) fail('Use GET for this action', 405);

try {
    switch ($action) {

    // ===== account =====
    case 'prefs_save':
        // Only the keys sent are changed, so the theme picker and the units form don't overwrite each other.
        $u = me();
        $prefs = user_prefs($u['id']);
        if (array_key_exists('temp_unit', body())) {
            $unit = p('temp_unit');
            if ($unit !== null && !in_array($unit, TEMP_UNITS, true)) fail('Unknown temperature unit');
            if ($unit === null) unset($prefs['temp_unit']); else $prefs['temp_unit'] = $unit;
        }
        if (array_key_exists('scheme', body())) {
            $scheme = p('scheme');
            if ($scheme !== null && !in_array($scheme, SCHEMES, true)) fail('Unknown theme');
            if ($scheme === null) unset($prefs['scheme']); else $prefs['scheme'] = $scheme;
        }
        db()->prepare('INSERT INTO user_prefs (user_id, prefs_json) VALUES (?,?) ON DUPLICATE KEY UPDATE prefs_json=VALUES(prefs_json)')
            ->execute([$u['id'], json_encode((object)$prefs)]);
        out(['prefs' => (object)$prefs]);

    // ===== user admin =====
    // Same queue as Sinless: new sign-ins wait as 'pending' until approved here.
    // Admin rights come only from admin_identities in the config (or a migrated account).
    case 'users':
        need_admin();
        out(['users' => db()->query("SELECT id, provider, email, display_name, status, is_admin, created_at, last_login_at FROM users ORDER BY status = 'pending' DESC, display_name")->fetchAll()]);

    case 'user_status':
        $admin = need_admin();
        rate_limit('admin', 'u' . $admin['id'], 60, 60);
        $id = int_in(p('id'), 1);
        $status = p('status');
        if (!in_array($status, ['approved', 'revoked'], true)) fail('Status must be approved or revoked');
        if ($id === $admin['id']) fail("You can't change your own access");
        $st = db()->prepare('SELECT email, display_name, status, is_admin FROM users WHERE id=?');
        $st->execute([$id]);
        $t = $st->fetch();
        if (!$t) fail('User not found', 404);
        if ($status === 'revoked' && (int)$t['is_admin']) fail("Admins can't be revoked here. Remove them from admin_identities first.");
        if ($t['status'] === $status) out(['ok' => true]);
        db()->prepare('UPDATE users SET status=?, approved_at=IF(?=\'approved\', NOW(), approved_at) WHERE id=?')->execute([$status, $status, $id]);
        send_account_email($status, (string)$t['email'], (string)$t['display_name']);
        out(['ok' => true]);

    case 'user_email': // link a pre-OAuth account: the first sign-in with this verified email takes it over
        $admin = need_admin();
        $id = int_in(p('id'), 1);
        $email = trim((string)str_in(p('email'), 191, false));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) fail("That doesn't look like an email address");
        $st = db()->prepare('SELECT provider FROM users WHERE id=?');
        $st->execute([$id]);
        if ($st->fetchColumn() !== 'legacy') fail('Only accounts from before Google/GitHub sign-in can be linked by email');
        db()->prepare("UPDATE users SET email=? WHERE id=? AND provider='legacy'")->execute([$email, $id]);
        out(['ok' => true]);

    case 'user_delete':
        $admin = need_admin();
        $id = int_in(p('id'), 1);
        if ($id === $admin['id']) fail("You can't delete yourself");
        db()->prepare('DELETE FROM users WHERE id=?')->execute([$id]);
        out(['ok' => true]);

    // ===== campaigns =====
    case 'campaigns':
        $u = me();
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
        $st = db()->prepare('SELECT u.id, u.email, u.display_name, m.role, m.character_name FROM campaign_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=? ORDER BY m.role, u.display_name');
        $st->execute([$cid]);
        $members = $st->fetchAll();
        if (!$isGm) $members = array_map(fn($m) => ['id' => $m['id'], 'display_name' => $m['display_name'], 'role' => $m['role'], 'character_name' => $m['character_name']], $members);
        out(['campaign' => $camp, 'role' => $role, 'regions' => $regions, 'holidays' => $holidays, 'members' => $members, 'tags' => campaign_tags($cid)]);

    case 'campaign_create':
        $u = me();
        $name = trim((string)str_in(p('name'), 150, false));
        if ($name === '') fail('Name required');
        $cal = stamp_cal(json_in(p('calendar')));
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
        $cal = p('calendar') !== null ? stamp_cal(json_in(p('calendar'))) : $c['calendar_json'];
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
    case 'member_candidates':
        // Approved accounts not yet in this campaign, for the GM's member picker. GMs only: it lists emails.
        $cid = cid(); need_gm($cid);
        $st = db()->prepare("SELECT id, email, display_name FROM users WHERE status='approved' AND id NOT IN (SELECT user_id FROM campaign_members WHERE campaign_id=?) ORDER BY display_name = '', display_name, email");
        $st->execute([$cid]);
        out(['users' => $st->fetchAll()]);

    case 'member_add':
        $cid = cid(); need_gm($cid);
        if (p('user_id') !== null) {
            // Picked from the list of registered users.
            $st = db()->prepare("SELECT id FROM users WHERE id=? AND status='approved'");
            $st->execute([int_in(p('user_id'), 1)]);
            $uid = $st->fetchColumn();
            if (!$uid) fail('That account is not approved (or no longer exists).', 404);
        } else {
            $st = db()->prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?) AND email<>'' AND status='approved'");
            $st->execute([trim((string)str_in(p('email'), 191, false))]);
            $uid = $st->fetchColumn();
            if (!$uid) fail('No approved account with that email. Ask them to sign in once, then have the site admin approve them.', 404);
        }
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

    case 'member_character': // a player names their own character; a GM can name anyone's
        $cid = cid();
        $uid = int_in(p('user_id', me()['id']), 1);
        if ($uid !== me()['id']) need_gm($cid); else role($cid);
        $name = trim((string)str_in(p('character_name'), 150, false));
        $chk = db()->prepare('SELECT 1 FROM campaign_members WHERE campaign_id=? AND user_id=?');
        $chk->execute([$cid, $uid]);
        if (!$chk->fetchColumn()) fail('Only campaign members can have a character name', 404);
        db()->prepare('UPDATE campaign_members SET character_name=? WHERE campaign_id=? AND user_id=?')->execute([$name, $cid, $uid]);
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
        $order = shift_order($c);

        $st = db()->prepare('SELECT abs_day, region_id, weather_json, notes, gm_notes FROM days WHERE campaign_id=? AND abs_day BETWEEN ? AND ?');
        $st->execute([$cid, $from, $to]);
        $days = [];
        foreach ($st->fetchAll() as $d) {
            $ad = (int)$d['abs_day'];
            $days[] = [
                'abs_day' => $ad,
                'region_id' => $d['region_id'] !== null ? (int)$d['region_id'] : null,
                'weather' => visible_weather($d['weather_json'], $ad, (int)$c['current_shift'], $hideFuture, $order),
                'has_notes' => ($d['notes'] ?? '') !== '' || ($isGm && ($d['gm_notes'] ?? '') !== ''),
            ];
        }
        $st = db()->prepare('SELECT abs_day, shift, activity, visibility_override' . ($isGm ? ', gm_notes' : '') . ' FROM shifts WHERE campaign_id=? AND abs_day BETWEEN ? AND ?');
        $st->execute([$cid, $from, $to]);
        $shifts = $st->fetchAll();
        $st = db()->prepare('SELECT id, abs_day, end_day, shift, shift_end, title, is_secret FROM events WHERE campaign_id=? AND abs_day <= ? AND COALESCE(end_day, abs_day) >= ?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY abs_day, shift');
        $st->execute([$cid, $to, $from]);
        $events = $st->fetchAll();
        attach_tags($events);
        out(['days' => $days, 'shifts' => $shifts, 'events' => $events, 'today' => $today]);

    // ===== single day drill-down =====
    case 'day':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $ad = int_in($_GET['d'] ?? 0);
        $c = campaign_row($cid);
        $settings = dec($c['settings_json']) ?: [];
        $today = floordiv4((int)$c['current_shift']);
        $st = db()->prepare('SELECT abs_day, region_id, weather_json, notes, gm_notes, locations FROM days WHERE campaign_id=? AND abs_day=?');
        $st->execute([$cid, $ad]);
        $d = $st->fetch() ?: null;
        $day = null;
        if ($d) {
            $hideFuture = !$isGm && empty($settings['players_see_future_weather']);
            $order = shift_order($c);
            $day = ['abs_day' => $ad, 'region_id' => $d['region_id'] !== null ? (int)$d['region_id'] : null,
                'weather' => visible_weather($d['weather_json'], $ad, (int)$c['current_shift'], $hideFuture, $order), 'notes' => $d['notes'],
                'locations' => $d['locations']];
            if ($isGm) $day['gm_notes'] = $d['gm_notes'];
        }
        $st = db()->prepare('SELECT shift, activity, visibility_override' . ($isGm ? ', gm_notes' : '') . ' FROM shifts WHERE campaign_id=? AND abs_day=? ORDER BY shift');
        $st->execute([$cid, $ad]);
        $shifts = $st->fetchAll();
        $st = db()->prepare('SELECT e.id, e.abs_day, e.end_day, e.shift, e.shift_end, e.title, e.body, e.is_secret, e.created_by, ' . AUTHOR_SQL . ' AS author, u.display_name AS player
            FROM events e LEFT JOIN users u ON u.id=e.created_by LEFT JOIN campaign_members m ON m.campaign_id=e.campaign_id AND m.user_id=e.created_by
            WHERE e.campaign_id=? AND e.abs_day <= ? AND COALESCE(e.end_day, e.abs_day) >= ?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY e.shift IS NULL DESC, e.shift, e.id');
        $st->execute([$cid, $ad, $ad]);
        $events = $st->fetchAll();
        if ($events) {
            $ids = array_column($events, 'id');
            $in = implode(',', array_fill(0, count($ids), '?'));
            $st = db()->prepare('SELECT n.id, n.event_id, n.user_id, n.body, n.created_at, ' . AUTHOR_SQL . " AS author, u.display_name AS player
                FROM event_notes n LEFT JOIN users u ON u.id=n.user_id LEFT JOIN campaign_members m ON m.campaign_id=? AND m.user_id=n.user_id
                WHERE n.event_id IN ($in) ORDER BY n.created_at");
            $st->execute([$cid, ...$ids]);
            $notes = [];
            foreach ($st->fetchAll() as $n) $notes[$n['event_id']][] = $n;
            foreach ($events as &$e) $e['notes'] = $notes[$e['id']] ?? [];
            unset($e);
            attach_tags($events);
        }
        $st = db()->prepare('SELECT n.id, n.shift, n.user_id, n.body, n.created_at, ' . AUTHOR_SQL . ' AS author, u.display_name AS player
            FROM shift_notes n LEFT JOIN users u ON u.id=n.user_id LEFT JOIN campaign_members m ON m.campaign_id=n.campaign_id AND m.user_id=n.user_id
            WHERE n.campaign_id=? AND n.abs_day=? ORDER BY n.created_at, n.id');
        $st->execute([$cid, $ad]);
        $shiftNotes = $st->fetchAll();
        out(['day' => $day, 'shifts' => $shifts, 'shift_notes' => $shiftNotes, 'events' => $events, 'today' => $today]);

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
        // locations is only changed when sent, so older callers don't wipe it
        $hasLoc = array_key_exists('locations', body()) ? 1 : 0;
        db()->prepare('INSERT INTO days (campaign_id, abs_day, region_id, weather_json, notes, gm_notes, locations) VALUES (?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE region_id=VALUES(region_id), weather_json=COALESCE(VALUES(weather_json), weather_json), notes=VALUES(notes), gm_notes=VALUES(gm_notes),
            locations=IF(?, VALUES(locations), locations)')
            ->execute([$cid, $ad, $rid, $weather, str_in(p('notes'), 20000), str_in(p('gm_notes'), 20000), str_in(p('locations'), 5000), $hasLoc]);
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

    case 'shift_note_add': // anyone in the campaign, GM or player
        $cid = cid();
        role($cid);
        $text = trim((string)str_in(p('body'), 5000, false));
        if ($text === '') fail('Note is empty');
        db()->prepare('INSERT INTO shift_notes (campaign_id, abs_day, shift, user_id, body) VALUES (?,?,?,?,?)')
            ->execute([$cid, int_in(p('abs_day')), int_in(p('shift'), 0, 3), me()['id'], $text]);
        out(['ok' => true, 'id' => (int)db()->lastInsertId()]);

    case 'shift_note_delete':
        $cid = cid();
        $role = role($cid);
        $nid = int_in(p('id'), 1);
        $st = db()->prepare('SELECT user_id FROM shift_notes WHERE id=? AND campaign_id=?');
        $st->execute([$nid, $cid]);
        $owner = $st->fetchColumn();
        if ($owner === false) fail('Note not found', 404);
        if ($role !== 'gm' && (int)$owner !== me()['id']) fail('You can only delete your own notes', 403);
        db()->prepare('DELETE FROM shift_notes WHERE id=?')->execute([$nid]);
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
        // shift empty = all day. Otherwise the event runs from shift (on abs_day)
        // to shift_end (on end_day, or the same day); shift_end defaults to shift.
        $shift = p('shift');
        $shift = ($shift === null || $shift === '') ? null : int_in($shift, 0, 3);
        $shiftEnd = p('shift_end');
        $shiftEnd = ($shift === null) ? null : (($shiftEnd === null || $shiftEnd === '') ? $shift : int_in($shiftEnd, 0, 3));
        if ($shift !== null && $end === null && $shiftEnd < $shift) fail('Shift End is before Shift Start');
        $secret = ($role === 'gm' && p('is_secret')) ? 1 : 0;
        $title = trim((string)str_in(p('title'), 200, false));
        if ($title === '') fail('Title required');
        $args = [$ad, $end, $shift, $shiftEnd, $title, str_in(p('body'), 20000), $secret];
        db()->beginTransaction();
        if ($id) {
            db()->prepare('UPDATE events SET abs_day=?, end_day=?, shift=?, shift_end=?, title=?, body=?, is_secret=? WHERE id=? AND campaign_id=?')->execute([...$args, $id, $cid]);
        } else {
            db()->prepare('INSERT INTO events (abs_day, end_day, shift, shift_end, title, body, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)')->execute([...$args, $cid, $u['id']]);
            $id = (int)db()->lastInsertId();
        }
        if (array_key_exists('tags', body())) save_event_tags($cid, $id, p('tags'));
        db()->commit();
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

    // ===== downtime: rests and downtime, one card each =====
    case 'downtimes':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $st = db()->prepare('SELECT id, kind, title, start_shift, end_shift, slots, activities_json, notes' . ($isGm ? ', gm_notes' : '')
            . ' FROM downtimes WHERE campaign_id=? ORDER BY start_shift DESC, id DESC');
        $st->execute([$cid]);
        $rows = array_map(function ($r) {
            foreach (['id', 'start_shift', 'end_shift', 'slots'] as $k) $r[$k] = (int)$r[$k];
            $r['activities'] = dec($r['activities_json']) ?: [];
            unset($r['activities_json']);
            return $r;
        }, $st->fetchAll());
        out(['downtimes' => $rows]);

    case 'downtime_save':
        // The GM makes a card and can change anything on it but its timing. Players can only write its public notes.
        $cid = cid();
        $role = role($cid);
        $id = p('id') ? int_in(p('id'), 1) : null;
        if ($id) {
            $st = db()->prepare('SELECT id FROM downtimes WHERE id=? AND campaign_id=?');
            $st->execute([$id, $cid]);
            if (!$st->fetchColumn()) fail('Downtime not found', 404);
            if ($role !== 'gm') {
                db()->prepare('UPDATE downtimes SET notes=? WHERE id=?')->execute([str_in(p('notes'), 20000), $id]);
                out(['ok' => true, 'id' => $id]);
            }
            db()->prepare('UPDATE downtimes SET title=?, activities_json=?, notes=?, gm_notes=? WHERE id=?')
                ->execute([trim((string)str_in(p('title'), 200, false)), downtime_activities(p('activities', []), $cid), str_in(p('notes'), 20000), str_in(p('gm_notes'), 20000), $id]);
            out(['ok' => true, 'id' => $id]);
        }
        need_gm($cid);
        $kind = (string)p('kind');
        if (!isset(DOWNTIME_KINDS[$kind])) fail('Pick a long rest, a short rest or downtime');
        $c = campaign_row($cid);
        $spd = downtime_spd($c);
        if ($kind === 'downtime') {
            // whole days, from the first shift of the start date to the last of the end date
            $d0 = int_in(p('start_day')); $d1 = int_in(p('end_day'));
            if ($d1 < $d0) fail('The end date is before the start date');
            if (($d1 - $d0 + 1) * $spd > 6000) fail('Downtime can last at most ' . intdiv(6000, $spd) . ' days');
            $from = $d0 * $spd; $to = $d1 * $spd + $spd - 1; $slots = $to - $from + 1;
        } else {
            // a rest starts now and uses up the shifts after the current one; a short rest of 0 just marks the current shift
            $min = $kind === 'long_rest' ? long_rest_min($c) : 0;
            $slots = p('slots');
            if (!is_numeric($slots) || (int)$slots < $min || (int)$slots > 10 * $spd) fail("A " . strtolower(DOWNTIME_KINDS[$kind]) . " takes $min to " . 10 * $spd . ' shifts');
            $slots = (int)$slots;
            $now = (int)$c['current_shift'];
            [$from, $to] = $slots ? [$now + 1, $now + $slots] : [$now, $now];
        }
        $pdo = db();
        $pdo->beginTransaction();
        $pdo->prepare('INSERT INTO downtimes (campaign_id, kind, title, start_shift, end_shift, slots, activities_json, notes, gm_notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
            ->execute([$cid, $kind, trim((string)str_in(p('title'), 200, false)), $from, $to, $slots, downtime_activities(p('activities', []), $cid),
                str_in(p('notes'), 20000), str_in(p('gm_notes'), 20000), me()['id']]);
        $id = (int)$pdo->lastInsertId();
        label_shifts($cid, $spd, $from, $to, DOWNTIME_KINDS[$kind], true);
        $pdo->commit();
        out(['ok' => true, 'id' => $id, 'start_shift' => $from, 'end_shift' => $to]);

    case 'downtime_delete':
        // Takes its label back off the shifts it covered; the clock stays where it is.
        $cid = cid(); need_gm($cid);
        $st = db()->prepare('SELECT kind, start_shift, end_shift FROM downtimes WHERE id=? AND campaign_id=?');
        $st->execute([int_in(p('id'), 1), $cid]);
        $d = $st->fetch();
        if (!$d) fail('Downtime not found', 404);
        db()->beginTransaction();
        if (isset(DOWNTIME_KINDS[$d['kind']])) label_shifts($cid, downtime_spd(campaign_row($cid)), (int)$d['start_shift'], (int)$d['end_shift'], DOWNTIME_KINDS[$d['kind']], false);
        db()->prepare('DELETE FROM downtimes WHERE id=? AND campaign_id=?')->execute([(int)p('id'), $cid]);
        db()->commit();
        out(['ok' => true]);

    default:
        fail('Unknown action', 404, 'unknown_action');
    }
} catch (PDOException $e) {
    if (db()->inTransaction()) db()->rollBack();
    if ($e->getCode() === '23000') fail('That conflicts with existing data (duplicate name?)', 409);
    error_log('campaign-chronicle: ' . $e->getMessage());
    fail('Database error', 500);
}
