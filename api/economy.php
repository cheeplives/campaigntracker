<?php
/**
 * The Economy tab: how a campaign pays for things (coins, barter, wealth, favours), its price book and the shifts
 * that change prices by region, the ledger of what the party gained and spent, regular costs, wealth and favours.
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 *
 * GMs set the economy up and keep the price book and its shifts. Every member reads them (not the secret rows),
 * writes the ledger, the regular costs and favours, and sets the wealth of a character they may edit.
 * db/migrations/059_economy.sql describes the tables.
 */
declare(strict_types=1);

const ECON_AVAIL = ['common', 'scarce', 'rare', 'none'];
const ECON_KINDS = ['coins', 'goods', 'wealth', 'favour', 'note'];
const ECON_SETTLED = ['called', 'repaid', 'forgiven'];
const ECON_MAX = 1e13;
const ECON_ITEMS_MAX = 5000;
const ECON_IMPORT_MAX = 2000;
const ECON_LEDGER_PAGE = 200;
const ECON_POST_MAX = 400;         // the most times one regular cost is posted by one pass of time
/** The everyday things Setup asks a price for first. Our own list: no prices, and from no published game. */
const ECON_EVERYDAY = [
    ['Private lodging, 1 night', 'Lodging'], ['Common room, 1 night', 'Lodging'], ['Fine meal for 1', 'Food and drink'],
    ['Plain meal for 1', 'Food and drink'], ['Day\'s unskilled labour', 'Services'], ['Day\'s skilled labour', 'Services'],
    ['Healer\'s visit', 'Services'], ['Riding animal or basic vehicle', 'Travel'], ['Passage, 1 day\'s travel', 'Travel'],
    ['Set of plain clothes', 'Gear'],
];

/** A number typed into a box, or null when it is empty: finite, within $min and $max, to four places. */
function econ_num($v, float $min, float $max, string $what): ?float {
    if ($v === null || $v === '') return null;
    if (!is_numeric($v) || !is_finite((float)$v)) fail("$what must be a number");
    $n = round((float)$v, 4);
    if ($n < $min || $n > $max) fail("$what is out of range");
    return $n;
}
/** A short name: one line, trimmed, at most $max characters. */
function econ_name($v, int $max): string {
    return trim(preg_replace('/\s+/u', ' ', (string)str_in($v, $max, false)));
}
/** The campaign's day: the one its clock is on. */
function econ_today(int $cid): int {
    $c = campaign_row($cid);
    return floordiv((int)$c['current_shift'], camp_spd($c));
}
/** A day sent with a change (any day, so a late entry can be put where it happened), or today. */
function econ_day_in(int $cid, $v): int {
    return ($v === null || $v === '') ? econ_today($cid) : int_in($v, -100_000_000, 100_000_000);
}

// ---------- the ways to pay ----------
/** The config as stored, or one with everything off for a campaign that hasn't set its economy up. */
function econ_config(int $cid): array {
    $st = db()->prepare('SELECT config_json FROM economy_config WHERE campaign_id=?');
    $st->execute([$cid]);
    $c = dec($st->fetchColumn() ?: null);
    return is_array($c) ? $c : econ_config_blank();
}
function econ_config_blank(): array {
    return ['coins' => ['on' => false, 'base' => ['name' => '', 'abbr' => ''], 'units' => []], 'barter' => ['on' => false, 'unit' => '', 'goods' => []],
        'wealth' => ['on' => false, 'levels' => []], 'favours' => ['on' => false], 'set' => false];
}
/** A config sent by the browser, checked and tidied: only what is listed here is kept. */
function econ_config_in($v): array {
    if (!is_array($v)) fail('Expected the economy\'s settings');
    $on = fn($k) => !empty($v[$k]['on']);
    $coins = ['on' => $on('coins'), 'base' => ['name' => econ_name($v['coins']['base']['name'] ?? '', 60), 'abbr' => econ_name($v['coins']['base']['abbr'] ?? '', 12)], 'units' => []];
    if ($coins['on'] && $coins['base']['name'] === '') fail('Name the main coin');
    $seen = [mb_strtolower($coins['base']['name']) => true];
    foreach ((array)($v['coins']['units'] ?? []) as $u) {
        if (!is_array($u)) continue;
        $name = econ_name($u['name'] ?? '', 60);
        if ($name === '') continue;
        if (isset($seen[mb_strtolower($name)])) fail("Two coins are called $name");
        $seen[mb_strtolower($name)] = true;
        $worth = econ_num($u['worth'] ?? null, 0.0001, 1e9, "What a $name is worth");
        if ($worth === null) fail("Say what a $name is worth");
        $coins['units'][] = ['name' => $name, 'abbr' => econ_name($u['abbr'] ?? '', 12), 'worth' => $worth];
        if (count($coins['units']) > 12) fail('At most 12 other coins');
    }
    $barter = ['on' => $on('barter'), 'unit' => econ_name($v['barter']['unit'] ?? '', 60), 'goods' => []];
    if ($barter['on'] && $barter['unit'] === '') fail('Name the good that barter is measured in');
    $seen = [mb_strtolower($barter['unit']) => true];
    foreach ((array)($v['barter']['goods'] ?? []) as $g) {
        if (!is_array($g)) continue;
        $name = econ_name($g['name'] ?? '', 200);
        if ($name === '') continue;
        if (isset($seen[mb_strtolower($name)])) fail("Two trade goods are called $name");
        $seen[mb_strtolower($name)] = true;
        $worth = econ_num($g['worth'] ?? null, 0.0001, 1e9, "What $name is worth");
        if ($worth === null) fail("Say what $name is worth");
        $barter['goods'][] = ['name' => $name, 'worth' => $worth];
        if (count($barter['goods']) > 60) fail('At most 60 trade goods');
    }
    $levels = [];
    foreach ((array)($v['wealth']['levels'] ?? []) as $l) { $l = econ_name($l, 40); if ($l !== '') $levels[] = $l; }
    if ($on('wealth') && (count($levels) < 2 || count($levels) > 12)) fail('Wealth needs 2 to 12 levels');
    return ['coins' => $coins, 'barter' => $barter, 'wealth' => ['on' => $on('wealth'), 'levels' => array_slice($levels, 0, 12)],
        'favours' => ['on' => $on('favours')], 'set' => true];
}

