<?php
/**
 * Party Holdings: gear, holdings and their storage, and the party funds (the Party Holdings tab).
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

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
    return row_of($table, $cid, $id, $table === 'holdings' ? 'Holding not found' : 'Item not found');
}
/** Tick a gear row's or holding's amount up or down by $delta, never below 0. Returns the new amount. */
function holding_tick(string $table, int $cid): int {
    $id = int_in(p('id'), 1);
    $delta = int_in(p('delta'), -HOLDING_MAX, HOLDING_MAX);
    holding_row($table, $id, $cid);
    db()->prepare("UPDATE $table SET amount=LEAST(?, GREATEST(0, amount + ?)) WHERE id=?")->execute([HOLDING_MAX, $delta, $id]);
    return (int)holding_row($table, $id, $cid)['amount'];
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function holdings_action(string $action): void {
    switch ($action) {
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
    }
}
