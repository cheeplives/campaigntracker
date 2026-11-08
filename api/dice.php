<?php
/**
 * The die roller: the 🎲 button on every campaign page (static/dice-tab.js) and the roll log the table shares.
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 *
 * The server never rolls the dice itself. It picks each roll's seed with random_int (128 bits), stores it with what was
 * typed, and every browser works out the same dice from them with static/dice.js. So nobody can choose their own
 * result: the seed only exists once the roll is asked for, and it can't be changed after.
 *
 * Rerolling some of a roll's dice by hand is a log entry of its own, written "~<roll id>:<die numbers>" with a new seed;
 * every browser folds it into that roll (static/dice.js roll()'s rerolls), so the roll's result changes for everyone and
 * the old faces stay in its history. Only the server writes these: a typed roll can't start with ~.
 */
declare(strict_types=1);

// visibility: all    everyone sees the roll
//             gm     the roller and the GMs
//             blind  the GMs only; the roller sees that they rolled, not what (they get no seed)
const DICE_VIS = ['all', 'gm', 'blind'];
const DICE_KEEP_DEFAULT = 500;
const DICE_KEEP_MIN = 50;
const DICE_KEEP_MAX = 5000;
const DICE_PAGE = 50;
/** Rerolls of one roll at most, and dice in one reroll at most. */
const DICE_REROLLS_MAX = 20;
const DICE_REROLL_DICE = 100;
/** Engine versions static/dice.js can roll (Dice.VERSION). */
const DICE_ENGINES = [1];
/** The built-in patterns a player can put on their dice (TEXTURES in static/dice-3d.js, which draws them). */
const DICE_TEXTURES = ['', 'marble', 'wood', 'stone', 'stars', 'metal', 'speckle', 'swirl', 'pearl', 'scales', 'carbon', 'ice', 'lava',
    'glitter', 'galaxy', 'ember'];

/** How a player's dice look, checked: { body, ink, tex }, or null if it isn't one. */
function dice_look($l): ?array {
    if (!is_array($l)) return null;
    $hex = fn($v) => is_string($v) && preg_match('/^#[0-9a-f]{6}$/i', $v) ? strtolower($v) : null;
    $body = $hex($l['body'] ?? null);
    $ink = $hex($l['ink'] ?? null);
    $tex = $l['tex'] ?? '';
    if (!$body || !$ink || !is_string($tex) || !in_array($tex, DICE_TEXTURES, true)) return null;
    return ['body' => $body, 'ink' => $ink, 'tex' => $tex];
}

/** The campaign's Settings → Dice choices, with the defaults filled in. */
function dice_settings(int $cid): array {
    $d = campaign_settings($cid)['dice'] ?? [];
    $d = is_array($d) ? $d : [];
    $vis = in_array($d['player_vis'] ?? 'all', DICE_VIS, true) ? $d['player_vis'] ?? 'all' : 'all';
    $keep = is_numeric($d['keep'] ?? null) ? (int)$d['keep'] : DICE_KEEP_DEFAULT;
    return ['player_vis' => $vis, 'lock_vis' => !empty($d['lock_vis']), 'gm_hidden' => !empty($d['gm_hidden']),
        'keep' => max(DICE_KEEP_MIN, min(DICE_KEEP_MAX, $keep)), 'system' => dice_system($d['system'] ?? null),
        // At the table: players roll only the game roll (when there is one), players don't see the odds, flat dice for all
        'no_free' => !empty($d['no_free']), 'hide_odds' => !empty($d['hide_odds']), 'flat' => !empty($d['flat'])];
}
/** The campaign's dice system (static/dice-systems.js reads it): its id, its numbers, the game it started from, its
 * renamed numbers and, for a result table, the table. Only shapes and sizes are checked here; the browser puts each
 * number in range. Null for free dice only. */