// ---------- the price book ----------
function econ_item_out(array $r): array {
    $f = fn($x) => $x === null ? null : (float)$x;
    return ['id' => (int)$r['id'], 'name' => $r['name'], 'category' => $r['category'], 'coin_cost' => $f($r['coin_cost']), 'barter_cost' => $f($r['barter_cost']),
        'wealth_level' => $r['wealth_level'] === null ? null : (int)$r['wealth_level'], 'favour_size' => $r['favour_size'] === null ? null : (int)$r['favour_size'],
        'availability' => $r['availability'], 'notes' => $r['notes'], 'is_everyday' => (bool)(int)$r['is_everyday'], 'is_secret' => (bool)(int)$r['is_secret']];
}
/** An item's columns from what was sent ($v: the request body, or one row of an upload). */
function econ_item_in(array $v, array $config): array {
    $name = econ_name($v['name'] ?? '', 200);
    if ($name === '') fail('Name the item');
    $avail = (string)($v['availability'] ?? 'common');
    if ($avail === '') $avail = 'common';
    if (!in_array($avail, ECON_AVAIL, true)) fail("Availability is common, scarce, rare or none ($name)");
    $levels = max(0, count($config['wealth']['levels']) - 1);
    $wealth = ($v['wealth_level'] ?? null) === null || $v['wealth_level'] === '' ? null : int_in($v['wealth_level'], 0, max($levels, 11));
    $favour = ($v['favour_size'] ?? null) === null || $v['favour_size'] === '' ? null : int_in($v['favour_size'], 1, 3);
    return [$name, econ_name($v['category'] ?? '', 60), econ_num($v['coin_cost'] ?? null, 0, ECON_MAX, "The price of $name"),
        econ_num($v['barter_cost'] ?? null, 0, ECON_MAX, "The barter price of $name"), $wealth, $favour, $avail,
        trim((string)str_in($v['notes'] ?? '', 500, false)), empty($v['is_everyday']) ? 0 : 1, empty($v['is_secret']) ? 0 : 1];
}
const ECON_ITEM_COLS = 'name, category, coin_cost, barter_cost, wealth_level, favour_size, availability, notes, is_everyday, is_secret';
function econ_items(int $cid, bool $isGm): array {
    $st = db()->prepare('SELECT * FROM economy_items WHERE campaign_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY is_everyday DESC, category, name, id');
    $st->execute([$cid]);
    return array_map('econ_item_out', $st->fetchAll());
}
function econ_shift_out(array $r): array {
    return ['id' => (int)$r['id'], 'region_id' => $r['region_id'] === null ? null : (int)$r['region_id'], 'item_id' => $r['item_id'] === null ? null : (int)$r['item_id'],
        'category' => $r['category'], 'multiplier' => (float)$r['multiplier'], 'availability' => $r['availability'], 'reason' => $r['reason'],
        'until_day' => $r['until_day'] === null ? null : (int)$r['until_day']];
}
/** The shifts a member may see: a player doesn't get one on a secret item. */
function econ_shifts(int $cid, bool $isGm): array {
    $st = db()->prepare('SELECT s.* FROM economy_shifts s LEFT JOIN economy_items i ON i.id=s.item_id WHERE s.campaign_id=?' . ($isGm ? '' : ' AND COALESCE(i.is_secret, 0)=0') . ' ORDER BY s.id');
    $st->execute([$cid]);
    return array_map('econ_shift_out', $st->fetchAll());
}

