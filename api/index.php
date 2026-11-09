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
require __DIR__ . '/actions.php';
require __DIR__ . '/richtext.php';
require __DIR__ . '/images.php';
require __DIR__ . '/scabard.php';
require __DIR__ . '/mdimport.php';
require __DIR__ . '/sheets.php';
require __DIR__ . '/maps.php';
require __DIR__ . '/holdings.php';
require __DIR__ . '/reminders.php';
require __DIR__ . '/encyclopedia.php';
require __DIR__ . '/connections.php';
require __DIR__ . '/files.php';
require __DIR__ . '/library.php';
require __DIR__ . '/history.php';
require __DIR__ . '/clocks.php';
require __DIR__ . '/dice.php';
require __DIR__ . '/sessions.php';
require __DIR__ . '/reports.php';
require __DIR__ . '/panel.php';
require __DIR__ . '/upgrade.php';
// Fan wikis: a module of its own, which the kill switch (tools/fanwiki-kill-switch.sh --all) can remove.
if (is_file(__DIR__ . '/fanwikis.php')) require __DIR__ . '/fanwikis.php';

// ---------- helpers ----------
/** Answer the action. A change marked 'touch' in api/actions.php, made by a GM, also tells open pages about it. */
function out($data, int $code = 200): void {
    $cid = $GLOBALS['touch_cid'] ?? 0;
    if ($cid && $code < 400 && role($cid) === 'gm') touch_campaign($cid);
    json_out($data, $code);
}
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
/** SQL condition, on users column $col, for accounts approved for Chronicle (users.status until migration 020 is run). */
function approved_sql(string $col = 'id'): string {
    return has_access_table() ? "$col IN (SELECT user_id FROM chronicle_access WHERE status='approved')" : "status='approved'";
}
function need_admin(): array { $u = me(); if (!$u['is_admin']) fail('Admins only', 403, 'not_admin'); return $u; }