function dice_system($s): ?array {
    if (!is_array($s) || !is_string($s['id'] ?? null) || !preg_match('/^[a-z0-9]{1,20}$/', $s['id'])) return null;
    $flat = function ($m): array {
        $o = [];
        foreach (is_array($m) ? array_slice($m, 0, 30, true) : [] as $k => $v) {
            if (!is_string($k) || !preg_match('/^[a-z0-9]{1,20}$/i', $k) || !(is_scalar($v))) continue;
            $o[$k] = is_string($v) ? mb_substr($v, 0, 40) : $v;
        }
        return $o;
    };
    $game = is_string($s['game'] ?? null) && preg_match('/^[a-z0-9]{1,20}$/', $s['game']) ? $s['game'] : null;
    return ['id' => $s['id'], 'params' => (object)$flat($s['params'] ?? []), 'labels' => (object)$flat($s['labels'] ?? []),
        'game' => $game, 'table' => is_string($s['table'] ?? null) ? mb_substr($s['table'], 0, 4000) : ''];
}
/** SQL condition on dice_rolls r for the rolls this member sees (a GM: all of them). */
function dice_seen_sql(bool $isGm): string {
    return $isGm ? '1=1' : "(r.visibility='all' OR r.user_id=" . (int)me()['id'] . ')';
}
/** A roll as the browser gets it. A blind roll reaches its player without its seed, so their page can't work it out.
 * look is how the roller's dice look (their account's choice now, not when they rolled), or null for the theme's. */