// ---------- the party's side: characters, wealth, funds and goods ----------
/** The characters wealth and favours are about: the players' and any travelling with the party, as this member sees them. */
function econ_characters(int $cid, bool $isGm): array {
    $out = [];
    foreach (character_rows($cid, $isGm) as $c) {
        if ($c['kind'] !== 'pc' && $c['party_group_id'] === null) continue;
        $out[] = ['id' => (int)$c['id'], 'name' => $c['name'], 'can_edit' => character_full($c, $isGm)];
    }
    return $out;
}
function econ_wealth(int $cid): array {
    $st = db()->prepare('SELECT character_id, level FROM economy_wealth WHERE campaign_id=?');
    $st->execute([$cid]);
    $out = [];
    foreach ($st->fetchAll() as $r) $out[(string)(int)$r['character_id']] = (int)$r['level'];
    return $out;
}
/** The Gear and Loot row of the party's that holds trade good $name (the first so named), or null. */
function econ_gear_row(int $cid, string $name): ?array {
    $st = db()->prepare('SELECT * FROM party_gear WHERE campaign_id=? AND character_id IS NULL AND item=? ORDER BY id LIMIT 1');
    $st->execute([$cid, $name]);
    return $st->fetch() ?: null;
}

// ---------- the ledger ----------
/** Write a ledger line. $row: kind, amount, unit, level_after, description, place, source, fund_id, gear_id, favour_id,
 * character_id, is_secret, abs_day; anything left out is empty. Returns its id. */