/** Returns 'gm' | 'player' for the current user in campaign $cid, or fails. Site admins are GMs everywhere. */
function role(int $cid): string {
    static $cache = [];
    if (isset($cache[$cid])) return $cache[$cid];
    $u = me();
    $st = db()->prepare('SELECT id FROM campaigns WHERE id=?');
    $st->execute([$cid]);
    if (!$st->fetch()) fail('Campaign not found', 404);
    if (panel_public()) $r = 'player';                    // a public panel link: any player, with no account of its own
    elseif ($u['is_admin']) $r = 'gm';
    else {
        $st = db()->prepare('SELECT role FROM campaign_members WHERE campaign_id=? AND user_id=?');
        $st->execute([$cid, $u['id']]);
        $r = $st->fetchColumn();
        // not a member yet, but perhaps invited by email (member_add): that invitation is taken up now
        if (!$r && claim_invites($cid)) { $st->execute([$cid, $u['id']]); $r = $st->fetchColumn(); }
        if (!$r) fail('You are not a member of this campaign', 403);
    }
    // Only once access is settled, so nobody outside the campaign sets its one-time upgrade off.
    dawn_first($cid);
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
/** Row $id of $table if it is campaign $cid's, or fail 404 with $missing; also when $hidden($row) says this member may
 * not see it (a secret one, for a player). $table is always a name from the code, never from the request. */
function row_of(string $table, int $cid, int $id, string $missing, ?callable $hidden = null): array {
    $st = db()->prepare("SELECT * FROM `$table` WHERE id=? AND campaign_id=?");
    $st->execute([$id, $cid]);
    $r = $st->fetch();
    if (!$r || ($hidden && $hidden($r))) fail($missing, 404);
    return $r;
}
function cid(): int {
    $c = $_GET['cid'] ?? p('cid');
    if ($c === null) fail('Missing campaign id');
    return int_in($c, 1);
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
define('AUTHOR_SQL', "COALESCE(NULLIF(m.character_name, ''), " . user_name_sql() . ")");
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
/** The actions picked on a day's shifts (or one shift of it): the party's (user_id and character_id 0), each player's,
 * and each party character's with no player (character_id its sheet), with who did it. A player isn't told of a
 * character whose entry is GM only. */
function shift_actions_of(int $cid, int $day, ?int $slot = null, bool $isGm = true): array {
    $st = db()->prepare('SELECT a.shift, a.user_id, a.character_id, a.action, ' . AUTHOR_SQL . ' AS who, ce.name AS char_name
        FROM shift_actions a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN campaign_members m ON m.campaign_id=a.campaign_id AND m.user_id=a.user_id
        LEFT JOIN sheet_characters sc ON sc.id=a.character_id AND sc.campaign_id=a.campaign_id LEFT JOIN encyclopedia_entries ce ON ce.id=sc.entry_id
        WHERE a.campaign_id=? AND a.abs_day=?' . ($slot === null ? '' : ' AND a.shift=?')
        . ' AND (a.character_id=0 OR ce.id IS NOT NULL' . ($isGm ? '' : ' AND ce.is_secret=0') . ')
        ORDER BY a.shift, a.user_id = 0 AND a.character_id = 0 DESC, a.character_id <> 0, who, char_name');
    $st->execute($slot === null ? [$cid, $day] : [$cid, $day, $slot]);
    return array_map(fn($r) => ['shift' => (int)$r['shift'], 'user_id' => (int)$r['user_id'], 'character_id' => (int)$r['character_id'], 'action' => $r['action'],
        'who' => (int)$r['character_id'] ? (string)$r['char_name'] : ((int)$r['user_id'] ? $r['who'] : 'The party')], $st->fetchAll());
}

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

    // each player's and the party's action: where two shifts become one, the earlier shift's action stays
    $st = $pdo->prepare('SELECT abs_day, shift, user_id, character_id, action, updated_by FROM shift_actions WHERE campaign_id=? ORDER BY abs_day, shift');
    $st->execute([$cid]);
    $acts = $st->fetchAll();
    $pdo->prepare('DELETE FROM shift_actions WHERE campaign_id=?')->execute([$cid]);
    $ins = $pdo->prepare('INSERT IGNORE INTO shift_actions (campaign_id, abs_day, shift, user_id, character_id, action, updated_by) VALUES (?,?,?,?,?,?,?)');
    foreach ($acts as $r) {
        [$d, $s] = $split(convert_slot((int)$r['abs_day'] * $n0 + (int)$r['shift'], $old, $new));
        $ins->execute([$cid, $d, $s, $r['user_id'], $r['character_id'], $r['action'], $r['updated_by']]);
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

    // A session's first and last shifts (an ended session runs to the end of its last shift), and the party's trail.
    $st = $pdo->prepare('SELECT id, first_shift, last_shift FROM play_sessions WHERE campaign_id=? AND first_shift IS NOT NULL');
    $st->execute([$cid]);
    $up = $pdo->prepare('UPDATE play_sessions SET first_shift=?, last_shift=? WHERE id=?');
    foreach ($st->fetchAll() as $r) {
        $a = convert_slot((int)$r['first_shift'], $old, $new);
        $up->execute([$a, $r['last_shift'] === null ? null : max($a, convert_slot((int)$r['last_shift'], $old, $new, true)), $r['id']]);
    }
    $st = $pdo->prepare('SELECT id, abs_shift FROM party_trail WHERE campaign_id=?');
    $st->execute([$cid]);
    $up = $pdo->prepare('UPDATE party_trail SET abs_shift=? WHERE id=?');
    foreach ($st->fetchAll() as $r) $up->execute([convert_slot((int)$r['abs_shift'], $old, $new), $r['id']]);
    // a session's shifts outside its run: two that land on the same slot become one
    $st = $pdo->prepare('SELECT x.session_id, x.abs_shift FROM session_shifts x JOIN play_sessions s ON s.id=x.session_id WHERE s.campaign_id=?');
    $st->execute([$cid]);
    $rows = $st->fetchAll();
    $pdo->prepare('DELETE x FROM session_shifts x JOIN play_sessions s ON s.id=x.session_id WHERE s.campaign_id=?')->execute([$cid]);
    $ins = $pdo->prepare('INSERT IGNORE INTO session_shifts (session_id, abs_shift) VALUES (?,?)');
    foreach ($rows as $r) $ins->execute([$r['session_id'], convert_slot((int)$r['abs_shift'], $old, $new)]);
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
    $out = ['type' => $now['type'] ?? null, 'temp' => $now['temp'] ?? null, 'wind' => $now['wind'] ?? 0,
        'season' => $w['season'] ?? null, 'shifts' => $seen, 'partial' => true];
    // the general outlook for today and the next two days (the Weather forecast button), which the GM's browser saves
    if (is_array($w['outlook'] ?? null)) $out['outlook'] = array_values($w['outlook']);
    return $out;
}

/** Tags every campaign is offered before anyone creates their own: name => colour. */
const STARTER_TAGS = [
    'Holiday' => '#b8860b', 'Battle' => '#b91c1c', 'Party' => '#db2777', 'Banquet' => '#c2410c',
    'Service' => '#4b5563', 'Ritual' => '#7c3aed', 'Festival' => '#d97706', 'Fair' => '#65a30d',
    'Coronation' => '#a16207', 'Wedding' => '#be185d', 'Birth' => '#0d9488', 'Catastrophe' => '#7f1d1d',
    'Transit' => '#0369a1',
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
/** Tags every campaign's Encyclopedia is offered before anyone makes their own: name => colour. Location, Person and
 * the like are Categories (ENTRY_CATEGORIES), not tags. */
const ENTRY_STARTER_TAGS = ['Event' => '#e11d48', 'Religion' => '#0891b2'];
/** The Categories an Encyclopedia entry can be in, one each (or none). */
const ENTRY_CATEGORIES = ['location', 'person', 'item', 'group', 'vehicle'];
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

/** Add the Transit tag (made if the campaign hasn't used it yet) to every event running during any shift from
 * $from to $to (absolute shift numbers, inclusive), keeping the tags they already have. */
function tag_transit_events(int $cid, int $from, int $to): void {
    $spd = camp_spd(campaign_row($cid));
    $st = db()->prepare('SELECT id, abs_day, end_day, shift, shift_end FROM events WHERE campaign_id=? AND abs_day<=? AND COALESCE(end_day, abs_day)>=?');
    $st->execute([$cid, floordiv($to, $spd), floordiv($from, $spd)]);
    $ids = [];
    foreach ($st->fetchAll() as $e) {
        $start = (int)$e['abs_day'] * $spd + ($e['shift'] === null ? 0 : (int)$e['shift']);
        $end = (int)($e['end_day'] ?? $e['abs_day']) * $spd + ($e['shift'] === null ? $spd - 1 : (int)$e['shift_end']);
        if ($start <= $to && $end >= $from) $ids[] = (int)$e['id'];
    }
    if (!$ids) return;
    $find = db()->prepare('SELECT id FROM tags WHERE campaign_id=? AND name=?');
    $find->execute([$cid, 'Transit']);
    $tag = $find->fetchColumn();
    if ($tag === false) {
        db()->prepare('INSERT INTO tags (campaign_id, name, color) VALUES (?,?,?)')->execute([$cid, 'Transit', STARTER_TAGS['Transit']]);
        $tag = db()->lastInsertId();
    }
    $link = db()->prepare('INSERT IGNORE INTO event_tags (event_id, tag_id) VALUES (?,?)');
    foreach ($ids as $id) $link->execute([$id, (int)$tag]);
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
/** A downtime's activities, checked: [{name, members: [user ids in the campaign], characters: [its characters' ids]}],
 * each name once. The characters are ones no player of the campaign plays (sheet_characters.id), as on a shift's actions. */
function downtime_activities($list, int $cid): string {
    if (!is_array($list)) fail('Expected a list of activities');
    if (count($list) > 40) fail('Too many activities (max 40)');
    $st = db()->prepare('SELECT user_id FROM campaign_members WHERE campaign_id=?');
    $st->execute([$cid]);
    $ids = array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
    $st = db()->prepare("SELECT c.id FROM sheet_characters c LEFT JOIN campaign_members m ON m.campaign_id=c.campaign_id AND m.user_id=c.owner_id
        WHERE c.campaign_id=? AND COALESCE(m.role, '')<>'player'");
    $st->execute([$cid]);
    $chars = array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
    $only = fn($v, array $ok) => array_values(array_unique(array_filter(array_map('intval', is_array($v) ? $v : []), fn($i) => in_array($i, $ok, true))));
    $out = []; $seen = [];
    foreach ($list as $a) {
        $name = trim((string)str_in(is_array($a) ? ($a['name'] ?? '') : '', 100, false));
        $k = mb_strtolower($name);
        if ($name === '' || isset($seen[$k])) continue;
        $seen[$k] = true;
        $out[] = ['name' => $name, 'members' => $only($a['members'] ?? null, $ids), 'characters' => $only($a['characters'] ?? null, $chars)];
    }
    return json_encode($out, JSON_UNESCAPED_UNICODE);
}
/** The party group a downtime is for: one of campaign $cid's groups, or null (empty, 0) for the whole party. */
function downtime_group($v, int $cid): ?int {
    if ($v === null || $v === '' || (string)$v === '0') return null;
    $st = db()->prepare('SELECT id FROM party_groups WHERE id=? AND campaign_id=?');
    $st->execute([int_in($v, 1), $cid]);
    $id = $st->fetchColumn();
    if ($id === false) fail('That party group isn\'t in this campaign', 404);
    return (int)$id;
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

/** Tell open pages about a GM's change. Most changes are marked 'touch' in api/actions.php and out() calls this; an
 * action whose notice depends on what changed (a private reminder, a player's own pin) calls it itself. */
function touch_campaign(int $cid): void {
    db()->prepare('UPDATE campaigns SET updated_at=CURRENT_TIMESTAMP WHERE id=?')->execute([$cid]);
}

// ---------- quotas ----------
/** A number from the config's 'limits', or $default; 0 turns that limit off. */
function limit_of(string $key, int $default): int {
    $l = (array)cfg('limits', []);
    return max(0, (int)($l[$key] ?? $default));
}
/** Refuse a new campaign once its creator already has limits.campaigns_per_account of their own. Site admins have none. */
function need_campaign_room(): void {
    $u = me();
    $max = limit_of('campaigns_per_account', 50);
    if ($u['is_admin'] || !$max) return;
    $st = db()->prepare('SELECT COUNT(*) FROM campaigns WHERE created_by=?');
    $st->execute([$u['id']]);
    if ((int)$st->fetchColumn() >= $max) fail("You already have $max campaigns of your own. Delete one you no longer play to make room", 403, 'campaign_limit');
}
/** The rows a campaign may keep in each of its biggest tables: about a century of days and their shifts. */
const ROW_BUDGETS = ['days' => ['days_per_campaign', 40000, 'days of weather and notes'],
    'shifts' => ['shifts_per_campaign', 200000, 'shifts'], 'events' => ['events_per_campaign', 20000, 'events'],
    'shift_actions' => ['shift_actions_per_campaign', 200000, 'shift actions']];
/** Refuse a change that would take campaign $cid's $table past its budget by adding up to $adding rows. */
function need_row_room(int $cid, string $table, int $adding): void {
    [$key, $default, $what] = ROW_BUDGETS[$table];
    $max = limit_of($key, $default);
    if (!$max) return;
    $st = db()->prepare("SELECT COUNT(*) FROM $table WHERE campaign_id=?");   // $table is one of ROW_BUDGETS' keys
    $st->execute([$cid]);
    if ((int)$st->fetchColumn() + $adding > $max) fail("This campaign has reached its limit of $max $what", 413, 'row_limit');
}

// ---------- invitations ----------
/** Turn the signed-in user's waiting invitations (campaign_invites, by their sign-in email) into memberships: every
 * one, or only campaign $cid's. Taken up when they open their campaign list, or anything in that campaign. Returns
 * whether there were any. */
function claim_invites(?int $cid = null): bool {
    if (panel_request()) return false;
    $u = me();
    $email = mb_strtolower(trim((string)$u['email']));
    if ($email === '') return false;
    $only = $cid !== null ? ' AND campaign_id=' . $cid : '';
    $st = db()->prepare("SELECT campaign_id, role FROM campaign_invites WHERE email=?$only");
    $st->execute([$email]);
    $rows = $st->fetchAll();
    if (!$rows) return false;
    $ins = db()->prepare('INSERT IGNORE INTO campaign_members (campaign_id, user_id, role) VALUES (?,?,?)');
    foreach ($rows as $r) $ins->execute([(int)$r['campaign_id'], $u['id'], $r['role']]);
    db()->prepare("DELETE FROM campaign_invites WHERE email=?$only")->execute([$email]);
    return true;
}
// ---------- routing ----------
$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

/** What campaign_copy carries over, in order, so every id a row points at has been copied before it. key: the map its own
 * old => new ids go into; maps: columns holding another copied row's id, and the map that turns it into the new one
 * (a row pointing at one that wasn't copied is left out); via: for a table without campaign_id, the column and map of
 * the row it hangs off; later: columns filled in once everything is copied (a map's picture is an attachment of the
 * map); setup: copied even when only the setup is asked for. Columns a table hasn't got are
 * skipped. The members (but whoever copies it) and who has dismissed which reminder are not copied. */
const CAMPAIGN_COPY = [
    ['regions', 'key' => 'regions', 'setup' => true],
    ['holidays', 'setup' => true],
    ['tags', 'key' => 'tags', 'setup' => true],
    ['holding_tag_names', 'key' => 'holding_tags', 'setup' => true],
    ['encyclopedia_tag_names', 'key' => 'entry_tags', 'setup' => true],
    ['encyclopedia_relation_types', 'key' => 'relation_types', 'setup' => true],
    ['days', 'maps' => ['region_id' => 'regions']],
    ['shifts'],
    ['shift_notes'],
    ['events', 'key' => 'events'],
    ['event_tags', 'via' => ['event_id', 'events'], 'maps' => ['tag_id' => 'tags']],
    ['event_notes', 'via' => ['event_id', 'events']],
    // its group and the characters on its activities are set once the party groups are copied, below
    ['downtimes', 'key' => 'downtime', 'later' => ['group_id' => 'group']],
    ['party_gear'],
    ['holdings', 'key' => 'holdings'],
    ['holding_tags', 'via' => ['holding_id', 'holdings'], 'maps' => ['tag_id' => 'holding_tags']],
    ['holding_storage', 'via' => ['holding_id', 'holdings']],
    ['reminders'],
    ['party_funds'],
    ['encyclopedia_entries', 'key' => 'encyclopedia'],
    ['encyclopedia_tags', 'via' => ['entry_id', 'encyclopedia'], 'maps' => ['tag_id' => 'entry_tags']],
    ['encyclopedia_ignored'],
    ['encyclopedia_relations', 'maps' => ['from_id' => 'encyclopedia', 'to_id' => 'encyclopedia', 'type_id' => 'relation_types']],
    ['library_tomes', 'key' => 'library'],
    ['play_sessions', 'key' => 'session'],
    ['session_notes', 'maps' => ['session_id' => 'session']],
    ['session_shifts', 'via' => ['session_id', 'session']],
    ['clocks', 'key' => 'clock', 'maps' => ['entry_id' => 'encyclopedia']],
    ['clock_ticks', 'maps' => ['clock_id' => 'clock']],
    ['dice_rolls'],
    // Character sheets (db/migrations/023_character_sheets.sql): the copier owns every copied character that has a player.
    // party_group_id and portrait_id are set once the party groups and files are copied, below.
    ['sheet_characters', 'key' => 'character', 'maps' => ['entry_id' => 'encyclopedia'], 'later' => ['party_group_id' => 'group', 'portrait_id' => 'attachments']],
    // after the characters: a party character's action points at its sheet (character_id 0: the party's or a player's)
    ['shift_actions', 'maps' => ['character_id' => 'character']],
    // Maps (db/migrations/019_maps.sql)
    ['maps', 'key' => 'map', 'later' => ['image_id' => 'attachments']],
    ['tokens', 'key' => 'token', 'maps' => ['entry_id' => 'encyclopedia'], 'later' => ['image_id' => 'attachments']],
    ['map_pins', 'maps' => ['map_id' => 'map', 'child_map_id' => 'map', 'entry_id' => 'encyclopedia', 'event_id' => 'events']],
    ['map_routes', 'maps' => ['map_id' => 'map']],
    ['party_groups', 'key' => 'group', 'maps' => ['region_id' => 'regions', 'map_id' => 'map', 'token_id' => 'token']],
    ['party_trail', 'maps' => ['group_id' => 'group', 'map_id' => 'map']],
    // Files last: each hangs off an entry, tome, session, map or token copied above, and gets its own copy on disk.
    ['attachments', 'key' => 'attachments'],
];
/** attachments.parent_type => the CAMPAIGN_COPY map its parent_id is in. */
const COPY_PARENTS = ['encyclopedia' => 'encyclopedia', 'library' => 'library', 'session' => 'session', 'map' => 'map', 'token' => 'token'];

/** Copy campaign $cid into a new one named $name, GM'd by whoever copies it: everything in it, or with $setupOnly its
 * calendar, settings, regions, holidays and tag and relationship lists. Returns [new id, tables copied]. */
function campaign_copy(int $cid, string $name, bool $setupOnly): array {
    $pdo = db();
    $me = me();
    $c = campaign_row($cid);
    $ids = [];
    $later = [];
    $files = [];                                          // stored names written, removed again if the copy fails
    $copied = [];
    $dir = upload_dir()['dir'];
    // The copied files are the copier's, so they count towards their own room for files, as an upload would.
    if (!$setupOnly) {
        $st = $pdo->prepare("SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE campaign_id=? AND kind<>'embed'");
        $st->execute([$cid]);
        $size = (int)$st->fetchColumn();
        $mine = max(1, (int)(cfg('uploads', [])['user_mb'] ?? 1000)) << 20;
        $st = $pdo->prepare('SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE created_by=?');
        $st->execute([$me['id']]);
        if ($size && (int)$st->fetchColumn() + $size > $mine) fail('Its files would take you past your ' . ($mine >> 20) . ' MB of files across your campaigns. Remove some first, or copy only its setup', 413);
    }
    $pdo->beginTransaction();
    try {
        $pdo->prepare('INSERT INTO campaigns (name, description, calendar_json, settings_json, current_shift, seed, created_by) VALUES (?,?,?,?,?,?,?)')
            ->execute([$name, $c['description'], $c['calendar_json'], $c['settings_json'], $c['current_shift'], $c['seed'], $me['id']]);
        $new = (int)$pdo->lastInsertId();
        $st = $pdo->prepare('SELECT character_name FROM campaign_members WHERE campaign_id=? AND user_id=?');
        $st->execute([$cid, $me['id']]);
        $pdo->prepare("INSERT INTO campaign_members (campaign_id, user_id, role, character_name) VALUES (?,?,'gm',?)")
            ->execute([$new, $me['id'], (string)($st->fetchColumn() ?: '')]);
        foreach (CAMPAIGN_COPY as $spec) {
            $t = $spec[0];
            if ($setupOnly && empty($spec['setup'])) continue;
            $cols = array_column($pdo->query("SHOW COLUMNS FROM `$t`")->fetchAll(), 'Field');
            if (isset($spec['via'])) {
                [$vc, $vm] = $spec['via'];
                if (empty($ids[$vm])) { $copied[] = $t; continue; }
                $st = $pdo->prepare("SELECT * FROM `$t` WHERE `$vc` IN (" . implode(',', array_map('intval', array_keys($ids[$vm]))) . ')');
                $st->execute();
            } else {
                $st = $pdo->prepare("SELECT * FROM `$t` WHERE campaign_id=?" . (in_array('id', $cols, true) ? ' ORDER BY id' : ''));
                $st->execute([$cid]);
            }
            $maps = ($spec['maps'] ?? []) + (isset($spec['via']) ? [$spec['via'][0] => $spec['via'][1]] : []);
            $ins = null;
            foreach ($st->fetchAll() as $r) {
                $old = isset($r['id']) ? (int)$r['id'] : null;
                if (array_key_exists('campaign_id', $r)) $r['campaign_id'] = $new;
                foreach ($maps as $col => $m) {
                    if (!array_key_exists($col, $r) || $r[$col] === null || (string)$r[$col] === '0') continue;   // 0: points at nothing
                    if (!isset($ids[$m][(int)$r[$col]])) continue 2;
                    $r[$col] = $ids[$m][(int)$r[$col]];
                }
                foreach (array_keys($spec['later'] ?? []) as $col) if (array_key_exists($col, $r)) $r[$col] = null;
                if ($t === 'sheet_characters' && $r['owner_id'] !== null) $r['owner_id'] = $me['id'];   // one with no player keeps none
                if ($t === 'attachments') {
                    $m = COPY_PARENTS[$r['parent_type']] ?? null;
                    if ($m === null || !isset($ids[$m][(int)$r['parent_id']])) continue;
                    $r['parent_id'] = $ids[$m][(int)$r['parent_id']];
                    $stored = bin2hex(random_bytes(16));
                    if ($r['kind'] !== 'embed') {
                        // A file that is missing on disk is left out, rather than copied as a broken picture.
                        if (!$dir || !preg_match('/^[0-9a-f]{32}$/', $r['stored_name']) || !is_file("$dir/{$r['stored_name']}")) continue;
                        if (!@copy("$dir/{$r['stored_name']}", "$dir/$stored")) throw new RuntimeException("couldn't copy file {$r['stored_name']}");
                        @chmod("$dir/$stored", 0600);
                        $files[] = $stored;
                    }
                    $r['stored_name'] = $stored;
                    $r['created_by'] = $me['id'];
                }
                unset($r['id']);
                $ins ??= $pdo->prepare("INSERT INTO `$t` (`" . implode('`, `', array_keys($r)) . '`) VALUES (' . implode(',', array_fill(0, count($r), '?')) . ')');
                $ins->execute(array_values($r));
                if ($old !== null && isset($spec['key'])) $ids[$spec['key']][$old] = (int)$pdo->lastInsertId();
                if ($old !== null && !empty($spec['later'])) $later[] = [$t, $spec['later'], $old, $ids[$spec['key']][$old]];
            }
            $copied[] = $t;
        }
        // Columns that point at rows copied after their own: a map's or token's picture.
        foreach ($later as [$t, $cols, $old, $nid]) {
            $st = $pdo->prepare("SELECT * FROM `$t` WHERE id=?");
            $st->execute([$old]);
            $r = $st->fetch();
            foreach ($cols as $col => $m) {
                if (($r[$col] ?? null) !== null && isset($ids[$m][(int)$r[$col]])) $pdo->prepare("UPDATE `$t` SET `$col`=? WHERE id=?")->execute([$ids[$m][(int)$r[$col]], $nid]);
            }
        }
        // A downtime's activities name characters with no player by their ids: the copy's own, or none once not copied.
        foreach ($ids['downtime'] ?? [] as $nid) {
            $st = $pdo->prepare('SELECT activities_json FROM downtimes WHERE id=?');
            $st->execute([$nid]);
            $acts = dec($st->fetchColumn()) ?: [];
            if (!array_filter($acts, fn($a) => !empty($a['characters']))) continue;
            foreach ($acts as &$a) $a['characters'] = array_values(array_filter(array_map(fn($i) => $ids['character'][(int)$i] ?? 0, $a['characters'] ?? [])));
            unset($a);
            $pdo->prepare('UPDATE downtimes SET activities_json=? WHERE id=?')->execute([json_encode($acts, JSON_UNESCAPED_UNICODE), $nid]);
        }
        // The settings name the current region by its id.
        $s = dec($c['settings_json']) ?: [];
        if (isset($s['current_region'])) {
            $s['current_region'] = $ids['regions'][(int)$s['current_region']] ?? null;
            $pdo->prepare('UPDATE campaigns SET settings_json=? WHERE id=?')->execute([json_in($s), $new]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        foreach ($files as $f) @unlink("$dir/$f");
        throw $e;
    }
    return [$new, $copied];
}

// A request with an API key may come from any site's page (a Foundry module, say), so CORS is open to it alone.
api_cors();
require_method('GET', 'POST');
// Default deny: an action runs only if api/actions.php lists it, and only for whom it says, checked before anything else
// runs, so a new action is never open by accident (tests/browser/access.spec.js holds every action to its entry).
$spec = ACTIONS[$action] ?? null;
if ($spec === null) fail('Unknown action', 404, 'unknown_action');
// The At the Table panel signs in with a panel link's code instead of the session, and a program with an API key, for
// the actions marked 'panel' or 'key' (api/panel.php); a header no other site can send needs no CSRF token.
if (panel_request()) panel_gate($action, $spec);
if ($spec['who'] !== 'public') me();
if ($method !== (empty($spec['get']) ? 'POST' : 'GET')) fail($method === 'GET' ? 'Use POST for this action' : 'Use GET for this action', 405);
if ($method === 'POST' && !panel_request()) require_csrf();
// Per account, so one script or stuck page can't flood the database: far above what anyone clicking does.
if ($method === 'POST') rate_limit('write', 'u' . me()['id'], (int)(cfg('limits', [])['writes_per_minute'] ?? 600), 60);
// And a day's worth of what they send, in KB, so a script can't grow the database by gigabytes while staying under the
// rate above. Uploads have their own room (uploads.user_mb), so only the JSON bodies count.
if ($method === 'POST' && ($kb = limit_of('write_mb_per_day', 50) * 1024) && !str_starts_with((string)($_SERVER['CONTENT_TYPE'] ?? ''), 'multipart/'))
    rate_limit('write_kb', 'u' . me()['id'], $kb, 86400, (int)ceil(((int)($_SERVER['CONTENT_LENGTH'] ?? 0)) / 1024),
        'You have saved a lot today. The rest can wait until tomorrow');

// A read changes nothing in the session, so let go of its file lock now (PHP writes last_seen as it does): otherwise
// every open tab's poll, an upload and a campaign copy all queue behind one another for the whole request.
if ($method === 'GET' && session_status() === PHP_SESSION_ACTIVE) session_write_close();

try {
    // tests/browser/hardening.spec.js: an exception that isn't a database one still answers JSON. Test configs only.
    if (cfg('test_login') && ($_SERVER['HTTP_X_TEST_THROW'] ?? '') === '1') throw new RuntimeException('test exception');
    // The code below assumes every migration has run (deploy.sh runs them), so an install that is behind says so plainly
    // instead of failing on a missing table or column halfway through an action.
    if (!schema_current(db(), dirname(__DIR__))) json_error(503, 'needs_upgrade', "This Chronicle's database needs an upgrade: run deploy.sh on the server, or open install.php and press Install or upgrade.");
    if ($spec['who'] === 'admin') need_admin();
    elseif ($spec['who'] === 'gm') need_gm(cid());
    elseif ($spec['who'] === 'member') role(cid());
    // A GM's change bumps campaigns.updated_at as it answers (out()), which open pages poll ('changed') to reload.
    if (!empty($spec['touch'])) $GLOBALS['touch_cid'] = cid();
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
        // starred: the campaigns they starred, listed first on the campaign list. Ids of campaigns they can't open are kept
        // out, so it never says which other campaigns exist.
        if (array_key_exists('starred', body())) {
            $ids = p('starred');
            if (!is_array($ids) || count($ids) > 1000) fail('Starred must be a list of campaigns');
            $ids = array_values(array_unique(array_map('intval', array_filter($ids, fn($v) => is_int($v) || (is_string($v) && ctype_digit($v))))));
            if ($ids && !$u['is_admin']) {
                $st = db()->prepare('SELECT campaign_id FROM campaign_members WHERE user_id=? AND campaign_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')');
                $st->execute([$u['id'], ...$ids]);
                $ok = array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
                $ids = array_values(array_filter($ids, fn($i) => in_array($i, $ok, true)));
            }
            if ($ids) $prefs['starred'] = $ids; else unset($prefs['starred']);
        }
        // dice_saved: { cid, list: [{n: name, e: roll}] }, the rolls they saved on the die roller (static/dice-tab.js) in
        // one campaign they are in. Kept by campaign under prefs.dice_saved; an empty list forgets that campaign's.
        if (array_key_exists('dice_saved', body())) {
            $ds = p('dice_saved');
            if (!is_array($ds) || !isset($ds['cid']) || !is_array($ds['list'] ?? null)) fail('Saved rolls must be a campaign and a list');
            $dcid = int_in($ds['cid'], 1);
            if (!$u['is_admin']) {
                $st = db()->prepare('SELECT 1 FROM campaign_members WHERE user_id=? AND campaign_id=?');
                $st->execute([$u['id'], $dcid]);
                if (!$st->fetchColumn()) fail('Campaign not found', 404);
            }
            if (count($ds['list']) > 100) fail('That is a lot of saved rolls: 100 is the most');
            $list = [];
            foreach ($ds['list'] as $r) {
                $n = trim((string)(is_array($r) ? $r['n'] ?? '' : ''));
                $e = trim((string)(is_array($r) ? $r['e'] ?? '' : ''));
                if ($n === '' || $e === '') continue;
                if (mb_strlen($n) > 60 || mb_strlen($e) > 200 || preg_match('/[\x00-\x1f\x7f]/u', $n . $e)) fail('A saved roll is a short name and one line of dice');
                $list[] = ['n' => $n, 'e' => $e];
            }
            $all = is_array($prefs['dice_saved'] ?? null) ? $prefs['dice_saved'] : [];
            if ($list) $all[(string)$dcid] = $list; else unset($all[(string)$dcid]);
            if ($all) $prefs['dice_saved'] = $all; else unset($prefs['dice_saved']);
        }
        // star: { cid, kind: 'entry'|'tome', id, on }, star or unstar one Encyclopedia entry or Library tome for this person
        // alone. Kept by campaign under prefs.stars as { "<cid>": { entry: [ids], tome: [ids] } }, newest star last. The
        // Encyclopedia and Library list a person's starred ones on their start pages. One star at a time, so two tabs
        // starring at once don't undo each other.
        if (array_key_exists('star', body())) {
            $s = p('star');
            if (!is_array($s) || !in_array($s['kind'] ?? null, ['entry', 'tome'], true)) fail('A star is an entry or a tome');
            $scid = int_in($s['cid'] ?? null, 1);
            $sid = int_in($s['id'] ?? null, 1);
            if (!$u['is_admin']) {
                $st = db()->prepare('SELECT 1 FROM campaign_members WHERE user_id=? AND campaign_id=?');
                $st->execute([$u['id'], $scid]);
                if (!$st->fetchColumn()) fail('Campaign not found', 404);
            }
            $all = is_array($prefs['stars'] ?? null) ? $prefs['stars'] : [];
            $mine = is_array($all[(string)$scid] ?? null) ? $all[(string)$scid] : [];
            $ids = array_values(array_filter(array_map('intval', is_array($mine[$s['kind']] ?? null) ? $mine[$s['kind']] : []), fn($i) => $i > 0 && $i !== $sid));
            if (!empty($s['on'])) {
                if (count($ids) >= 500) fail('That is a lot of stars: 500 is the most');
                $ids[] = $sid;
            }
            if ($ids) $mine[$s['kind']] = $ids; else unset($mine[$s['kind']]);
            if ($mine) $all[(string)$scid] = $mine; else unset($all[(string)$scid]);
            if ($all) $prefs['stars'] = $all; else unset($prefs['stars']);
        }
        // dice_look: { body, ink, tex }, how their dice look (static/dice-3d.js): the dice's colour, the numbers' colour and
        // a built-in pattern. It is theirs in every campaign, and everyone sees their rolls in it. Null goes back to the
        // theme's dice.
        if (array_key_exists('dice_look', body())) {
            $dl = p('dice_look');
            if ($dl === null) unset($prefs['dice_look']);
            else {
                $look = dice_look($dl);
                if (!$look) fail('Pick a colour for the dice and one for the numbers');
                $prefs['dice_look'] = $look;
            }
        }
        db()->prepare('INSERT INTO user_prefs (user_id, prefs_json) VALUES (?,?) ON DUPLICATE KEY UPDATE prefs_json=VALUES(prefs_json)')
            ->execute([$u['id'], json_encode((object)$prefs)]);
        out(['prefs' => (object)$prefs]);

    case 'profile_save':
        // The name and pronouns Chronicle calls them by, in place of their Google or GitHub name. Blank clears either one.
        // Kept in user_profiles, as the users row is Sinless's too and every sign-in rewrites its name.
        $u = me();
        $clean = fn($v) => is_string($v) ? trim((string)preg_replace('/\s+/u', ' ', $v)) : fail('Expected text');
        $name = $clean(p('name', ''));
        $pronouns = $clean(p('pronouns', ''));
        if (mb_strlen($name) > 150) fail('Keep the name to 150 characters');
        if (mb_strlen($pronouns) > 40) fail('Keep the pronouns to 40 characters');
        db()->prepare('INSERT INTO user_profiles (user_id, name, pronouns) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), pronouns=VALUES(pronouns)')
            ->execute([$u['id'], $name === '' ? null : $name, $pronouns === '' ? null : $pronouns]);
        out(['name' => $name === '' ? $u['provider_name'] : $name, 'custom_name' => $name === '' ? null : $name, 'pronouns' => $pronouns === '' ? null : $pronouns]);

    // ===== user admin =====
    // Chronicle's own queue (chronicle_access), apart from Sinless's: everyone who has signed in here, and accounts from
    // before Google/GitHub sign-in. Someone who only uses Sinless isn't listed. New sign-ins wait as 'pending'.
    // Admin rights come only from admin_identities in the config (or a migrated account).
    case 'users':
        need_admin();
        out(['users' => db()->query(has_access_table()
            ? "SELECT u.id, u.provider, u.email, " . user_name_sql() . " AS display_name, u.display_name AS provider_name, " . user_pronouns_sql() . " AS pronouns,
               COALESCE(a.status, u.status) AS status, u.is_admin, COALESCE(a.requested_at, u.created_at) AS created_at, u.last_login_at
               FROM users u LEFT JOIN chronicle_access a ON a.user_id=u.id WHERE a.user_id IS NOT NULL OR u.provider='legacy'
               ORDER BY COALESCE(a.status, u.status) = 'pending' DESC, display_name"
            : "SELECT u.id, u.provider, u.email, " . user_name_sql() . " AS display_name, u.display_name AS provider_name, " . user_pronouns_sql() . " AS pronouns,
               u.status, u.is_admin, u.created_at, u.last_login_at FROM users u ORDER BY u.status = 'pending' DESC, display_name")->fetchAll()]);

    case 'user_status':
        $admin = need_admin();
        rate_limit('admin', 'u' . $admin['id'], 60, 60);
        $id = int_in(p('id'), 1);
        $status = p('status');
        if (!in_array($status, ['approved', 'revoked'], true)) fail('Status must be approved or revoked');
        if ($id === $admin['id']) fail("You can't change your own access");
        $st = db()->prepare('SELECT u.id, u.email, ' . user_name_sql() . ' AS display_name, u.status, u.is_admin FROM users u WHERE u.id=?');
        $st->execute([$id]);
        $t = $st->fetch();
        if (!$t) fail('User not found', 404);
        if ($status === 'revoked' && (int)$t['is_admin']) fail("Admins can't be revoked here. Remove them from admin_identities first.");
        if (chronicle_status($t) === $status) out(['ok' => true]);
        // Only their access to Chronicle: users.status is Sinless's.
        if (has_access_table()) db()->prepare('INSERT INTO chronicle_access (user_id, status, approved_at) VALUES (?, ?, IF(?=\'approved\', NOW(), NULL))
            ON DUPLICATE KEY UPDATE status=VALUES(status), approved_at=IF(VALUES(status)=\'approved\', NOW(), approved_at)')->execute([$id, $status, $status]);
        else db()->prepare('UPDATE users SET status=?, approved_at=IF(?=\'approved\', NOW(), approved_at) WHERE id=?')->execute([$status, $status, $id]);
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
        // Their token (in any campaign) is free for another, as when a member is removed; party_rows drops them from the groups.
        db()->prepare('UPDATE tokens SET member_id=NULL WHERE member_id=?')->execute([$id]);
        $st = db()->prepare('SELECT provider FROM users WHERE id=?');
        $st->execute([$id]);
        // The account is shared with Sinless, so it stays: they leave Chronicle (its list and their campaigns) only. An
        // account from before Google/GitHub sign-in was only ever Chronicle's, and goes.
        if ($st->fetchColumn() === 'legacy' || !has_access_table()) db()->prepare('DELETE FROM users WHERE id=?')->execute([$id]);
        else {
            db()->beginTransaction();
            db()->prepare('DELETE FROM campaign_members WHERE user_id=?')->execute([$id]);
            db()->prepare('DELETE FROM chronicle_access WHERE user_id=?')->execute([$id]);
            db()->commit();
        }
        out(['ok' => true]);

    // ===== campaigns =====
    case 'templates':
    case 'template':
    case 'template_save':
    case 'template_fork':
    case 'template_delete':
    case 'sheet_import_fetch':
        templates_action($action);

    case 'starter_templates_load':
        starter_templates_load();

    case 'starter_sources':
        starter_sources();

    case 'game_request':
    case 'game_requests':
    case 'game_requests_clear':
    case 'site_setting_save':
        game_requests_action($action);

    case 'report_send':
    case 'reports':
    case 'report_shot':
    case 'report_status':
    case 'report_github':
    case 'report_github_link':
    case 'report_delete':
        reports_action($action);

    case 'characters':
    case 'character':
    case 'character_create':
    case 'character_field':
    case 'character_values':
    case 'character_save':
    case 'character_portrait':
    case 'character_delete':
    case 'character_presence':
    case 'member_active_character':
    case 'member_link_character':
        characters_action($action, cid());

    case 'campaigns':
        $u = me();
        claim_invites();   // a GM's invitation by email, waiting for this account
        // member says whether they belong to it (an admin is shown every campaign as GM); character_name is theirs there.
        $st = db()->prepare($u['is_admin']
            ? "SELECT c.id, c.name, c.description, COALESCE(m.role, 'gm') AS role, COALESCE(m.character_name, '') AS character_name, m.active_character_id, m.user_id IS NOT NULL AS member FROM campaigns c LEFT JOIN campaign_members m ON m.campaign_id=c.id AND m.user_id=? ORDER BY c.name"
            : 'SELECT c.id, c.name, c.description, m.role, m.character_name, m.active_character_id, 1 AS member FROM campaigns c JOIN campaign_members m ON m.campaign_id=c.id WHERE m.user_id=? ORDER BY c.name');
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
        $st = db()->prepare('SELECT u.id, u.email, ' . user_name_sql() . ' AS display_name, ' . user_pronouns_sql() . ' AS pronouns, m.role, m.character_name, m.active_character_id
            FROM campaign_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=? ORDER BY m.role, display_name');
        $st->execute([$cid]);
        $members = $st->fetchAll();
        // an API key's program gets no one's email, even through a GM's key
        if (!$isGm || api_request()) $members = array_map(fn($m) => ['id' => $m['id'], 'display_name' => $m['display_name'], 'pronouns' => $m['pronouns'], 'role' => $m['role'], 'character_name' => $m['character_name'],
            'active_character_id' => $m['active_character_id'] ?? null], $members);
        $tokenUrls = token_urls($cid, $isGm);
        $members = array_map(fn($m) => $m + ['token_url' => $tokenUrls['member'][(int)$m['id']] ?? null], $members);
        $invites = [];
        if ($isGm && !api_request()) {
            $st = db()->prepare('SELECT email, role, created_at FROM campaign_invites WHERE campaign_id=? ORDER BY email');
            $st->execute([$cid]);
            $invites = $st->fetchAll();
        }
        out(['campaign' => $camp, 'role' => $role, 'regions' => $regions, 'holidays' => $holidays, 'members' => $members, 'invites' => $invites, 'tags' => campaign_tags($cid),
            'encyclopedia' => entry_index($cid, $isGm, $tokenUrls['entry']), 'encyclopedia_ignored' => ignored_terms($cid, $role),
            'encyclopedia_tags' => entry_tags($cid), 'maps_index' => maps_index($cid, $isGm),
            'viewing_as_player' => !empty($GLOBALS['viewing_as_player'])]
            + ($isGm ? ['open_session' => ($o = open_session($cid)) ? session_out($o, false, true) : null] : []));

    case 'changed': // polled by open pages: a new value means a GM changed something since
        $cid = cid();
        role($cid);
        $st = db()->prepare('SELECT updated_at FROM campaigns WHERE id=?');
        $st->execute([$cid]);
        out(['changed' => (string)$st->fetchColumn(), 'last_roll' => dice_last_seen($cid, role($cid) === 'gm')]);

    case 'owlbear_manifest': // anyone: Owlbear Rodeo reads it from its own page when a GM or player adds the extension
        owlbear_manifest();

    case 'panel_whoami': // At the Table: who this page is signed in as, and through which panel link
        $cid = cid();
        $role = role($cid);
        $k = panel_link();
        out(['campaign_id' => $cid, 'role' => $role, 'name' => $k && $k['scope'] === 'public_panel' ? null : (string)me()['display_name'],
            'link' => $k ? panel_link_out($k) : null]);

    case 'panel_links': // your panel links in this campaign (a GM: everyone's)
        $cid = cid();
        $isGm = role($cid) === 'gm';
        out(['links' => panel_links_list($cid, $isGm)]);

    case 'panel_link_create':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        out(['ok' => true, 'link' => panel_link_create($cid, $isGm)]);

    case 'panel_link_revoke':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        panel_link_revoke($cid, $isGm);
        out(['ok' => true]);

    case 'campaign_create':
        $u = me();
        need_campaign_room();
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
        try { party_sync_main_region($cid); }   // the main group's region follows current_region; the settings are saved either way
        catch (Throwable $e) { error_log('campaign-chronicle: party_sync_main_region: ' . $e->getMessage()); }
        out(['ok' => true]);

    case 'campaign_delete':
        $cid = cid(); need_gm($cid);
        if (p('confirm') !== 'DELETE') fail('Confirmation missing');
        attachments_purge($cid);
        db()->prepare('DELETE FROM campaigns WHERE id=?')->execute([$cid]);
        out(['ok' => true]);

    case 'campaign_copy': // GMs: a new campaign of their own with everything in this one (or setup: true, its setup only)
        $cid = cid(); need_gm($cid);
        rate_limit('campaign_copy', (string)me()['id'], 10, 60);   // each one copies every row and file of a campaign
        need_campaign_room();
        $name = trim((string)str_in(p('name'), 150, false));
        if ($name === '') fail('Name required');
        @set_time_limit(300);
        [$new, $tables] = campaign_copy($cid, $name, !empty(p('setup')));
        out(['ok' => true, 'id' => $new, 'tables' => $tables]);

    case 'set_time':
        $cid = cid(); need_gm($cid);
        $shift = int_in(p('current_shift'));
        db()->prepare('UPDATE campaigns SET current_shift=? WHERE id=?')->execute([$shift, $cid]);
        out(['ok' => true, 'current_shift' => $shift]);

    // ===== members =====
    case 'member_candidates':
        // The GM's member picker searches, it never lists: nobody sees who else has access to the site. GMs only, and only
        // for a search of at least 2 letters (q), which returns up to 8 approved accounts not yet in this campaign.
        $cid = cid(); need_gm($cid);
        $q = mb_strtolower(trim((string)str_in($_GET['q'] ?? '', 191, false)));
        if (mb_strlen($q) < 2) out(['users' => [], 'more' => false]);
        $like = '%' . addcslashes($q, '\\%_') . '%';
        // Only a site admin sees emails and finds people by them: any approved user can start a campaign and be its GM, so
        // the rest search names. The accounts table is shared with Sinless, so a GM who isn't a site admin finds only
        // people they already play with in another campaign; anyone else they add by typing their sign-in email.
        $admin = (bool)me()['is_admin'];
        $mine = $admin ? '' : ' AND u.id IN (SELECT o.user_id FROM campaign_members o JOIN campaign_members me ON me.campaign_id=o.campaign_id WHERE me.user_id=?)';
        $match = $admin ? '(LOWER(display_name) LIKE ? OR LOWER(email) LIKE ?)' : "(TRIM(display_name) <> '' AND LOWER(display_name) LIKE ?)";
        $st = db()->prepare("SELECT * FROM (SELECT u.id, u.email, " . user_name_sql() . " AS display_name FROM users u WHERE " . approved_sql('u.id') . " AND u.id NOT IN (SELECT user_id FROM campaign_members WHERE campaign_id=?)$mine) x
            WHERE $match ORDER BY display_name = '', display_name, email LIMIT 9");
        $st->execute($admin ? [$cid, $like, $like] : [$cid, me()['id'], $like]);
        $users = $st->fetchAll();
        $more = count($users) > 8;
        $users = array_slice($users, 0, 8);
        if (!$admin) $users = array_map(fn($x) => ['id' => $x['id'], 'display_name' => $x['display_name']], $users);
        out(['users' => $users, 'more' => $more]);

    case 'member_add':
        // By the account picked from member_candidates, or by sign-in email. An approved account joins at once, so the
        // GM can name their character and put them in a group straight away. Any other email is recorded as an
        // invitation, which becomes a membership when that person, approved, next opens their campaign list or the
        // campaign itself, so a GM can invite someone before they have signed up.
        $cid = cid(); need_gm($cid);
        $role = p('role') === 'gm' ? 'gm' : 'player';
        if (p('user_id') !== null) {
            // Picked from the list: only people the GM already plays with (anyone, for a site admin), as that list offers,
            // so account ids can't be tried one by one.
            $known = me()['is_admin'] ? '' : ' AND id IN (SELECT o.user_id FROM campaign_members o JOIN campaign_members me ON me.campaign_id=o.campaign_id WHERE me.user_id=' . me()['id'] . ')';
            $st = db()->prepare('SELECT id FROM users WHERE id=? AND ' . approved_sql() . $known);
            $st->execute([int_in(p('user_id'), 1)]);
            $uid = $st->fetchColumn();
            if (!$uid) fail('That account is not approved (or no longer exists).', 404);
        } else {
            $email = mb_strtolower(trim((string)str_in(p('email'), 191, false)));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Type the email they sign in with');
            $st = db()->prepare("SELECT id FROM users WHERE LOWER(email)=? AND email<>'' AND " . approved_sql());
            $st->execute([$email]);
            $uid = $st->fetchColumn();
            if (!$uid) {
                db()->prepare('INSERT INTO campaign_invites (campaign_id, email, role, invited_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)')
                    ->execute([$cid, $email, $role, me()['id']]);
                out(['ok' => true, 'invited' => true]);
            }
            db()->prepare('DELETE FROM campaign_invites WHERE campaign_id=? AND email=?')->execute([$cid, $email]);
        }
        db()->prepare('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES (?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)')->execute([$cid, $uid, $role]);
        out(['ok' => true]);

    case 'member_remove':
        $cid = cid(); need_gm($cid);
        if (p('email') !== null && p('user_id') === null) {   // an invitation not taken up yet
            db()->prepare('DELETE FROM campaign_invites WHERE campaign_id=? AND email=?')
                ->execute([$cid, mb_strtolower(trim((string)str_in(p('email'), 191, false)))]);
            out(['ok' => true]);
        }
        $uid = int_in(p('user_id'), 1);
        $st = db()->prepare("SELECT COUNT(*) FROM campaign_members WHERE campaign_id=? AND role='gm' AND user_id<>?");
        $st->execute([$cid, $uid]);
        $isGmTarget = db()->prepare("SELECT role FROM campaign_members WHERE campaign_id=? AND user_id=?");
        $isGmTarget->execute([$cid, $uid]);
        if ($isGmTarget->fetchColumn() === 'gm' && (int)$st->fetchColumn() === 0) fail('A campaign needs at least one GM');
        db()->prepare('DELETE FROM campaign_members WHERE campaign_id=? AND user_id=?')->execute([$cid, $uid]);
        party_remove_member($cid, $uid);
        db()->prepare('UPDATE tokens SET member_id=NULL WHERE campaign_id=? AND member_id=?')->execute([$cid, $uid]);   // their token is free for another
        out(['ok' => true]);

    case 'member_character': // a player names their own character; a GM can name anyone's
        $cid = cid();
        $uid = int_in(p('user_id', me()['id']), 1);
        if ($uid !== me()['id']) need_gm($cid); else role($cid);
        $name = trim((string)str_in(p('character_name'), 150, false));
        $chk = db()->prepare('SELECT 1 FROM campaign_members WHERE campaign_id=? AND user_id=?');
        $chk->execute([$cid, $uid]);
        if (!$chk->fetchColumn()) fail('Only campaign members can have a character name', 404);
        // with an active character, the name is its entry's name: renaming one renames the other
        $active = null;
        $st = db()->prepare('SELECT c.entry_id FROM campaign_members m JOIN sheet_characters c ON c.id=m.active_character_id AND c.owner_id=m.user_id
            JOIN encyclopedia_entries e ON e.id=c.entry_id AND e.is_secret=0 WHERE m.campaign_id=? AND m.user_id=?');
        $st->execute([$cid, $uid]);
        $active = $st->fetchColumn() ?: null;
        if ($active && $name !== '') {
            $name = character_name_in($cid, $name, role($cid) === 'gm', (int)$active);
            db()->prepare('UPDATE encyclopedia_entries SET name=?' . entry_bump() . ' WHERE id=?')->execute([$name, $active]);
            character_names_sync((int)$active);
        }
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
        $st = db()->prepare('SELECT abs_day, region_id, weather_json, notes, notes_format, gm_notes, gm_notes_format, locations, version FROM days WHERE campaign_id=? AND abs_day=?');
        $st->execute([$cid, $ad]);
        $d = $st->fetch() ?: null;
        $day = null;
        if ($d) {
            $hideFuture = !$isGm && empty($settings['players_see_future_weather']);
            $order = shift_order($c);
            $day = ['abs_day' => $ad, 'region_id' => $d['region_id'] !== null ? (int)$d['region_id'] : null,
                'weather' => visible_weather($d['weather_json'], $ad, (int)$c['current_shift'], $hideFuture, $order, dec($c['calendar_json'])), 'notes' => note_for($d['notes'], $d['notes_format'], $isGm),
                'notes_format' => $d['notes_format'], 'locations' => $d['locations']];
            if ($isGm) $day += ['gm_notes' => $d['gm_notes'], 'gm_notes_format' => $d['gm_notes_format'], 'version' => (int)$d['version']];
        }
        $st = db()->prepare('SELECT shift, activity, visibility_override' . ($isGm ? ', gm_notes' : '') . ' FROM shifts WHERE campaign_id=? AND abs_day=? ORDER BY shift');
        $st->execute([$cid, $ad]);
        $shifts = $st->fetchAll();
        $st = db()->prepare('SELECT e.id, e.abs_day, e.end_day, e.shift, e.shift_end, e.title, e.body, e.is_secret, e.created_by, ' . AUTHOR_SQL . ' AS author, ' . user_name_sql() . ' AS player
            FROM events e LEFT JOIN users u ON u.id=e.created_by LEFT JOIN campaign_members m ON m.campaign_id=e.campaign_id AND m.user_id=e.created_by
            WHERE e.campaign_id=? AND e.abs_day <= ? AND COALESCE(e.end_day, e.abs_day) >= ?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY e.shift IS NULL DESC, e.shift, e.id');
        $st->execute([$cid, $ad, $ad]);
        $events = $st->fetchAll();
        if ($events) {
            $ids = array_column($events, 'id');
            $in = implode(',', array_fill(0, count($ids), '?'));
            $st = db()->prepare('SELECT n.id, n.event_id, n.user_id, n.body, n.created_at, ' . AUTHOR_SQL . " AS author, " . user_name_sql() . " AS player
                FROM event_notes n LEFT JOIN users u ON u.id=n.user_id LEFT JOIN campaign_members m ON m.campaign_id=? AND m.user_id=n.user_id
                WHERE n.event_id IN ($in) ORDER BY n.created_at");
            $st->execute([$cid, ...$ids]);
            $notes = [];
            foreach ($st->fetchAll() as $n) $notes[$n['event_id']][] = $n;
            foreach ($events as &$e) $e['notes'] = $notes[$e['id']] ?? [];
            unset($e);
            attach_tags($events);
        }
        $st = db()->prepare('SELECT n.id, n.shift, n.user_id, n.body, n.created_at, ' . AUTHOR_SQL . ' AS author, ' . user_name_sql() . ' AS player
            FROM shift_notes n LEFT JOIN users u ON u.id=n.user_id LEFT JOIN campaign_members m ON m.campaign_id=n.campaign_id AND m.user_id=n.user_id
            WHERE n.campaign_id=? AND n.abs_day=? ORDER BY n.created_at, n.id');
        $st->execute([$cid, $ad]);
        $shiftNotes = $st->fetchAll();
        out(['day' => $day, 'shifts' => $shifts, 'shift_notes' => $shiftNotes, 'shift_actions' => shift_actions_of($cid, $ad, null, $isGm), 'events' => $events, 'today' => $today,
            'sessions' => day_sessions($cid, $c, $ad, $isGm),
            // the characters with no player who travel with the party, in any of its groups: each gets an action line
            'party_characters' => array_merge(...array_values(party_characters($cid, $isGm)) ?: [[]])]);

    case 'days_save': // GM: batch upsert generated weather (+ region) — never touches notes
        $cid = cid(); need_gm($cid);
        $rows = p('days', []);
        if (!is_array($rows) || count($rows) > 1500) fail('Send 1–1500 days at a time');
        need_row_room($cid, 'days', count($rows));
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
        $written = $has('notes') || $has('gm_notes') || $has('locations');   // what the Notes box saves, and its version counts
        db()->beginTransaction();
        $st = db()->prepare('SELECT version FROM days WHERE campaign_id=? AND abs_day=? FOR UPDATE');
        $st->execute([$cid, $ad]);
        $now = $st->fetchColumn();
        if ($now === false) need_row_room($cid, 'days', 1);
        // version: the copy the Notes box opened (0 for a day with no row yet). Someone else's save since is refused,
        // so it isn't overwritten; a save that leaves version out (the weather, older pages) isn't checked.
        if ($written && p('version') !== null && int_in(p('version'), 0) !== (int)$now) {
            db()->rollBack();
            fail('Someone saved this day\'s notes after you opened them. Copy what you wrote, reload, and add it again', 409, 'stale');
        }
        $notesWritten = $has('notes') || $has('gm_notes');
        if ($notesWritten) history_before($cid, 'day', $ad);
        db()->prepare('INSERT INTO days (campaign_id, abs_day, region_id, weather_json, notes, notes_format, gm_notes, gm_notes_format, locations) VALUES (?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE region_id=IF(?, VALUES(region_id), region_id), weather_json=COALESCE(VALUES(weather_json), weather_json),
            notes=IF(?, VALUES(notes), notes), notes_format=IF(?, VALUES(notes_format), notes_format),
            gm_notes=IF(?, VALUES(gm_notes), gm_notes), gm_notes_format=IF(?, VALUES(gm_notes_format), gm_notes_format),
            locations=IF(?, VALUES(locations), locations), version=IF(?, version+1, version)')
            ->execute([$cid, $ad, $rid, $weather, $notes, $notesFmt, $gmNotes, $gmNotesFmt, str_in(p('locations'), 5000),
                $has('region_id'), $has('notes'), $has('notes'), $has('gm_notes'), $has('gm_notes'), $has('locations'), $written ? 1 : 0]);
        if ($notesWritten) history_record($cid, 'day', $ad);
        $st->execute([$cid, $ad]);
        $version = (int)$st->fetchColumn();
        db()->commit();
        out(['ok' => true, 'version' => $version]);

    case 'shift_save':
        $cid = cid(); need_gm($cid);
        need_row_room($cid, 'shifts', 1);
        $maxSlot = camp_spd(campaign_row($cid)) - 1;
        $vo = p('visibility_override');
        $vo = ($vo === null || $vo === '') ? null : int_in($vo, 0, 5);
        db()->prepare('INSERT INTO shifts (campaign_id, abs_day, shift, activity, gm_notes, visibility_override) VALUES (?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE activity=VALUES(activity), gm_notes=VALUES(gm_notes), visibility_override=VALUES(visibility_override)')
            ->execute([$cid, $day = int_in(p('abs_day')), $slot = int_in(p('shift'), 0, $maxSlot), str_in(p('activity'), 5000), str_in(p('gm_notes'), 5000), $vo]);
        // an "On the move" action in the activity tags the events running then as Transit
        if (p('transit')) tag_transit_events($cid, $day * ($maxSlot + 1) + $slot, $day * ($maxSlot + 1) + $slot);
        out(['ok' => true]);

    case 'shifts_fill': // GM: label a span of shifts (e.g. "Travelling to Altdorf") without overwriting existing activity
        $cid = cid(); need_gm($cid);
        $from = int_in(p('from_shift')); $to = int_in(p('to_shift'));
        if ($to < $from || $to - $from > 6000) fail('Too many shifts at once (max 6000)');
        need_row_room($cid, 'shifts', $to - $from + 1);
        $act = str_in(p('activity'), 5000, false);
        if ($act === '') fail('Activity text required');
        $st = db()->prepare("INSERT INTO shifts (campaign_id, abs_day, shift, activity) VALUES (?,?,?,?)
            ON DUPLICATE KEY UPDATE activity=IF(activity IS NULL OR activity='', VALUES(activity), activity)");
        db()->beginTransaction();
        $spd = camp_spd(campaign_row($cid));
        for ($s = $from; $s <= $to; $s++) $st->execute([$cid, floordiv($s, $spd), $s - $spd * floordiv($s, $spd), $act]);
        if (p('transit')) tag_transit_events($cid, $from, $to);
        db()->commit();
        out(['ok' => true]);

    case 'shift_action_set': // one action per player's character, one per party character with no player (character_id)
        // and one for the party (user_id 0) on a shift; '' clears it. A GM sets any of them; a player only their own character's.
        $cid = cid();
        $role = role($cid);
        $c = campaign_row($cid);
        $maxSlot = camp_spd($c) - 1;
        $day = int_in(p('abs_day')); $slot = int_in(p('shift'), 0, $maxSlot);
        $uid = int_in(p('user_id') ?? 0, 0);
        $chid = int_in(p('character_id') ?? 0, 0);
        if ($role !== 'gm' && ($chid || $uid !== me()['id'])) fail('Only a GM picks the party\'s action or another player\'s', 403);
        if ($chid) {
            if ($uid) fail('Pick a player or a character, not both');
            $st = db()->prepare('SELECT party_group_id FROM sheet_characters WHERE campaign_id=? AND id=?');
            $st->execute([$cid, $chid]);
            $pg = $st->fetch();
            if (!$pg) fail('That character is not in this campaign');
            // one that has left the party keeps what it did, but gets no new action
            if ($pg['party_group_id'] === null && trim((string)p('action')) !== '') fail('That character doesn\'t travel with the party');
        }
        if ($uid) {
            $st = db()->prepare("SELECT 1 FROM campaign_members WHERE campaign_id=? AND user_id=? AND role='player'");
            $st->execute([$cid, $uid]);
            if (!$st->fetchColumn()) fail('That player is not in this campaign');
        }
        $act = trim((string)str_in(p('action'), 100, false));
        if ($act === '') {
            db()->prepare('DELETE FROM shift_actions WHERE campaign_id=? AND abs_day=? AND shift=? AND user_id=? AND character_id=?')->execute([$cid, $day, $slot, $uid, $chid]);
        } else {
            need_row_room($cid, 'shift_actions', 1);
            db()->prepare('INSERT INTO shift_actions (campaign_id, abs_day, shift, user_id, character_id, action, updated_by) VALUES (?,?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE action=VALUES(action), updated_by=VALUES(updated_by)')->execute([$cid, $day, $slot, $uid, $chid, $act, me()['id']]);
            // the party on the move (Travel, Navigate...) tags the events running then as Transit, as the activity does
            if (!$uid && !$chid && p('transit')) tag_transit_events($cid, $day * ($maxSlot + 1) + $slot, $day * ($maxSlot + 1) + $slot);
        }
        out(['ok' => true, 'actions' => shift_actions_of($cid, $day, $slot, $role === 'gm')]);

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
        if (!$id) need_row_room($cid, 'events', 1);
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
        // With the names and kinds of the characters with no player its activities name (a player isn't told of a GM-only one),
        // and the party group each is for: null for the whole party, or once its group has been merged away.
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $st = db()->prepare('SELECT d.id, d.kind, IF(g.id IS NULL, NULL, d.group_id) AS group_id, g.name AS group_name, d.title, d.start_shift, d.end_shift,
            d.slots, d.activities_json, d.notes' . ($isGm ? ', d.gm_notes' : '') . '
            FROM downtimes d LEFT JOIN party_groups g ON g.id=d.group_id AND g.campaign_id=d.campaign_id
            WHERE d.campaign_id=? ORDER BY d.start_shift DESC, d.id DESC');
        $st->execute([$cid]);
        $cs = db()->prepare("SELECT c.id, c.kind, e.name FROM sheet_characters c JOIN encyclopedia_entries e ON e.id=c.entry_id
            LEFT JOIN campaign_members m ON m.campaign_id=c.campaign_id AND m.user_id=c.owner_id
            WHERE c.campaign_id=? AND COALESCE(m.role, '')<>'player'" . ($isGm ? '' : ' AND e.is_secret=0'));
        $cs->execute([$cid]);
        $names = [];
        foreach ($cs->fetchAll() as $c) $names[(int)$c['id']] = ['name' => $c['name'], 'kind' => $c['kind']];
        $used = [];
        $rows = array_map(function ($r) use ($names, &$used) {
            foreach (['id', 'start_shift', 'end_shift', 'slots'] as $k) $r[$k] = (int)$r[$k];
            $r['group_id'] = $r['group_id'] !== null ? (int)$r['group_id'] : null;
            $r['activities'] = array_map(function ($a) use ($names, &$used) {
                $ch = array_values(array_filter(array_map('intval', $a['characters'] ?? []), fn($i) => isset($names[$i])));
                foreach ($ch as $i) $used[$i] = $names[$i];
                return ['name' => (string)($a['name'] ?? ''), 'members' => array_map('intval', $a['members'] ?? []), 'characters' => $ch];
            }, dec($r['activities_json']) ?: []);
            unset($r['activities_json']);
            return $r;
        }, $st->fetchAll());
        out(['downtimes' => $rows, 'characters' => (object)$used]);

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
            db()->prepare('UPDATE downtimes SET group_id=?, title=?, activities_json=?, notes=?, gm_notes=? WHERE id=?')
                ->execute([downtime_group(p('group_id'), $cid), trim((string)str_in(p('title'), 200, false)), downtime_activities(p('activities', []), $cid),
                    str_in(p('notes'), 20000), str_in(p('gm_notes'), 20000), $id]);
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
        $group = downtime_group(p('group_id'), $cid);
        $pdo = db();
        $pdo->beginTransaction();
        $pdo->prepare('INSERT INTO downtimes (campaign_id, kind, group_id, title, start_shift, end_shift, slots, activities_json, notes, gm_notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            ->execute([$cid, $kind, $group, trim((string)str_in(p('title'), 200, false)), $from, $to, $slots, downtime_activities(p('activities', []), $cid),
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

    // ===== party holdings: the Gear and Loot list and the holding cards, open to GM and players alike ===== (api/holdings.php)
    case 'holdings':
    case 'gear_save':
    case 'gear_tick':
    case 'gear_delete':
    case 'holding_save':
    case 'holding_tick':
    case 'funds_save':
    case 'funds_delete':
    case 'storage_save':
    case 'storage_delete':
    case 'holding_delete':
        holdings_action($action);

    // ===== reminders: pop up when the campaign clock reaches them ===== (api/reminders.php)
    case 'reminders':
    case 'reminder_save':
    case 'reminder_delete':
    case 'reminder_dismiss':
        reminders_action($action);

    // ===== the Encyclopedia ===== (api/encyclopedia.php)
    case 'encyclopedia':
    case 'encyclopedia_sources':
    case 'entry_save':
    case 'secret_reveal':
    case 'item_reveal':
    case 'entries_add':
    case 'entry_note_add':
    case 'entry_delete':
    case 'terms_ignore':
    case 'term_restore':
        encyclopedia_action($action);

    // ===== connections between entries ===== (api/connections.php)
    case 'relations_save':
    case 'relation_update':
    case 'relation_delete':
    case 'relation_type_save':
    case 'relation_type_delete':
        connections_action($action);

    // ===== the Library ===== (api/library.php)
    case 'library':
    case 'tome':
    case 'tome_save':
    case 'tome_delete':
        library_action($action);

    // ===== edit history ===== (api/history.php)
    case 'history_list':
    case 'history_get':
    case 'history_restore':
        history_action($action);

    // ===== clocks ===== (api/clocks.php)
    case 'clocks':
    case 'clock_save':
    case 'clock_tick':
    case 'clock_delete':
        clocks_action($action);

    // ===== the die roller ===== (api/dice.php)
    case 'dice_roll':
    case 'dice_reroll':
    case 'dice_rolls':
    case 'dice_clear':
        dice_action($action);

    // ===== play sessions ===== (api/sessions.php)
    case 'sessions':
    case 'session':
    case 'session_save':
    case 'session_summary_save':
    case 'session_notes_save':
    case 'session_end':
    case 'session_delete':
    case 'session_shift_add':
    case 'session_shift_remove':
        sessions_action($action);

    // ===== pictures and files ===== (api/files.php)
    case 'files':
    case 'file':
    case 'file_upload':
    case 'image_search':
    case 'image_import':
    case 'file_update':
    case 'file_delete':
        files_action($action);

    // ===== maps =====
    case 'maps':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        out(['maps' => maps_list($cid, $isGm)]);

    case 'map': // one map with its pins, routes and party groups
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $m = map_row($cid, int_in($_GET['id'] ?? null, 1), $isGm);
        // the party's trail: every group's that has been on this map, as a player can see this map
        out(['map' => map_out($m), 'parent' => map_parent($cid, (int)$m['id'], $isGm), 'pins' => map_pins_visible($cid, (int)$m['id'], $isGm), 'routes' => map_routes_visible($cid, (int)$m['id'], $isGm),
            'groups' => array_values(array_filter(party_groups($cid, $isGm), fn($g) => $g['map_id'] === (int)$m['id'])),
            'trail' => trail_on_map((int)$m['id'], array_map(fn($g) => $g['id'], party_groups($cid, $isGm)))]);

    case 'groups': // every member: the party's groups, main first
        $cid = cid();
        $isGm = role($cid) === 'gm';
        out(['groups' => party_groups($cid, $isGm)]);

    case 'group_split': // GMs: from_id, name, members [user ids from that group], characters [ids of its characters with no player], region_id (default: the group's)
        $cid = cid();
        need_gm($cid);
        group_split($cid);
        out(['ok' => true, 'groups' => party_groups($cid)]);

    case 'group_save': // GMs: id, then name, region_id, is_main, token_id
        $cid = cid();
        need_gm($cid);
        group_save($cid);
        out(['ok' => true, 'groups' => party_groups($cid)]);

    case 'group_move': // GMs: id, map_id (null to take it off the maps), x, y
        $cid = cid();
        need_gm($cid);
        group_move($cid);
        out(['ok' => true, 'groups' => party_groups($cid)]);

    case 'trail_clear': // GMs: map_id, and id for one group's trail (every group's without)
        $cid = cid();
        need_gm($cid);
        trail_clear($cid);
        out(['ok' => true]);

    case 'group_merge': // GMs: id, into_id
        $cid = cid();
        need_gm($cid);
        group_merge($cid);
        out(['ok' => true, 'groups' => party_groups($cid)]);

    case 'map_save': // GMs: id (to change one), name, is_secret, image_id, scale_per_px, scale_unit, grid_px, grid_offset_x, grid_offset_y, grid_type, grid_shown
        $cid = cid();
        need_gm($cid);
        out(['ok' => true, 'map' => map_save($cid)]);

    case 'map_delete':
        $cid = cid();
        need_gm($cid);
        $m = map_row($cid, int_in(p('id'), 1), true);
        db()->prepare('DELETE FROM maps WHERE id=?')->execute([$m['id']]);
        attachments_purge($cid, 'map', (int)$m['id']);   // files have no foreign key to cascade
        touch_campaign($cid);
        out(['ok' => true]);

    case 'pin_save': // members: id (to change one), map_id, x, y, label, note; GMs also kind (note|entry|event), entry_id, event_id, is_secret
        $cid = cid();
        $isGm = role($cid) === 'gm';
        out(['ok' => true, 'pin' => pin_save($cid, $isGm)]);

    case 'pin_delete': // a player's own note pin, or any pin for a GM
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $pin = pin_row($cid, int_in(p('id'), 1), $isGm);
        if (!$isGm && ((int)$pin['created_by'] !== me()['id'] || $pin['kind'] !== 'note')) fail('You can only change your own pins', 403);
        db()->prepare('DELETE FROM map_pins WHERE id=?')->execute([$pin['id']]);
        if ($isGm) touch_campaign($cid);   // a player's pin is like their notes: not a campaign change
        out(['ok' => true]);

    case 'map_clear': // GMs: map_id, pins and/or routes (true) to delete all of a map's pins and/or routes. Encyclopedia entries and Events stay
        $cid = cid();
        need_gm($cid);
        $m = map_row($cid, int_in(p('map_id'), 1), true);
        $pins = $routes = 0;
        if (p('pins')) { $st = db()->prepare('DELETE FROM map_pins WHERE map_id=? AND campaign_id=?'); $st->execute([$m['id'], $cid]); $pins = $st->rowCount(); }
        if (p('routes')) { $st = db()->prepare('DELETE FROM map_routes WHERE map_id=? AND campaign_id=?'); $st->execute([$m['id'], $cid]); $routes = $st->rowCount(); }
        if ($pins || $routes) touch_campaign($cid);
        out(['ok' => true, 'pins' => $pins, 'routes' => $routes]);

    case 'pin_to_entry': // GMs: id (a note pin), entry_id (an entry to use; else the one matching its label, else a new one)
        $cid = cid();
        need_gm($cid);
        [$pin, $entryId, $created] = pin_to_entry($cid, int_in(p('id'), 1), p('entry_id') ? int_in(p('entry_id'), 1) : null);
        out(['ok' => true, 'pin' => $pin, 'entry_id' => $entryId, 'created' => $created]);

    case 'route_save': // GMs: id (to change one), map_id, name, points [[x, y], ...], is_secret, color, dash, terrain [1-4 for each leg]
        $cid = cid();
        need_gm($cid);
        out(['ok' => true, 'route' => route_save($cid)]);

    case 'route_delete':
        $cid = cid();
        need_gm($cid);
        $st = db()->prepare('DELETE FROM map_routes WHERE id=? AND campaign_id=?');
        $st->execute([int_in(p('id'), 1), $cid]);
        if (!$st->rowCount()) fail('Route not found', 404);
        touch_campaign($cid);
        out(['ok' => true]);

    // ===== tokens =====
    case 'tokens': // GMs: every token with the groups using it
        $cid = cid();
        need_gm($cid);
        out(['tokens' => tokens_list($cid)]);

    case 'token_upload': // GMs, multipart: file, name (default: the file's name), kind, icon (a game icon's artist/name, credited). One token and its picture
        $cid = cid();
        need_gm($cid);
        if (empty($_FILES) && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) fail('That file is too big for the server', 413);
        out(['ok' => true, 'token' => token_upload($cid)]);

    case 'token_save': // GMs: id (to change one), name, kind, size_squares, member_id, entry_id, is_secret, image_id, group_ids
        $cid = cid();
        need_gm($cid);
        out(['ok' => true, 'token' => token_save($cid)]);

    case 'token_delete':
        $cid = cid();
        need_gm($cid);
        $t = token_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM tokens WHERE id=?')->execute([$t['id']]);   // the groups using it let go of it
        attachments_purge($cid, 'token', (int)$t['id']);
        touch_campaign($cid);
        out(['ok' => true]);

    case 'scabard_import': // GMs: pages and/or connections from a Scabard JSON export, in batches (api/scabard.php)
        $cid = cid();
        need_gm($cid);
        rate_limit('scabard_import', (string)me()['id'], 30, 60);   // each batch is one transaction over up to 300 pages
        out(scabard_import($cid, body()));

    case 'md_import': // GMs: entries and/or links from Markdown notes, in batches (api/mdimport.php)
        $cid = cid();
        need_gm($cid);
        rate_limit('md_import', (string)me()['id'], 30, 60);   // each batch is one transaction over up to 200 entries
        out(mdimport($cid, body()));

    case 'scabard_picture': // GMs: one imported entry's picture, fetched from scabard.com
        $cid = cid();
        need_gm($cid);
        rate_limit('scabard_picture', (string)me()['id'], 120, 60);   // each one downloads a picture from scabard.com
        out(scabard_picture($cid, body()));

    default:
        if (function_exists('fanwiki_action')) fanwiki_action($action);   // answers its own actions, and exits
        fail('Unknown action', 404, 'unknown_action');
    }
} catch (PDOException $e) {
    if (db()->inTransaction()) db()->rollBack();
    if ($e->getCode() === '23000') fail('That conflicts with existing data (duplicate name?)', 409);
    error_log('campaign-chronicle: ' . $e->getMessage());
    fail('Database error', 500);
} catch (Throwable $e) {
    // Anything else (a RuntimeException from a helper, a TypeError from an unexpected shape): undo any half-made change
    // and answer JSON like every other error, never PHP's own HTML 500 page.
    try { if (db()->inTransaction()) db()->rollBack(); } catch (Throwable $_) { /* the connection itself is gone */ }
    error_log('campaign-chronicle: ' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    fail('Server error', 500);
}