function dice_out(array $r, bool $isGm): array {
    $uid = $r['user_id'] !== null ? (int)$r['user_id'] : null;
    $hidden = !$isGm && $r['visibility'] === 'blind';
    return ['id' => (int)$r['id'], 'expr' => $r['expr'], 'seed' => $hidden ? null : $r['seed'], 'engine' => (int)$r['engine'],
        'visibility' => $r['visibility'], 'by_gm' => (bool)(int)$r['by_gm'], 'mine' => $uid !== null && $uid === me()['id'],
        'author' => $r['author'], 'abs_shift' => $r['abs_shift'] !== null ? (int)$r['abs_shift'] : null, 'at' => $r['created_at'],
        'look' => dice_look((dec($r['prefs_json'] ?? null) ?: [])['dice_look'] ?? null)];
}
/** The rolls this member sees: newer than $after, oldest first; or with no $after, the newest page of them, oldest first. */
function dice_list(int $cid, bool $isGm, ?int $after): array {
    $sql = 'SELECT r.*, ' . AUTHOR_SQL . ' AS author, up.prefs_json FROM dice_rolls r LEFT JOIN users u ON u.id=r.user_id
        LEFT JOIN user_prefs up ON up.user_id=r.user_id
        LEFT JOIN campaign_members m ON m.campaign_id=r.campaign_id AND m.user_id=r.user_id
        WHERE r.campaign_id=? AND ' . dice_seen_sql($isGm);
    if ($after !== null) {
        $st = db()->prepare("$sql AND r.id>? ORDER BY r.id LIMIT " . DICE_PAGE);
        $st->execute([$cid, $after]);
        $rows = $st->fetchAll();
    } else {
        $st = db()->prepare("$sql ORDER BY r.id DESC LIMIT " . DICE_PAGE);
        $st->execute([$cid]);
        $rows = array_reverse($st->fetchAll());
    }
    return array_map(fn($r) => dice_out($r, $isGm), $rows);
}
/** The newest roll this member may see, for the 'changed' poll (0 when none), so a closed roller can show that someone rolled. */
function dice_last_seen(int $cid, bool $isGm): int {
    $st = db()->prepare('SELECT COALESCE(MAX(r.id), 0) FROM dice_rolls r WHERE r.campaign_id=? AND ' . dice_seen_sql($isGm));
    $st->execute([$cid]);
    return (int)$st->fetchColumn();
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function dice_action(string $action): void {
    $cid = cid();
    $isGm = role($cid) === 'gm';
    switch ($action) {
    case 'dice_rolls':
        $after = isset($_GET['after']) && $_GET['after'] !== '' ? int_in($_GET['after'], 0) : null;
        out(['rolls' => dice_list($cid, $isGm, $after), 'settings' => dice_settings($cid)]);

    case 'dice_roll':
        // What was typed is only stored and handed back: each browser reads it (static/dice.js), and one that can't
        // shows it as unreadable. So it is only checked for length and for characters no roll uses.
        rate_limit('dice', 'u' . me()['id'], 120, 60, 1, 'That is a lot of rolls. Wait a minute and roll again.');
        $expr = trim((string)str_in(p('expr'), 200, false));
        if ($expr === '') fail('Type a roll, like 2d6+3');
        if (preg_match('/[\x00-\x1f\x7f]/u', $expr)) fail('A roll is one line of text');
        if ($expr[0] === '~') fail('A roll starts with dice or a number, like 2d6+3');
        $engine = int_in(p('engine', 1), 1, 255);
        if (!in_array($engine, DICE_ENGINES, true)) fail('Reload the page to roll with the current dice');
        $set = dice_settings($cid);
        // With free rolls turned off, a player's roll has to be the campaign's game roll
        if (!$isGm && $set['no_free'] && $set['system'] && !preg_match('/@' . preg_quote($set['system']['id'], '/') . '(?![a-z0-9])/', $expr))
            fail('The GM has turned free rolls off: use the Game roll');
        $vis = (string)p('visibility', $isGm ? ($set['gm_hidden'] ? 'gm' : 'all') : $set['player_vis']);
        if (!in_array($vis, DICE_VIS, true)) fail('Pick who sees the roll: all, gm or blind');
        if ($isGm && $vis === 'blind') $vis = 'gm';                      // a GM's roll hidden from players is simply theirs
        if (!$isGm && $set['lock_vis']) $vis = $set['player_vis'];       // the GM decides who sees players' rolls
        $seed = bin2hex(random_bytes(16));
        db()->prepare('INSERT INTO dice_rolls (campaign_id, user_id, by_gm, expr, seed, engine, visibility, abs_shift) VALUES (?,?,?,?,?,?,?,?)')
            ->execute([$cid, me()['id'] ?: null, $isGm ? 1 : 0, $expr, $seed, $engine, $vis, (int)campaign_row($cid)['current_shift']]);
        $id = (int)db()->lastInsertId();
        // Keep only the newest rolls (Settings → Dice); the older ones go as new ones come.
        $st = db()->prepare('SELECT id FROM dice_rolls WHERE campaign_id=? ORDER BY id DESC LIMIT 1 OFFSET ' . $set['keep']);
        $st->execute([$cid]);
        $cut = $st->fetchColumn();
        if ($cut) db()->prepare('DELETE FROM dice_rolls WHERE campaign_id=? AND id<=?')->execute([$cid, (int)$cut]);
        $roll = array_values(array_filter(dice_list($cid, $isGm, $id - 1), fn($r) => $r['id'] === $id))[0] ?? fail('Roll not found', 404);
        out(['ok' => true, 'roll' => $roll]);

    case 'dice_reroll':
        // Reroll some of a roll's dice: the roller's own roll, or any roll for a GM, that they can see the dice of.
        rate_limit('dice', 'u' . me()['id'], 120, 60, 1, 'That is a lot of rolls. Wait a minute and roll again.');
        $rid = int_in(p('id'), 1);
        $st = db()->prepare('SELECT * FROM dice_rolls WHERE id=? AND campaign_id=?');
        $st->execute([$rid, $cid]);
        $orig = $st->fetch() ?: fail('Roll not found', 404);
        $mine = $orig['user_id'] !== null && (int)$orig['user_id'] === me()['id'];
        if (!$isGm && !$mine) fail('Only the roller or a GM can reroll a roll', 403);
        if (!$isGm && $orig['visibility'] === 'blind') fail('Only the GMs can reroll a blind roll', 403);
        if ($orig['expr'][0] === '~') fail('That is a reroll; reroll the roll itself');
        $dice = p('dice');
        if (!is_array($dice) || !$dice || count($dice) > DICE_REROLL_DICE) fail('Pick the dice to reroll');
        $dice = array_values(array_unique(array_map(fn($v) => int_in($v, 0, 1999), $dice)));
        sort($dice);
        $st = db()->prepare("SELECT COUNT(*) FROM dice_rolls WHERE campaign_id=? AND expr LIKE ?");
        $st->execute([$cid, '~' . $rid . ':%']);
        if ((int)$st->fetchColumn() >= DICE_REROLLS_MAX) fail('That roll has been rerolled enough: roll again instead');
        $expr = '~' . $rid . ':' . implode(',', $dice);
        if (strlen($expr) > 200) fail('Pick fewer dice to reroll at once');
        $seed = bin2hex(random_bytes(16));
        db()->prepare('INSERT INTO dice_rolls (campaign_id, user_id, by_gm, expr, seed, engine, visibility, abs_shift) VALUES (?,?,?,?,?,?,?,?)')
            // filed under the roller (so whoever sees their roll sees its reroll); by_gm says a GM did it
            ->execute([$cid, $orig['user_id'], $isGm ? 1 : 0, $expr, $seed, (int)$orig['engine'], $orig['visibility'], (int)campaign_row($cid)['current_shift']]);
        $id = (int)db()->lastInsertId();
        $roll = array_values(array_filter(dice_list($cid, $isGm, $id - 1), fn($r) => $r['id'] === $id))[0] ?? fail('Roll not found', 404);
        out(['ok' => true, 'roll' => $roll]);

    case 'dice_clear':
        db()->prepare('DELETE FROM dice_rolls WHERE campaign_id=?')->execute([$cid]);
        out(['ok' => true]);
    }
}
