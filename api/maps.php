<?php
/**
 * The Maps tab: maps (an uploaded image with pins, routes, a scale and a grid), tokens and party groups.
 * The actions are added to api/index.php's switch as the tab is built; this file starts with the upgrade guard.
 */

/** Whether migration 019 has been run, so the rest of the app still works on an install that hasn't. */
function has_maps(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW TABLES LIKE 'maps'")->fetchColumn();
}
function need_maps(): void {
    if (!has_maps()) fail('Maps need a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}

/** The units a map's scale can be in, as MapGeo keeps them (static/mapgeo.js). */
const MAP_UNITS = ['ft', 'm', 'mi', 'km', 'au', 'ly'];

/** A map of campaign $cid, or fail as not found: a GM-only map is not found for a player. */
function map_row(int $cid, int $id, bool $isGm): array {
    $st = db()->prepare('SELECT * FROM maps WHERE id=? AND campaign_id=?');
    $st->execute([$id, $cid]);
    $m = $st->fetch();
    if (!$m || (!$isGm && (int)$m['is_secret'])) fail('Map not found', 404);
    return $m;
}
/** A map as the browser gets it; image_url is the picture's address, null until it has one. */
function map_out(array $m): array {
    $num = fn($k) => ($m[$k] ?? null) !== null ? (float)$m[$k] : null;
    $url = null;
    if ($m['image_id'] !== null && has_attachments())
        $url = 'api/index.php?' . http_build_query(['a' => 'file', 'cid' => (int)$m['campaign_id'], 'id' => (int)$m['image_id']]);
    return ['id' => (int)$m['id'], 'name' => $m['name'], 'is_secret' => (bool)(int)$m['is_secret'],
        'width' => $m['width'] !== null ? (int)$m['width'] : null, 'height' => $m['height'] !== null ? (int)$m['height'] : null,
        'scale_per_px' => $num('scale_per_px'), 'scale_unit' => $m['scale_unit'], 'grid_px' => $num('grid_px'),
        'grid_offset_x' => $num('grid_offset_x'), 'grid_offset_y' => $num('grid_offset_y'), 'image_url' => $url,
        'created_by' => $m['created_by'] !== null ? (int)$m['created_by'] : null];
}
/** SQL conditions (aliases p = map_pins, e = its entry, ev = its event, both LEFT JOINed) for the pins this member may see:
 * a player's drop GM-only pins and those on GM-only entries or secret events. Empty for a GM. */
function map_pin_visible_sql(bool $isGm): string {
    return $isGm ? '' : ' AND p.is_secret=0 AND (e.id IS NULL OR e.is_secret=0) AND (ev.id IS NULL OR ev.is_secret=0)';
}
const MAP_PIN_JOINS = ' LEFT JOIN encyclopedia_entries e ON e.id=p.entry_id LEFT JOIN events ev ON ev.id=p.event_id';
/** This campaign's maps (a player's without the GM-only ones), oldest first, each with how many pins this member may see. */
function maps_list(int $cid, bool $isGm): array {
    $st = db()->prepare('SELECT m.*, (SELECT COUNT(*) FROM map_pins p' . MAP_PIN_JOINS . ' WHERE p.map_id=m.id' . map_pin_visible_sql($isGm) . ') AS pins
        FROM maps m WHERE m.campaign_id=?' . ($isGm ? '' : ' AND m.is_secret=0') . ' ORDER BY m.id');
    $st->execute([$cid]);
    return array_map(fn($m) => map_out($m) + ['pins' => (int)$m['pins']], $st->fetchAll());
}
/** A number from a request, or null when it is null or empty; fails if it isn't one. $min is the lowest allowed. */
function map_num($v, string $what, float $min = 0.0, ?float $max = null, bool $above = false): ?float {
    if ($v === null || $v === '') return null;
    if (!is_numeric($v) || !is_finite((float)$v)) fail("$what must be a number");
    $f = (float)$v;
    if ($above ? $f <= $min : $f < $min) fail($above ? "$what must be more than $min" : "$what can't be less than $min");
    if ($max !== null && $f > $max) fail("$what is too big");
    return $f;
}
/** Add a map (GM), or change the fields of map $id that the request names. Returns the map as the browser gets it. */
function map_save(int $cid): array {
    $body = body();
    $has = fn($k) => array_key_exists($k, $body);
    $old = isset($body['id']) ? map_row($cid, int_in($body['id'], 1), true) : null;
    $m = $old ?? ['id' => null, 'campaign_id' => $cid, 'name' => '', 'image_id' => null, 'width' => null, 'height' => null, 'scale_per_px' => null,
        'scale_unit' => null, 'grid_px' => null, 'grid_offset_x' => null, 'grid_offset_y' => null, 'is_secret' => 0, 'created_by' => me()['id']];
    if ($has('name') || !$old) {
        $m['name'] = trim((string)str_in($body['name'] ?? null, 150));
        if ($m['name'] === '') fail('Give the map a name');
    }
    if ($has('is_secret')) $m['is_secret'] = !empty($body['is_secret']) ? 1 : 0;
    if ($has('scale_per_px')) $m['scale_per_px'] = map_num($body['scale_per_px'], 'The scale', 0.0, 1e15, true);
    if ($has('scale_unit')) {
        $u = $body['scale_unit'];
        if ($u !== null && $u !== '' && !in_array($u, MAP_UNITS, true)) fail('Pick feet, metres, miles, kilometres, AU or light-years');
        $m['scale_unit'] = $u === '' ? null : $u;
    }
    if ($has('grid_px')) $m['grid_px'] = map_num($body['grid_px'], 'The grid size', 0.0, 100000.0, true);
    foreach (['grid_offset_x', 'grid_offset_y'] as $k)
        if ($has($k)) $m[$k] = map_num($body[$k], 'The grid offset', 0.0, $m['grid_px'] ?? 100000.0);
    if ($has('grid_px') && $m['grid_px'] !== null)   // a new grid size alone keeps the offsets already stored, wrapped to fit it
        foreach (['grid_offset_x', 'grid_offset_y'] as $k) if (!$has($k) && $m[$k] !== null) $m[$k] = fmod((float)$m[$k], $m['grid_px']);
    if ($has('image_id')) {
        if ($body['image_id'] === null || $body['image_id'] === '') { $m['image_id'] = $m['width'] = $m['height'] = null; }
        else {
            need_attachments();
            if (!$old) fail('Save the map first, then add its picture');
            $st = db()->prepare("SELECT id, width, height FROM attachments WHERE id=? AND campaign_id=? AND parent_type='map' AND parent_id=? AND kind='image' AND is_secret=0");
            $st->execute([int_in($body['image_id'], 1), $cid, $old['id']]);
            $a = $st->fetch();
            if (!$a) fail("That picture isn't one of this map's pictures", 400);
            $m['image_id'] = (int)$a['id'];
            $m['width'] = $a['width'] !== null ? (int)$a['width'] : null;
            $m['height'] = $a['height'] !== null ? (int)$a['height'] : null;
        }
    }
    $cols = [$m['name'], $m['image_id'], $m['width'], $m['height'], $m['scale_per_px'], $m['scale_unit'], $m['grid_px'], $m['grid_offset_x'], $m['grid_offset_y'], $m['is_secret']];
    if ($old) {
        db()->prepare('UPDATE maps SET name=?, image_id=?, width=?, height=?, scale_per_px=?, scale_unit=?, grid_px=?, grid_offset_x=?, grid_offset_y=?, is_secret=? WHERE id=?')
            ->execute([...$cols, $old['id']]);
        $id = (int)$old['id'];
        if ($old['image_id'] !== null && (int)$old['image_id'] !== $m['image_id']) attachment_remove($cid, (int)$old['image_id']);   // the old picture is no longer wanted
    } else {
        db()->prepare('INSERT INTO maps (name, image_id, width, height, scale_per_px, scale_unit, grid_px, grid_offset_x, grid_offset_y, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
            ->execute([...$cols, $cid, $m['created_by']]);
        $id = (int)db()->lastInsertId();
    }
    touch_campaign($cid);
    return map_out(map_row($cid, $id, true));
}

// ---------- pins and routes ----------
// A pin is a player's public note, or a GM's pin of an entry or an event. Players see no GM-only pin and none on a
// GM-only entry or secret event; the filter is in the SQL. Routes are drawn by GMs; a GM-only one is theirs alone.

/** A pin row (from map_pins_select) as the browser gets it. */
function pin_out(array $p): array {
    $entry = $p['entry_id'] !== null && $p['e_name'] !== null
        ? ['id' => (int)$p['entry_id'], 'name' => $p['e_name'], 'category' => $p['e_category'], 'first_line' => entry_preview(rich_open($p['e_notes']))] : null;
    $event = $p['event_id'] !== null && $p['ev_title'] !== null
        ? ['id' => (int)$p['event_id'], 'abs_day' => (int)$p['ev_abs_day'], 'title' => $p['ev_title']] : null;
    return ['id' => (int)$p['id'], 'map_id' => (int)$p['map_id'], 'x' => (float)$p['x'], 'y' => (float)$p['y'], 'kind' => $p['kind'],
        'entry_id' => $p['entry_id'] !== null ? (int)$p['entry_id'] : null, 'event_id' => $p['event_id'] !== null ? (int)$p['event_id'] : null,
        'label' => $p['label'], 'note' => $p['note'], 'is_secret' => (bool)(int)$p['is_secret'],
        'created_by' => $p['created_by'] !== null ? (int)$p['created_by'] : null, 'author' => $p['author'], 'entry' => $entry, 'event' => $event];
}
/** The pins of campaign $cid matching $where (SQL on aliases p, e, ev), with their entry, event and author joined, oldest first. */
function map_pins_select(int $cid, string $where, array $args): array {
    $st = db()->prepare('SELECT p.*, e.name AS e_name, ' . (has_categories() ? 'e.category' : 'NULL') . ' AS e_category, e.notes AS e_notes, ev.abs_day AS ev_abs_day, ev.title AS ev_title, ' . AUTHOR_SQL . ' AS author
        FROM map_pins p' . MAP_PIN_JOINS . ' LEFT JOIN users u ON u.id=p.created_by LEFT JOIN campaign_members m ON m.campaign_id=p.campaign_id AND m.user_id=p.created_by
        WHERE p.campaign_id=? AND ' . $where . ' ORDER BY p.id');
    $st->execute([$cid, ...$args]);
    return $st->fetchAll();
}
/** The pins on map $mapId that this member may see. */
function map_pins_visible(int $cid, int $mapId, bool $isGm): array {
    return array_map('pin_out', map_pins_select($cid, 'p.map_id=?' . map_pin_visible_sql($isGm), [$mapId]));
}
/** Pin $id as this member may see it (a player: not on a GM-only map either), or fail as not found. */
function pin_row(int $cid, int $id, bool $isGm): array {
    $rows = map_pins_select($cid, 'p.id=?' . map_pin_visible_sql($isGm) . ($isGm ? '' : ' AND (SELECT is_secret FROM maps WHERE id=p.map_id)=0'), [$id]);
    if (!$rows) fail('Pin not found', 404);
    return $rows[0];
}
/** Every pin this member may see on a map they may see, short: for knowing which entries and events are on a map. */
function maps_index(int $cid, bool $isGm): array {
    $st = db()->prepare('SELECT p.id, p.map_id, m.name, p.entry_id, p.event_id FROM map_pins p JOIN maps m ON m.id=p.map_id' . MAP_PIN_JOINS . '
        WHERE p.campaign_id=?' . ($isGm ? '' : ' AND m.is_secret=0') . map_pin_visible_sql($isGm) . ' ORDER BY p.id');
    $st->execute([$cid]);
    return array_map(fn($r) => ['pin_id' => (int)$r['id'], 'map_id' => (int)$r['map_id'], 'map_name' => $r['name'],
        'entry_id' => $r['entry_id'] !== null ? (int)$r['entry_id'] : null, 'event_id' => $r['event_id'] !== null ? (int)$r['event_id'] : null], $st->fetchAll());
}
/** A coordinate from a request, which must lie within 0..$max. */
function map_coord($v, $max): float {
    if (!is_numeric($v) || !is_finite((float)$v)) fail("That's off the map");
    $f = (float)$v;
    if ($f < 0 || $f > $max) fail("That's off the map");
    return $f;
}
/** Add a pin, or change the fields of pin $id that the request names. Players: public notes of their own; GMs: anything. */
function pin_save(int $cid, bool $isGm): array {
    $body = body();
    $has = fn($k) => array_key_exists($k, $body);
    $u = me()['id'];
    $old = isset($body['id']) ? pin_row($cid, int_in($body['id'], 1), $isGm) : null;
    if ($old && !$isGm && ((int)$old['created_by'] !== $u || $old['kind'] !== 'note')) fail('You can only change your own pins', 403);
    $map = map_row($cid, $has('map_id') || !$old ? int_in($body['map_id'] ?? null, 1) : (int)$old['map_id'], $isGm);
    if ($map['width'] === null || $map['height'] === null) fail('Give the map a picture before pinning it');
    $x = map_coord($has('x') || !$old ? $body['x'] ?? null : $old['x'], $map['width']);   // kept coordinates are checked against the map it is on now
    $y = map_coord($has('y') || !$old ? $body['y'] ?? null : $old['y'], $map['height']);
    $kind = $isGm && $has('kind') ? $body['kind'] : ($old['kind'] ?? 'note');
    if (!in_array($kind, ['note', 'entry', 'event'], true)) fail('Pick a note, an entry or an event');
    $label = $has('label') ? trim((string)str_in($body['label'], 150)) : ($old['label'] ?? '');
    $note = $has('note') ? str_in(trim((string)($body['note'] ?? '')), 1000) : ($old['note'] ?? null);
    $secret = $isGm ? ($has('is_secret') ? (!empty($body['is_secret']) ? 1 : 0) : (int)($old['is_secret'] ?? 0)) : 0;
    $entryId = $eventId = null;
    if ($kind === 'entry') {
        $entryId = $has('entry_id') || !$old ? int_in($body['entry_id'] ?? null, 1) : (int)$old['entry_id'];
        entry_row($cid, $entryId, 'gm');
    } elseif ($kind === 'event') {
        $eventId = $has('event_id') || !$old ? int_in($body['event_id'] ?? null, 1) : (int)$old['event_id'];
        $st = db()->prepare('SELECT id FROM events WHERE id=? AND campaign_id=?');
        $st->execute([$eventId, $cid]);
        if (!$st->fetchColumn()) fail('Event not found', 404);
    } elseif ($label === '') fail('Give the pin a label');
    $cols = [$map['id'], $x, $y, $kind, $entryId, $eventId, $label, $note, $secret];
    if ($old) {
        db()->prepare('UPDATE map_pins SET map_id=?, x=?, y=?, kind=?, entry_id=?, event_id=?, label=?, note=?, is_secret=? WHERE id=?')->execute([...$cols, $old['id']]);
        $id = (int)$old['id'];
    } else {
        db()->prepare('INSERT INTO map_pins (map_id, x, y, kind, entry_id, event_id, label, note, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            ->execute([...$cols, $cid, $u]);
        $id = (int)db()->lastInsertId();
    }
    if ($isGm) touch_campaign($cid);   // players' pins are like their notes: they don't count as a campaign change
    return pin_out(pin_row($cid, $id, true));
}
/** A name as entry names are matched: any case, no leading "The". */
function pin_name_key(string $n): string {
    return preg_replace('/^the\s+/u', '', mb_strtolower(trim(preg_replace('/\s+/u', ' ', $n))));
}
/** GM: make note pin $id an entry pin. $entryId names the entry to use; else one whose name or other name matches the label
 * is reused, else one is added from the label and note. Returns [pin, entry id, whether an entry was added]. */
function pin_to_entry(int $cid, int $id, ?int $entryId): array {
    need_encyclopedia();
    $pin = pin_row($cid, $id, true);
    if ($pin['kind'] !== 'note') fail('Only a note pin can become an entry');
    $created = false;
    if ($entryId !== null) entry_row($cid, $entryId, 'gm');
    db()->beginTransaction();
    try {
        if ($entryId === null) {
            $key = pin_name_key($pin['label']);
            $st = db()->prepare('SELECT id, name, aliases_json FROM encyclopedia_entries WHERE campaign_id=? ORDER BY id');
            $st->execute([$cid]);
            foreach ($st->fetchAll() as $e)
                foreach ([$e['name'], ...entry_aliases($e)] as $n) if (pin_name_key($n) === $key) { $entryId = (int)$e['id']; break 2; }
            if ($entryId === null) {
                $notes = trim((string)$pin['note']) !== '' ? '<p>' . htmlspecialchars(trim($pin['note']), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</p>' : null;
                db()->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, notes, is_secret, created_by) VALUES (?,?,?,0,?)')
                    ->execute([$cid, entry_name($pin['label']), $notes, me()['id']]);
                $entryId = (int)db()->lastInsertId();
                if (has_categories()) db()->prepare('UPDATE encyclopedia_entries SET category=? WHERE id=?')->execute(['location', $entryId]);
                $created = true;
            }
        }
        db()->prepare("UPDATE map_pins SET kind='entry', entry_id=?, label='' WHERE id=?")->execute([$entryId, $id]);
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
    touch_campaign($cid);
    return [pin_out(pin_row($cid, $id, true)), $entryId, $created];
}

/** A route as the browser gets it. */
function route_out(array $r): array {
    return ['id' => (int)$r['id'], 'map_id' => (int)$r['map_id'], 'name' => $r['name'], 'points' => dec($r['points_json']) ?: [], 'is_secret' => (bool)(int)$r['is_secret']];
}
/** The routes on map $mapId that this member may see, oldest first. */
function map_routes_visible(int $cid, int $mapId, bool $isGm): array {
    $st = db()->prepare('SELECT * FROM map_routes WHERE campaign_id=? AND map_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY id');
    $st->execute([$cid, $mapId]);
    return array_map('route_out', $st->fetchAll());
}
/** Add a route (GM), or change route $id. Returns it as the browser gets it. */
function route_save(int $cid): array {
    $body = body();
    $has = fn($k) => array_key_exists($k, $body);
    $old = null;
    if (isset($body['id'])) {
        $st = db()->prepare('SELECT * FROM map_routes WHERE id=? AND campaign_id=?');
        $st->execute([int_in($body['id'], 1), $cid]);
        $old = $st->fetch() ?: null;
        if (!$old) fail('Route not found', 404);
    }
    $map = map_row($cid, $has('map_id') || !$old ? int_in($body['map_id'] ?? null, 1) : (int)$old['map_id'], true);
    $name = $has('name') || !$old ? trim((string)str_in($body['name'] ?? null, 150)) : $old['name'];
    if ($name === '') fail('Give the route a name');
    $points = $has('points') || !$old ? $body['points'] ?? null : dec($old['points_json']);
    if (!is_array($points) || count($points) < 2 || count($points) > 500) fail('A route needs 2 to 500 points');
    if ($map['width'] === null || $map['height'] === null) fail('Give the map a picture before drawing on it');
    $pts = [];
    foreach ($points as $pt) {
        if (!is_array($pt) || count($pt) !== 2) fail('A route is a list of [x, y] points');
        $pts[] = [map_coord(array_values($pt)[0], $map['width']), map_coord(array_values($pt)[1], $map['height'])];
    }
    $secret = $has('is_secret') ? (!empty($body['is_secret']) ? 1 : 0) : (int)($old['is_secret'] ?? 0);
    $json = json_encode($pts);
    if ($old) {
        db()->prepare('UPDATE map_routes SET map_id=?, name=?, points_json=?, is_secret=? WHERE id=?')->execute([$map['id'], $name, $json, $secret, $old['id']]);
        $id = (int)$old['id'];
    } else {
        db()->prepare('INSERT INTO map_routes (map_id, name, points_json, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?)')
            ->execute([$map['id'], $name, $json, $secret, $cid, me()['id']]);
        $id = (int)db()->lastInsertId();
    }
    touch_campaign($cid);
    $st = db()->prepare('SELECT * FROM map_routes WHERE id=?');
    $st->execute([$id]);
    return route_out($st->fetch());
}
