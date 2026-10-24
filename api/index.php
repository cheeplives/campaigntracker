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
require __DIR__ . '/richtext.php';
require __DIR__ . '/images.php';

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
/** A user's units preference (static/app.js unitSystem). */
const UNIT_SYSTEMS = ['metric', 'imperial'];
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
    if ($u['is_admin']) $r = 'gm';
    else {
        $st = db()->prepare('SELECT role FROM campaign_members WHERE campaign_id=? AND user_id=?');
        $st->execute([$cid, $u['id']]);
        $r = $st->fetchColumn();
        if (!$r) fail('You are not a member of this campaign', 403);
    }
    // View as player: a GM's page sends X-View-As: player, and is answered exactly as a player would be, through the
    // same filtering. Nothing can be changed meanwhile, so a preview never saves anything by accident.
    if ($r === 'gm' && ($_SERVER['HTTP_X_VIEW_AS'] ?? '') === 'player') {
        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') fail('You are viewing as a player. Leave player view to make changes', 403, 'viewing_as_player');
        $GLOBALS['viewing_as_player'] = true;
        $r = 'player';
    }
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

/** A holiday's colour as sent, or the default gold when it isn't a #hex colour. */
function holiday_color($v): string {
    return is_string($v) && preg_match('/^#[0-9a-fA-F]{3,8}$/', $v) ? $v : '#b8860b';
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
function floordiv(int $n, int $d): int { return (int)floor($n / $d); }
/** The calendar's shift order: 'dawn' once a day runs Dawn first, 'overnight' for the original order. */
function shift_order(array $campaign): string { return (string)((dec($campaign['calendar_json']) ?: [])['shiftOrder'] ?? 'overnight'); }

// ---------- time modes (mirrors timeMode() and friends in static/engine.js) ----------
/** How a calendar splits its days: 'shifts4' (Dawn, Midday, Dusk, Overnight), 'shifts2' (Day, Night) or 'hours'. */
function time_mode(?array $cal): string {
    $m = $cal['timeMode'] ?? 'shifts4';
    return in_array($m, ['shifts4', 'shifts2', 'hours'], true) ? $m : 'shifts4';
}
function slots_per_day(?array $cal): int {
    switch (time_mode($cal)) {
        case 'shifts2': return 2;
        case 'hours': return max(1, min(240, (int)round((float)($cal['hoursPerDay'] ?? 24) ?: 24)));
        default: return 4;
    }
}
/** Slots per day of a campaign row. */
function camp_spd(array $campaign): int { return slots_per_day(dec($campaign['calendar_json'])); }
/** The quarter of the day (0 Dawn, 1 Midday, 2 Dusk, 3 Overnight) whose weather a slot takes. */
function slot_quarter(?array $cal, int $slot): int {
    switch (time_mode($cal)) {
        case 'shifts2': return $slot ? 3 : 1;
        case 'hours': return (intdiv(4 * $slot, slots_per_day($cal)) + 3) % 4;
        default: return $slot;
    }
}
/**
 * Absolute slot $a of calendar $from as an absolute slot of calendar $to, by the time of day it covers.
 * Times are in days from the epoch's first midnight: four shifts start at dawn (a quarter of the way
 * through the day), Day at dawn and Night at dusk, and hours on the hour. A start slot becomes the slot
 * its start falls in; an end slot ($end) becomes the slot its last moment falls in.
 */
function convert_slot(int $a, ?array $from, ?array $to, bool $end = false): int {
    $n = slots_per_day($from);
    $t = $a + ($end ? 1 : 0);
    switch (time_mode($from)) {
        case 'shifts4': $t = ($t + 1) / 4; break;
        case 'shifts2': $t = ($t + 0.5) / 2; break;
        default: $t = $t / $n;
    }
    $m = slots_per_day($to);
    switch (time_mode($to)) {
        case 'shifts4': $x = 4 * $t - 1; break;
        case 'shifts2': $x = 2 * $t - 0.5; break;
        default: $x = $m * $t;
    }
    return $end ? (int)ceil($x - 1e-9) - 1 : (int)floor($x + 1e-9);
}
/**
 * Move a campaign's clock, shift activities, shift notes, timed events and rests from calendar $old's slots to
 * $new's, after its time mode (or its hours per day, in hours mode) changes. Activities that end up in
 * the same slot are joined. All-day events and the days themselves don't move.
 */
function convert_time_mode(PDO $pdo, int $cid, ?array $old, ?array $new): void {
    $n0 = slots_per_day($old); $n1 = slots_per_day($new);
    $split = fn(int $a) => [floordiv($a, $n1), $a - $n1 * floordiv($a, $n1)];
    $pdo->prepare('UPDATE campaigns SET current_shift=? WHERE id=?')
        ->execute([convert_slot((int)campaign_row($cid)['current_shift'], $old, $new), $cid]);

    $st = $pdo->prepare('SELECT abs_day, shift, activity, gm_notes, visibility_override FROM shifts WHERE campaign_id=? ORDER BY abs_day, shift');
    $st->execute([$cid]);
    $merged = [];
    foreach ($st->fetchAll() as $r) {
        [$d, $s] = $split(convert_slot((int)$r['abs_day'] * $n0 + (int)$r['shift'], $old, $new));
        $k = "$d|$s";
        if (!isset($merged[$k])) { $merged[$k] = [$d, $s, null, null, null]; }
        foreach ([2 => 'activity', 3 => 'gm_notes'] as $i => $f) {
            $v = trim((string)$r[$f]);
            if ($v === '') continue;
            $cur = (string)$merged[$k][$i];
            if ($cur === '') $merged[$k][$i] = $v;
            elseif (!in_array($v, explode("\n", $cur), true)) $merged[$k][$i] = "$cur\n$v";
        }
        if ($merged[$k][4] === null && $r['visibility_override'] !== null) $merged[$k][4] = (int)$r['visibility_override'];
    }
    $pdo->prepare('DELETE FROM shifts WHERE campaign_id=?')->execute([$cid]);
    $ins = $pdo->prepare('INSERT INTO shifts (campaign_id, abs_day, shift, activity, gm_notes, visibility_override) VALUES (?,?,?,?,?,?)');
    foreach ($merged as [$d, $s, $act, $gmn, $vo]) $ins->execute([$cid, $d, $s, $act, $gmn, $vo]);

    $st = $pdo->prepare('SELECT id, abs_day, shift FROM shift_notes WHERE campaign_id=?');
    $st->execute([$cid]);
    $up = $pdo->prepare('UPDATE shift_notes SET abs_day=?, shift=? WHERE id=?');
    foreach ($st->fetchAll() as $r) {
        [$d, $s] = $split(convert_slot((int)$r['abs_day'] * $n0 + (int)$r['shift'], $old, $new));
        $up->execute([$d, $s, $r['id']]);
    }

    $st = $pdo->prepare('SELECT id, abs_day, end_day, shift, shift_end FROM events WHERE campaign_id=? AND shift IS NOT NULL');
    $st->execute([$cid]);
    $up = $pdo->prepare('UPDATE events SET abs_day=?, end_day=?, shift=?, shift_end=? WHERE id=?');
    foreach ($st->fetchAll() as $e) {
        $endDay = $e['end_day'] !== null ? (int)$e['end_day'] : (int)$e['abs_day'];
        $endShift = $e['shift_end'] !== null ? (int)$e['shift_end'] : (int)$e['shift'];
        $a = convert_slot((int)$e['abs_day'] * $n0 + (int)$e['shift'], $old, $new);
        $b = max($a, convert_slot($endDay * $n0 + $endShift, $old, $new, true));
        [$d0, $s0] = $split($a); [$d1, $s1] = $split($b);
        $up->execute([$d0, $d1 > $d0 ? $d1 : null, $s0, $s1, $e['id']]);
    }

    $st = $pdo->prepare('SELECT id, due_shift FROM reminders WHERE campaign_id=?');
    $st->execute([$cid]);
    $up = $pdo->prepare('UPDATE reminders SET due_shift=? WHERE id=?');
    foreach ($st->fetchAll() as $r) $up->execute([convert_slot((int)$r['due_shift'], $old, $new), $r['id']]);

    // Rests and downtime keep absolute slots; a short rest that cost no shift (slots 0) stays a single moment.
    $st = $pdo->prepare('SELECT id, start_shift, end_shift, slots FROM downtimes WHERE campaign_id=?');
    $st->execute([$cid]);
    $up = $pdo->prepare('UPDATE downtimes SET start_shift=?, end_shift=?, slots=? WHERE id=?');
    foreach ($st->fetchAll() as $r) {
        $a = convert_slot((int)$r['start_shift'], $old, $new);
        if ((int)$r['slots'] === 0) { $up->execute([$a, $a, 0, $r['id']]); continue; }
        $b = max($a, convert_slot((int)$r['end_shift'], $old, $new, true));
        $up->execute([$a, $b, $b - $a + 1, $r['id']]);
    }
}

/**
 * A day's weather as this user may see it. Players without future weather get nothing for days after
 * today, and for today only the shifts up to the current one: the weather fields are the current
 * shift's, never the day's forecast (which is the worst the day brings, so it would give later shifts
 * away). The shifts come from the copy the GM's browser saves with the forecast, and only count if it
 * was saved in the calendar's current shift order ($shiftOrder); otherwise players get nothing.
 */
function visible_weather(?string $json, int $ad, int $currentShift, bool $hideFuture, string $shiftOrder, ?array $cal = null) {
    $w = dec($json);
    $spd = slots_per_day($cal);
    $today = floordiv($currentShift, $spd);
    if (!$hideFuture || $w === null || $ad < $today) return $w;
    if ($ad > $today) return null;
    $shifts = is_array($w['shifts'] ?? null) ? array_values($w['shifts']) : [];
    // The weather is kept by quarter of the day (Dawn, Midday, Dusk, Overnight); the current slot falls in quarter $q.
    // Quarters up to it have come round, and in hours mode so has the overnight one, which covers the hours before dawn.
    $slot = $currentShift - $spd * $today;
    $q = slot_quarter($cal, $slot);
    $preDawn = time_mode($cal) === 'hours' && $q === 3 && 4 * $slot < $spd;
    $seen = [];
    foreach ($shifts as $i => $x) $seen[] = ($preDawn ? $i === 3 : ($i <= $q || time_mode($cal) === 'hours' && $i === 3)) ? $x : null;
    while ($seen && end($seen) === null) array_pop($seen);
    $now = $shifts[$q] ?? null;
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
/** What carries tags: its link table, that table's id column, and the table of tag names.
 * Events and holdings each keep their own list of tags. */
const TAG_LINKS = ['event' => ['event_tags', 'event_id', 'tags'], 'holding' => ['holding_tags', 'holding_id', 'holding_tag_names'],
    'entry' => ['encyclopedia_tags', 'entry_id', 'encyclopedia_tag_names']];
/** Tags every campaign's Encyclopedia is offered before anyone makes their own: name => colour. */
const ENTRY_STARTER_TAGS = [
    'Location' => '#16a34a', 'Item' => '#d97706', 'Person' => '#2563eb', 'Group' => '#9333ea', 'Event' => '#e11d48', 'Religion' => '#0891b2',
];
/** Starter tags of what carries tags, by $of: the events' and the Encyclopedia's (holdings have none). */
function starter_tags(string $of): array { return ['event' => STARTER_TAGS, 'entry' => ENTRY_STARTER_TAGS][$of] ?? []; }
/** Add each event's (or holding's, $of 'holding') tags ([{id, name, color}]) as $e['tags']. */
function attach_tags(array &$events, string $of = 'event'): void {
    if (!$events) return;
    [$table, $col, $names] = TAG_LINKS[$of];
    $ids = array_column($events, 'id');
    $in = implode(',', array_fill(0, count($ids), '?'));
    $st = db()->prepare("SELECT et.$col AS owner, t.id, t.name, t.color FROM $table et JOIN $names t ON t.id=et.tag_id WHERE et.$col IN ($in) ORDER BY t.name");
    $st->execute($ids);
    $by = [];
    foreach ($st->fetchAll() as $t) $by[$t['owner']][] = ['id' => (int)$t['id'], 'name' => $t['name'], 'color' => $t['color']];
    foreach ($events as &$e) $e['tags'] = $by[$e['id']] ?? [];
    unset($e);
}
/** Replace an event's (or holding's, $of 'holding') tags with $list ([{name, color?}]); a name the
 * campaign hasn't used yet becomes a new tag, coloured as sent (or its starter colour). */
function save_event_tags(int $cid, int $eid, $list, string $of = 'event'): void {
    [$table, $col, $names] = TAG_LINKS[$of];
    if (!is_array($list) || count($list) > 20) fail('Send up to 20 tags');
    $find = db()->prepare("SELECT id FROM $names WHERE campaign_id=? AND name=?");
    $add = db()->prepare("INSERT INTO $names (campaign_id, name, color) VALUES (?,?,?)");
    $ids = [];
    foreach ($list as $t) {
        $name = trim((string)str_in(is_array($t) ? ($t['name'] ?? '') : $t, 40, false));
        if ($name === '') continue;
        $find->execute([$cid, $name]);
        $id = $find->fetchColumn();
        if ($id === false) {
            $starter = null;
            foreach (starter_tags($of) as $n => $c) if (strcasecmp($n, $name) === 0) { $starter = $c; $name = $n; }
            $color = is_array($t) ? (string)($t['color'] ?? '') : '';
            if (!preg_match(TAG_COLOR, $color)) $color = $starter ?? '#6b7280';
            $add->execute([$cid, $name, $color]);
            $id = db()->lastInsertId();
        }
        $ids[(int)$id] = true;
    }
    db()->prepare("DELETE FROM $table WHERE $col=?")->execute([$eid]);
    $link = db()->prepare("INSERT INTO $table ($col, tag_id) VALUES (?,?)");
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

// ---------- party holdings (the Party Holdings tab) ----------
/** Holding types and the fields each one has beyond the common ones (name, location, description, amount, tags).
 * 'custom' is a type the party names itself. All fields are free text; Construction Type and Category
 * offer a list in the browser but take anything. Matches HOLDING_KINDS in static/app.js. */
const HOLDING_KINDS = [
    'vehicle' => ['top_speed', 'fuel_cap', 'fuel_type', 'fuel_consume', 'reliability', 'armor', 'crew', 'cargo', 'value'],
    'animal' => ['top_speed', 'training', 'armor', 'crew', 'cargo', 'value'],
    'building' => ['construction', 'armor', 'size', 'class', 'status', 'upkeep', 'access', 'seclusion', 'environment', 'value'],
    'asset' => ['category', 'value'],
    'custom' => ['value'],
];
const HOLDING_MAX = 1_000_000_000;
/** A holding's fields for its kind, as stored: only that kind's keys, blank ones left out. */
function holding_stats($v, string $kind): string {
    if ($v !== null && !is_array($v)) fail('Expected an object of fields');
    $out = [];
    foreach (HOLDING_KINDS[$kind] as $k) {
        $x = trim((string)str_in(is_array($v) ? ($v[$k] ?? null) : null, 200, false));
        if ($x !== '') $out[$k] = $x;
    }
    return $out ? json_encode($out, JSON_UNESCAPED_UNICODE) : '{}';
}
/** Fetch a gear row or holding of campaign $cid by id, or fail. */
function holding_row(string $table, int $id, int $cid): array {
    $st = db()->prepare("SELECT * FROM $table WHERE id=? AND campaign_id=?");
    $st->execute([$id, $cid]);
    $r = $st->fetch();
    if (!$r) fail($table === 'holdings' ? 'Holding not found' : 'Item not found', 404);
    return $r;
}
/** Tick a gear row's or holding's amount up or down by $delta, never below 0. Returns the new amount. */
function holding_tick(string $table, int $cid): int {
    $id = int_in(p('id'), 1);
    $delta = int_in(p('delta'), -HOLDING_MAX, HOLDING_MAX);
    holding_row($table, $id, $cid);
    db()->prepare("UPDATE $table SET amount=LEAST(?, GREATEST(0, amount + ?)) WHERE id=?")->execute([HOLDING_MAX, $delta, $id]);
    return (int)holding_row($table, $id, $cid)['amount'];
}

// ---------- reminders ----------
const REMINDER_AUDIENCES = ['me', 'gm', 'all'];
/** SQL condition for the reminders user $uid may see (alias r): their own, the GMs' if they are a GM, and everyone's. */
function reminder_visible_sql(bool $isGm): string {
    return "(r.audience='all' OR r.created_by=?" . ($isGm ? " OR r.audience='gm'" : '') . ')';
}
/** A reminder this user may change: one they made, or as a GM one shared with the GMs or everyone. Fails otherwise. */
function editable_reminder(int $cid, int $id, string $role): array {
    $st = db()->prepare('SELECT id, due_shift, audience, created_by FROM reminders WHERE id=? AND campaign_id=?');
    $st->execute([$id, $cid]);
    $r = $st->fetch();
    $mine = $r && (int)$r['created_by'] === me()['id'];
    if (!$r || (!$mine && !($role === 'gm' && $r['audience'] !== 'me'))) fail('Reminder not found', 404);
    return $r;
}
/** Tell open pages about a GM's change to a reminder others can see (a private one stays quiet). */
function touch_campaign(int $cid): void {
    db()->prepare('UPDATE campaigns SET updated_at=CURRENT_TIMESTAMP WHERE id=?')->execute([$cid]);
}

// ---------- the Encyclopedia ----------
// Entries are the people, places, items and the like that turn up in play. Every member reads the entries that
// aren't secret and can add them and write their Public notes; GM notes, secret entries and deleting other people's
// entries are for GMs. The Proper Noun Detector (static/encyclopedia.js) runs in the browser and offers new names
// after each save; the words someone turns down are kept per campaign, one list for the GMs and one for the players.

/** Whether migration 011 has been run, so the rest of the app still works on an install that hasn't. */
function has_encyclopedia(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW TABLES LIKE 'encyclopedia_ignored'")->fetchColumn();
}
function need_encyclopedia(): void {
    if (!has_encyclopedia()) fail('The Encyclopedia needs a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}
/** The Encyclopedia's tags plus any starter tag the campaign hasn't used yet (id null), by name. */
function entry_tags(int $cid): array {
    if (!has_encyclopedia()) return [];
    $st = db()->prepare('SELECT id, name, color FROM encyclopedia_tag_names WHERE campaign_id=?');
    $st->execute([$cid]);
    $tags = [];
    foreach ($st->fetchAll() as $t) $tags[mb_strtolower($t['name'])] = ['id' => (int)$t['id'], 'name' => $t['name'], 'color' => $t['color']];
    foreach (ENTRY_STARTER_TAGS as $name => $color) $tags[mb_strtolower($name)] ??= ['id' => null, 'name' => $name, 'color' => $color];
    $tags = array_values($tags);
    usort($tags, fn($a, $b) => strcasecmp($a['name'], $b['name']));
    return $tags;
}
/** Every entry this member may see, short: what the browser needs to link names and to know which are new. */
function entry_index(int $cid, bool $isGm): array {
    if (!has_encyclopedia()) return [];
    $st = db()->prepare("SELECT id, name, aliases_json, notes, is_secret, (COALESCE(notes, '') = '' AND " . ($isGm ? "COALESCE(gm_notes, '') = ''" : '1') . ') AS blank
        FROM encyclopedia_entries WHERE campaign_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY name');
    $st->execute([$cid]);
    $pics = entry_pics($cid, $isGm);
    return array_map(fn($e) => ['id' => (int)$e['id'], 'name' => $e['name'], 'aliases' => entry_aliases($e), 'is_secret' => (bool)$e['is_secret'],
        'blank' => (bool)$e['blank'] || (!$isGm && rich_open($e['notes']) === ''), 'preview' => entry_preview(rich_for($e['notes'], $isGm)),
        'pic' => $pics[(int)$e['id']] ?? null], $st->fetchAll());
}
/** Each entry's first picture this member may see, as entry id => its file URL, for the picture on its links' tooltips. */
function entry_pics(int $cid, bool $isGm): array {
    if (!has_attachments()) return [];
    $st = db()->prepare("SELECT a.parent_id, MIN(a.id) AS id FROM attachments a WHERE a.campaign_id=? AND a.parent_type='encyclopedia'
        AND " . (has_credits() ? "(a.kind='image' OR (a.kind='embed' AND a.embed_src IS NOT NULL))" : "a.kind='image'") . ($isGm ? '' : ' AND a.is_secret=0') . ' GROUP BY a.parent_id');
    $st->execute([$cid]);
    $out = [];
    foreach ($st->fetchAll() as $r) $out[(int)$r['parent_id']] = 'api/index.php?' . http_build_query(['a' => 'file', 'cid' => $cid, 'id' => (int)$r['id']]);
    return $out;
}
/** An entry row's aliases as a list. */
function entry_aliases(array $e): array {
    $a = dec($e['aliases_json'] ?? null);
    return is_array($a) ? array_values(array_filter($a, 'is_string')) : [];
}
/** The first line or so of an entry's Public notes, for the tooltip on its links. */
function entry_preview(?string $html): string {
    $t = preg_replace('/\s+/u', ' ', rich_html_plain((string)$html));
    return mb_strlen($t) > 140 ? rtrim(mb_substr($t, 0, 139)) . '…' : $t;
}
/** Aliases as sent ([names]) checked and stored as JSON, or null for none. $ownName and $ownId are left out of the clash check. */
function aliases_in($list, int $cid, string $ownName, ?int $ownId): ?string {
    if ($list === null) return null;
    if (!is_array($list) || count($list) > 30) fail('Send up to 30 other names');
    $out = []; $seen = [mb_strtolower($ownName) => true];
    foreach ($list as $a) {
        $n = entry_name($a);
        $k = mb_strtolower($n);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $same = entry_named($cid, $n);
        if ($same && (int)$same['id'] !== $ownId) fail("\"$n\" is already a name of \"{$same['name']}\"", 409);
        $out[] = $n;
    }
    return $out ? json_encode($out, JSON_UNESCAPED_UNICODE) : null;
}
/** Which list of turned-down words this member uses: the GMs' or the players'. */
function ignore_scope(string $role): string { return $role === 'gm' ? 'gm' : 'player'; }
function ignored_terms(int $cid, string $role): array {
    if (!has_encyclopedia()) return [];
    $st = db()->prepare('SELECT term FROM encyclopedia_ignored WHERE campaign_id=? AND scope=? ORDER BY term');
    $st->execute([$cid, ignore_scope($role)]);
    return $st->fetchAll(PDO::FETCH_COLUMN);
}
/** An entry's name or a word to ignore, as sent: trimmed, spaces run together, 1–150 characters. */
function entry_name($v): string {
    $n = trim(preg_replace('/\s+/u', ' ', (string)str_in($v, 400, false)) ?? '');
    if ($n === '') fail('Give the entry a name');
    if (mb_strlen($n) > 150) fail('Names are 150 characters at most');
    return $n;
}
/** An entry of campaign $cid this member may see, or fail. */
function entry_row(int $cid, int $id, string $role): array {
    $st = db()->prepare('SELECT * FROM encyclopedia_entries WHERE id=? AND campaign_id=?');
    $st->execute([$id, $cid]);
    $e = $st->fetch();
    if (!$e || ($role !== 'gm' && (int)$e['is_secret'])) fail('Entry not found', 404);
    return $e;
}
/** The entry of campaign $cid named $name (any case), secret or not, or null. */
function entry_by_name(int $cid, string $name): ?array {
    $st = db()->prepare('SELECT id, name, is_secret FROM encyclopedia_entries WHERE campaign_id=? AND name=?');
    $st->execute([$cid, $name]);
    return $st->fetch() ?: null;
}
/** The entry of campaign $cid that $name is the name or an alias of (any case), secret or not, or null. */
function entry_named(int $cid, string $name): ?array {
    if ($e = entry_by_name($cid, $name)) return $e;
    $st = db()->prepare("SELECT id, name, is_secret, aliases_json FROM encyclopedia_entries WHERE campaign_id=? AND aliases_json IS NOT NULL");
    $st->execute([$cid]);
    $k = mb_strtolower($name);
    foreach ($st->fetchAll() as $e) foreach (entry_aliases($e) as $a) if (mb_strtolower($a) === $k) return $e;
    return null;
}

// ---------- connections between Encyclopedia entries ----------
// A relationship type reads one way from each end: London "Has resident" Gunther, Gunther "Resident of" London. A
// symmetric one ("Ally of") reads the same both ways and keeps each pair once, in either order: from_id is the entry it
// was made on, so a symmetric type given an inverse label later still reads from the end people meant. Every member can connect the
// entries they can see; removing a connection is for whoever made it and for GMs. A connection marked GM only, or one
// that touches a secret entry, is never sent to players: the filter is in the SQL, so making an entry secret hides its
// connections at once.

/** Relationships every campaign is offered before it makes its own: [label, inverse label ('' when symmetric), colour]. */
const RELATION_STARTER_TYPES = [
    ['Has resident', 'Resident of', '#16a34a'], ['Contains', 'Located in', '#15803d'], ['Has member', 'Member of', '#9333ea'],
    ['Rules', 'Ruled by', '#b45309'], ['Owns', 'Owned by', '#d97706'], ['Serves', 'Served by', '#2563eb'],
    ['Worships', 'Worshipped by', '#0891b2'], ['Parent of', 'Child of', '#db2777'],
    ['Ally of', '', '#059669'], ['Enemy of', '', '#dc2626'], ['Related to', '', '#6b7280'],
];
/** Whether migration 012 has been run. */
function has_relations(): bool {
    static $has = null;
    return $has ??= has_encyclopedia() && (bool)db()->query("SHOW TABLES LIKE 'encyclopedia_relations'")->fetchColumn();
}
function need_relations(): void {
    if (!has_relations()) fail('Connections need a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}
/** SQL (aliases r, a, b) for the connections of campaign ? that this member may see. */
function relations_visible_sql(bool $isGm): string {
    return 'FROM encyclopedia_relations r JOIN encyclopedia_entries a ON a.id=r.from_id JOIN encyclopedia_entries b ON b.id=r.to_id
        WHERE r.campaign_id=?' . ($isGm ? '' : ' AND r.is_secret=0 AND a.is_secret=0 AND b.is_secret=0');
}
function relation_out(array $r): array {
    return ['id' => (int)$r['id'], 'from_id' => (int)$r['from_id'], 'to_id' => (int)$r['to_id'], 'type_id' => (int)$r['type_id'],
        'note' => $r['note'], 'is_secret' => (bool)$r['is_secret'], 'created_by' => $r['created_by'] !== null ? (int)$r['created_by'] : null];
}
/** Every connection this member may see. */
function relations_list(int $cid, bool $isGm): array {
    if (!has_relations()) return [];
    $st = db()->prepare('SELECT r.* ' . relations_visible_sql($isGm) . ' ORDER BY r.id');
    $st->execute([$cid]);
    return array_map('relation_out', $st->fetchAll());
}
function relation_type_out(array $t): array {
    return ['id' => $t['id'] !== null ? (int)$t['id'] : null, 'label' => $t['label'], 'inverse_label' => $t['inverse_label'],
        'symmetric' => $t['inverse_label'] === '', 'color' => $t['color']];
}
/** The campaign's relationships plus any starter it hasn't used yet (id null). Players get only the ones used by a
 * connection they can see, and the starters, so a label a GM made up for a secret connection never reaches them. */
function relation_types(int $cid, bool $isGm): array {
    if (!has_relations()) return [];
    $sql = 'SELECT id, label, inverse_label, color FROM encyclopedia_relation_types WHERE campaign_id=?';
    $args = [$cid];
    if (!$isGm) { $sql .= ' AND id IN (SELECT r.type_id ' . relations_visible_sql(false) . ')'; $args[] = $cid; }
    $st = db()->prepare($sql);
    $st->execute($args);
    $types = [];
    $key = fn($l, $i) => mb_strtolower($l) . "\0" . mb_strtolower($i);
    foreach ($st->fetchAll() as $t) $types[$key($t['label'], $t['inverse_label'])] = relation_type_out($t);
    foreach (RELATION_STARTER_TYPES as [$l, $i, $c]) $types[$key($l, $i)] ??= relation_type_out(['id' => null, 'label' => $l, 'inverse_label' => $i, 'color' => $c]);
    $types = array_values($types);
    usort($types, fn($a, $b) => strcasecmp($a['label'], $b['label']));
    return $types;
}
/** A relationship label as sent: trimmed, spaces run together, 1–40 characters ('' allowed when $optional). */
function relation_label($v, bool $optional = false): string {
    $l = trim(preg_replace('/\s+/u', ' ', (string)str_in($v, 200, false)) ?? '');
    if ($l === '' && !$optional) fail('Name the connection');
    if (mb_strlen($l) > 40) fail('Connection names are 40 characters at most');
    return $l;
}
/** The id of the relationship sent as {id} or {label, inverse_label?, symmetric?, color?}, made if it is new. A type
 * given one label, or the same label twice, reads the same from both ends: it is symmetric. $flip is set when the
 * labels sent are an existing type's the other way round, so the entry sending them is at its "to" end. */
function relation_type_id(int $cid, $t, bool &$flip = false): int {
    if (!is_array($t)) fail('Pick a connection');
    if (!empty($t['id'])) {
        $st = db()->prepare('SELECT id FROM encyclopedia_relation_types WHERE id=? AND campaign_id=?');
        $st->execute([int_in($t['id'], 1), $cid]);
        $id = $st->fetchColumn();
        if ($id === false) fail('That connection is gone', 404);
        return (int)$id;
    }
    $label = relation_label($t['label'] ?? '');
    $inverse = !empty($t['symmetric']) ? '' : relation_label($t['inverse_label'] ?? '', true);
    if (mb_strtolower($inverse) === mb_strtolower($label)) $inverse = '';
    $st = db()->prepare('SELECT id, label, inverse_label FROM encyclopedia_relation_types WHERE campaign_id=? AND
        ((label=? AND inverse_label=?) OR (label=? AND inverse_label=?))');
    $st->execute([$cid, $label, $inverse, $inverse, $label]);
    if ($row = $st->fetch()) {
        $flip = $inverse !== '' && mb_strtolower($row['label']) !== mb_strtolower($label); // typed the other way round: "Resident of" / "Has resident"
        return (int)$row['id'];
    }
    $color = (string)($t['color'] ?? '');
    if (!preg_match(TAG_COLOR, $color)) {
        $color = '#6b7280';
        foreach (RELATION_STARTER_TYPES as [$l, $i, $c]) if (strcasecmp($l, $label) === 0 && strcasecmp($i, $inverse) === 0) $color = $c;
    }
    db()->prepare('INSERT INTO encyclopedia_relation_types (campaign_id, label, inverse_label, color) VALUES (?,?,?,?)')->execute([$cid, $label, $inverse, $color]);
    return (int)db()->lastInsertId();
}
/** Keep one row of each pair made with symmetric type $tid, the older one, where both A→B and B→A exist. */
function relations_dedupe(int $tid): void {
    db()->prepare('DELETE r1 FROM encyclopedia_relations r1 JOIN encyclopedia_relations r2 ON r2.type_id=r1.type_id AND r2.from_id=r1.to_id AND r2.to_id=r1.from_id
        WHERE r1.type_id=? AND r1.id > r2.id')->execute([$tid]);
}
/** A relationship row of campaign $cid, or fail. */
function relation_type_row(int $cid, int $id): array {
    $st = db()->prepare('SELECT * FROM encyclopedia_relation_types WHERE id=? AND campaign_id=?');
    $st->execute([$id, $cid]);
    $t = $st->fetch();
    if (!$t) fail('That connection is gone', 404);
    return $t;
}
/** A connection of campaign $cid this member may see, or fail. */
function relation_row(int $cid, int $id, bool $isGm): array {
    $st = db()->prepare('SELECT r.* ' . relations_visible_sql($isGm) . ' AND r.id=?');
    $st->execute([$cid, $id]);
    $r = $st->fetch();
    if (!$r) fail('Connection not found', 404);
    return $r;
}
/** Whether this member may remove or change connection $r: whoever made it, and GMs. */
function relation_mine(array $r, bool $isGm): bool {
    return $isGm || ($r['created_by'] !== null && (int)$r['created_by'] === me()['id']);
}

// ---------- pictures and files ----------
// A file hangs off a parent (an Encyclopedia entry, for now) and is seen by exactly the people who see that parent:
// a file on a secret entry, or one a GM marked GM only, never reaches players. Uploads are checked by their contents
// (images must decode as the type they claim), kept outside the web root under a random name, and only sent by the
// 'file' action below with headers that stop the browser running or sniffing them.

/** What a file can hang off. Add a kind here and a case to attachment_parent(). */
const ATTACHMENT_PARENTS = ['encyclopedia', 'library'];
/** The types allowed, by the type the contents show: [extensions, 'image' (shown on the page) or 'file' (downloaded)].
 * No SVG or HTML: both can carry scripts. Text files are checked to be text and always downloaded. */
const UPLOAD_TYPES = [
    'image/jpeg' => [['jpg', 'jpeg'], 'image'], 'image/png' => [['png'], 'image'], 'image/gif' => [['gif'], 'image'],
    'image/webp' => [['webp'], 'image'], 'application/pdf' => [['pdf'], 'file'], 'text/plain' => [['txt', 'md', 'csv'], 'file'],
];
const ATTACHMENTS_PER_PARENT = 50;

/** Whether migration 013 has been run. */
function has_attachments(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW TABLES LIKE 'attachments'")->fetchColumn();
}
function need_attachments(): void {
    if (!has_attachments()) fail('Pictures and files need a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}
/** The thing a file hangs off, checked: this member must be able to see it (or it fails as not found). secret: only
 * GMs may see it, so its files are GM only too; manage_any: every member may change or remove its files, not only
 * whoever uploaded them and the GMs. */
function attachment_parent(int $cid, string $type, int $id, string $role): array {
    switch ($type) {
        case 'encyclopedia':
            need_encyclopedia();
            $e = entry_row($cid, $id, $role);
            return ['secret' => (bool)(int)$e['is_secret'], 'manage_any' => false];
        case 'library':                                   // every member reads and changes every tome, and its files
            need_library();
            tome_row($cid, $id);
            return ['secret' => false, 'manage_any' => true];
    }
    fail('Files can\'t be attached to that', 400);
}
/** Whether migration 017 has been run: found pictures keep their credit, and DeviantArt works can be embedded. */
function has_credits(): bool {
    static $has = null;
    return $has ??= has_attachments() && (bool)db()->query("SHOW COLUMNS FROM attachments LIKE 'credit_license'")->fetchColumn();
}
/** A found picture's credit, null for a file uploaded by hand. */
function attachment_credit(array $a): ?array {
    if (($a['credit_license'] ?? null) === null && ($a['credit_source'] ?? null) === null) return null;
    return ['title' => $a['credit_title'], 'author' => $a['credit_author'], 'author_url' => $a['credit_author_url'], 'license' => $a['credit_license'],
        'license_url' => $a['credit_license_url'], 'source' => $a['credit_source'], 'source_url' => $a['credit_source_url']];
}
function attachment_out(array $a): array {
    $id = (int)$a['id'];
    return ['id' => $id, 'parent_type' => $a['parent_type'], 'parent_id' => (int)$a['parent_id'], 'name' => $a['original_name'],
        'mime' => $a['mime'], 'kind' => $a['kind'], 'size' => (int)$a['size_bytes'],
        'width' => $a['width'] !== null ? (int)$a['width'] : null, 'height' => $a['height'] !== null ? (int)$a['height'] : null,
        'caption' => $a['caption'], 'is_secret' => (bool)(int)$a['is_secret'], 'created_by' => $a['created_by'] !== null ? (int)$a['created_by'] : null,
        'credit' => attachment_credit($a), 'embed' => $a['kind'] === 'embed' ? ['url' => $a['embed_url'], 'gone' => ($a['embed_src'] ?? null) === null] : null,
        'url' => 'api/index.php?' . http_build_query(['a' => 'file', 'cid' => (int)$a['campaign_id'], 'id' => $id])];
}
/** The files on every Encyclopedia entry this member may see. */
function entry_files(int $cid, bool $isGm): array {
    if (!has_attachments()) return [];
    $st = db()->prepare("SELECT a.* FROM attachments a JOIN encyclopedia_entries e ON e.id=a.parent_id AND e.campaign_id=a.campaign_id
        WHERE a.campaign_id=? AND a.parent_type='encyclopedia'" . ($isGm ? '' : ' AND a.is_secret=0 AND e.is_secret=0') . ' ORDER BY a.id');
    $st->execute([$cid]);
    return array_map('attachment_out', $st->fetchAll());
}
/** A file of campaign $cid this member may see, with its parent's checks, or fail. */
function attachment_row(int $cid, int $id, string $role): array {
    $st = db()->prepare('SELECT * FROM attachments WHERE id=? AND campaign_id=?');
    $st->execute([$id, $cid]);
    $a = $st->fetch();
    if (!$a) fail('File not found', 404);
    $parent = attachment_parent($cid, $a['parent_type'], (int)$a['parent_id'], $role);
    if ($role !== 'gm' && ($parent['secret'] || (int)$a['is_secret'])) fail('File not found', 404);
    return $a + ['_parent' => $parent];
}
/** Whether this member may change or remove file $a: whoever uploaded it, GMs, and anyone when its parent says so. */
function attachment_mine(array $a, string $role): bool {
    return $role === 'gm' || $a['_parent']['manage_any'] || ($a['created_by'] !== null && (int)$a['created_by'] === me()['id']);
}
/** Delete files and their rows: those of one parent, or with $type null every file of the campaign. The rows go first,
 * so a file that can't be removed from disk is only left over, never served. */
function attachments_purge(int $cid, ?string $type = null, ?int $id = null): void {
    if (!has_attachments()) return;
    $where = 'campaign_id=?' . ($type !== null ? ' AND parent_type=? AND parent_id=?' : '');
    $args = $type !== null ? [$cid, $type, $id] : [$cid];
    $st = db()->prepare("SELECT stored_name FROM attachments WHERE $where");
    $st->execute($args);
    $names = $st->fetchAll(PDO::FETCH_COLUMN);
    if (!$names) return;
    db()->prepare("DELETE FROM attachments WHERE $where")->execute($args);
    $dir = upload_dir()['dir'];
    if ($dir) foreach ($names as $n) if (preg_match('/^[0-9a-f]{32}$/', $n)) @unlink("$dir/$n");
}
/** An uploaded file's name, safe to keep and to send back: no folders, no control characters, 200 characters at most. */
function upload_name(string $name): string {
    $name = preg_replace('/[\x00-\x1F\x7F"\\\\\/:*?<>|]+/u', '_', basename(str_replace('\\', '/', $name))) ?? '';
    $name = trim($name, " .\t");
    if ($name === '' || !mb_check_encoding($name, 'UTF-8')) $name = 'file';
    return mb_strlen($name) > 200 ? mb_substr($name, -200) : $name;
}
/** [mime, kind, width, height] of an uploaded file, from its contents and its extension, or fail when it isn't one of
 * UPLOAD_TYPES. A file whose contents and extension disagree is refused: a .jpg must be a JPEG. */
function upload_type(string $path, string $name): array {
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $mime = class_exists('finfo') ? (string)(new finfo(FILEINFO_MIME_TYPE))->file($path) : '';
    $allowed = 'Pictures can be JPEG, PNG, GIF or WebP; files can be PDF or plain text (.txt, .md, .csv)';
    if (in_array($ext, ['txt', 'md', 'csv'], true)) {
        // Plain text whatever finfo calls it (text/x-markdown, text/csv…), as long as it is text and not markup.
        $head = (string)file_get_contents($path, false, null, 0, 65536);
        if ($mime !== '' && !str_starts_with($mime, 'text/') && $mime !== 'application/csv' && $mime !== 'application/x-empty') fail("That isn't a text file. $allowed", 415, 'unsupported_type');
        if (str_contains($head, "\0") || preg_match('/^\s*<(?:!doctype|html|svg|script)/i', $head)) fail("That isn't a text file. $allowed", 415, 'unsupported_type');
        return ['text/plain', 'file', null, null];
    }
    foreach (UPLOAD_TYPES as $m => [$exts, $kind]) {
        if (!in_array($ext, $exts, true)) continue;
        if ($kind === 'image') {
            $info = @getimagesize($path);
            if (!$info || ($info['mime'] ?? '') !== $m || ($mime !== '' && $mime !== $m) || $info[0] < 1 || $info[1] < 1)
                fail("That file isn't a working ." . $ext . ' picture', 415, 'unsupported_type');
            return [$m, 'image', min(65535, (int)$info[0]), min(65535, (int)$info[1])];
        }
        if ($mime !== $m && !($m === 'application/pdf' && str_starts_with((string)file_get_contents($path, false, null, 0, 5), '%PDF-')))
            fail("That file isn't a working ." . $ext . ' file', 415, 'unsupported_type');
        return [$m, $kind, null, null];
    }
    fail("Files of that type can't be uploaded. $allowed", 415, 'unsupported_type');
}
/** What the browser needs before it sends a file: whether uploads work here, the size limit and the types allowed. */
function upload_info(): array {
    $up = upload_dir();
    $out = ['ready' => has_attachments() && $up['dir'] !== null, 'max_bytes' => upload_max_bytes(),
        'accept' => implode(',', array_merge(array_keys(UPLOAD_TYPES), array_map(fn($e) => ".$e", array_merge(...array_column(UPLOAD_TYPES, 0)))))];
    // The folder's path is for whoever runs the server, not for every player.
    if (!$out['ready']) $out['problem'] = !has_attachments() ? 'Pictures and files need a database upgrade: open install.php and press Install or upgrade.'
        : (me()['is_admin'] ? 'Uploads aren\'t set up on this server: ' . $up['problem'] : 'Uploads aren\'t set up on this server yet. Ask whoever runs it.');
    return $out;
}

/** Fail unless parent ($type, $pid) has room for one more file and the campaign for $size more bytes. */
function attachment_room(int $cid, string $type, int $pid, int $size): void {
    $st = db()->prepare('SELECT COUNT(*) FROM attachments WHERE campaign_id=? AND parent_type=? AND parent_id=?');
    $st->execute([$cid, $type, $pid]);
    if ((int)$st->fetchColumn() >= ATTACHMENTS_PER_PARENT) fail('There are ' . ATTACHMENTS_PER_PARENT . ' files here already. Remove one first', 409);
    $quota = max(1, (int)(cfg('uploads', [])['campaign_mb'] ?? 500)) << 20;
    $st = db()->prepare('SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE campaign_id=?');
    $st->execute([$cid]);
    if ((int)$st->fetchColumn() + $size > $quota) fail('This campaign\'s files are using all of its ' . ($quota >> 20) . ' MB. Remove some first', 413);
}
/** Keep the file at $tmp (already checked) under a new random name and add its row; $row holds the columns besides
 * campaign_id, stored_name and created_by. $tmp null: a row with no file (an embed). Returns the row as the browser gets it. */
function attachment_store(int $cid, ?string $tmp, array $row, bool $uploaded = false): array {
    $stored = bin2hex(random_bytes(16));
    $dest = null;
    if ($tmp !== null) {
        $up = upload_dir();
        if (!$up['dir']) fail(upload_info()['problem'], 409, 'uploads_unavailable');
        $dest = "{$up['dir']}/$stored";
        $moved = $uploaded ? move_uploaded_file($tmp, $dest) : (@rename($tmp, $dest) || (@copy($tmp, $dest) && (@unlink($tmp) || true)));
        if (!$moved) { error_log("upload: couldn't move the file to $dest"); fail('The file couldn\'t be saved on the server', 500); }
        @chmod($dest, 0600);
    }
    $row = ['campaign_id' => $cid, 'stored_name' => $stored, 'created_by' => me()['id']] + $row;
    try {
        db()->prepare('INSERT INTO attachments (' . implode(', ', array_keys($row)) . ') VALUES (' . implode(',', array_fill(0, count($row), '?')) . ')')->execute(array_values($row));
    } catch (Throwable $e) { if ($dest) @unlink($dest); throw $e; }
    $st = db()->prepare('SELECT * FROM attachments WHERE id=?');
    $st->execute([(int)db()->lastInsertId()]);
    return attachment_out($st->fetch());
}
/** A found picture's credit as attachments columns. */
function credit_columns(array $i): array {
    return ['credit_title' => mb_substr($i['title'], 0, 200), 'credit_author' => $i['author'] !== null ? mb_substr($i['author'], 0, 200) : null,
        'credit_author_url' => $i['author_url'] !== null && strlen($i['author_url']) <= 500 ? $i['author_url'] : null, 'credit_license' => mb_substr($i['license'], 0, 60),
        'credit_license_url' => $i['license_url'], 'credit_source' => mb_substr($i['via'] ?: ucfirst($i['source']), 0, 60),
        'credit_source_url' => $i['landing_url'] !== null && strlen($i['landing_url']) <= 500 ? $i['landing_url'] : null];
}
/** An embed's picture address, asked of oEmbed again once EMBED_RECHECK has passed; null once DeviantArt says it's gone. */
function embed_refresh(array $a): ?string {
    $fresh = $a['embed_checked_at'] && strtotime($a['embed_checked_at']) > time() - EMBED_RECHECK;
    if ($fresh) return embed_src_ok($a['embed_src']);
    try { $o = deviantart_oembed((string)$a['embed_url']); } catch (ImageSourceDown) { return embed_src_ok($a['embed_src']); }  // keep the last one meanwhile
    db()->prepare('UPDATE attachments SET embed_src=?, embed_checked_at=NOW() WHERE id=?')->execute([$o['src'] ?? null, $a['id']]);
    return $o['src'] ?? null;
}
/** The file name a found picture is kept under: its title, and the extension its contents call for. */
function found_name(string $title, string $path): string {
    $ext = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'][@getimagesize($path)['mime'] ?? ''] ?? 'jpg';
    $base = trim(preg_replace('/[^\p{L}\p{N} ._-]+/u', ' ', $title) ?? '') ?: 'picture';
    return upload_name(mb_substr($base, 0, 150) . ".$ext");
}

// ---------- routing ----------
$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// ---------- the Library ----------
// The campaign's books, journals and notes ("tomes"): a title, a short description and a rich-text body. Every member,
// GM or player, can add one and change any of them; deleting is for whoever added it, or a GM, as with Encyclopedia entries.

const TOME_KINDS = ['book', 'journal', 'note'];
/** Whether migration 014 has been run, so the rest of the app still works on an install that hasn't. */
function has_library(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW TABLES LIKE 'library_tomes'")->fetchColumn();
}
function need_library(): void {
    if (!has_library()) fail('The Library needs a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}
function tome_row(int $cid, int $id): array {
    $st = db()->prepare('SELECT * FROM library_tomes WHERE id=? AND campaign_id=?');
    $st->execute([$id, $cid]);
    return $st->fetch() ?: fail('Tome not found', 404);
}
/** A tome as the browser gets it, without its secret paragraphs for a player; the body only when $full (the list sends a word count instead). */
function tome_out(array $t, bool $full, bool $isGm): array {
    $t['body'] = rich_for($t['body'], $isGm);
    $plain = rich_html_plain((string)$t['body']);
    $o = ['id' => (int)$t['id'], 'kind' => $t['kind'], 'title' => $t['title'], 'description' => (string)$t['description'],
        'version' => (int)$t['version'], 'created_by' => $t['created_by'] !== null ? (int)$t['created_by'] : null,
        'created_at' => $t['created_at'], 'updated_at' => $t['updated_at'], 'author' => $t['author'] ?? null, 'player' => $t['player'] ?? null,
        'editor' => $t['editor'] ?? null, 'words' => $plain === '' ? 0 : count(preg_split('/\s+/u', $plain))];
    if ($full) $o['body'] = (string)$t['body'];
    return $o;
}
/** Tomes of campaign $cid with who added and who last changed each (character name first); one tome when $id is given. */
function tomes(int $cid, ?int $id = null): array {
    $st = db()->prepare('SELECT t.*, ' . AUTHOR_SQL . ' AS author, u.display_name AS player, COALESCE(NULLIF(m2.character_name, \'\'), u2.display_name) AS editor
        FROM library_tomes t LEFT JOIN users u ON u.id=t.created_by LEFT JOIN campaign_members m ON m.campaign_id=t.campaign_id AND m.user_id=t.created_by
        LEFT JOIN users u2 ON u2.id=t.updated_by LEFT JOIN campaign_members m2 ON m2.campaign_id=t.campaign_id AND m2.user_id=t.updated_by
        WHERE t.campaign_id=?' . ($id ? ' AND t.id=?' : '') . ' ORDER BY t.title');
    $st->execute($id ? [$cid, $id] : [$cid]);
    return $st->fetchAll();
}

// ---------- play sessions ----------
// A session is one game night: the GM's quick notes taken during it (session_notes, GMs only) and the summary written
// from them afterwards, which players read once it is published. A campaign has at most one open session (last_day
// NULL); the Session notes box adds to it, and starts one when there is none.

/** Whether migration 015 has been run, so the rest of the app still works on an install that hasn't. */
function has_sessions(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW TABLES LIKE 'play_sessions'")->fetchColumn();
}
function need_sessions(): void {
    if (!has_sessions()) fail('Sessions need a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}
/** A session of campaign $cid; a player only gets a published one. $lock: FOR UPDATE, inside a transaction. */
function session_row(int $cid, int $id, bool $isGm = true, bool $lock = false): array {
    $st = db()->prepare('SELECT * FROM play_sessions WHERE id=? AND campaign_id=?' . ($isGm ? '' : ' AND is_published=1') . ($lock ? ' FOR UPDATE' : ''));
    $st->execute([$id, $cid]);
    return $st->fetch() ?: fail('Session not found', 404);
}
/** The campaign's open session, or null. */
function open_session(int $cid): ?array {
    $st = db()->prepare('SELECT * FROM play_sessions WHERE campaign_id=? AND last_day IS NULL ORDER BY number DESC LIMIT 1');
    $st->execute([$cid]);
    return $st->fetch() ?: null;
}
/** A session as the browser gets it: the summary only when $full, without its secret paragraphs for a player. */
function session_out(array $s, bool $full, bool $isGm): array {
    $o = ['id' => (int)$s['id'], 'number' => (int)$s['number'], 'title' => $s['title'], 'played_on' => $s['played_on'],
        'first_day' => (int)$s['first_day'], 'last_day' => $s['last_day'] === null ? null : (int)$s['last_day'],
        'is_published' => (bool)(int)$s['is_published'], 'version' => (int)$s['version']];
    if ($full) {
        $o['summary'] = (string)rich_for($s['summary'], $isGm);
        if (array_key_exists('rewards', $s)) { // the Session Rewards and Loot Found columns, once install.php has added them
            $o['rewards'] = (string)rich_for($s['rewards'], $isGm);
            $o['loot'] = (string)rich_for($s['loot'], $isGm);
        }
    }
    if ($isGm && isset($s['notes'])) { $o['notes'] = (int)$s['notes']; $o['covered'] = (int)$s['covered']; }
    return $o;
}
function snote_out(array $n): array {
    return ['id' => (int)$n['id'], 'session_id' => (int)$n['session_id'], 'position' => (int)$n['position'], 'depth' => (int)$n['depth'],
        'text' => $n['text'], 'abs_shift' => (int)$n['abs_shift'], 'is_covered' => (bool)(int)$n['is_covered']];
}
function snote_row(int $cid, int $id): array {
    $st = db()->prepare('SELECT * FROM session_notes WHERE id=? AND campaign_id=?');
    $st->execute([$id, $cid]);
    return $st->fetch() ?: fail('Note not found', 404);
}
function snotes(int $sid): array {
    $st = db()->prepare('SELECT * FROM session_notes WHERE session_id=? ORDER BY position, id');
    $st->execute([$sid]);
    return array_map('snote_out', $st->fetchAll());
}
/** A note's text: one line, 1 to 1000 characters. */
function snote_text($v): string {
    $t = trim(preg_replace('/\s+/u', ' ', (string)str_in($v, 1000, false)));
    if ($t === '') fail('Write something first');
    return $t;
}
/** End every open session of the campaign at the current day. */
function sessions_end_all(int $cid): void {
    $c = campaign_row($cid);
    $day = floordiv((int)$c['current_shift'], slots_per_day(dec($c['calendar_json'])));
    db()->prepare('UPDATE play_sessions SET last_day=GREATEST(first_day, ?) WHERE campaign_id=? AND last_day IS NULL')->execute([$day, $cid]);
}
/** A new open session (any open one ended first), numbered after the campaign's last. */
function session_create(int $cid, int $firstDay, string $title = '', ?string $playedOn = null): int {
    sessions_end_all($cid);
    $st = db()->prepare('SELECT COALESCE(MAX(number), 0) + 1 FROM play_sessions WHERE campaign_id=? FOR UPDATE');
    $st->execute([$cid]);
    db()->prepare('INSERT INTO play_sessions (campaign_id, number, title, played_on, first_day, created_by) VALUES (?,?,?,?,?,?)')
        ->execute([$cid, (int)$st->fetchColumn(), $title, $playedOn ?? date('Y-m-d'), $firstDay, me()['id']]);
    return (int)db()->lastInsertId();
}
/** A real-world date as YYYY-MM-DD, or null. */
function date_in($v): ?string {
    if ($v === null || $v === '') return null;
    if (!is_string($v) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) || !checkdate((int)substr($v, 5, 2), (int)substr($v, 8, 2), (int)substr($v, 0, 4))) fail('Pick a date');
    return $v;
}

require_method('GET', 'POST');
if ($method === 'POST') require_csrf();

$readActions = ['campaigns', 'campaign', 'changed', 'days', 'day', 'events', 'downtimes', 'holdings', 'reminders', 'users', 'member_candidates',
    'encyclopedia', 'encyclopedia_sources', 'library', 'tome', 'files', 'file', 'sessions', 'session', 'image_search'];
if ($method === 'GET' && !in_array($action, $readActions, true)) fail('Use POST for this action', 405);
if ($method === 'POST' && in_array($action, $readActions, true)) fail('Use GET for this action', 405);

// A GM's change to a campaign bumps campaigns.updated_at, which open pages poll ('changed') to tell
// players the calendar has changed. days_save is left out: it is the GM's browser storing generated
// weather on its own, which players' pages already work out the same way.
$touchActions = ['campaign_update', 'set_time', 'member_add', 'member_remove', 'member_character', 'region_save', 'region_delete',
    'holiday_save', 'holiday_delete', 'day_update', 'shift_save', 'shifts_fill', 'shift_note_add', 'shift_note_delete',
    'event_save', 'event_delete', 'note_add', 'note_delete', 'downtime_save', 'downtime_delete',
    'gear_save', 'gear_tick', 'gear_delete', 'holding_save', 'holding_tick', 'holding_delete', 'storage_save', 'storage_delete', 'funds_save', 'funds_delete',
    'entry_save', 'entries_add', 'entry_delete', 'tome_save', 'tome_delete', 'file_upload', 'image_import', 'file_update', 'file_delete', 'secret_reveal',
    'session_save', 'session_end', 'session_delete'];
if ($method === 'POST' && in_array($action, $touchActions, true)) {
    register_shutdown_function(function () {
        if (http_response_code() >= 400) return;
        try {
            $cid = (int)($_GET['cid'] ?? p('cid'));
            if ($cid > 0 && role($cid) === 'gm') db()->prepare('UPDATE campaigns SET updated_at=CURRENT_TIMESTAMP WHERE id=?')->execute([$cid]);
        } catch (Throwable $e) { /* the change itself is saved; only the notice is lost */ }
    });
}

try {
    switch ($action) {

    // ===== account =====
    case 'prefs_save':
        // Only the keys sent are changed, so the theme picker and the units form don't overwrite each other.
        $u = me();
        $prefs = user_prefs($u['id']);
        // units: 'metric' or 'imperial' for every length, speed and temperature, or null to show each campaign's own.
        // It replaces the older temperature-only temp_unit, which is dropped once units is saved.
        if (array_key_exists('units', body())) {
            $units = p('units');
            if ($units !== null && !in_array($units, UNIT_SYSTEMS, true)) fail('Units must be metric or imperial');
            unset($prefs['temp_unit']);
            if ($units === null) unset($prefs['units']); else $prefs['units'] = $units;
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
        // member says whether they belong to it (an admin is shown every campaign as GM); character_name is theirs there.
        $st = db()->prepare($u['is_admin']
            ? "SELECT c.id, c.name, c.description, COALESCE(m.role, 'gm') AS role, COALESCE(m.character_name, '') AS character_name, m.user_id IS NOT NULL AS member FROM campaigns c LEFT JOIN campaign_members m ON m.campaign_id=c.id AND m.user_id=? ORDER BY c.name"
            : 'SELECT c.id, c.name, c.description, m.role, m.character_name, 1 AS member FROM campaigns c JOIN campaign_members m ON m.campaign_id=c.id WHERE m.user_id=? ORDER BY c.name');
        $st->execute([$u['id']]);
        out(['campaigns' => array_map(fn($r) => ['member' => (bool)(int)$r['member']] + $r, $st->fetchAll())]);

    case 'campaign':
        $cid = cid();
        $role = role($cid);
        $c = campaign_row($cid);
        $isGm = $role === 'gm';
        $camp = [
            'id' => (int)$c['id'], 'name' => $c['name'], 'description' => $c['description'],
            'calendar' => dec($c['calendar_json']), 'settings' => (object)(dec($c['settings_json']) ?: []),
            'current_shift' => (int)$c['current_shift'], 'changed' => (string)$c['updated_at'],
        ];
        // The weather engine rolls every future day from the seed, so a player who may not see future weather
        // doesn't get it: their page uses the shifts the GM's browser saves with each day's weather instead.
        if ($isGm || !empty((dec($c['settings_json']) ?: [])['players_see_future_weather'])) $camp['seed'] = (int)$c['seed'];
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
        out(['campaign' => $camp, 'role' => $role, 'regions' => $regions, 'holidays' => $holidays, 'members' => $members, 'tags' => campaign_tags($cid),
            'encyclopedia_ready' => has_encyclopedia(), 'encyclopedia' => entry_index($cid, $isGm), 'encyclopedia_ignored' => ignored_terms($cid, $role),
            'encyclopedia_tags' => entry_tags($cid), 'library_ready' => has_library(), 'sessions_ready' => has_sessions(),
            'viewing_as_player' => !empty($GLOBALS['viewing_as_player'])]
            + ($isGm && has_sessions() ? ['open_session' => ($o = open_session($cid)) ? session_out($o, false, true) : null] : []));

    case 'changed': // polled by open pages: a new value means a GM changed something since
        $cid = cid();
        role($cid);
        $st = db()->prepare('SELECT updated_at FROM campaigns WHERE id=?');
        $st->execute([$cid]);
        out(['changed' => (string)$st->fetchColumn()]);

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
                ->execute([$cid, str_in($h['name'] ?? 'Holiday', 150, false), json_in($h['rule'] ?? []), str_in($h['description'] ?? null, 5000), holiday_color($h['color'] ?? null), !empty($h['is_secret']) ? 1 : 0]);
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
        $oldCal = dec($c['calendar_json']); $newCal = dec($cal);
        $pdo = db();
        $pdo->beginTransaction();
        try {
            // A new time mode (or a new number of hours in hours mode) moves the clock and everything kept by shift.
            if (time_mode($oldCal) !== time_mode($newCal) || slots_per_day($oldCal) !== slots_per_day($newCal)) convert_time_mode($pdo, $cid, $oldCal, $newCal);
            $pdo->prepare('UPDATE campaigns SET name=?, description=?, calendar_json=?, settings_json=? WHERE id=?')
                ->execute([$name, str_in($desc, 5000), $cal, $settings, $cid]);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        out(['ok' => true]);

    case 'campaign_delete':
        $cid = cid(); need_gm($cid);
        if (p('confirm') !== 'DELETE') fail('Confirmation missing');
        attachments_purge($cid);
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
        // Only a site admin sees their emails: any approved user can start a campaign and be its GM, so the
        // rest get names, and add someone without a name by typing their sign-in email.
        $st = db()->prepare("SELECT id, email, display_name FROM users WHERE status='approved' AND id NOT IN (SELECT user_id FROM campaign_members WHERE campaign_id=?) ORDER BY display_name = '', display_name, email");
        $st->execute([$cid]);
        $users = $st->fetchAll();
        if (!me()['is_admin']) $users = array_values(array_map(fn($x) => ['id' => $x['id'], 'display_name' => $x['display_name']],
            array_filter($users, fn($x) => trim((string)$x['display_name']) !== '')));
        out(['users' => $users]);

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
        $args = [str_in(p('name'), 150, false), json_in(p('rule', [])), str_in(p('description'), 5000), holiday_color(p('color')), p('is_secret') ? 1 : 0];
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
        $today = floordiv((int)$c['current_shift'], camp_spd($c));
        $hideFuture = !$isGm && empty($settings['players_see_future_weather']);
        $order = shift_order($c);

        $st = db()->prepare('SELECT abs_day, region_id, weather_json, notes, notes_format, gm_notes, gm_notes_format FROM days WHERE campaign_id=? AND abs_day BETWEEN ? AND ?');
        $st->execute([$cid, $from, $to]);
        $days = [];
        $notes = []; // abs_day => short previews for the month grid, only what this member may read
        $clip = fn(string $t): string => mb_strlen($t) > 280 ? rtrim(mb_substr($t, 0, 279)) . '…' : $t;
        $addNote = function (int $ad, array $n) use (&$notes, $clip) {
            $notes[$ad] ??= ['abs_day' => $ad, 'count' => 0, 'items' => []];
            $notes[$ad]['count']++;
            if (count($notes[$ad]['items']) < 8) $notes[$ad]['items'][] = ['text' => $clip(trim($n['text']))] + $n;
        };
        foreach ($st->fetchAll() as $d) {
            $ad = (int)$d['abs_day'];
            // a Public note's secret paragraphs preview with the GM notes, for GMs only
            $html = $d['notes_format'] === 'html';
            $dn = day_note_text($html ? rich_open($d['notes']) : $d['notes'], $d['notes_format']);
            $gn = $isGm ? day_note_text($d['gm_notes'], $d['gm_notes_format']) : '';
            $sn = $isGm && $html ? rich_html_plain(rich_secrets($d['notes'])) : '';
            if (trim($dn) !== '') $addNote($ad, ['kind' => 'day', 'text' => $dn]);
            if (trim($sn) !== '') $addNote($ad, ['kind' => 'gm', 'text' => $sn]);
            if (trim($gn) !== '') $addNote($ad, ['kind' => 'gm', 'text' => $gn]);
            $days[] = [
                'abs_day' => $ad,
                'region_id' => $d['region_id'] !== null ? (int)$d['region_id'] : null,
                'weather' => visible_weather($d['weather_json'], $ad, (int)$c['current_shift'], $hideFuture, $order, dec($c['calendar_json'])),
            ];
        }
        $st = db()->prepare('SELECT abs_day, shift, activity, visibility_override' . ($isGm ? ', gm_notes' : '') . ' FROM shifts WHERE campaign_id=? AND abs_day BETWEEN ? AND ?');
        $st->execute([$cid, $from, $to]);
        $shifts = $st->fetchAll();
        $st = db()->prepare('SELECT id, abs_day, end_day, shift, shift_end, title, is_secret FROM events WHERE campaign_id=? AND abs_day <= ? AND COALESCE(end_day, abs_day) >= ?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY abs_day, shift');
        $st->execute([$cid, $to, $from]);
        $events = $st->fetchAll();
        attach_tags($events);
        $st = db()->prepare('SELECT n.abs_day, n.shift, n.body, ' . AUTHOR_SQL . ' AS author
            FROM shift_notes n LEFT JOIN users u ON u.id=n.user_id LEFT JOIN campaign_members m ON m.campaign_id=n.campaign_id AND m.user_id=n.user_id
            WHERE n.campaign_id=? AND n.abs_day BETWEEN ? AND ? ORDER BY n.abs_day, n.shift, n.created_at, n.id');
        $st->execute([$cid, $from, $to]);
        foreach ($st->fetchAll() as $n) {
            if (trim($n['body']) !== '') $addNote((int)$n['abs_day'], ['kind' => 'shift', 'shift' => (int)$n['shift'], 'author' => $n['author'], 'text' => $n['body']]);
        }
        out(['days' => $days, 'shifts' => $shifts, 'events' => $events, 'notes' => array_values($notes), 'today' => $today]);

    // ===== every event, for the Events tab's list and search =====
    case 'events':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $st = db()->prepare('SELECT e.id, e.abs_day, e.end_day, e.shift, e.shift_end, e.title, e.body, e.is_secret, ' . AUTHOR_SQL . ' AS author
            FROM events e LEFT JOIN users u ON u.id=e.created_by LEFT JOIN campaign_members m ON m.campaign_id=e.campaign_id AND m.user_id=e.created_by
            WHERE e.campaign_id=?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY e.abs_day, e.shift IS NOT NULL, e.shift, e.id');
        $st->execute([$cid]);
        $events = $st->fetchAll();
        if ($events) {
            // note bodies come along so the search finds an event by what was said about it
            $st = db()->prepare('SELECT n.event_id, n.body FROM event_notes n JOIN events e ON e.id=n.event_id
                WHERE e.campaign_id=?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY n.created_at, n.id');
            $st->execute([$cid]);
            $notes = [];
            foreach ($st->fetchAll() as $n) $notes[$n['event_id']][] = $n['body'];
            foreach ($events as &$e) $e['notes'] = $notes[$e['id']] ?? [];
            unset($e);
            attach_tags($events);
        }
        out(['events' => $events]);

    // ===== single day drill-down =====
    case 'day':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $ad = int_in($_GET['d'] ?? 0);
        $c = campaign_row($cid);
        $settings = dec($c['settings_json']) ?: [];
        $today = floordiv((int)$c['current_shift'], camp_spd($c));
        $st = db()->prepare('SELECT abs_day, region_id, weather_json, notes, notes_format, gm_notes, gm_notes_format, locations FROM days WHERE campaign_id=? AND abs_day=?');
        $st->execute([$cid, $ad]);
        $d = $st->fetch() ?: null;
        $day = null;
        if ($d) {
            $hideFuture = !$isGm && empty($settings['players_see_future_weather']);
            $order = shift_order($c);
            $day = ['abs_day' => $ad, 'region_id' => $d['region_id'] !== null ? (int)$d['region_id'] : null,
                'weather' => visible_weather($d['weather_json'], $ad, (int)$c['current_shift'], $hideFuture, $order, dec($c['calendar_json'])), 'notes' => note_for($d['notes'], $d['notes_format'], $isGm),
                'notes_format' => $d['notes_format'], 'locations' => $d['locations']];
            if ($isGm) $day += ['gm_notes' => $d['gm_notes'], 'gm_notes_format' => $d['gm_notes_format']];
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
        // Region, notes and locations only change when sent, so the Weather and Notes boxes save apart and older
        // callers don't wipe what they leave out. A note sent with format 'html' is rich text and is cleaned here.
        $has = fn(string $k): int => array_key_exists($k, body()) ? 1 : 0;
        $note = function (string $k): array {
            if (p($k . '_format') !== 'html') return [str_in(p($k), 20000), 'plain'];
            $html = rich_html_clean((string)str_in(p($k), 200000));
            return [$html === '' ? null : $html, 'html'];
        };
        [$notes, $notesFmt] = $note('notes');
        [$gmNotes, $gmNotesFmt] = $note('gm_notes');
        db()->prepare('INSERT INTO days (campaign_id, abs_day, region_id, weather_json, notes, notes_format, gm_notes, gm_notes_format, locations) VALUES (?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE region_id=IF(?, VALUES(region_id), region_id), weather_json=COALESCE(VALUES(weather_json), weather_json),
            notes=IF(?, VALUES(notes), notes), notes_format=IF(?, VALUES(notes_format), notes_format),
            gm_notes=IF(?, VALUES(gm_notes), gm_notes), gm_notes_format=IF(?, VALUES(gm_notes_format), gm_notes_format),
            locations=IF(?, VALUES(locations), locations)')
            ->execute([$cid, $ad, $rid, $weather, $notes, $notesFmt, $gmNotes, $gmNotesFmt, str_in(p('locations'), 5000),
                $has('region_id'), $has('notes'), $has('notes'), $has('gm_notes'), $has('gm_notes'), $has('locations')]);
        out(['ok' => true]);

    case 'shift_save':
        $cid = cid(); need_gm($cid);
        $maxSlot = camp_spd(campaign_row($cid)) - 1;
        $vo = p('visibility_override');
        $vo = ($vo === null || $vo === '') ? null : int_in($vo, 0, 5);
        db()->prepare('INSERT INTO shifts (campaign_id, abs_day, shift, activity, gm_notes, visibility_override) VALUES (?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE activity=VALUES(activity), gm_notes=VALUES(gm_notes), visibility_override=VALUES(visibility_override)')
            ->execute([$cid, int_in(p('abs_day')), int_in(p('shift'), 0, $maxSlot), str_in(p('activity'), 5000), str_in(p('gm_notes'), 5000), $vo]);
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
        $spd = camp_spd(campaign_row($cid));
        for ($s = $from; $s <= $to; $s++) $st->execute([$cid, floordiv($s, $spd), $s - $spd * floordiv($s, $spd), $act]);
        db()->commit();
        out(['ok' => true]);

    case 'shift_note_add': // anyone in the campaign, GM or player
        $cid = cid();
        role($cid);
        $text = trim((string)str_in(p('body'), 5000, false));
        if ($text === '') fail('Note is empty');
        db()->prepare('INSERT INTO shift_notes (campaign_id, abs_day, shift, user_id, body) VALUES (?,?,?,?,?)')
            ->execute([$cid, int_in(p('abs_day')), int_in(p('shift'), 0, camp_spd(campaign_row($cid)) - 1), me()['id'], $text]);
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
        if ($role !== 'gm' && empty($settings['players_can_add_events'])) fail('Only the GM can add events in this campaign', 403);
        $old = null;
        if ($id) {
            // the event must be this campaign's, or its tags (saved below by event id) would be another campaign's
            $st = db()->prepare('SELECT created_by, is_secret FROM events WHERE id=? AND campaign_id=?');
            $st->execute([$id, $cid]);
            $old = $st->fetch();
            if (!$old) fail('Event not found', 404);
            if ($role !== 'gm' && (int)$old['created_by'] !== $u['id']) fail('You can only edit events you created', 403);
        }
        $ad = int_in(p('abs_day'));
        $end = p('end_day');
        $end = ($end === null || $end === '') ? null : int_in($end);
        if ($end !== null && $end < $ad) fail('End day is before start day');
        if ($end === $ad) $end = null;
        // shift empty = all day. Otherwise the event runs from shift (on abs_day)
        // to shift_end (on end_day, or the same day); shift_end defaults to shift.
        $maxSlot = camp_spd(campaign_row($cid)) - 1;
        $shift = p('shift');
        $shift = ($shift === null || $shift === '') ? null : int_in($shift, 0, $maxSlot);
        $shiftEnd = p('shift_end');
        $shiftEnd = ($shift === null) ? null : (($shiftEnd === null || $shiftEnd === '') ? $shift : int_in($shiftEnd, 0, $maxSlot));
        if ($shift !== null && $end === null && $shiftEnd < $shift) fail('Shift End is before Shift Start');
        // a player's edit keeps whatever the GM set; only a GM makes an event secret or not
        $secret = $role === 'gm' ? (p('is_secret') ? 1 : 0) : ($old ? (int)$old['is_secret'] : 0);
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

    // ===== party holdings: the Gear and Loot list and the holding cards, open to GM and players alike =====
    case 'holdings':
        $cid = cid();
        role($cid);
        $st = db()->prepare('SELECT id, item, claimed_by, location, amount FROM party_gear WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        $gear = array_map(function ($r) { $r['id'] = (int)$r['id']; $r['amount'] = (int)$r['amount']; return $r; }, $st->fetchAll());
        $st = db()->prepare('SELECT id, name, kind, type_name, location, description, amount, stats_json FROM holdings WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        $holdings = array_map(function ($r) {
            $r['id'] = (int)$r['id']; $r['amount'] = (int)$r['amount'];
            $r['stats'] = (object)(dec($r['stats_json']) ?: []);
            unset($r['stats_json']);
            return $r;
        }, $st->fetchAll());
        attach_tags($holdings, 'holding');
        if ($holdings) {
            $ids = array_column($holdings, 'id');
            $st = db()->prepare('SELECT id, holding_id, item, weight FROM holding_storage WHERE holding_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ') ORDER BY id');
            $st->execute($ids);
            $by = [];
            foreach ($st->fetchAll() as $r) $by[$r['holding_id']][] = ['id' => (int)$r['id'], 'item' => $r['item'], 'weight' => $r['weight'] === null ? null : (float)$r['weight']];
            foreach ($holdings as &$h) $h['storage'] = $by[$h['id']] ?? [];
            unset($h);
        }
        $st = db()->prepare('SELECT id, name, color FROM holding_tag_names WHERE campaign_id=? ORDER BY name');
        $st->execute([$cid]);
        $tags = array_map(fn($t) => ['id' => (int)$t['id'], 'name' => $t['name'], 'color' => $t['color']], $st->fetchAll());
        $st = db()->prepare('SELECT id, currency, location, amount FROM party_funds WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        $funds = array_map(fn($r) => ['id' => (int)$r['id'], 'currency' => $r['currency'], 'location' => $r['location'], 'amount' => (float)$r['amount']], $st->fetchAll());
        out(['funds' => $funds, 'gear' => $gear, 'holdings' => $holdings, 'tags' => $tags]);

    case 'gear_save':
        $cid = cid();
        role($cid);
        $row = [trim((string)str_in(p('item'), 200, false)), trim((string)str_in(p('claimed_by'), 200, false)),
            trim((string)str_in(p('location'), 200, false))];
        if (p('id')) {
            // amount is only changed when sent, so editing a box doesn't undo someone else's tick
            $id = int_in(p('id'), 1);
            $old = holding_row('party_gear', $id, $cid);
            $amount = array_key_exists('amount', body()) ? int_in(p('amount'), 0, HOLDING_MAX) : (int)$old['amount'];
            db()->prepare('UPDATE party_gear SET item=?, claimed_by=?, location=?, amount=? WHERE id=?')->execute([...$row, $amount, $id]);
            out(['ok' => true, 'id' => $id]);
        }
        if ($row[0] === '') fail('Name the item');
        db()->prepare('INSERT INTO party_gear (campaign_id, item, claimed_by, location, amount, created_by) VALUES (?,?,?,?,?,?)')
            ->execute([$cid, ...$row, int_in(p('amount', 1), 0, HOLDING_MAX), me()['id']]);
        out(['ok' => true, 'id' => (int)db()->lastInsertId()]);

    case 'gear_tick':
        $cid = cid();
        role($cid);
        out(['ok' => true, 'amount' => holding_tick('party_gear', $cid)]);

    case 'gear_delete':
        $cid = cid();
        role($cid);
        db()->prepare('DELETE FROM party_gear WHERE id=? AND campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        out(['ok' => true]);

    case 'holding_save':
        $cid = cid();
        role($cid);
        $id = p('id') ? int_in(p('id'), 1) : null;
        if ($id) holding_row('holdings', $id, $cid);
        $kind = (string)p('kind');
        if (!isset(HOLDING_KINDS[$kind])) fail('Pick a type: Vehicle, Animal, Building, Asset or Custom');
        $name = trim((string)str_in(p('name'), 200, false));
        if ($name === '') fail('Give the holding a name');
        $typeName = $kind === 'custom' ? trim((string)str_in(p('type_name'), 60, false)) : '';
        if ($kind === 'custom' && $typeName === '') fail('Name the custom type');
        $row = [$name, $kind, $typeName, trim((string)str_in(p('location'), 200, false)), str_in(p('description'), 20000),
            int_in(p('amount', 1), 0, HOLDING_MAX), holding_stats(p('stats'), $kind)];
        $pdo = db();
        $pdo->beginTransaction();
        if ($id) {
            $pdo->prepare('UPDATE holdings SET name=?, kind=?, type_name=?, location=?, description=?, amount=?, stats_json=? WHERE id=?')->execute([...$row, $id]);
        } else {
            $pdo->prepare('INSERT INTO holdings (name, kind, type_name, location, description, amount, stats_json, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
                ->execute([...$row, $cid, me()['id']]);
            $id = (int)$pdo->lastInsertId();
        }
        if (array_key_exists('tags', body())) save_event_tags($cid, $id, p('tags'), 'holding');
        $pdo->commit();
        out(['ok' => true, 'id' => $id]);

    case 'holding_tick':
        $cid = cid();
        role($cid);
        out(['ok' => true, 'amount' => holding_tick('holdings', $cid)]);

    case 'funds_save': // a line of Party Funds: a kind of money, where it is kept and how much; new, or changed (id)
        $cid = cid();
        role($cid);
        $currency = trim((string)str_in(p('currency'), 60, false));
        if ($currency === '') fail('Name the currency');
        $location = trim((string)str_in(p('location'), 200, false));
        $a = p('amount', 0);
        if ($a === '' || $a === null) $a = 0;
        if (!is_numeric($a) || abs((float)$a) > 1e13) fail('The amount must be a number');
        $a = round((float)$a, 2);
        if (p('id')) {
            $id = int_in(p('id'), 1);
            holding_row('party_funds', $id, $cid);
            db()->prepare('UPDATE party_funds SET currency=?, location=?, amount=? WHERE id=?')->execute([$currency, $location, $a, $id]);
            out(['ok' => true, 'id' => $id]);
        }
        db()->prepare('INSERT INTO party_funds (campaign_id, currency, location, amount, created_by) VALUES (?,?,?,?,?)')->execute([$cid, $currency, $location, $a, me()['id']]);
        out(['ok' => true, 'id' => (int)db()->lastInsertId()]);

    case 'funds_delete':
        $cid = cid();
        role($cid);
        db()->prepare('DELETE FROM party_funds WHERE id=? AND campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        out(['ok' => true]);

    case 'storage_save': // a line in a holding's Storage box: new (holding_id) or changed (id)
        $cid = cid();
        role($cid);
        $item = trim((string)str_in(p('item'), 200, false));
        if ($item === '') fail('Name the item');
        $w = p('weight');
        if ($w === '' || $w === null) $w = null;
        elseif (!is_numeric($w) || (float)$w < 0 || (float)$w > 1e12) fail('Weight must be a number, 0 or more');
        else $w = round((float)$w, 2);
        if (p('id')) {
            $id = int_in(p('id'), 1);
            $st = db()->prepare('SELECT s.id FROM holding_storage s JOIN holdings h ON h.id=s.holding_id WHERE s.id=? AND h.campaign_id=?');
            $st->execute([$id, $cid]);
            if (!$st->fetchColumn()) fail('Item not found', 404);
            db()->prepare('UPDATE holding_storage SET item=?, weight=? WHERE id=?')->execute([$item, $w, $id]);
            out(['ok' => true, 'id' => $id]);
        }
        $hid = int_in(p('holding_id'), 1);
        holding_row('holdings', $hid, $cid);
        db()->prepare('INSERT INTO holding_storage (holding_id, item, weight, created_by) VALUES (?,?,?,?)')->execute([$hid, $item, $w, me()['id']]);
        out(['ok' => true, 'id' => (int)db()->lastInsertId()]);

    case 'storage_delete':
        $cid = cid();
        role($cid);
        db()->prepare('DELETE s FROM holding_storage s JOIN holdings h ON h.id=s.holding_id WHERE s.id=? AND h.campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        out(['ok' => true]);

    case 'holding_delete':
        $cid = cid();
        role($cid);
        db()->prepare('DELETE FROM holdings WHERE id=? AND campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        out(['ok' => true]);

    // ===== reminders: pop up when the campaign clock reaches them =====
    case 'reminders':
        // Everything this user may see, with whether it is due (the clock has reached it) and whether they dismissed it.
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $uid = me()['id'];
        $now = (int)campaign_row($cid)['current_shift'];
        $st = db()->prepare('SELECT r.id, r.due_shift, r.title, r.body, r.audience, r.created_by, ' . AUTHOR_SQL . ' AS author, u.display_name AS player,
                (dm.user_id IS NOT NULL) AS dismissed
            FROM reminders r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN campaign_members m ON m.campaign_id=r.campaign_id AND m.user_id=r.created_by
            LEFT JOIN reminder_dismissals dm ON dm.reminder_id=r.id AND dm.user_id=?
            WHERE r.campaign_id=? AND ' . reminder_visible_sql($isGm) . ' ORDER BY r.due_shift, r.id');
        $st->execute([$uid, $cid, $uid]);
        $rows = array_map(function ($r) use ($now) {
            foreach (['id', 'due_shift'] as $k) $r[$k] = (int)$r[$k];
            $r['created_by'] = $r['created_by'] !== null ? (int)$r['created_by'] : null;
            $r['dismissed'] = (bool)$r['dismissed'];
            $r['due'] = $r['due_shift'] <= $now;
            return $r;
        }, $st->fetchAll());
        out(['reminders' => $rows, 'current_shift' => $now]);

    case 'reminder_save':
        // Anyone can keep reminders for themselves; a GM can also share one with the GMs or with everyone.
        $cid = cid();
        $role = role($cid);
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? editable_reminder($cid, $id, $role) : null;
        $title = trim((string)str_in(p('title'), 200, false));
        if ($title === '') fail('Give the reminder a title');
        $audience = (string)p('audience', 'me');
        if (!in_array($audience, REMINDER_AUDIENCES, true)) fail('Pick who the reminder is for');
        if ($role !== 'gm' && $audience !== 'me') fail('Only a GM can share a reminder', 403);
        $due = int_in(p('due_shift'));
        $moved = !$old || (int)$old['due_shift'] !== $due;
        if ($moved && $due <= (int)campaign_row($cid)['current_shift']) fail('Pick a time after now: the clock has already passed that one');
        db()->beginTransaction();
        if ($old) {
            db()->prepare('UPDATE reminders SET due_shift=?, title=?, body=?, audience=? WHERE id=?')->execute([$due, $title, str_in(p('body'), 5000), $audience, $id]);
            // moved to a new time: it pops up again for everyone, even those who dismissed it
            if ($moved) db()->prepare('DELETE FROM reminder_dismissals WHERE reminder_id=?')->execute([$id]);
        } else {
            db()->prepare('INSERT INTO reminders (campaign_id, due_shift, title, body, audience, created_by) VALUES (?,?,?,?,?,?)')
                ->execute([$cid, $due, $title, str_in(p('body'), 5000), $audience, me()['id']]);
            $id = (int)db()->lastInsertId();
        }
        if ($role === 'gm' && ($audience !== 'me' || ($old && $old['audience'] !== 'me'))) touch_campaign($cid);
        db()->commit();
        out(['ok' => true, 'id' => $id]);

    case 'reminder_delete':
        $cid = cid();
        $role = role($cid);
        $r = editable_reminder($cid, int_in(p('id'), 1), $role);
        db()->prepare('DELETE FROM reminders WHERE id=?')->execute([$r['id']]);
        if ($role === 'gm' && $r['audience'] !== 'me') touch_campaign($cid);
        out(['ok' => true]);

    case 'reminder_dismiss':
        // This user has read these reminders: they stop popping up for them (and only them).
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $uid = me()['id'];
        $ids = array_slice(array_map('intval', (array)p('ids', [])), 0, 200);
        $seen = db()->prepare('SELECT r.id FROM reminders r WHERE r.id=? AND r.campaign_id=? AND ' . reminder_visible_sql($isGm));
        $ins = db()->prepare('INSERT IGNORE INTO reminder_dismissals (reminder_id, user_id) VALUES (?,?)');
        foreach ($ids as $rid) {
            $seen->execute([$rid, $cid, $uid]);
            if ($seen->fetchColumn()) $ins->execute([$rid, $uid]);
        }
        out(['ok' => true]);

    // ===== the Encyclopedia =====
    case 'encyclopedia':
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        need_encyclopedia();
        $st = db()->prepare('SELECT e.id, e.name, e.aliases_json, e.notes, ' . ($isGm ? 'e.gm_notes, ' : '') . 'e.is_secret, e.created_by, e.updated_at, ' . AUTHOR_SQL . ' AS author, u.display_name AS player
            FROM encyclopedia_entries e LEFT JOIN users u ON u.id=e.created_by LEFT JOIN campaign_members m ON m.campaign_id=e.campaign_id AND m.user_id=e.created_by
            WHERE e.campaign_id=?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY e.name');
        $st->execute([$cid]);
        $entries = array_map(function ($e) use ($isGm) {
            $e['id'] = (int)$e['id'];
            $e['aliases'] = entry_aliases($e);
            $e['notes'] = rich_for($e['notes'], $isGm);
            unset($e['aliases_json']);
            $e['is_secret'] = (bool)$e['is_secret'];
            $e['created_by'] = $e['created_by'] !== null ? (int)$e['created_by'] : null;
            return $e;
        }, $st->fetchAll());
        attach_tags($entries, 'entry');
        out(['entries' => $entries, 'tags' => entry_tags($cid), 'ignored' => ignored_terms($cid, $role),
            'relations_ready' => has_relations(), 'relations' => relations_list($cid, $isGm), 'relation_types' => relation_types($cid, $isGm),
            'files' => entry_files($cid, $isGm), 'uploads' => upload_info()]);

    case 'encyclopedia_sources':
        // Everything written in the campaign that this member may read, for the detector's full scan and for an
        // entry's "Mentioned in" list. secret: only GMs can read it, so names found only there start as GM only.
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        $out = [];
        $add = function (array $src, $text, bool $secret = false, string $format = 'plain') use (&$out) {
            if (trim((string)$text) === '') return;
            $out[] = $src + ['text' => (string)$text, 'format' => $format, 'secret' => $secret];
        };
        $st = db()->prepare("SELECT abs_day, notes, notes_format, gm_notes, gm_notes_format, locations FROM days WHERE campaign_id=?
            AND (COALESCE(notes, '') <> '' OR COALESCE(gm_notes, '') <> '' OR COALESCE(locations, '') <> '') ORDER BY abs_day");
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $d) {
            $ad = (int)$d['abs_day'];
            $add(['kind' => 'locations', 'abs_day' => $ad], $d['locations']);
            if ($d['notes_format'] === 'html') {
                $add(['kind' => 'day_notes', 'abs_day' => $ad], rich_open($d['notes']), false, 'html');
                if ($isGm) $add(['kind' => 'day_notes', 'abs_day' => $ad], rich_secrets($d['notes']), true, 'html');
            } else $add(['kind' => 'day_notes', 'abs_day' => $ad], $d['notes'], false, $d['notes_format']);
            if ($isGm) $add(['kind' => 'day_gm_notes', 'abs_day' => $ad], $d['gm_notes'], true, $d['gm_notes_format']);
        }
        $st = db()->prepare('SELECT abs_day, shift, activity' . ($isGm ? ', gm_notes' : '') . ' FROM shifts WHERE campaign_id=? ORDER BY abs_day, shift');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $s) {
            $src = ['abs_day' => (int)$s['abs_day'], 'shift' => (int)$s['shift']];
            $add(['kind' => 'activity'] + $src, $s['activity']);
            if ($isGm) $add(['kind' => 'shift_gm_notes'] + $src, $s['gm_notes'], true);
        }
        $st = db()->prepare('SELECT abs_day, shift, body FROM shift_notes WHERE campaign_id=? ORDER BY abs_day, shift, id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $n) $add(['kind' => 'shift_note', 'abs_day' => (int)$n['abs_day'], 'shift' => (int)$n['shift']], $n['body']);
        $st = db()->prepare('SELECT id, abs_day, title, body, is_secret FROM events WHERE campaign_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY abs_day, id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $e) {
            $src = ['kind' => 'event', 'id' => (int)$e['id'], 'abs_day' => (int)$e['abs_day'], 'title' => $e['title']];
            $add($src, trim($e['title'] . "\n" . $e['body']), (bool)$e['is_secret']);
        }
        $st = db()->prepare('SELECT e.id, e.abs_day, e.title, e.is_secret, n.body FROM event_notes n JOIN events e ON e.id=n.event_id
            WHERE e.campaign_id=?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY e.abs_day, n.id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $n) $add(['kind' => 'event_note', 'id' => (int)$n['id'], 'abs_day' => (int)$n['abs_day'], 'title' => $n['title']], $n['body'], (bool)$n['is_secret']);
        $uid = me()['id'];
        $spdC = camp_spd(campaign_row($cid));
        $st = db()->prepare('SELECT r.id, r.due_shift, r.title, r.body, r.audience FROM reminders r WHERE r.campaign_id=? AND ' . reminder_visible_sql($isGm) . ' ORDER BY r.due_shift, r.id');
        $st->execute([$cid, $uid]);
        foreach ($st->fetchAll() as $r) {
            $add(['kind' => 'reminder', 'id' => (int)$r['id'], 'abs_day' => floordiv((int)$r['due_shift'], $spdC), 'title' => $r['title']],
                trim($r['title'] . "\n" . $r['body']), $isGm && $r['audience'] !== 'all');
        }
        $st = db()->prepare('SELECT id, kind, title, start_shift, notes' . ($isGm ? ', gm_notes' : '') . ' FROM downtimes WHERE campaign_id=? ORDER BY start_shift, id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $d) {
            $src = ['kind' => 'downtime', 'id' => (int)$d['id'], 'abs_day' => floordiv((int)$d['start_shift'], $spdC), 'title' => $d['title'] ?: ucwords(str_replace('_', ' ', $d['kind']))];
            $add($src, trim($d['title'] . "\n" . $d['notes']));
            if ($isGm) $add(['kind' => 'downtime_gm_notes'] + $src, $d['gm_notes'], true);
        }
        // Party Holdings: short boxes (names, places, items) are read as titles, where an everyday first word isn't a name.
        $st = db()->prepare('SELECT id, name, location, description FROM holdings WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $h) {
            $add(['kind' => 'holding', 'id' => (int)$h['id'], 'title' => $h['name'], 'short' => true], trim($h['name'] . "\n" . $h['location']));
            $add(['kind' => 'holding', 'id' => (int)$h['id'], 'title' => $h['name']], $h['description']);
        }
        $st = db()->prepare('SELECT h.name, s.item FROM holding_storage s JOIN holdings h ON h.id=s.holding_id WHERE h.campaign_id=? ORDER BY s.id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $x) $add(['kind' => 'storage', 'title' => $x['name'], 'short' => true], $x['item']);
        $st = db()->prepare('SELECT item, location FROM party_gear WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $g) $add(['kind' => 'gear', 'short' => true], trim($g['item'] . "\n" . $g['location']));
        $st = db()->prepare('SELECT currency, location FROM party_funds WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $f) $add(['kind' => 'funds', 'short' => true], trim($f['currency'] . "\n" . $f['location']));
        if (has_library()) {
            $st = db()->prepare('SELECT id, title, description, body FROM library_tomes WHERE campaign_id=? ORDER BY title');
            $st->execute([$cid]);
            foreach ($st->fetchAll() as $t) {
                $add(['kind' => 'tome', 'id' => (int)$t['id'], 'title' => $t['title'], 'short' => true], trim($t['title'] . "\n" . $t['description']));
                $add(['kind' => 'tome', 'id' => (int)$t['id'], 'title' => $t['title']], rich_open($t['body']), false, 'html');
                if ($isGm) $add(['kind' => 'tome', 'id' => (int)$t['id'], 'title' => $t['title']], rich_secrets($t['body']), true, 'html');
            }
        }
        if (has_sessions()) {
            // a published summary for everyone (its secret paragraphs for GMs only); the rest, and the notes, for GMs
            $st = db()->prepare('SELECT * FROM play_sessions WHERE campaign_id=?' . ($isGm ? '' : ' AND is_published=1') . ' ORDER BY number');
            $st->execute([$cid]);
            foreach ($st->fetchAll() as $x) {
                $src = ['kind' => 'session', 'id' => (int)$x['id'], 'title' => $x['title'] !== '' ? $x['title'] : "Session {$x['number']}"];
                foreach (['summary', 'rewards', 'loot'] as $f) {
                    if (!array_key_exists($f, $x)) continue;
                    $add($src, rich_open($x[$f]), !(int)$x['is_published'], 'html');
                    if ($isGm) $add($src, rich_secrets($x[$f]), true, 'html');
                }
            }
            if ($isGm) {
                $st = db()->prepare('SELECT n.text, s.id, s.number, s.title FROM session_notes n JOIN play_sessions s ON s.id=n.session_id WHERE n.campaign_id=? ORDER BY s.number, n.position');
                $st->execute([$cid]);
                foreach ($st->fetchAll() as $x) $add(['kind' => 'session_note', 'id' => (int)$x['id'], 'title' => $x['title'] !== '' ? $x['title'] : "Session {$x['number']}", 'short' => true], $x['text'], true);
            }
        }
        if (has_encyclopedia()) {
            $st = db()->prepare('SELECT id, name, notes, is_secret' . ($isGm ? ', gm_notes' : '') . ' FROM encyclopedia_entries WHERE campaign_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY name');
            $st->execute([$cid]);
            foreach ($st->fetchAll() as $e) {
                $src = ['kind' => 'entry', 'id' => (int)$e['id'], 'title' => $e['name']];
                $add($src, rich_open($e['notes']), (bool)$e['is_secret'], 'html');
                if ($isGm) $add($src, rich_secrets($e['notes']), true, 'html');
                if ($isGm) $add(['kind' => 'entry_gm_notes'] + $src, $e['gm_notes'], true, 'html');
            }
        }
        out(['sources' => $out]);

    case 'entry_save':
        // A new entry, or a change to one. Players change the name, tags and Public notes of entries that aren't
        // secret; GM notes and whether an entry is secret are only for GMs, and are kept as they were otherwise.
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        need_encyclopedia();
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? entry_row($cid, $id, $role) : null;
        $name = entry_name(p('name'));
        $same = entry_named($cid, $name);
        if ($same && (int)$same['id'] !== $id) fail($isGm || !(int)$same['is_secret'] ? "\"$name\" is already a name of \"{$same['name']}\"" : 'Pick another name', 409);
        $aliases = array_key_exists('aliases', body()) ? aliases_in(p('aliases'), $cid, $name, $id) : ($old['aliases_json'] ?? null);
        $rich = fn(string $k) => array_key_exists($k, body()) ? (rich_html_clean((string)str_in(p($k), 200000)) ?: null) : ($old[$k] ?? null);
        $notes = $rich('notes');
        // a player never had the GM's secret paragraphs to send back, so they are kept from the stored copy
        if (!$isGm && array_key_exists('notes', body())) $notes = rich_keep_secrets($old['notes'] ?? null, (string)$notes) ?: null;
        $gmNotes = $isGm ? $rich('gm_notes') : ($old['gm_notes'] ?? null);
        $secret = $isGm ? (p('is_secret', $old ? (bool)$old['is_secret'] : false) ? 1 : 0) : 0;
        db()->beginTransaction();
        if ($old) {
            db()->prepare('UPDATE encyclopedia_entries SET name=?, aliases_json=?, notes=?, gm_notes=?, is_secret=? WHERE id=?')->execute([$name, $aliases, $notes, $gmNotes, $secret, $id]);
        } else {
            db()->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, aliases_json, notes, gm_notes, is_secret, created_by) VALUES (?,?,?,?,?,?,?)')
                ->execute([$cid, $name, $aliases, $notes, $gmNotes, $secret, me()['id']]);
            $id = (int)db()->lastInsertId();
        }
        if (array_key_exists('tags', body())) save_event_tags($cid, $id, p('tags'), 'entry');
        db()->commit();
        out(['ok' => true, 'id' => $id]);

    case 'secret_reveal':
        // GM: make a run of GM-only paragraphs public, in an entry's public notes or a tome, and (log) note it as an
        // event on the campaign's current day. which: the indexes of those <aside>s in the stored text, with the text the
        // GM's page showed for each, so a note changed since is refused rather than the wrong paragraphs revealed.
        $cid = cid(); need_gm($cid);
        $kind = p('kind');
        $id = int_in(p('id'), 1);
        if ($kind === 'entry') { need_encyclopedia(); $row = entry_row($cid, $id, 'gm'); $html = (string)$row['notes']; $name = $row['name']; }
        elseif ($kind === 'tome') { need_library(); $row = tome_row($cid, $id); $html = (string)$row['body']; $name = $row['title']; }
        else fail('Pick an entry or a tome');
        $which = p('which');
        if (!is_array($which) || !$which || count($which) > 200) fail('Pick the paragraphs to reveal');
        preg_match_all(RICH_SECRET_RE, $html, $m, PREG_OFFSET_CAPTURE);
        $plain = [];
        foreach ($which as $w) {
            $i = is_array($w) ? int_in($w['index'] ?? null) : -1;
            $hit = $m[0][$i] ?? null;
            $flat = fn(string $t) => trim(preg_replace('/\s+/u', ' ', $t) ?? '');
            $text = $hit ? rich_html_plain($hit[0]) : null;
            if ($text === null || $flat($text) !== $flat((string)($w['text'] ?? ''))) fail('This note has changed since you opened it. Reload and try again', 409, 'stale');
            $plain[$i] = $text;
        }
        krsort($plain);  // from the end, so the earlier offsets still hold
        foreach (array_keys($plain) as $i) {
            [$tag, $at] = $m[0][$i];
            $html = substr_replace($html, '<p>' . substr($tag, 7, -8) . '</p>', $at, strlen($tag));
        }
        if ($kind === 'entry') db()->prepare('UPDATE encyclopedia_entries SET notes=? WHERE id=?')->execute([$html, $id]);
        else db()->prepare('UPDATE library_tomes SET body=?, version=version+1, updated_by=? WHERE id=?')->execute([$html, me()['id'], $id]);
        $event = null;
        if (p('log')) {
            $c = campaign_row($cid);
            $today = floordiv((int)$c['current_shift'], camp_spd($c));
            db()->prepare('INSERT INTO events (abs_day, title, body, is_secret, campaign_id, created_by) VALUES (?,?,?,0,?,?)')
                ->execute([$today, mb_substr("Revealed: $name", 0, 200), implode("\n", array_reverse($plain)), $cid, me()['id']]);
            $event = (int)db()->lastInsertId();
            save_event_tags($cid, $event, [['name' => 'Revealed']]);
        }
        out(['ok' => true, 'event_id' => $event]);

    case 'entries_add':
        // The detector's approved names: [{name, is_secret, tags: [{name, color?}]}], or {name, alias_of: entry id} to add
        // the name to an entry that exists as another name for it. A name that is already a name of an entry is left as
        // it is. A player who sends the name of a secret entry is told nothing; the word joins the players' turned-down
        // list so they aren't asked about it again.
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        need_encyclopedia();
        $list = p('entries', []);
        if (!is_array($list) || count($list) > 500) fail('Send up to 500 entries at a time');
        $added = []; $aliased = [];
        $ins = db()->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, is_secret, created_by) VALUES (?,?,?,?)');
        $upd = db()->prepare('UPDATE encyclopedia_entries SET aliases_json=? WHERE id=?');
        $ign = db()->prepare('INSERT IGNORE INTO encyclopedia_ignored (campaign_id, scope, term) VALUES (?,?,?)');
        db()->beginTransaction();
        foreach ($list as $x) {
            if (!is_array($x)) fail('Expected a list of entries');
            $name = entry_name($x['name'] ?? '');
            $same = entry_named($cid, $name);
            if ($same) {
                if (!$isGm && (int)$same['is_secret']) $ign->execute([$cid, 'player', $name]);
                continue;
            }
            if (!empty($x['alias_of'])) {
                $of = entry_row($cid, int_in($x['alias_of'], 1), $role);
                $list = entry_aliases($of);
                $list[] = $name;
                $upd->execute([aliases_in($list, $cid, $of['name'], (int)$of['id']), $of['id']]);
                $aliased[] = ['id' => (int)$of['id'], 'name' => $of['name'], 'alias' => $name];
                continue;
            }
            $ins->execute([$cid, $name, $isGm && !empty($x['is_secret']) ? 1 : 0, me()['id']]);
            $id = (int)db()->lastInsertId();
            if (isset($x['tags'])) save_event_tags($cid, $id, $x['tags'], 'entry');
            $added[] = ['id' => $id, 'name' => $name];
        }
        db()->commit();
        out(['ok' => true, 'added' => $added, 'aliased' => $aliased]);

    case 'entry_delete':
        $cid = cid();
        $role = role($cid);
        need_encyclopedia();
        $e = entry_row($cid, int_in(p('id'), 1), $role);
        if ($role !== 'gm' && (int)$e['created_by'] !== me()['id']) fail('Only a GM can delete an entry someone else added', 403);
        db()->beginTransaction();
        attachments_purge($cid, 'encyclopedia', (int)$e['id']);
        db()->prepare('DELETE FROM encyclopedia_entries WHERE id=?')->execute([$e['id']]);
        db()->commit();
        out(['ok' => true]);

    case 'terms_ignore': // the detector stops offering these words to this member's side (the GMs, or the players)
        $cid = cid();
        $role = role($cid);
        need_encyclopedia();
        $terms = p('terms', []);
        if (!is_array($terms) || count($terms) > 500) fail('Send up to 500 words at a time');
        $ins = db()->prepare('INSERT IGNORE INTO encyclopedia_ignored (campaign_id, scope, term) VALUES (?,?,?)');
        foreach ($terms as $t) $ins->execute([$cid, ignore_scope($role), entry_name($t)]);
        out(['ok' => true]);

    case 'term_restore': // offer a turned-down word again
        $cid = cid();
        $role = role($cid);
        need_encyclopedia();
        db()->prepare('DELETE FROM encyclopedia_ignored WHERE campaign_id=? AND scope=? AND term=?')->execute([$cid, ignore_scope($role), entry_name(p('term'))]);
        out(['ok' => true]);

    // ===== connections between entries =====
    case 'relations_save':
        // Connect entry_id to the entries in add, and drop its connections to those in remove, all with one relationship:
        // type {id} or {label, inverse_label?, symmetric?, color?}. side 'from': entry_id reads the type's label
        // ("London Has resident …"); 'to': the inverse ("Gunther Resident of …"). A connection that touches a secret
        // entry is always GM only.
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        need_relations();
        $me = entry_row($cid, int_in(p('entry_id'), 1), $role);
        $add = p('add', []); $remove = p('remove', []);
        if (!is_array($add) || !is_array($remove) || count($add) + count($remove) > 200) fail('Send up to 200 entries at a time');
        $note = trim((string)str_in(p('note'), 200)) ?: null;
        $wantSecret = $isGm && p('is_secret', false);
        db()->beginTransaction();
        $flip = false;
        $tid = relation_type_id($cid, p('type'), $flip);
        $symmetric = relation_type_row($cid, $tid)['inverse_label'] === '';
        $atTo = (p('side', 'from') === 'to') !== $flip;
        $pair = fn(int $other): array => $atTo && !$symmetric ? [$other, (int)$me['id']] : [(int)$me['id'], $other];
        $ins = db()->prepare('INSERT IGNORE INTO encyclopedia_relations (campaign_id, from_id, to_id, type_id, note, is_secret, created_by) VALUES (?,?,?,?,?,?,?)');
        $back = db()->prepare('SELECT 1 FROM encyclopedia_relations WHERE type_id=? AND from_id=? AND to_id=?');
        foreach ($add as $x) {
            $o = entry_row($cid, int_in($x, 1), $role);
            if ((int)$o['id'] === (int)$me['id']) continue;
            [$f, $t] = $pair((int)$o['id']);
            if ($symmetric) { // already made from the other end
                $back->execute([$tid, $t, $f]);
                if ($back->fetchColumn()) continue;
            }
            $ins->execute([$cid, $f, $t, $tid, $note, $wantSecret || (int)$o['is_secret'] || (int)$me['is_secret'] ? 1 : 0, me()['id']]);
        }
        // A symmetric pair counts in either order.
        $find = db()->prepare('SELECT r.* ' . relations_visible_sql($isGm) . ' AND r.type_id=? AND ((r.from_id=? AND r.to_id=?)' . ($symmetric ? ' OR (r.from_id=? AND r.to_id=?)' : '') . ')');
        $has = function (int $f, int $t) use ($find, $cid, $tid, $symmetric) {
            $find->execute($symmetric ? [$cid, $tid, $f, $t, $t, $f] : [$cid, $tid, $f, $t]);
            return $find->fetch();
        };
        $del = db()->prepare('DELETE FROM encyclopedia_relations WHERE id=?');
        foreach ($remove as $x) {
            [$f, $t] = $pair(int_in($x, 1));
            if (!$r = $has($f, $t)) continue;
            if (!relation_mine($r, $isGm)) fail('Only a GM can remove a connection someone else made', 403);
            $del->execute([$r['id']]);
        }
        db()->commit();
        out(['ok' => true, 'type_id' => $tid, 'relations' => relations_list($cid, $isGm), 'relation_types' => relation_types($cid, $isGm)]);

    case 'relation_update': // one connection's note, and (GMs) whether it is GM only
        $cid = cid();
        $isGm = role($cid) === 'gm';
        need_relations();
        $r = relation_row($cid, int_in(p('id'), 1), $isGm);
        if (!relation_mine($r, $isGm)) fail('Only a GM can change a connection someone else made', 403);
        $note = array_key_exists('note', body()) ? (trim((string)str_in(p('note'), 200)) ?: null) : $r['note'];
        $secret = (int)$r['is_secret'];
        if ($isGm && array_key_exists('is_secret', body())) {
            $st = db()->prepare('SELECT MAX(is_secret) FROM encyclopedia_entries WHERE id IN (?,?)');
            $st->execute([$r['from_id'], $r['to_id']]);
            $secret = p('is_secret') || (int)$st->fetchColumn() ? 1 : 0;
        }
        db()->prepare('UPDATE encyclopedia_relations SET note=?, is_secret=? WHERE id=?')->execute([$note, $secret, $r['id']]);
        out(['ok' => true]);

    case 'relation_delete':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        need_relations();
        $r = relation_row($cid, int_in(p('id'), 1), $isGm);
        if (!relation_mine($r, $isGm)) fail('Only a GM can remove a connection someone else made', 403);
        db()->prepare('DELETE FROM encyclopedia_relations WHERE id=?')->execute([$r['id']]);
        out(['ok' => true]);

    case 'relation_type_save':
        // GMs rename a relationship's labels or colour, or merge it into another (merge_into: its connections move there).
        $cid = cid();
        need_gm($cid);
        need_relations();
        $t = relation_type_row($cid, int_in(p('id'), 1));
        db()->beginTransaction();
        if (p('merge_into')) {
            $into = relation_type_row($cid, int_in(p('merge_into'), 1));
            if ((int)$into['id'] === (int)$t['id']) fail('Pick another connection to merge into');
            // Merging into the same pair of labels the other way round swaps the ends.
            $flip = $into['inverse_label'] !== '' && strcasecmp($into['label'], $t['inverse_label']) === 0 && strcasecmp($into['inverse_label'], $t['label']) === 0;
            $sym = $into['inverse_label'] === '';
            db()->prepare('INSERT IGNORE INTO encyclopedia_relations (campaign_id, from_id, to_id, type_id, note, is_secret, created_by, created_at)
                SELECT campaign_id, ' . ($flip ? 'to_id, from_id' : 'from_id, to_id') . ', ?, note, is_secret, created_by, created_at
                FROM encyclopedia_relations WHERE type_id=?')->execute([$into['id'], $t['id']]);
            db()->prepare('DELETE FROM encyclopedia_relation_types WHERE id=?')->execute([$t['id']]);
            if ($sym) relations_dedupe((int)$into['id']);
        } else {
            $label = relation_label(p('label', $t['label']));
            $inverse = p('symmetric') ? '' : relation_label(p('inverse_label', $t['inverse_label']), true);
            if (mb_strtolower($inverse) === mb_strtolower($label)) $inverse = '';
            $color = (string)p('color', $t['color']);
            if (!preg_match(TAG_COLOR, $color)) fail('Pick a colour');
            if ($inverse === '' && $t['inverse_label'] !== '') {
                relations_dedupe((int)$t['id']); // becoming symmetric: A→B and B→A are now the same connection
            }
            db()->prepare('UPDATE encyclopedia_relation_types SET label=?, inverse_label=?, color=? WHERE id=?')->execute([$label, $inverse, $color, $t['id']]);
        }
        db()->commit();
        out(['ok' => true, 'relations' => relations_list($cid, true), 'relation_types' => relation_types($cid, true)]);

    case 'relation_type_delete': // GMs: the relationship and every connection made with it
        $cid = cid();
        need_gm($cid);
        need_relations();
        $t = relation_type_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM encyclopedia_relation_types WHERE id=?')->execute([$t['id']]);
        out(['ok' => true]);

    // ===== the Library =====
    case 'library':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        need_library();
        out(['tomes' => array_map(fn($t) => tome_out($t, false, $isGm), tomes($cid))]);

    case 'tome':
        $cid = cid();
        $role = role($cid);
        need_library();
        $t = tomes($cid, int_in($_GET['id'] ?? null, 1))[0] ?? fail('Tome not found', 404);
        $files = [];
        if (has_attachments()) {
            $st = db()->prepare("SELECT * FROM attachments WHERE campaign_id=? AND parent_type='library' AND parent_id=?" . ($role === 'gm' ? '' : ' AND is_secret=0') . ' ORDER BY id');
            $st->execute([$cid, (int)$t['id']]);
            $files = array_map('attachment_out', $st->fetchAll());
        }
        out(['tome' => tome_out($t, true, $role === 'gm') + ['files' => $files], 'uploads' => upload_info()]);

    case 'tome_save':
        // A new tome, or a change to one, by any member. version is the copy the browser opened: when someone else has
        // saved since, the save is refused so it doesn't overwrite their words.
        $cid = cid();
        $isGm = role($cid) === 'gm';
        need_library();
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? tome_row($cid, $id) : null;
        $kind = (string)p('kind', $old['kind'] ?? 'book');
        if (!in_array($kind, TOME_KINDS, true)) fail('Pick a book, a journal or a note');
        $title = trim(preg_replace('/\s+/u', ' ', (string)str_in(p('title'), 200, false)));
        if ($title === '') fail('Title required');
        $desc = trim((string)str_in(p('description'), 1000)) ?: null;
        $body = rich_html_clean((string)str_in(p('body'), 2_000_000));
        // a player never had the GM's secret paragraphs to send back, so they are kept from the stored copy
        $body = ($isGm ? $body : rich_keep_secrets($old['body'] ?? null, $body)) ?: null;
        $uid = me()['id'];
        if ($old) {
            $st = db()->prepare('UPDATE library_tomes SET kind=?, title=?, description=?, body=?, version=version+1, updated_by=? WHERE id=? AND version=?');
            $st->execute([$kind, $title, $desc, $body, $uid, $id, int_in(p('version'), 1)]);
            if (!$st->rowCount()) {
                $now = tomes($cid, $id)[0];
                fail(($now['editor'] ?: 'Someone') . ' saved this tome after you opened it. Copy what you wrote, reload, and add it again', 409, 'stale');
            }
        } else {
            db()->prepare('INSERT INTO library_tomes (campaign_id, kind, title, description, body, created_by, updated_by) VALUES (?,?,?,?,?,?,?)')
                ->execute([$cid, $kind, $title, $desc, $body, $uid, $uid]);
            $id = (int)db()->lastInsertId();
        }
        out(['ok' => true, 'tome' => tome_out(tomes($cid, $id)[0], true, $isGm)]);

    case 'tome_delete':
        $cid = cid();
        $role = role($cid);
        need_library();
        $t = tome_row($cid, int_in(p('id'), 1));
        if ($role !== 'gm' && (int)$t['created_by'] !== me()['id']) fail('Only a GM can delete a tome someone else added', 403);
        db()->prepare('DELETE FROM library_tomes WHERE id=?')->execute([$t['id']]);
        if (has_attachments()) attachments_purge($cid, 'library', (int)$t['id']);   // files have no foreign key to cascade
        out(['ok' => true]);

    // ===== play sessions =====
    case 'sessions': // newest first; a player gets the published ones only, without the GMs' note counts
        $cid = cid();
        $isGm = role($cid) === 'gm';
        need_sessions();
        $st = db()->prepare($isGm
            ? 'SELECT s.*, COUNT(n.id) AS notes, COALESCE(SUM(n.is_covered), 0) AS covered FROM play_sessions s LEFT JOIN session_notes n ON n.session_id=s.id
               WHERE s.campaign_id=? GROUP BY s.id ORDER BY s.number DESC'
            : 'SELECT * FROM play_sessions WHERE campaign_id=? AND is_published=1 ORDER BY number DESC');
        $st->execute([$cid]);
        out(['sessions' => array_map(fn($x) => session_out($x, false, $isGm), $st->fetchAll())]);

    case 'session': // one session with its summary; GMs get its notes too
        $cid = cid();
        $isGm = role($cid) === 'gm';
        need_sessions();
        $s = session_row($cid, int_in($_GET['id'] ?? null, 1), $isGm);
        out(['session' => session_out($s, true, $isGm)] + ($isGm ? ['notes' => snotes((int)$s['id'])] : []));

    case 'session_save': // GMs: a new session, or a change to one's title, dates or publishing; reopen makes it the open one
        $cid = cid();
        need_gm($cid);
        need_sessions();
        db()->beginTransaction();
        if (p('id')) {
            $s = session_row($cid, int_in(p('id'), 1), true, true);
            $title = array_key_exists('title', body()) ? trim(preg_replace('/\s+/u', ' ', (string)str_in(p('title'), 200))) : $s['title'];
            $played = array_key_exists('played_on', body()) ? date_in(p('played_on')) : $s['played_on'];
            $first = array_key_exists('first_day', body()) ? int_in(p('first_day')) : (int)$s['first_day'];
            $last = array_key_exists('last_day', body()) ? (p('last_day') === null ? null : int_in(p('last_day'))) : ($s['last_day'] === null ? null : (int)$s['last_day']);
            if (p('reopen')) { sessions_end_all($cid); $last = null; }
            if ($last !== null && $last < $first) fail('The last day can\'t be before the first');
            $pub = array_key_exists('is_published', body()) ? (p('is_published') ? 1 : 0) : (int)$s['is_published'];
            db()->prepare('UPDATE play_sessions SET title=?, played_on=?, first_day=?, last_day=?, is_published=? WHERE id=?')
                ->execute([$title, $played, $first, $last, $pub, $s['id']]);
            $id = (int)$s['id'];
        } else {
            db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]); // one new session at a time
            $c = campaign_row($cid);
            $first = array_key_exists('first_day', body()) ? int_in(p('first_day')) : floordiv((int)$c['current_shift'], slots_per_day(dec($c['calendar_json'])));
            $id = session_create($cid, $first, trim((string)str_in(p('title'), 200)), date_in(p('played_on')));
        }
        db()->commit();
        out(['ok' => true, 'session' => session_out(session_row($cid, $id), true, true)]);

    case 'session_summary_save': // GMs: the summary, from the copy the page opened (version)
        $cid = cid();
        need_gm($cid);
        need_sessions();
        $s = session_row($cid, int_in(p('id'), 1));
        $html = rich_html_clean((string)str_in(p('summary'), 2_000_000)) ?: null;
        $set = 'summary=?'; $args = [$html];
        foreach (['rewards', 'loot'] as $f) if (array_key_exists($f, body())) {
            if (!array_key_exists($f, $s)) fail('Open install.php on the server and press Install or upgrade first', 400);
            $set .= ", $f=?";
            $args[] = rich_html_clean((string)str_in(p($f), 2_000_000)) ?: null;
        }
        $st = db()->prepare("UPDATE play_sessions SET $set, summary_format='html', version=version+1 WHERE id=? AND version=?");
        $st->execute([...$args, $s['id'], int_in(p('version'), 1)]);
        if (!$st->rowCount()) fail('This summary was saved somewhere else after you opened it. Copy what you wrote, reload, and add it again', 409, 'stale');
        out(['ok' => true, 'session' => session_out(session_row($cid, (int)$s['id']), true, true)]);

    case 'session_end': // GMs: the open session (or the one named) ends on the current day
        $cid = cid();
        need_gm($cid);
        need_sessions();
        if (p('id')) {
            $s = session_row($cid, int_in(p('id'), 1));
            $c = campaign_row($cid);
            $day = floordiv((int)$c['current_shift'], slots_per_day(dec($c['calendar_json'])));
            db()->prepare('UPDATE play_sessions SET last_day=GREATEST(first_day, ?) WHERE id=? AND last_day IS NULL')->execute([$day, $s['id']]);
        } else sessions_end_all($cid);
        out(['ok' => true]);

    case 'session_delete': // GMs: the session and its notes
        $cid = cid();
        need_gm($cid);
        need_sessions();
        $s = session_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM play_sessions WHERE id=?')->execute([$s['id']]);
        out(['ok' => true]);

    case 'snote_add': // GMs: a quick note, at the end of the session named, else the open one, else a new one
        $cid = cid();
        need_gm($cid);
        need_sessions();
        $text = snote_text(p('text'));
        $depth = int_in(p('depth', 0), 0, 3);
        $at = int_in(p('abs_shift'));
        $key = p('key') !== null ? (string)str_in(p('key'), 40) : null;
        db()->beginTransaction();
        // The campaign's lock first, before any other read: one note (and one new session) at a time, each seeing the last.
        db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]);
        $c = campaign_row($cid);
        if ($key !== null) { // sent before, and the reply lost: the note that was saved then
            $st = db()->prepare('SELECT * FROM session_notes WHERE campaign_id=? AND client_key=?');
            $st->execute([$cid, $key]);
            if ($n = $st->fetch()) {
                db()->commit();
                out(['ok' => true, 'note' => snote_out($n), 'session' => session_out(session_row($cid, (int)$n['session_id']), false, true)]);
            }
        }
        if (p('session_id')) $s = session_row($cid, int_in(p('session_id'), 1), true, true);
        else {
            $s = open_session($cid);
            if (!$s) $s = session_row($cid, session_create($cid, floordiv($at, slots_per_day(dec($c['calendar_json'])))));
            $s = session_row($cid, (int)$s['id'], true, true);
        }
        db()->prepare('INSERT INTO session_notes (campaign_id, session_id, position, depth, text, abs_shift, client_key, created_by)
            SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ?, ?, ?, ?, ? FROM session_notes WHERE session_id=?')
            ->execute([$cid, $s['id'], $depth, $text, $at, $key, me()['id'], $s['id']]);
        $nid = (int)db()->lastInsertId();
        db()->commit();
        out(['ok' => true, 'note' => snote_out(snote_row($cid, $nid)), 'session' => session_out(session_row($cid, (int)$s['id']), false, true)]);

    case 'snote_bulk': // GMs: many notes at once (typed in the session's notes box, or taken from a day's notes), at the end of the session named
        $cid = cid();
        need_gm($cid);
        need_sessions();
        $list = p('notes');
        if (!is_array($list) || !$list) fail('There are no notes to add', 400);
        if (count($list) > 500) fail('That is more than 500 notes at once. Add them in parts', 400);
        $rows = [];
        foreach ($list as $x) {
            if (!is_array($x)) fail('Those notes could not be read', 400);
            $rows[] = [snote_text($x['text'] ?? null), int_in($x['depth'] ?? 0, 0, 3), int_in($x['abs_shift'] ?? null)];
        }
        $key = p('key') !== null ? (string)str_in(p('key'), 30) : null;
        db()->beginTransaction();
        db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]);
        $s = session_row($cid, int_in(p('session_id'), 1), true, true);
        if ($key !== null) { // sent before, and the reply lost: nothing more to add
            $st = db()->prepare('SELECT 1 FROM session_notes WHERE campaign_id=? AND client_key=?');
            $st->execute([$cid, $key . '.0']);
            if ($st->fetch()) { db()->commit(); out(['ok' => true, 'added' => 0, 'again' => true]); }
        }
        $ins = db()->prepare('INSERT INTO session_notes (campaign_id, session_id, position, depth, text, abs_shift, client_key, created_by)
            SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ?, ?, ?, ?, ? FROM session_notes WHERE session_id=?');
        foreach ($rows as $i => [$text, $depth, $at])
            $ins->execute([$cid, $s['id'], $depth, $text, $at, $key !== null ? "$key.$i" : null, me()['id'], $s['id']]);
        db()->commit();
        out(['ok' => true, 'added' => count($rows)]);

    case 'snote_save': // GMs: a note's text, indent, stamp or tick
        $cid = cid();
        need_gm($cid);
        need_sessions();
        $n = snote_row($cid, int_in(p('id'), 1));
        $text = array_key_exists('text', body()) ? snote_text(p('text')) : $n['text'];
        $depth = array_key_exists('depth', body()) ? int_in(p('depth'), 0, 3) : (int)$n['depth'];
        $at = array_key_exists('abs_shift', body()) ? int_in(p('abs_shift')) : (int)$n['abs_shift'];
        $cov = array_key_exists('is_covered', body()) ? (p('is_covered') ? 1 : 0) : (int)$n['is_covered'];
        db()->prepare('UPDATE session_notes SET text=?, depth=?, abs_shift=?, is_covered=? WHERE id=?')->execute([$text, $depth, $at, $cov, $n['id']]);
        out(['ok' => true, 'note' => snote_out(snote_row($cid, (int)$n['id']))]);

    case 'snote_move': // GMs: a note to another place in its session (position, from 1), or to the end of another session
        $cid = cid();
        need_gm($cid);
        need_sessions();
        db()->beginTransaction();
        $n = snote_row($cid, int_in(p('id'), 1));
        $sid = (int)$n['session_id'];
        if (p('session_id') && int_in(p('session_id'), 1) !== $sid) {
            $to = session_row($cid, int_in(p('session_id'), 1), true, true);
            db()->prepare('UPDATE session_notes SET session_id=?, position=(SELECT p FROM (SELECT COALESCE(MAX(position), 0) + 1 AS p FROM session_notes WHERE session_id=?) x) WHERE id=?')
                ->execute([$to['id'], $to['id'], $n['id']]);
        } else {
            session_row($cid, $sid, true, true);
            $ids = array_column(snotes($sid), 'id');
            $ids = array_values(array_filter($ids, fn($i) => $i !== (int)$n['id']));
            if (p('after_id') !== null) {               // after this note (0: first), wherever it is now
                $after = int_in(p('after_id'), 0);
                $at = $after ? array_search($after, $ids, true) : -1;
                if ($at === false) fail('That note is no longer in this session. Reload and try again', 409);
                $pos = $at + 2;
            } else $pos = int_in(p('position', count($ids) + 1), 1);
            array_splice($ids, min($pos, count($ids) + 1) - 1, 0, [(int)$n['id']]);
            $up = db()->prepare('UPDATE session_notes SET position=? WHERE id=?');
            foreach ($ids as $i => $id) $up->execute([$i + 1, $id]);
        }
        db()->commit();
        out(['ok' => true]);

    case 'snote_delete':
        $cid = cid();
        need_gm($cid);
        need_sessions();
        $n = snote_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM session_notes WHERE id=?')->execute([$n['id']]);
        out(['ok' => true]);

    // ===== pictures and files =====
    case 'files': // the files on one parent that this member may see
        $cid = cid();
        $role = role($cid);
        need_attachments();
        $type = (string)($_GET['parent_type'] ?? '');
        $pid = int_in($_GET['parent_id'] ?? null, 1);
        attachment_parent($cid, $type, $pid, $role);
        $st = db()->prepare('SELECT * FROM attachments WHERE campaign_id=? AND parent_type=? AND parent_id=?' . ($role === 'gm' ? '' : ' AND is_secret=0') . ' ORDER BY id');
        $st->execute([$cid, $type, $pid]);
        out(['files' => array_map('attachment_out', $st->fetchAll()), 'uploads' => upload_info()]);

    case 'file': // the file itself, to show or download, only to someone who may see it
        $cid = cid();
        $role = role($cid);
        need_attachments();
        $a = attachment_row($cid, int_in($_GET['id'] ?? null, 1), $role);
        if ($a['kind'] === 'embed') {
            // An embedded DeviantArt work: no file here, so the browser is sent to DeviantArt's picture, and only there.
            $src = embed_refresh($a);
            if (!$src) fail('No longer on DeviantArt', 404, 'embed_gone');
            header('Cache-Control: private, no-cache');
            header('Location: ' . $src, true, 302);
            exit;
        }
        $dir = upload_dir()['dir'];
        $path = $dir && preg_match('/^[0-9a-f]{32}$/', $a['stored_name']) ? "$dir/{$a['stored_name']}" : '';
        if ($path === '' || !is_file($path)) fail('File not found', 404);
        if (!isset(UPLOAD_TYPES[$a['mime']])) fail('File not found', 404);
        // The stored file never changes, so its name is its version. no-cache: the browser asks each time, so a file
        // a GM has since hidden is refused rather than shown from the cache.
        $etag = '"' . $a['stored_name'] . '"';
        header('Cache-Control: private, no-cache');
        header('ETag: ' . $etag);
        if (trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) { http_response_code(304); exit; }
        $inline = $a['kind'] === 'image' && empty($_GET['dl']);
        $ascii = preg_replace('/[^A-Za-z0-9._ -]/', '_', $a['original_name']);
        header('Content-Type: ' . $a['mime'] . ($a['mime'] === 'text/plain' ? '; charset=utf-8' : ''));
        header('Content-Length: ' . filesize($path));
        header(sprintf('Content-Disposition: %s; filename="%s"; filename*=UTF-8\'\'%s', $inline ? 'inline' : 'attachment', $ascii, rawurlencode($a['original_name'])));
        // Even opened on its own, the file runs nothing and loads nothing, and no other site may embed it.
        header("Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
        header('Cross-Origin-Resource-Policy: same-origin');
        readfile($path);
        exit;

    case 'file_upload': // multipart form: parent_type, parent_id, file, caption, is_secret (GMs)
        $cid = cid();
        $role = role($cid);
        need_attachments();
        $max = upload_max_bytes();
        $limit = round($max / 1048576, 1) . ' MB';
        // Past post_max_size PHP drops the whole request, so all there is to go on is its length.
        if (empty($_FILES) && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) fail("That file is too big: files can be $limit at most", 413);
        $type = (string)($_POST['parent_type'] ?? '');
        $pid = int_in($_POST['parent_id'] ?? null, 1);
        $parent = attachment_parent($cid, $type, $pid, $role);
        $f = $_FILES['file'] ?? null;
        if (!is_array($f) || is_array($f['error'] ?? null)) fail('Pick a file to upload');
        if (in_array($f['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) fail("That file is too big: files can be $limit at most", 413);
        if ($f['error'] === UPLOAD_ERR_NO_FILE) fail('Pick a file to upload');
        if ($f['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) { error_log('upload failed: error ' . $f['error']); fail('The upload didn\'t arrive. Try again', 500); }
        $size = (int)filesize($f['tmp_name']);
        if ($size < 1) fail('That file is empty');
        if ($size > $max) fail("That file is too big: files can be $limit at most", 413);
        if (!upload_dir()['dir']) fail(upload_info()['problem'], 409, 'uploads_unavailable');
        attachment_room($cid, $type, $pid, $size);
        $name = upload_name((string)($f['name'] ?? ''));
        [$mime, $kind, $w, $h] = upload_type($f['tmp_name'], $name);
        $caption = trim((string)str_in($_POST['caption'] ?? null, 200)) ?: null;
        $secret = $role === 'gm' && !empty($_POST['is_secret']) && $_POST['is_secret'] !== '0' && $_POST['is_secret'] !== 'false' ? 1 : 0;
        out(['ok' => true, 'file' => attachment_store($cid, $f['tmp_name'], ['parent_type' => $type, 'parent_id' => $pid, 'original_name' => $name, 'mime' => $mime,
            'kind' => $kind, 'size_bytes' => $size, 'width' => $w, 'height' => $h, 'caption' => $caption, 'is_secret' => $secret], true)]);

    case 'image_search': // Find Image: source (openverse, museums or deviantart), q. Results as image_item() describes.
        $cid = cid();
        role($cid);
        $source = (string)($_GET['source'] ?? '');
        if (!in_array($source, IMAGE_SOURCES, true)) fail('Unknown picture source', 400);
        $q = trim((string)str_in($_GET['q'] ?? '', 200));
        if ($q === '') fail('Type something to search for');
        rate_limit('image_search', (string)me()['id'], 30, 60);
        if ($source === 'deviantart' && !deviantart_ready())
            fail(me()['is_admin'] ? "DeviantArt isn't set up on this server: register an app at deviantart.com/developers and put its client_id and client_secret under 'image_search' => ['deviantart' => …] in the config."
                : 'DeviantArt isn\'t available on this server.', 409, 'source_not_set_up');
        try { out(['results' => image_search($source, $q)]); }
        catch (ImageSourceDown) { fail(['openverse' => 'Openverse', 'museums' => 'The museums', 'deviantart' => 'DeviantArt'][$source] . ' couldn\'t be reached just now. Try again later.', 502, 'source_unavailable'); }

    case 'image_import': // Find Image's picks: parent_type, parent_id, source, id, mode ('copy' or 'embed'), is_secret (GMs)
        $cid = cid();
        $role = role($cid);
        need_attachments();
        if (!has_credits()) fail('Saving found pictures needs a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
        $type = (string)p('parent_type', '');
        $pid = int_in(p('parent_id'), 1);
        attachment_parent($cid, $type, $pid, $role);
        $source = (string)p('source', '');
        $id = (string)str_in(p('id'), 100);
        $mode = (string)p('mode', 'copy');
        if (!in_array($source, IMAGE_SOURCES, true) || !in_array($mode, ['copy', 'embed'], true)) fail('Unknown picture source', 400);
        if ($mode === 'embed' && $source !== 'deviantart') fail('Only DeviantArt works can be embedded', 400);
        if ($source === 'deviantart' && !deviantart_ready()) fail('DeviantArt isn\'t available on this server.', 409, 'source_not_set_up');
        $secret = $role === 'gm' && p('is_secret') ? 1 : 0;
        $down = fn() => fail('That picture couldn\'t be fetched just now. Try again later.', 502, 'source_unavailable');
        try { $item = image_lookup($source, $id); } catch (ImageSourceDown) { $down(); }
        if (!$item) fail('That picture isn\'t there any more', 404);
        if ($mode === 'embed') {
            try { $o = deviantart_oembed((string)$item['landing_url']); } catch (ImageSourceDown) { $down(); }
            if (!$o) fail('DeviantArt won\'t let that work be embedded', 422, 'not_embeddable');
            attachment_room($cid, $type, $pid, 0);
            out(['ok' => true, 'file' => attachment_store($cid, null, ['parent_type' => $type, 'parent_id' => $pid,
                'original_name' => upload_name($item['title']), 'mime' => 'image/jpeg', 'kind' => 'embed', 'size_bytes' => 0,
                'width' => $o['width'] ? min(65535, $o['width']) : null, 'height' => $o['height'] ? min(65535, $o['height']) : null, 'is_secret' => $secret,
                'embed_url' => $item['landing_url'], 'embed_src' => $o['src'], 'embed_checked_at' => date('Y-m-d H:i:s')] + credit_columns($item))]);
        }
        if (!$item['open']) fail('That picture isn\'t openly licensed, so it can\'t be copied here', 403, 'not_open');
        if (!upload_dir()['dir']) fail(upload_info()['problem'], 409, 'uploads_unavailable');
        $max = upload_max_bytes();
        $tmp = null;
        // The full picture, or the thumbnail when that is too big or won't come.
        foreach (array_unique(array_filter([$item['full'], $item['thumb']])) as $url) {
            try { $tmp = image_download($url, $max); break; } catch (ImageSourceDown | LengthException) {}
        }
        if (!$tmp) $down();
        register_shutdown_function(fn() => is_file($tmp) && @unlink($tmp));   // when it is refused below; a kept one has moved
        $size = (int)filesize($tmp);
        attachment_room($cid, $type, $pid, $size);
        $name = found_name($item['title'], $tmp);
        [$mime, $kind, $w, $h] = upload_type($tmp, $name);
        if ($kind !== 'image') fail('That isn\'t a picture', 415, 'unsupported_type');
        out(['ok' => true, 'file' => attachment_store($cid, $tmp, ['parent_type' => $type, 'parent_id' => $pid, 'original_name' => $name, 'mime' => $mime,
            'kind' => 'image', 'size_bytes' => $size, 'width' => $w, 'height' => $h, 'is_secret' => $secret] + credit_columns($item))]);

    case 'file_update': // a file's caption, and (GMs) whether it is GM only
        $cid = cid();
        $role = role($cid);
        need_attachments();
        $a = attachment_row($cid, int_in(p('id'), 1), $role);
        if (!attachment_mine($a, $role)) fail('Only a GM can change a file someone else added', 403);
        $caption = array_key_exists('caption', body()) ? (trim((string)str_in(p('caption'), 200)) ?: null) : $a['caption'];
        $secret = $role === 'gm' && array_key_exists('is_secret', body()) ? (p('is_secret') ? 1 : 0) : (int)$a['is_secret'];
        db()->prepare('UPDATE attachments SET caption=?, is_secret=? WHERE id=?')->execute([$caption, $secret, $a['id']]);
        $st = db()->prepare('SELECT * FROM attachments WHERE id=?');
        $st->execute([$a['id']]);
        out(['ok' => true, 'file' => attachment_out($st->fetch())]);

    case 'file_delete':
        $cid = cid();
        $role = role($cid);
        need_attachments();
        $a = attachment_row($cid, int_in(p('id'), 1), $role);
        if (!attachment_mine($a, $role)) fail('Only a GM can remove a file someone else added', 403);
        db()->prepare('DELETE FROM attachments WHERE id=?')->execute([$a['id']]);
        if (($dir = upload_dir()['dir']) && preg_match('/^[0-9a-f]{32}$/', $a['stored_name'])) @unlink("$dir/{$a['stored_name']}");
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
