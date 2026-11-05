<?php
/**
 * Clocks: a circle cut into segments that fills as something comes closer (a plot, a danger, a long job).
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

// Any member makes a clock. A GM's and a player's are told apart (by_gm) and drawn in different colours.
// visibility: shown   everyone sees how full it is
//             vague   players see it is there and how many segments it has, not how many are filled (its maker sees all)
//             secret  GMs only; only a GM makes one
// The maker and GMs change it, fill it and empty it; GMs delete any, a player only their own.

const CLOCK_VIS = ['shown', 'vague', 'secret'];
const CLOCK_MAX_SEGMENTS = 24;
const CLOCK_TICKS_SHOWN = 30;

/** Whether this member may change clock $c: a GM, or whoever made it. */
function clock_mine(array $c, bool $isGm): bool {
    return $isGm || ((int)($c['created_by'] ?? 0) === me()['id'] && me()['id'] > 0);
}
/** Clock $id of campaign $cid that this member may see, or fail 404. */
function clock_row(int $cid, int $id, bool $isGm): array {
    return row_of('clocks', $cid, $id, 'Clock not found', fn($c) => !$isGm && $c['visibility'] === 'secret');
}
/** Clocks of campaign $cid this member may see, with who made each and the entry they are about; one clock when $id is given. */
function clocks_of(int $cid, bool $isGm, ?int $id = null): array {
    $st = db()->prepare('SELECT c.*, ' . AUTHOR_SQL . ' AS author, e.name AS entry_name, e.is_secret AS entry_secret
        FROM clocks c LEFT JOIN users u ON u.id=c.created_by LEFT JOIN campaign_members m ON m.campaign_id=c.campaign_id AND m.user_id=c.created_by
        LEFT JOIN encyclopedia_entries e ON e.id=c.entry_id
        WHERE c.campaign_id=?' . ($isGm ? '' : " AND c.visibility<>'secret'") . ($id ? ' AND c.id=?' : '') . ' ORDER BY c.archived, c.created_at DESC, c.id DESC');
    $st->execute($id ? [$cid, $id] : [$cid]);
    return $st->fetchAll();
}
/** The last few fills and empties of clocks $ids, newest first, keyed by clock id. */
function clock_ticks_of(int $cid, array $ids): array {
    if (!$ids) return [];
    $st = db()->prepare('SELECT t.clock_id, t.delta, t.filled_after, t.abs_shift, t.created_at, ' . AUTHOR_SQL . ' AS author
        FROM clock_ticks t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN campaign_members m ON m.campaign_id=t.campaign_id AND m.user_id=t.user_id
        WHERE t.campaign_id=? AND t.clock_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ') ORDER BY t.id DESC');
    $st->execute([$cid, ...$ids]);
    $out = [];
    foreach ($st->fetchAll() as $t) {
        $k = (int)$t['clock_id'];
        if (count($out[$k] ?? []) >= CLOCK_TICKS_SHOWN) continue;
        $out[$k][] = ['delta' => (int)$t['delta'], 'filled' => (int)$t['filled_after'], 'abs_shift' => $t['abs_shift'] !== null ? (int)$t['abs_shift'] : null,
            'at' => $t['created_at'], 'author' => $t['author']];
    }
    return $out;
}
/** A clock as the browser gets it. A vague clock tells a player who didn't make it neither how full it is nor its history;
 * a secret entry it is about is left off for a player. */
function clock_out(array $c, bool $isGm, array $ticks): array {
    $mine = clock_mine($c, $isGm);
    $hidden = !$isGm && !$mine && $c['visibility'] === 'vague';
    $entry = $c['entry_id'] !== null && ($isGm || !(int)$c['entry_secret']) ? ['id' => (int)$c['entry_id'], 'name' => $c['entry_name']] : null;
    return ['id' => (int)$c['id'], 'name' => $c['name'], 'description' => (string)$c['description'], 'segments' => (int)$c['segments'],
        'filled' => $hidden ? null : (int)$c['filled'], 'visibility' => $c['visibility'], 'by_gm' => (bool)(int)$c['by_gm'],
        'entry' => $entry, 'archived' => (bool)(int)$c['archived'], 'mine' => $mine,
        'created_by' => $c['created_by'] !== null ? (int)$c['created_by'] : null, 'author' => $c['author'],
        'created_at' => $c['created_at'], 'updated_at' => $c['updated_at'], 'ticks' => $hidden ? [] : ($ticks[(int)$c['id']] ?? [])];
}
/** One clock as clock_out() gives it. */
function clock_one(int $cid, bool $isGm, int $id): array {
    $c = clocks_of($cid, $isGm, $id)[0] ?? fail('Clock not found', 404);
    return clock_out($c, $isGm, clock_ticks_of($cid, [$id]));
}
/** Note a fill or empty of clock $id. */
function clock_tick_log(int $cid, int $id, int $delta, int $after): void {
    if ($delta === 0) return;
    db()->prepare('INSERT INTO clock_ticks (campaign_id, clock_id, delta, filled_after, abs_shift, user_id) VALUES (?,?,?,?,?,?)')
        ->execute([$cid, $id, $delta, $after, (int)campaign_row($cid)['current_shift'], me()['id'] ?: null]);
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function clocks_action(string $action): void {
    $cid = cid();
    $isGm = role($cid) === 'gm';
    switch ($action) {
    case 'clocks':
        $rows = clocks_of($cid, $isGm);
        $ticks = clock_ticks_of($cid, array_map(fn($c) => (int)$c['id'], $rows));
        out(['clocks' => array_map(fn($c) => clock_out($c, $isGm, $ticks), $rows)]);

    case 'clock_save':
        // A new clock, or a change to one by its maker or a GM. filled is set here too (as a fill would), and logged.
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? clock_row($cid, $id, $isGm) : null;
        if ($old && !clock_mine($old, $isGm)) fail('Only a GM or whoever made this clock can change it', 403);
        $name = trim(preg_replace('/\s+/u', ' ', (string)str_in(p('name'), 120, false)));
        if ($name === '') fail('Give the clock a name');
        $desc = trim((string)str_in(p('description'), 1000)) ?: null;
        $segments = int_in(p('segments', $old['segments'] ?? 4), 2, CLOCK_MAX_SEGMENTS);
        $filled = min($segments, int_in(p('filled', $old['filled'] ?? 0), 0, CLOCK_MAX_SEGMENTS));
        $vis = (string)p('visibility', $old['visibility'] ?? 'shown');
        if (!in_array($vis, CLOCK_VIS, true)) fail('Pick shown, vague or secret');
        if ($vis === 'secret' && !$isGm) fail('Only a GM can make a secret clock', 403);
        $entry = p('entry_id') ? (int)entry_row($cid, int_in(p('entry_id'), 1), $isGm ? 'gm' : 'player')['id'] : null;
        // a player never saw a secret entry a GM linked to their clock, so it stays linked when they save
        if (!$isGm && $old && $old['entry_id'] !== null && !p('entry_id')) {
            $st = db()->prepare('SELECT is_secret FROM encyclopedia_entries WHERE id=?');
            $st->execute([$old['entry_id']]);
            if ((int)$st->fetchColumn()) $entry = (int)$old['entry_id'];
        }
        $archived = p('archived', $old['archived'] ?? 0) ? 1 : 0;
        $uid = me()['id'];
        if ($old) {
            db()->prepare('UPDATE clocks SET name=?, description=?, segments=?, filled=?, visibility=?, entry_id=?, archived=?, updated_by=? WHERE id=?')
                ->execute([$name, $desc, $segments, $filled, $vis, $entry, $archived, $uid, $id]);
            clock_tick_log($cid, $id, $filled - (int)$old['filled'], $filled);
        } else {
            db()->prepare('INSERT INTO clocks (campaign_id, name, description, segments, filled, visibility, by_gm, entry_id, archived, created_by, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                ->execute([$cid, $name, $desc, $segments, $filled, $vis, $isGm ? 1 : 0, $entry, $archived, $uid, $uid]);
            $id = (int)db()->lastInsertId();
            clock_tick_log($cid, $id, $filled, $filled);
        }
        touch_campaign($cid);   // a player's clock is everyone's to see too
        out(['ok' => true, 'clock' => clock_one($cid, $isGm, $id)]);

    case 'clock_tick':
        // Fill (by 1, or more) or empty (by -1) a clock, from the Clocks tab or At the Table. Stops at empty and full.
        $c = clock_row($cid, int_in(p('id'), 1), $isGm);
        if (!clock_mine($c, $isGm)) fail('Only a GM or whoever made this clock can fill it', 403);
        $by = int_in(p('by', 1), -CLOCK_MAX_SEGMENTS, CLOCK_MAX_SEGMENTS);
        $after = max(0, min((int)$c['segments'], (int)$c['filled'] + $by));
        $st = db()->prepare('UPDATE clocks SET filled=?, updated_by=? WHERE id=? AND filled=?');
        $st->execute([$after, me()['id'], $c['id'], $c['filled']]);
        if ($st->rowCount()) clock_tick_log($cid, (int)$c['id'], $after - (int)$c['filled'], $after);
        touch_campaign($cid);
        out(['ok' => true, 'clock' => clock_one($cid, $isGm, (int)$c['id'])]);

    case 'clock_delete':
        $c = clock_row($cid, int_in(p('id'), 1), $isGm);
        if (!clock_mine($c, $isGm)) fail('Only a GM or whoever made this clock can delete it', 403);
        db()->prepare('DELETE FROM clocks WHERE id=?')->execute([$c['id']]);
        touch_campaign($cid);
        out(['ok' => true]);
    }
}