function econ_log(int $cid, array $row): int {
    $row += ['amount' => null, 'unit' => '', 'level_after' => null, 'description' => '', 'place' => '', 'source' => 'hand', 'fund_id' => null,
        'gear_id' => null, 'favour_id' => null, 'character_id' => null, 'is_secret' => 0, 'abs_day' => null, 'user' => me()['id'] ?: null];
    db()->prepare('INSERT INTO economy_ledger (campaign_id, abs_day, kind, amount, unit, level_after, description, place, source, fund_id, gear_id, favour_id, character_id, is_secret, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        ->execute([$cid, $row['abs_day'] ?? econ_today($cid), $row['kind'], $row['amount'], mb_substr((string)$row['unit'], 0, 200), $row['level_after'],
            mb_substr((string)$row['description'], 0, 500), mb_substr((string)$row['place'], 0, 200), $row['source'], $row['fund_id'], $row['gear_id'], $row['favour_id'],
            $row['character_id'], $row['is_secret'] ? 1 : 0, $row['user']]);
    return (int)db()->lastInsertId();
}
function econ_ledger(int $cid, bool $isGm, ?int $before = null, ?int $id = null): array {
    $st = db()->prepare('SELECT l.*, ' . AUTHOR_SQL . ' AS author, e.name AS character_name
        FROM economy_ledger l LEFT JOIN users u ON u.id=l.created_by LEFT JOIN campaign_members m ON m.campaign_id=l.campaign_id AND m.user_id=l.created_by
        LEFT JOIN sheet_characters sc ON sc.id=l.character_id LEFT JOIN encyclopedia_entries e ON e.id=sc.entry_id
        WHERE l.campaign_id=?' . ($isGm ? '' : ' AND l.is_secret=0') . ($before ? ' AND l.id<?' : '') . ($id ? ' AND l.id=?' : '') . '
        ORDER BY l.abs_day DESC, l.id DESC LIMIT ' . (ECON_LEDGER_PAGE + 1));
    $st->execute(array_values(array_filter([$cid, $before, $id], fn($x) => $x !== null)));
    $uid = me()['id'];
    return array_map(fn($r) => ['id' => (int)$r['id'], 'abs_day' => (int)$r['abs_day'], 'kind' => $r['kind'], 'amount' => $r['amount'] === null ? null : (float)$r['amount'],
        'unit' => $r['unit'], 'level_after' => $r['level_after'] === null ? null : (int)$r['level_after'], 'description' => $r['description'], 'place' => $r['place'],
        'source' => $r['source'], 'character' => $r['character_id'] === null ? null : ['id' => (int)$r['character_id'], 'name' => (string)$r['character_name']],
        'favour_id' => $r['favour_id'] === null ? null : (int)$r['favour_id'], 'is_secret' => (bool)(int)$r['is_secret'], 'author' => $r['author'],
        'mine' => $isGm || ($uid > 0 && (int)$r['created_by'] === $uid)], $st->fetchAll());
}
/** A Party Funds amount changed by hand (api/holdings.php): note it, once the economy is set up. */
function econ_log_funds(int $cid, array $old, float $new): void {
    $delta = round($new - (float)$old['amount'], 2);
    if ($delta == 0.0 || $old['character_id'] !== null || empty(econ_config($cid)['set'])) return;
    econ_log($cid, ['kind' => 'coins', 'amount' => $delta, 'unit' => $old['currency'], 'place' => $old['location'], 'source' => 'funds', 'fund_id' => (int)$old['id'],
        'description' => 'Changed on Party Funds']);
}

// ---------- regular costs ----------
function econ_costs(int $cid): array {
    $st = db()->prepare('SELECT c.*, f.currency, f.location FROM economy_costs c LEFT JOIN party_funds f ON f.id=c.fund_id WHERE c.campaign_id=? ORDER BY c.next_day, c.id');
    $st->execute([$cid]);
    return array_map(fn($r) => ['id' => (int)$r['id'], 'name' => $r['name'], 'amount' => (float)$r['amount'], 'fund_id' => $r['fund_id'] === null ? null : (int)$r['fund_id'],
        'currency' => $r['currency'], 'location' => $r['location'], 'good' => $r['good'], 'every_days' => (int)$r['every_days'], 'next_day' => (int)$r['next_day']], $st->fetchAll());
}
/** Post every regular cost the campaign's clock has reached: a ledger line on the day it fell due, and the amount off
 * its funds line or trade good. Called when time passes (set_time). Turning the clock back takes nothing off again. */
function econ_post_due(int $cid): void {
    $today = econ_today($cid);
    $pdo = db();
    $st = $pdo->prepare('SELECT c.*, f.currency, f.location FROM economy_costs c LEFT JOIN party_funds f ON f.id=c.fund_id WHERE c.campaign_id=? AND c.next_day<=?');
    $st->execute([$cid, $today]);
    $due = $st->fetchAll();
    if (!$due) return;
    $pdo->beginTransaction();
    foreach ($due as $c) {
        $day = (int)$c['next_day'];
        $every = max(1, (int)$c['every_days']);
        $amount = (float)$c['amount'];
        $gear = $c['good'] !== '' ? econ_gear_row($cid, $c['good']) : null;
        for ($n = 0; $day <= $today && $n < ECON_POST_MAX; $n++, $day += $every) {
            if ($c['fund_id'] !== null) $pdo->prepare('UPDATE party_funds SET amount=amount-? WHERE id=?')->execute([round($amount, 2), $c['fund_id']]);
            if ($gear) $pdo->prepare('UPDATE party_gear SET amount=GREATEST(0, amount-?) WHERE id=?')->execute([(int)round($amount), $gear['id']]);
            econ_log($cid, ['abs_day' => $day, 'kind' => $c['good'] !== '' ? 'goods' : 'coins', 'amount' => -$amount, 'unit' => $c['good'] !== '' ? $c['good'] : (string)$c['currency'],
                'place' => $c['good'] !== '' ? 'Gear and Loot' : (string)$c['location'], 'source' => 'upkeep', 'description' => $c['name'],
                'fund_id' => $c['fund_id'], 'gear_id' => $gear['id'] ?? null, 'user' => null]);
        }
        if ($day <= $today) $day = $today + 1;   // further behind than one pass posts: start again from tomorrow
        $pdo->prepare('UPDATE economy_costs SET next_day=? WHERE id=?')->execute([$day, $c['id']]);
    }
    $pdo->commit();
}

// ---------- favours ----------
function econ_favours(int $cid, bool $isGm, ?int $id = null): array {
    $st = db()->prepare('SELECT f.*, ' . AUTHOR_SQL . ' AS author, ce.name AS character_name, e.is_secret AS entry_secret
        FROM economy_favours f LEFT JOIN users u ON u.id=f.created_by LEFT JOIN campaign_members m ON m.campaign_id=f.campaign_id AND m.user_id=f.created_by
        LEFT JOIN sheet_characters sc ON sc.id=f.character_id LEFT JOIN encyclopedia_entries ce ON ce.id=sc.entry_id
        LEFT JOIN encyclopedia_entries e ON e.id=f.entry_id
        WHERE f.campaign_id=?' . ($isGm ? '' : ' AND f.is_secret=0') . ($id ? ' AND f.id=?' : '') . " ORDER BY f.status='open' DESC, f.owed_to_party DESC, f.since_day DESC, f.id DESC");
    $st->execute($id ? [$cid, $id] : [$cid]);
    $uid = me()['id'];
    return array_map(fn($r) => ['id' => (int)$r['id'], 'character' => $r['character_id'] === null ? null : ['id' => (int)$r['character_id'], 'name' => (string)$r['character_name']],
        'other_name' => $r['other_name'], 'entry_id' => $r['entry_id'] !== null && ($isGm || !(int)$r['entry_secret']) ? (int)$r['entry_id'] : null,
        'owed_to_party' => (bool)(int)$r['owed_to_party'], 'size' => (int)$r['size'], 'description' => $r['description'], 'since_day' => (int)$r['since_day'],
        'is_secret' => (bool)(int)$r['is_secret'], 'status' => $r['status'], 'settled_day' => $r['settled_day'] === null ? null : (int)$r['settled_day'],
        'settled_note' => $r['settled_note'], 'author' => $r['author'], 'mine' => $isGm || ($uid > 0 && (int)$r['created_by'] === $uid)], $st->fetchAll());
}
const ECON_SIZES = [1 => 'Small', 2 => 'Significant', 3 => 'Major'];
/** A favour in a line, for the ledger: "Significant favour owed to Gunther Hasselbach by the party". */
function econ_favour_words(array $f, string $who): string {
    $size = ECON_SIZES[(int)$f['size']] ?? 'Small';
    return (int)$f['owed_to_party'] ? "$size favour owed to $who by {$f['other_name']}" : "$size favour owed to {$f['other_name']} by $who";
}
/** The party's side of a favour in words: the character's name, or "the party". */
function econ_side(int $cid, ?int $characterId, bool $isGm): string {
    return $characterId === null ? 'the party' : (string)character_row($cid, $characterId, $isGm)['name'];
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function economy_action(string $action): void {
    $cid = cid();
    $isGm = role($cid) === 'gm';
    $pdo = db();
    switch ($action) {
    case 'economy':
        // Everything the tab draws but the ledger, which comes a page at a time.
        $st = $pdo->prepare('SELECT id, currency, location, amount FROM party_funds WHERE campaign_id=? AND character_id IS NULL ORDER BY id');
        $st->execute([$cid]);
        $funds = array_map(fn($r) => ['id' => (int)$r['id'], 'currency' => $r['currency'], 'location' => $r['location'], 'amount' => (float)$r['amount']], $st->fetchAll());
        $st = $pdo->prepare('SELECT id, item, amount FROM party_gear WHERE campaign_id=? AND character_id IS NULL ORDER BY id');
        $st->execute([$cid]);
        $gear = array_map(fn($r) => ['id' => (int)$r['id'], 'item' => $r['item'], 'amount' => (int)$r['amount']], $st->fetchAll());
        out(['config' => econ_config($cid), 'items' => econ_items($cid, $isGm), 'shifts' => econ_shifts($cid, $isGm), 'characters' => econ_characters($cid, $isGm),
            'wealth' => (object)econ_wealth($cid), 'funds' => $funds, 'gear' => $gear, 'costs' => econ_costs($cid), 'favours' => econ_favours($cid, $isGm),
            'today' => econ_today($cid)]);

    case 'economy_ledger':
        $before = isset($_GET['before']) && $_GET['before'] !== '' ? int_in($_GET['before'], 1) : null;
        $rows = econ_ledger($cid, $isGm, $before);
        $more = count($rows) > ECON_LEDGER_PAGE;
        out(['entries' => array_slice($rows, 0, ECON_LEDGER_PAGE), 'more' => $more]);

    case 'economy_config_save':
        // The ways to pay. The first save also puts the everyday things in the price book, with no prices yet.
        $config = econ_config_in(p('config'));
        $pdo->prepare('INSERT INTO economy_config (campaign_id, config_json) VALUES (?,?) ON DUPLICATE KEY UPDATE config_json=VALUES(config_json)')
            ->execute([$cid, json_encode($config, JSON_UNESCAPED_UNICODE)]);
        $st = $pdo->prepare('SELECT COUNT(*) FROM economy_items WHERE campaign_id=?');
        $st->execute([$cid]);
        if (!(int)$st->fetchColumn()) {
            $ins = $pdo->prepare('INSERT INTO economy_items (campaign_id, name, category, is_everyday, created_by) VALUES (?,?,?,1,?)');
            foreach (ECON_EVERYDAY as [$name, $cat]) $ins->execute([$cid, $name, $cat, me()['id']]);
        }
        out(['ok' => true, 'config' => $config, 'items' => econ_items($cid, true)]);

    case 'economy_item_save':
        $id = p('id') ? int_in(p('id'), 1) : null;
        if ($id) row_of('economy_items', $cid, $id, 'Item not found');
        $row = econ_item_in(body(), econ_config($cid));
        if ($id) {
            $pdo->prepare('UPDATE economy_items SET name=?, category=?, coin_cost=?, barter_cost=?, wealth_level=?, favour_size=?, availability=?, notes=?, is_everyday=?, is_secret=? WHERE id=?')
                ->execute([...$row, $id]);
        } else {
            $st = $pdo->prepare('SELECT COUNT(*) FROM economy_items WHERE campaign_id=?');
            $st->execute([$cid]);
            if ((int)$st->fetchColumn() >= ECON_ITEMS_MAX) fail('The price book is full (' . ECON_ITEMS_MAX . ' items)');
            $pdo->prepare('INSERT INTO economy_items (' . ECON_ITEM_COLS . ', campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')->execute([...$row, $cid, me()['id']]);
            $id = (int)$pdo->lastInsertId();
        }
        out(['ok' => true, 'item' => econ_item_out(row_of('economy_items', $cid, $id, 'Item not found'))]);

    case 'economy_item_delete':
        $pdo->prepare('DELETE FROM economy_items WHERE id=? AND campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        out(['ok' => true]);

    case 'economy_items_import':
        // An uploaded price book: rows the browser read from a CSV file. An item already in the book under the same
        // name (whatever its capitals) takes the row's prices; the rest are added. All of it or none.
        $rows = p('rows');
        if (!is_array($rows) || !$rows) fail('No rows to add');
        if (count($rows) > ECON_IMPORT_MAX) fail('At most ' . ECON_IMPORT_MAX . ' rows at a time');
        $config = econ_config($cid);
        $st = $pdo->prepare('SELECT id, name, is_everyday FROM economy_items WHERE campaign_id=?');
        $st->execute([$cid]);
        $have = [];
        foreach ($st->fetchAll() as $r) $have[mb_strtolower($r['name'])] = $r;
        $added = $changed = 0;
        $pdo->beginTransaction();
        $ins = $pdo->prepare('INSERT INTO economy_items (' . ECON_ITEM_COLS . ', campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        $upd = $pdo->prepare('UPDATE economy_items SET name=?, category=?, coin_cost=?, barter_cost=?, wealth_level=?, favour_size=?, availability=?, notes=?, is_everyday=?, is_secret=? WHERE id=?');
        foreach ($rows as $v) {
            if (!is_array($v)) fail('Each row is an item');
            $row = econ_item_in($v, $config);
            $key = mb_strtolower($row[0]);
            if (isset($have[$key])) {
                $row[8] = (int)$have[$key]['is_everyday'];   // an everyday price stays one
                $upd->execute([...$row, $have[$key]['id']]);
                $changed++;
            } else {
                if (count($have) >= ECON_ITEMS_MAX) fail('The price book is full (' . ECON_ITEMS_MAX . ' items)');
                $ins->execute([...$row, $cid, me()['id']]);
                $have[$key] = ['id' => (int)$pdo->lastInsertId(), 'name' => $row[0], 'is_everyday' => 0];
                $added++;
            }
        }
        $pdo->commit();
        out(['ok' => true, 'added' => $added, 'changed' => $changed, 'items' => econ_items($cid, true)]);

    case 'economy_shift_save':
        $id = p('id') ? int_in(p('id'), 1) : null;
        if ($id) row_of('economy_shifts', $cid, $id, 'Shift not found');
        $region = p('region_id') ? (int)row_of('regions', $cid, int_in(p('region_id'), 1), 'Region not found')['id'] : null;
        $item = p('item_id') ? (int)row_of('economy_items', $cid, int_in(p('item_id'), 1), 'Item not found')['id'] : null;
        $mult = econ_num(p('multiplier', 1), 0, 1000, 'The multiplier') ?? 1.0;
        $avail = (string)p('availability', '');
        if ($avail !== '' && !in_array($avail, ECON_AVAIL, true)) fail('Availability is common, scarce, rare or none');
        if ($mult == 1.0 && $avail === '') fail('Change the price, the availability, or both');
        $row = [$region, $item, $item ? '' : econ_name(p('category', ''), 60), $mult, $avail === '' ? null : $avail, econ_name(p('reason', ''), 200),
            p('until_day') === null || p('until_day') === '' ? null : int_in(p('until_day'), -100_000_000, 100_000_000)];
        if ($id) {
            $pdo->prepare('UPDATE economy_shifts SET region_id=?, item_id=?, category=?, multiplier=?, availability=?, reason=?, until_day=? WHERE id=?')->execute([...$row, $id]);
        } else {
            $pdo->prepare('INSERT INTO economy_shifts (region_id, item_id, category, multiplier, availability, reason, until_day, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
                ->execute([...$row, $cid, me()['id']]);
            $id = (int)$pdo->lastInsertId();
        }
        out(['ok' => true, 'shift' => econ_shift_out(row_of('economy_shifts', $cid, $id, 'Shift not found'))]);

    case 'economy_shift_delete':
        $pdo->prepare('DELETE FROM economy_shifts WHERE id=? AND campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        out(['ok' => true]);

    case 'economy_entry_save':
        // A new ledger line, from any member. Coins name a Party Funds line (fund_id) and goods a trade good, and
        // change it by the amount in the same transaction; a note changes nothing.
        $kind = (string)p('kind');
        if (!in_array($kind, ['coins', 'goods', 'note'], true)) fail('Pick coins, goods or a note');
        $desc = trim((string)str_in(p('description'), 500, false));
        $source = p('source') === 'reward' ? 'reward' : 'hand';
        $row = ['kind' => $kind, 'description' => $desc, 'source' => $source, 'abs_day' => econ_day_in($cid, p('abs_day'))];
        $pdo->beginTransaction();
        if ($kind === 'note') {
            if ($desc === '') fail('Say what happened');
        } else {
            $amount = econ_num(p('amount'), -ECON_MAX, ECON_MAX, 'The amount');
            if ($amount === null || $amount == 0.0) fail('Give an amount: a minus for what was spent');
            $row['amount'] = $amount;
            if ($kind === 'coins') {
                if (p('fund_id')) {
                    $f = row_of('party_funds', $cid, int_in(p('fund_id'), 1), 'That line of Party Funds is gone', fn($r) => $r['character_id'] !== null);
                    $pdo->prepare('UPDATE party_funds SET amount=amount+? WHERE id=?')->execute([round($amount, 2), $f['id']]);
                    $row += ['fund_id' => (int)$f['id'], 'unit' => $f['currency'], 'place' => $f['location']];
                } else {
                    $row['unit'] = econ_name(p('unit', ''), 60);
                }
            } else {
                $good = econ_name(p('unit', ''), 200);
                if ($good === '') fail('Pick the trade good');
                if ($amount != round($amount)) fail('Goods are counted in whole numbers');
                $g = econ_gear_row($cid, $good);
                if ($g) {
                    $pdo->prepare('UPDATE party_gear SET amount=LEAST(?, GREATEST(0, amount+?)) WHERE id=?')->execute([HOLDING_MAX, (int)$amount, $g['id']]);
                    $row['gear_id'] = (int)$g['id'];
                } elseif ($amount > 0) {
                    $pdo->prepare('INSERT INTO party_gear (campaign_id, item, amount, created_by) VALUES (?,?,?,?)')->execute([$cid, $good, min(HOLDING_MAX, (int)$amount), me()['id']]);
                    $row['gear_id'] = (int)$pdo->lastInsertId();
                }
                $row += ['unit' => $good, 'place' => 'Gear and Loot'];
            }
        }
        $id = econ_log($cid, $row);
        $pdo->commit();
        touch_campaign($cid);
        out(['ok' => true, 'entry' => econ_ledger($cid, $isGm, null, $id)[0]]);

    case 'economy_entry_delete':
        // Takes the line out of the history. What it changed (a funds line, a gear row, a wealth level) stays changed.
        $e = row_of('economy_ledger', $cid, int_in(p('id'), 1), 'Entry not found', fn($r) => !$isGm && (int)$r['is_secret']);
        if (!$isGm && (int)$e['created_by'] !== me()['id']) fail('Only a GM or whoever wrote this entry can delete it', 403);
        $pdo->prepare('DELETE FROM economy_ledger WHERE id=?')->execute([$e['id']]);
        touch_campaign($cid);
        out(['ok' => true]);

    case 'economy_wealth_set':
        // A character's wealth level (character_id 0: the party's own), by its player or a GM; the party's by anyone.
        $config = econ_config($cid);
        if (empty($config['wealth']['on'])) fail('Wealth is not turned on for this campaign');
        $ch = int_in(p('character_id', 0), 0);
        $name = 'The party';
        if ($ch) {
            $c = character_row($cid, $ch, $isGm);
            if (!character_full($c, $isGm)) fail('Only its player or a GM can change this character\'s wealth', 403);
            $name = (string)$c['name'];
        }
        $level = int_in(p('level'), 0, count($config['wealth']['levels']) - 1);
        $was = econ_wealth($cid)[(string)$ch] ?? null;
        $pdo->beginTransaction();
        $pdo->prepare('INSERT INTO economy_wealth (campaign_id, character_id, level) VALUES (?,?,?) ON DUPLICATE KEY UPDATE level=VALUES(level)')->execute([$cid, $ch, $level]);
        if ($was !== $level) {
            $note = trim((string)str_in(p('description'), 500, false));
            econ_log($cid, ['kind' => 'wealth', 'amount' => $was === null ? null : $level - $was, 'level_after' => $level, 'character_id' => $ch ?: null,
                'description' => $note !== '' ? $note : ($was === null ? "$name's wealth set" : "$name's wealth changed")]);
        }
        $pdo->commit();
        touch_campaign($cid);
        out(['ok' => true, 'wealth' => (object)econ_wealth($cid)]);

    case 'economy_cost_save':
        $id = p('id') ? int_in(p('id'), 1) : null;
        if ($id) row_of('economy_costs', $cid, $id, 'Regular cost not found');
        $name = econ_name(p('name'), 200);
        if ($name === '') fail('Name the cost, e.g. Upkeep: the watchtower');
        $amount = econ_num(p('amount'), 0.0001, ECON_MAX, 'The amount');
        if ($amount === null) fail('Say how much it costs each time');
        $fund = p('fund_id') ? (int)row_of('party_funds', $cid, int_in(p('fund_id'), 1), 'That line of Party Funds is gone', fn($r) => $r['character_id'] !== null)['id'] : null;
        $good = $fund ? '' : econ_name(p('good', ''), 200);
        if (!$fund && $good === '') fail('Pick the funds line or trade good it is paid from');
        if ($good !== '' && $amount != round($amount)) fail('Goods are counted in whole numbers');
        $row = [$name, $amount, $fund, $good, int_in(p('every_days', 30), 1, 100_000), econ_day_in($cid, p('next_day'))];
        if ($id) {
            $pdo->prepare('UPDATE economy_costs SET name=?, amount=?, fund_id=?, good=?, every_days=?, next_day=? WHERE id=?')->execute([...$row, $id]);
        } else {
            $st = $pdo->prepare('SELECT COUNT(*) FROM economy_costs WHERE campaign_id=?');
            $st->execute([$cid]);
            if ((int)$st->fetchColumn() >= 100) fail('At most 100 regular costs');
            $pdo->prepare('INSERT INTO economy_costs (name, amount, fund_id, good, every_days, next_day, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?)')->execute([...$row, $cid, me()['id']]);
        }
        touch_campaign($cid);
        out(['ok' => true, 'costs' => econ_costs($cid)]);

    case 'economy_cost_delete':
        $pdo->prepare('DELETE FROM economy_costs WHERE id=? AND campaign_id=?')->execute([int_in(p('id'), 1), $cid]);
        touch_campaign($cid);
        out(['ok' => true]);

    case 'economy_favour_save':
        // A new favour (any member; a secret one only a GM), or a change to one by a GM or whoever wrote it.
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? row_of('economy_favours', $cid, $id, 'Favour not found', fn($r) => !$isGm && (int)$r['is_secret']) : null;
        if ($old && !$isGm && (int)$old['created_by'] !== me()['id']) fail('Only a GM or whoever wrote this favour can change it', 403);
        $other = econ_name(p('other_name'), 200);
        if ($other === '') fail('Say who the favour is with');
        $ch = p('character_id') ? (int)character_row($cid, int_in(p('character_id'), 1), $isGm)['id'] : null;
        $secret = !empty(p('is_secret'));
        if ($secret && !$isGm) fail('Only a GM can keep a favour secret', 403);
        $st = $pdo->prepare('SELECT id FROM encyclopedia_entries WHERE campaign_id=? AND name=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY id LIMIT 1');
        $st->execute([$cid, $other]);
        $entry = $st->fetchColumn();
        $row = [$ch, $other, $entry ? (int)$entry : null, empty(p('owed_to_party')) ? 0 : 1, int_in(p('size', 1), 1, 3), trim((string)str_in(p('description'), 500, false)),
            econ_day_in($cid, p('since_day')), $secret ? 1 : 0];
        $pdo->beginTransaction();
        if ($old) {
            $pdo->prepare('UPDATE economy_favours SET character_id=?, other_name=?, entry_id=?, owed_to_party=?, size=?, description=?, since_day=?, is_secret=? WHERE id=?')->execute([...$row, $id]);
            // its ledger lines are as secret as it is, so revealing the favour shows its history too
            $pdo->prepare('UPDATE economy_ledger SET is_secret=? WHERE favour_id=?')->execute([$secret ? 1 : 0, $id]);
        } else {
            $pdo->prepare('INSERT INTO economy_favours (character_id, other_name, entry_id, owed_to_party, size, description, since_day, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
                ->execute([...$row, $cid, me()['id']]);
            $id = (int)$pdo->lastInsertId();
            $f = ['size' => $row[4], 'owed_to_party' => $row[3], 'other_name' => $other];
            econ_log($cid, ['kind' => 'favour', 'abs_day' => $row[6], 'favour_id' => $id, 'character_id' => $ch, 'is_secret' => $secret, 'source' => 'favour',
                'description' => econ_favour_words($f, econ_side($cid, $ch, $isGm)) . ($row[5] !== '' ? ": {$row[5]}" : '')]);
        }
        $pdo->commit();
        touch_campaign($cid);
        out(['ok' => true, 'favour' => econ_favours($cid, $isGm, $id)[0]]);

    case 'economy_favour_settle':
        // Called in, repaid or forgiven, with a note of what was asked; or opened again (status open).
        $f = row_of('economy_favours', $cid, int_in(p('id'), 1), 'Favour not found', fn($r) => !$isGm && (int)$r['is_secret']);
        $status = (string)p('status');
        if ($status !== 'open' && !in_array($status, ECON_SETTLED, true)) fail('Pick called in, repaid or forgiven');
        if ($status === $f['status']) out(['ok' => true, 'favour' => econ_favours($cid, $isGm, (int)$f['id'])[0]]);
        $note = trim((string)str_in(p('note'), 500, false));
        $day = $status === 'open' ? null : econ_day_in($cid, p('day'));
        $pdo->beginTransaction();
        $pdo->prepare('UPDATE economy_favours SET status=?, settled_day=?, settled_note=? WHERE id=?')->execute([$status, $day, $status === 'open' ? '' : $note, $f['id']]);
        $words = ['called' => 'called in', 'repaid' => 'repaid', 'forgiven' => 'forgiven', 'open' => 'opened again'][$status];
        $who = $f['character_id'] === null ? 'the party' : (string)(econ_favours($cid, true, (int)$f['id'])[0]['character']['name'] ?? 'the party');
        econ_log($cid, ['kind' => 'favour', 'abs_day' => $day, 'favour_id' => (int)$f['id'], 'character_id' => $f['character_id'], 'is_secret' => (int)$f['is_secret'], 'source' => 'favour',
            'description' => econ_favour_words($f, $who) . ", $words" . ($note !== '' ? ": $note" : '')]);
        $pdo->commit();
        touch_campaign($cid);
        out(['ok' => true, 'favour' => econ_favours($cid, $isGm, (int)$f['id'])[0]]);

    case 'economy_favour_delete':
        $f = row_of('economy_favours', $cid, int_in(p('id'), 1), 'Favour not found', fn($r) => !$isGm && (int)$r['is_secret']);
        if (!$isGm && (int)$f['created_by'] !== me()['id']) fail('Only a GM or whoever wrote this favour can delete it', 403);
        $pdo->prepare('DELETE FROM economy_favours WHERE id=?')->execute([$f['id']]);   // its ledger lines go with it
        touch_campaign($cid);
        out(['ok' => true]);
    }
}
