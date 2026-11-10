<?php
/**
 * The Maps tab: maps (an uploaded image with pins, routes, a scale and a grid), tokens and party groups.
 * The actions are added to api/index.php's switch as the tab is built.
 */

/** The lines a route can be drawn with (MapsTab's DASHES). */
const MAP_DASHES = ['solid', 'dashed', 'dotted', 'dashdot'];
/** A colour from a request: #rrggbb, or null for none. */
function map_colour($v): ?string {
    if ($v === null || $v === '') return null;
    if (!is_string($v) || !preg_match('/^#[0-9a-f]{6}$/i', $v)) fail('A colour is #rrggbb');
    return strtolower($v);
}
/** A pin's icon from a request: a short emoji or symbol (any text up to 16 characters, shown as text), or null for its kind's own. */
function map_icon($v): ?string {
    if ($v === null || $v === '') return null;
    if (!is_string($v) || mb_strlen($v) > 16 || preg_match('/[\x00-\x1f<>]/', $v)) fail('Pick an icon from the list');
    return trim($v) === '' ? null : trim($v);
}

/** The shapes a map's grid can be, as MapGeo draws them. */
const MAP_GRID_TYPES = ['square', 'hex_flat', 'hex_pointy'];

/** The units a map's scale can be in, as MapGeo keeps them (static/mapgeo.js). */
const MAP_UNITS = ['ft', 'm', 'mi', 'km', 'au', 'ly'];

/** A map of campaign $cid, or fail as not found: a GM-only map is not found for a player. */
function map_row(int $cid, int $id, bool $isGm): array {
    return row_of('maps', $cid, $id, 'Map not found', fn($m) => !$isGm && (int)$m['is_secret']);
}
/** A map as the browser gets it; image_url is the picture's address, null until it has one. */
function map_out(array $m): array {
    $num = fn($k) => ($m[$k] ?? null) !== null ? (float)$m[$k] : null;
    $url = null;
    if ($m['image_id'] !== null)
        $url = 'api/index.php?' . http_build_query(['a' => 'file', 'cid' => (int)$m['campaign_id'], 'id' => (int)$m['image_id']]);
    return ['id' => (int)$m['id'], 'name' => $m['name'], 'is_secret' => (bool)(int)$m['is_secret'],
        'width' => $m['width'] !== null ? (int)$m['width'] : null, 'height' => $m['height'] !== null ? (int)$m['height'] : null,
        'scale_per_px' => $num('scale_per_px'), 'scale_unit' => $m['scale_unit'], 'grid_px' => $num('grid_px'),
        'grid_offset_x' => $num('grid_offset_x'), 'grid_offset_y' => $num('grid_offset_y'),
        'grid_type' => $m['grid_type'] ?? 'square', 'grid_shown' => (bool)(int)($m['grid_shown'] ?? 0), 'image_url' => $url,
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
    // 'inside': the pin and map this one opens from, when this member may see them (see map_parent)
    return array_map(fn($m) => map_out($m) + ['pins' => (int)$m['pins'], 'inside' => map_parent($cid, (int)$m['id'], $isGm)], $st->fetchAll());
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
    $m += ['grid_type' => 'square', 'grid_shown' => 0];
    if ($has('grid_type')) {
        if (!in_array($body['grid_type'], MAP_GRID_TYPES, true)) fail('Pick squares, flat-topped hexes or pointy-topped hexes');
        $m['grid_type'] = $body['grid_type'];
    }
    if ($has('grid_shown')) $m['grid_shown'] = !empty($body['grid_shown']) ? 1 : 0;
    if ($has('image_id')) {
        if ($body['image_id'] === null || $body['image_id'] === '') { $m['image_id'] = $m['width'] = $m['height'] = null; }
        else {
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
        db()->prepare('UPDATE maps SET grid_type=?, grid_shown=? WHERE id=?')->execute([$m['grid_type'], $m['grid_shown'], $id]);
        if ($old['image_id'] !== null && (int)$old['image_id'] !== $m['image_id']) attachment_remove($cid, (int)$old['image_id']);   // the old picture is no longer wanted
    } else {
        db()->prepare('INSERT INTO maps (name, image_id, width, height, scale_per_px, scale_unit, grid_px, grid_offset_x, grid_offset_y, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
            ->execute([...$cols, $cid, $m['created_by']]);
        $id = (int)db()->lastInsertId();
        db()->prepare('UPDATE maps SET grid_type=?, grid_shown=? WHERE id=?')->execute([$m['grid_type'], $m['grid_shown'], $id]);
    }
    touch_campaign($cid);
    return map_out(map_row($cid, $id, true));
}

// ---------- pins and routes ----------
// A pin is a player's public note, or a GM's pin of an entry or an event. Players see no GM-only pin and none on a
// GM-only entry or secret event; the filter is in the SQL. Routes are drawn by GMs; a GM-only one is theirs alone.

/** A pin row (from map_pins_select) as the browser gets it. */
function pin_out(array $p, bool $isGm = true): array {
    $entry = $p['entry_id'] !== null && $p['e_name'] !== null
        ? ['id' => (int)$p['entry_id'], 'name' => $p['e_name'], 'category' => $p['e_category'], 'first_line' => entry_preview(rich_open($p['e_notes']))] : null;
    $event = $p['event_id'] !== null && $p['ev_title'] !== null
        ? ['id' => (int)$p['event_id'], 'abs_day' => (int)$p['ev_abs_day'], 'title' => $p['ev_title']] : null;
    // the map this pin opens; a player isn't told of a GM-only one (not even its name)
    $child = ($p['child_map_id'] ?? null) !== null && ($isGm || !(int)$p['cm_secret']) ? ['id' => (int)$p['child_map_id'], 'name' => $p['cm_name']] : null;
    return ['id' => (int)$p['id'], 'map_id' => (int)$p['map_id'], 'child_map' => $child, 'x' => (float)$p['x'], 'y' => (float)$p['y'], 'kind' => $p['kind'],
        'entry_id' => $p['entry_id'] !== null ? (int)$p['entry_id'] : null, 'event_id' => $p['event_id'] !== null ? (int)$p['event_id'] : null,
        'label' => $p['label'], 'note' => $p['note'], 'is_secret' => (bool)(int)$p['is_secret'],
        'icon' => $p['icon'] ?? null, 'color' => $p['color'] ?? null, 'is_locked' => (bool)(int)($p['is_locked'] ?? 0),
        'created_by' => $p['created_by'] !== null ? (int)$p['created_by'] : null, 'author' => $p['author'], 'entry' => $entry, 'event' => $event];
}
/** The pins of campaign $cid matching $where (SQL on aliases p, e, ev), with their entry, event and author joined, oldest first. */
function map_pins_select(int $cid, string $where, array $args): array {
    $st = db()->prepare('SELECT p.*, e.name AS e_name, e.category AS e_category, e.notes AS e_notes, ev.abs_day AS ev_abs_day, ev.title AS ev_title, cm.name AS cm_name, cm.is_secret AS cm_secret, ' . AUTHOR_SQL . ' AS author
        FROM map_pins p' . MAP_PIN_JOINS . ' LEFT JOIN maps cm ON cm.id=p.child_map_id LEFT JOIN users u ON u.id=p.created_by LEFT JOIN campaign_members m ON m.campaign_id=p.campaign_id AND m.user_id=p.created_by
        WHERE p.campaign_id=? AND ' . $where . ' ORDER BY p.id');
    $st->execute([$cid, ...$args]);
    return $st->fetchAll();
}
/** The pins on map $mapId that this member may see. */
function map_pins_visible(int $cid, int $mapId, bool $isGm): array {
    return array_map(fn($p) => pin_out($p, $isGm), map_pins_select($cid, 'p.map_id=?' . map_pin_visible_sql($isGm), [$mapId]));
}
/** The first pin this member may see that opens map $mapId (on a map they may see), as {pin_id, label, map_id, map_name}, or null. */
function map_parent(int $cid, int $mapId, bool $isGm): ?array {
    $rows = map_pins_select($cid, 'p.child_map_id=?' . map_pin_visible_sql($isGm) . ($isGm ? '' : ' AND (SELECT is_secret FROM maps WHERE id=p.map_id)=0'), [$mapId]);
    if (!$rows) return null;
    $p = $rows[0];
    $st = db()->prepare('SELECT name FROM maps WHERE id=?');
    $st->execute([$p['map_id']]);
    $label = trim((string)$p['label']) !== '' ? $p['label'] : ($p['e_name'] ?? $p['ev_title'] ?? 'a pin');
    return ['pin_id' => (int)$p['id'], 'label' => $label, 'map_id' => (int)$p['map_id'], 'map_name' => (string)$st->fetchColumn()];
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
    $locked = $has('is_locked') ? (!empty($body['is_locked']) ? 1 : 0) : (int)($old['is_locked'] ?? 0);
    // a locked pin stays put: moving it (or onto another map) needs unlocking first, in the same save or before
    if ($old && (int)($old['is_locked'] ?? 0) && $locked && ((float)$old['x'] !== $x || (float)$old['y'] !== $y || (int)$old['map_id'] !== (int)$map['id']))
        fail('That pin is locked. Unlock it to move it', 409);
    $icon = $has('icon') ? map_icon($body['icon']) : ($old['icon'] ?? null);
    $colour = $has('color') ? map_colour($body['color']) : ($old['color'] ?? null);
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
    // GMs: the map this pin opens (any kind of pin), another map of this campaign
    $child = $isGm && $has('child_map_id') ? ($body['child_map_id'] === null ? null : int_in($body['child_map_id'], 1)) : (isset($old['child_map_id']) ? (int)$old['child_map_id'] : null);
    if ($child !== null) {
        if ($child === (int)$map['id']) fail('A pin can\'t open the map it is on');
        map_row($cid, $child, true);
    }
    $cols = [$map['id'], $x, $y, $kind, $entryId, $eventId, $label, $note, $secret];
    if ($old) {
        db()->prepare('UPDATE map_pins SET map_id=?, x=?, y=?, kind=?, entry_id=?, event_id=?, label=?, note=?, is_secret=? WHERE id=?')->execute([...$cols, $old['id']]);
        $id = (int)$old['id'];
    } else {
        db()->prepare('INSERT INTO map_pins (map_id, x, y, kind, entry_id, event_id, label, note, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            ->execute([...$cols, $cid, $u]);
        $id = (int)db()->lastInsertId();
    }
    db()->prepare('UPDATE map_pins SET icon=?, color=?, is_locked=?, child_map_id=? WHERE id=?')->execute([$icon, $colour, $locked, $child, $id]);
    if ($isGm) touch_campaign($cid);   // players' pins are like their notes: they don't count as a campaign change
    return pin_out(pin_row($cid, $id, true));
}
/** A name as entry names are matched (as MapGeo.nameKey does): any case, no accents, no leading "The". */
function pin_name_key(string $n): string {
    if (class_exists('Normalizer')) $n = preg_replace('/\p{Mn}+/u', '', Normalizer::normalize($n, Normalizer::FORM_D) ?: $n);
    return preg_replace('/^the\s+/u', '', mb_strtolower(trim(preg_replace('/\s+/u', ' ', $n))));
}
/** GM: make note pin $id an entry pin. $entryId names the entry to use; else one whose name or other name matches the label
 * is reused, else one is added from the label and note. Returns [pin, entry id, whether an entry was added]. */
function pin_to_entry(int $cid, int $id, ?int $entryId): array {
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
            if ($entryId === null) {   // the column's collation also equates accents ("Café" and "Cafe"), which mb_strtolower does not
                $st = db()->prepare('SELECT id FROM encyclopedia_entries WHERE campaign_id=? AND name=?');
                $st->execute([$cid, entry_name($pin['label'])]);
                $same = $st->fetchColumn();
                if ($same !== false) $entryId = (int)$same;
            }
            if ($entryId === null) {
                $notes = trim((string)$pin['note']) !== '' ? '<p>' . htmlspecialchars(trim($pin['note']), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</p>' : null;
                try {
                    db()->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, notes, is_secret, created_by) VALUES (?,?,?,0,?)')
                        ->execute([$cid, entry_name($pin['label']), $notes, me()['id']]);
                    $entryId = (int)db()->lastInsertId();
                    db()->prepare('UPDATE encyclopedia_entries SET category=? WHERE id=?')->execute(['location', $entryId]);
                    $created = true;
                } catch (PDOException $e) {   // 1062: an entry of this name appeared since the look above
                    if (($e->errorInfo[1] ?? 0) != 1062) throw $e;
                    $st = db()->prepare('SELECT id FROM encyclopedia_entries WHERE campaign_id=? AND name=?');
                    $st->execute([$cid, entry_name($pin['label'])]);
                    $entryId = (int)$st->fetchColumn();
                    if (!$entryId) throw $e;
                }
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
    return ['id' => (int)$r['id'], 'map_id' => (int)$r['map_id'], 'name' => $r['name'], 'points' => dec($r['points_json']) ?: [], 'is_secret' => (bool)(int)$r['is_secret'],
        'color' => $r['color'] ?? null, 'dash' => $r['dash'] ?? null, 'terrain' => ($r['terrain_json'] ?? null) !== null ? dec($r['terrain_json']) : null];
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
        $old = row_of('map_routes', $cid, int_in($body['id'], 1), 'Route not found');
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
    $colour = $has('color') ? map_colour($body['color']) : ($old['color'] ?? null);
    $dash = $has('dash') ? $body['dash'] : ($old['dash'] ?? null);
    if ($dash === '') $dash = null;
    if ($dash !== null && !in_array($dash, MAP_DASHES, true)) fail('Pick a solid, dashed, dotted or dash-dot line');
    // terrain: a travel-time multiplier for each leg, 1 to 4; new points without a new list drop the old one, which no longer fits
    $terrain = $old ? ($has('points') && !$has('terrain') && count($pts) !== count(dec($old['points_json']) ?: []) ? null : $old['terrain_json'] ?? null) : null;
    if ($has('terrain')) {
        $t = $body['terrain'];
        if ($t === null) $terrain = null;
        else {
            if (!is_array($t) || count($t) !== count($pts) - 1) fail('Give each leg of the route a terrain');
            foreach ($t as $m) if (!in_array($m, [1, 2, 3, 4], true)) fail('A leg\'s terrain is x1, x2, x3 or x4');
            $terrain = in_array(true, array_map(fn($m) => $m !== 1, $t), true) ? json_encode(array_values($t)) : null;   // all x1 is no terrain at all
        }
    }
    db()->prepare('UPDATE map_routes SET color=?, dash=?, terrain_json=? WHERE id=?')->execute([$colour, $dash, $terrain, $id]);
    touch_campaign($cid);
    $st = db()->prepare('SELECT * FROM map_routes WHERE id=?');
    $st->execute([$id]);
    return route_out($st->fetch());
}

// ---------- party groups ----------
// The party is one main group, "The party", holding every player character until a GM splits some off. A user is in
// one group only. The main group's region is the campaign's current region (settings current_region), kept in step both ways.

/** The id of region $rid if it is one of campaign $cid's, else null. */
function party_region(int $cid, $rid): ?int {
    if ($rid === null || $rid === '' || !is_numeric($rid)) return null;
    $st = db()->prepare('SELECT id FROM regions WHERE id=? AND campaign_id=?');
    $st->execute([(int)$rid, $cid]);
    $id = $st->fetchColumn();
    return $id === false ? null : (int)$id;
}
/** A region_id from a request: one of this campaign's regions, or null for none. */
function party_region_in($v, int $cid): ?int {
    if ($v === null || $v === '') return null;
    $id = party_region($cid, $v);
    if ($id === null) fail('Pick one of this campaign\'s regions');
    return $id;
}
/** Campaign $cid's current region, if it still exists. */
function party_current_region(int $cid): ?int {
    return party_region($cid, (dec(campaign_row($cid)['settings_json']) ?: [])['current_region'] ?? null);
}
/** Make settings current_region $rid (null for none), leaving the rest of the settings alone. */
function party_set_current_region(int $cid, ?int $rid): void {
    $s = dec(campaign_row($cid)['settings_json']) ?: [];
    $s['current_region'] = $rid;
    db()->prepare('UPDATE campaigns SET settings_json=? WHERE id=?')->execute([json_in($s), $cid]);
}
/** The main group's region := the campaign's current region (after the settings change). */
function party_sync_main_region(int $cid): void {
    db()->prepare('UPDATE party_groups SET region_id=? WHERE campaign_id=? AND is_main=1')->execute([party_current_region($cid), $cid]);
}
/** Take user $uid out of every group of campaign $cid (they have left the campaign), and the characters they played
 * as a player ($player). */
function party_remove_member(int $cid, int $uid, bool $player = false): void {
    db()->beginTransaction();
    try {
        party_lock($cid);
        if ($player) db()->prepare('UPDATE sheet_characters SET party_group_id=NULL WHERE campaign_id=? AND owner_id=?')->execute([$cid, $uid]);
        $st = db()->prepare('SELECT id, members_json FROM party_groups WHERE campaign_id=?');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $g) {
            $m = dec($g['members_json']) ?: [];
            $left = array_values(array_filter($m, fn($x) => (int)$x !== $uid));
            if (count($left) !== count($m)) db()->prepare('UPDATE party_groups SET members_json=? WHERE id=?')->execute([json_encode($left), $g['id']]);
        }
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
}
/** Inside a transaction: lock campaign $cid's groups against other writers (the campaign row is the lock, as in party_rows). */
function party_lock(int $cid): void {
    db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]);
}
/** Inside a transaction, after party_lock: group $id of campaign $cid as it is now, or fail as not found. */
function party_reread(int $cid, $id): array {
    return row_of('party_groups', $cid, (int)$id, 'Group not found');
}
/** Campaign $cid's players with no character sheet, who stand in the party as themselves (party_groups.members_json).
 * A player with a sheet is in the party through their characters, each in a group of its own (party_group_id). */
function party_players(int $cid): array {
    $st = db()->prepare("SELECT m.user_id FROM campaign_members m WHERE m.campaign_id=? AND m.role='player'
        AND NOT EXISTS (SELECT 1 FROM sheet_characters c WHERE c.campaign_id=m.campaign_id AND c.owner_id=m.user_id) ORDER BY m.user_id");
    $st->execute([$cid]);
    return array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
}
function party_members(array $g): array {
    return array_values(array_map('intval', dec($g['members_json']) ?: []));
}
/** Campaign $cid's groups, main first, as rows. Makes the main group when there is none, puts any player with no sheet
 * who is in no group into it (players can join late) and drops from members_json anyone who is no longer a player with no
 * sheet (removed, deleted, made a GM, or now with a character, who stands for them). That is housekeeping, not a campaign change, so it doesn't touch the campaign, and it writes only when
 * something needs fixing. */
function party_rows(int $cid): array {
    $load = function () use ($cid) {
        $st = db()->prepare('SELECT * FROM party_groups WHERE campaign_id=? ORDER BY is_main DESC, id');
        $st->execute([$cid]);
        return $st->fetchAll();
    };
    $players = party_players($cid);
    $tidy = function (array $rows) use ($players) {   // [stale members somewhere, players in no group]
        $placed = [];
        $stale = false;
        foreach ($rows as $g) foreach (party_members($g) as $u) { $placed[$u] = true; if (!in_array($u, $players, true)) $stale = true; }
        return [$stale, array_values(array_filter($players, fn($u) => !isset($placed[$u])))];
    };
    $rows = $load();
    [$stale, $loose] = $tidy($rows);
    if ($rows && $rows[0]['is_main'] && !$loose && !$stale) return $rows;
    db()->beginTransaction();
    try {
        party_lock($cid);   // two readers at once make one main group
        $rows = $load();
        if (!$rows) {
            db()->prepare('INSERT INTO party_groups (campaign_id, name, members_json, region_id, is_main) VALUES (?,?,?,?,1)')
                ->execute([$cid, 'The party', json_encode($players), party_current_region($cid)]);
        } else {
            if (!$rows[0]['is_main']) db()->prepare('UPDATE party_groups SET is_main=1 WHERE id=?')->execute([$rows[0]['id']]);
            foreach ($rows as $i => $g) {
                $m = party_members($g);
                $keep = array_values(array_filter($m, fn($u) => in_array($u, $players, true)));
                $rows[$i]['members_json'] = json_encode($keep);
                if (count($keep) !== count($m)) db()->prepare('UPDATE party_groups SET members_json=? WHERE id=?')->execute([json_encode($keep), $g['id']]);
            }
            [, $loose] = $tidy($rows);
            if ($loose) db()->prepare('UPDATE party_groups SET members_json=? WHERE id=?')
                ->execute([json_encode([...party_members($rows[0]), ...$loose]), $rows[0]['id']]);
        }
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
    return $load();
}
/** Campaign $cid's party groups, main first, as the browser gets them. A player gets no position on a GM-only map and
 * no picture of a token that is GM only or sits on a GM-only entry. */
function party_groups(int $cid, bool $isGm = true): array {
    $rows = party_rows($cid);
    $ids = array_map(fn($g) => (int)$g['id'], $rows);
    $st = db()->prepare('SELECT g.id, m.is_secret AS map_secret, t.id AS tid, t.image_id AS timg, (t.is_secret OR COALESCE(te.is_secret, 0)) AS tsecret, ta.frame_x, ta.frame_y, ta.frame_zoom
        FROM party_groups g LEFT JOIN maps m ON m.id=g.map_id LEFT JOIN tokens t ON t.id=g.token_id LEFT JOIN encyclopedia_entries te ON te.id=t.entry_id
        LEFT JOIN attachments ta ON ta.id=t.image_id WHERE g.campaign_id=?');
    $st->execute([$cid]);
    $extra = [];
    foreach ($st->fetchAll() as $e) $extra[(int)$e['id']] = $e;
    $chars = party_characters($cid, $isGm);
    return array_map(function ($g) use ($cid, $isGm, $extra, $chars) {
        $e = $extra[(int)$g['id']] ?? [];
        $hideMap = !$isGm && !empty($e['map_secret']);
        $hideTok = !$isGm && !empty($e['tsecret']);
        $url = null;
        if (!$hideTok && ($e['timg'] ?? null) !== null)
            $url = pic_url($cid, (int)$e['timg'], $e);
        $num = fn($k) => $g[$k] !== null && !$hideMap ? (float)$g[$k] : null;
        return ['id' => (int)$g['id'], 'name' => $g['name'], 'members' => party_members($g), 'characters' => $chars[(int)$g['id']] ?? [],
            'region_id' => $g['region_id'] !== null ? (int)$g['region_id'] : null,
            'map_id' => $g['map_id'] !== null && !$hideMap ? (int)$g['map_id'] : null, 'x' => $num('x'), 'y' => $num('y'),
            'token_id' => $g['token_id'] !== null && !$hideTok ? (int)$g['token_id'] : null, 'token_url' => $url, 'is_main' => (bool)(int)$g['is_main'],
            'players_can_move' => (bool)(int)$g['players_can_move']];
    }, $rows);
}
/** The characters who travel with the party, as group id => [{id, name, kind, entry_id, player_id}]: players' characters
 * first, then those with no player, A to Z. player_id is the player who plays it, or null (no player, or a GM's). A player
 * isn't told of one whose entry is GM only, unless it is their own. */
function party_characters(int $cid, bool $isGm): array {
    $st = db()->prepare("SELECT c.id, c.kind, c.entry_id, c.party_group_id, e.name, IF(m.role='player', c.owner_id, NULL) AS player_id
        FROM sheet_characters c JOIN encyclopedia_entries e ON e.id=c.entry_id
        LEFT JOIN campaign_members m ON m.campaign_id=c.campaign_id AND m.user_id=c.owner_id
        WHERE c.campaign_id=? AND c.party_group_id IS NOT NULL" . ($isGm ? '' : ' AND (e.is_secret=0 OR c.owner_id=?)') . "
        ORDER BY m.role='player' DESC, e.name");
    $st->execute($isGm ? [$cid] : [$cid, me()['id']]);
    $out = [];
    foreach ($st->fetchAll() as $c)
        $out[(int)$c['party_group_id']][] = ['id' => (int)$c['id'], 'name' => $c['name'], 'kind' => $c['kind'], 'entry_id' => (int)$c['entry_id'],
            'player_id' => $c['player_id'] !== null ? (int)$c['player_id'] : null];
    return $out;
}
/** Character $id of campaign $cid as group_split and group_join need it: its group and the player who plays it (null:
 * no player). Fails as not found. */
function party_character(int $cid, $id): array {
    $st = db()->prepare("SELECT c.id, c.party_group_id, IF(m.role='player', c.owner_id, NULL) AS player_id FROM sheet_characters c
        LEFT JOIN campaign_members m ON m.campaign_id=c.campaign_id AND m.user_id=c.owner_id WHERE c.id=? AND c.campaign_id=?");
    $st->execute([int_in($id, 1), $cid]);
    $c = $st->fetch() ?: fail('Character not found', 404);
    return ['id' => (int)$c['id'], 'group' => $c['party_group_id'] !== null ? (int)$c['party_group_id'] : null,
        'player' => $c['player_id'] !== null ? (int)$c['player_id'] : null];
}
/** Group $id of campaign $cid as a row, or fail as not found. */
function group_row(int $cid, $id): array {
    party_rows($cid);
    return row_of('party_groups', $cid, int_in($id, 1), 'Group not found');
}
/** Make group $g the only main one, and the campaign's current region its region. */
function party_make_main(int $cid, int $id): void {
    db()->prepare('UPDATE party_groups SET is_main=(id=?) WHERE campaign_id=?')->execute([$id, $cid]);
    $st = db()->prepare('SELECT region_id FROM party_groups WHERE id=?');
    $st->execute([$id]);
    $r = $st->fetchColumn();
    party_set_current_region($cid, $r !== null && $r !== false ? (int)$r : null);
}
/** GM: split the players with no sheet (members) and the characters the request names off group from_id into a new
 * group. A player ($isGm false) splits off one of their own characters (or themselves, with no sheet), from a group that
 * lets players move, into a group of their own; it starts where they were. */
function group_split(int $cid, bool $isGm = true): void {
    $body = body();
    $g = group_row($cid, $body['from_id'] ?? null);   // 404s a group that isn't here, and tidies the groups first
    if (!$isGm) {
        $me = me()['id'];
        $m = $body['members'] ?? []; $c = $body['characters'] ?? [];
        $alone = $m === [$me] && !$c
            || !$m && is_array($c) && count($c) === 1 && party_character($cid, $c[0])['player'] === $me;
        if (!$alone) fail('You can start a group with just one of your own characters', 403);
        if (!(int)$g['players_can_move']) fail('The GM has kept that group together for now', 403);
        unset($body['region_id']);
    }
    $name = trim((string)str_in($body['name'] ?? null, 100));
    if ($name === '') fail('Give the group a name');
    $pick = $body['members'] ?? [];
    $chars = $body['characters'] ?? [];   // ids of characters in that group
    if (!is_array($pick) || !is_array($chars) || !$pick && !$chars) fail('Pick who goes from that group');
    $pick = array_values(array_unique(array_map(fn($u) => is_numeric($u) ? (int)$u : 0, $pick)));
    $chars = array_values(array_unique(array_map(fn($c) => is_numeric($c) ? (int)$c : 0, $chars)));
    if (array_diff($pick, party_players($cid))) fail('Pick who goes from that group');
    $newRegion = array_key_exists('region_id', $body) ? [party_region_in($body['region_id'], $cid)] : null;
    db()->beginTransaction();
    try {
        party_lock($cid);
        $from = party_reread($cid, $body['from_id']);   // as it is now, with the lock held
        $have = party_members($from);
        if (array_diff($pick, $have)) fail('Pick who goes from that group');
        $st = db()->prepare('SELECT id FROM sheet_characters WHERE campaign_id=? AND party_group_id=?');
        $st->execute([$cid, $from['id']]);
        if (array_diff($chars, array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN)))) fail('Pick who goes from that group');
        $region = $newRegion ? $newRegion[0] : ($from['region_id'] !== null ? (int)$from['region_id'] : null);
        db()->prepare('UPDATE party_groups SET members_json=? WHERE id=?')->execute([json_encode(array_values(array_diff($have, $pick))), $from['id']]);
        db()->prepare('INSERT INTO party_groups (campaign_id, name, members_json, region_id, map_id, x, y, is_main) VALUES (?,?,?,?,?,?,?,0)')
            ->execute([$cid, $name, json_encode($pick), $region, $from['map_id'], $from['x'], $from['y']]);   // they start where the group was
        if ($chars) db()->prepare('UPDATE sheet_characters SET party_group_id=? WHERE campaign_id=? AND id IN (' . implode(',', $chars) . ')')
            ->execute([(int)db()->lastInsertId(), $cid]);
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
    touch_campaign($cid);
}
/** GM: change the fields of group id that the request names. */
function group_save(int $cid): void {
    $body = body();
    $has = fn($k) => array_key_exists($k, $body);
    $g = group_row($cid, $body['id'] ?? null);
    $name = $g['name'];
    if ($has('name')) {
        $name = trim((string)str_in($body['name'], 100));
        if ($name === '') fail('Give the group a name');
    }
    $region = $g['region_id'] !== null ? (int)$g['region_id'] : null;
    if ($has('region_id')) $region = party_region_in($body['region_id'], $cid);
    $token = $g['token_id'] !== null ? (int)$g['token_id'] : null;
    if ($has('token_id')) {
        if ($body['token_id'] === null || $body['token_id'] === '') $token = null;
        else {
            $st = db()->prepare('SELECT id FROM tokens WHERE id=? AND campaign_id=?');
            $st->execute([int_in($body['token_id'], 1), $cid]);
            if (!$st->fetchColumn()) fail('That token isn\'t one of this campaign\'s', 400);
            $token = (int)$body['token_id'];
        }
    }
    if ($has('is_main') && !$body['is_main'] && $g['is_main']) fail('Make another group the main one instead');
    $moves = $has('players_can_move') ? (int)(bool)$body['players_can_move'] : (int)$g['players_can_move'];
    db()->beginTransaction();
    try {
        db()->prepare('UPDATE party_groups SET name=?, region_id=?, token_id=?, players_can_move=? WHERE id=?')->execute([$name, $region, $token, $moves, $g['id']]);
        if (!empty($body['is_main']) && !$g['is_main']) party_make_main($cid, (int)$g['id']);
        elseif ($g['is_main'] && $has('region_id')) party_set_current_region($cid, $region);
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
    touch_campaign($cid);
}
/** GM: put group id on a map at x, y, or (map_id null) off the maps. */
function group_move(int $cid): void {
    $body = body();
    $g = group_row($cid, $body['id'] ?? null);
    if (($body['map_id'] ?? null) === null || $body['map_id'] === '') {
        db()->prepare('UPDATE party_groups SET map_id=NULL, x=NULL, y=NULL WHERE id=?')->execute([$g['id']]);
    } else {
        $map = map_row($cid, int_in($body['map_id'], 1), true);
        if ($map['width'] === null || $map['height'] === null) fail('Give the map a picture before putting the party on it');
        $same = $g['map_id'] !== null && (int)$g['map_id'] === (int)$map['id'];
        $x = map_coord(array_key_exists('x', $body) ? $body['x'] : ($same ? $g['x'] : $map['width'] / 2), $map['width']);   // no x or y: where it was, else the middle
        $y = map_coord(array_key_exists('y', $body) ? $body['y'] : ($same ? $g['y'] : $map['height'] / 2), $map['height']);
        db()->prepare('UPDATE party_groups SET map_id=?, x=?, y=? WHERE id=?')->execute([$map['id'], $x, $y, $g['id']]);
        // stops: where a journey had the group on the shifts it passed on the way (Travel's Depart), before this point
        $stops = $body['stops'] ?? [];
        if (!is_array($stops) || count($stops) > 400) fail('Send at most 400 stops');
        $now = (int)campaign_row($cid)['current_shift'];
        $prev = PHP_INT_MIN;
        foreach ($stops as $p) {
            $at = int_in($p['abs_shift'] ?? null);
            if ($at <= $prev || $at >= $now) fail('Stops go in time order, before the clock');
            trail_add($cid, (int)$g['id'], (int)$map['id'], map_coord($p['x'] ?? null, $map['width']), map_coord($p['y'] ?? null, $map['height']), $at);
            $prev = $at;
        }
        trail_add($cid, (int)$g['id'], (int)$map['id'], $x, $y);
    }
    touch_campaign($cid);
}

// ---------- the party's trail ----------
// Where each group was put on a map, and on which shift (party_trail). A move in the same shift as the group's last
// point on that map replaces it, so a drag to tidy up where the party stands leaves one point, not a scribble; a
// move in a later shift adds a point. The map draws them in order as the group's trail.

/** Add group $gid's new place on map $mapId to its trail, at the campaign's current shift. */
function trail_add(int $cid, int $gid, int $mapId, float $x, float $y, ?int $at = null): void {
    $now = $at ?? (int)campaign_row($cid)['current_shift'];
    $st = db()->prepare('SELECT id, map_id, abs_shift FROM party_trail WHERE group_id=? ORDER BY id DESC LIMIT 1');
    $st->execute([$gid]);
    $last = $st->fetch();
    if ($last && (int)$last['map_id'] === $mapId && (int)$last['abs_shift'] === $now)
        db()->prepare('UPDATE party_trail SET x=?, y=? WHERE id=?')->execute([$x, $y, $last['id']]);
    else db()->prepare('INSERT INTO party_trail (campaign_id, group_id, map_id, x, y, abs_shift) VALUES (?,?,?,?,?,?)')
        ->execute([$cid, $gid, $mapId, $x, $y, $now]);
}
/** The trail points on map $mapId, oldest first, of the groups in $groupIds (the ones this user may see there). */
function trail_on_map(int $mapId, array $groupIds): array {
    if (!$groupIds) return [];
    $st = db()->prepare('SELECT group_id, x, y, abs_shift FROM party_trail WHERE map_id=? AND group_id IN (' . implode(',', array_map('intval', $groupIds)) . ') ORDER BY group_id, id');
    $st->execute([$mapId]);
    return array_map(fn($r) => ['group_id' => (int)$r['group_id'], 'x' => (float)$r['x'], 'y' => (float)$r['y'], 'abs_shift' => (int)$r['abs_shift']], $st->fetchAll());
}
/** GM: forget group id's trail on map map_id (every group's when id is left out). */
function trail_clear(int $cid): void {
    $body = body();
    $map = map_row($cid, int_in($body['map_id'] ?? null, 1), true);
    if (($body['id'] ?? null) !== null) {
        $g = group_row($cid, $body['id']);
        db()->prepare('DELETE FROM party_trail WHERE map_id=? AND group_id=?')->execute([$map['id'], $g['id']]);
    } else db()->prepare('DELETE FROM party_trail WHERE map_id=?')->execute([$map['id']]);
    touch_campaign($cid);
}
/** GM: fold group id into into_id. Merging the main group makes into_id the main one. */
function group_merge(int $cid): void {
    $body = body();
    $g = group_row($cid, $body['id'] ?? null);
    $into = group_row($cid, $body['into_id'] ?? null);
    if ($g['id'] === $into['id']) fail('Pick a different group to merge into');
    db()->beginTransaction();
    try {
        party_lock($cid);
        $g = party_reread($cid, $g['id']);
        $into = party_reread($cid, $into['id']);
        db()->prepare('UPDATE party_groups SET members_json=? WHERE id=?')
            ->execute([json_encode(array_values(array_unique([...party_members($into), ...party_members($g)]))), $into['id']]);
        db()->prepare('UPDATE sheet_characters SET party_group_id=? WHERE party_group_id=?')->execute([$into['id'], $g['id']]);
        db()->prepare('DELETE FROM party_groups WHERE id=?')->execute([$g['id']]);
        if ($g['is_main']) party_make_main($cid, (int)$into['id']);
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
    touch_campaign($cid);
}

/** Move one character (character: its id), or one player with no sheet (member: a user id), into group id, out of
 * whichever group they were in. A GM can also bring in a character who isn't travelling and, with id null, take one out
 * of the party. A player ($isGm false) moves only their own characters (or themselves, with no sheet), and only out of
 * and into groups that let players move. */
function group_join(int $cid, bool $isGm = true): void {
    $body = body();
    $out = array_key_exists('id', $body) && $body['id'] === null;
    if ($out && !$isGm) fail('Only a GM can take someone out of the party', 403);
    $to = $out ? null : group_row($cid, $body['id'] ?? null);
    $user = $body['member'] ?? null;
    $char = $body['character'] ?? null;
    if (($user === null) === ($char === null)) fail('Name one player or one character to move');
    $me = me()['id'];
    $sheet = null;
    if ($char !== null) {
        $sheet = party_character($cid, $char);
        if (!$isGm && $sheet['player'] !== $me) fail('You can only move your own characters', 403);
        if (!$isGm && $sheet['group'] === null) fail('That character is out of the party for now: ask the GM to bring them back', 403);
    } else {
        $user = int_in($user, 1);
        if (!$isGm && $user !== $me) fail('You can only move your own characters', 403);
        if (member_role($cid, $user) !== 'player') fail('That player isn\'t in this campaign');
        if (!in_array($user, party_players($cid), true)) fail('That player has a character sheet: move their character instead');
        if ($out) fail('They have no character sheet to take out of the party');
    }
    db()->beginTransaction();
    try {
        party_lock($cid);
        if ($to) $to = party_reread($cid, $to['id']);
        $st = db()->prepare('SELECT * FROM party_groups WHERE campaign_id=?');
        $st->execute([$cid]);
        $rows = $st->fetchAll();
        // a player leaves a group and joins one only where the GM lets players move
        $from = null;
        if ($sheet) {
            $st = db()->prepare('SELECT party_group_id FROM sheet_characters WHERE id=?');
            $st->execute([$sheet['id']]);
            $now = $st->fetchColumn();
            foreach ($rows as $g) if ($now !== null && (int)$g['id'] === (int)$now) $from = $g;
        } else foreach ($rows as $g) if (in_array($user, party_members($g), true)) $from = $g;
        $same = $from && $to && (int)$from['id'] === (int)$to['id'];
        if (!$isGm && !$same && ($from && !(int)$from['players_can_move'] || $to && !(int)$to['players_can_move']))
            fail('The GM has kept that group together for now', 403);
        if ($sheet) {
            db()->prepare('UPDATE sheet_characters SET party_group_id=? WHERE id=?')->execute([$to ? $to['id'] : null, $sheet['id']]);
        } else foreach ($rows as $g) {
            $m = party_members($g);
            $keep = array_values(array_filter($m, fn($u) => $u !== $user));
            if ($to && (int)$g['id'] === (int)$to['id']) $keep[] = $user;
            if ($keep !== $m) db()->prepare('UPDATE party_groups SET members_json=? WHERE id=?')->execute([json_encode($keep), $g['id']]);
        }
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
    touch_campaign($cid);
}

// ---------- tokens ----------
// A token is a picture on a round marker: a party group's, a character's, an entry's, or a creature's. GMs keep the
// library; a player is only sent the picture of a token that is assigned to a character or an entry they can see.

const TOKEN_KINDS = ['party', 'character', 'creature', 'object'];

/** Whether a player may not see token row $t (from token_row): it is GM only, or it sits on a GM-only entry. */
function token_hidden(array $t): bool {
    return (bool)(int)$t['is_secret'] || (bool)(int)($t['entry_secret'] ?? 0);
}
const TOKEN_SELECT = 'SELECT t.*, e.is_secret AS entry_secret, (SELECT GROUP_CONCAT(g.id ORDER BY g.id) FROM party_groups g WHERE g.token_id=t.id) AS group_ids,
    a.credit_title, a.credit_author, a.credit_author_url, a.credit_license, a.credit_license_url, a.credit_source, a.credit_source_url,
    a.frame_x, a.frame_y, a.frame_zoom
    FROM tokens t LEFT JOIN encyclopedia_entries e ON e.id=t.entry_id LEFT JOIN attachments a ON a.id=t.image_id WHERE t.campaign_id=?';
/** A token of campaign $cid, or fail as not found. */
function token_row(int $cid, int $id): array {
    $st = db()->prepare(TOKEN_SELECT . ' AND t.id=?');
    $st->execute([$cid, $id]);
    $t = $st->fetch();
    if (!$t) fail('Token not found', 404);
    return $t;
}
/** A token as the browser gets it; image_url is the picture's address, null until it has one (or when a player may not see it),
 * and credit where the picture came from (Find Image, a game icon), null for one uploaded by hand. */
function token_out(array $t, bool $isGm): array {
    $url = null;
    if ($t['image_id'] !== null && ($isGm || !token_hidden($t)))
        $url = pic_url((int)$t['campaign_id'], (int)$t['image_id'], $t);
    return ['id' => (int)$t['id'], 'name' => $t['name'], 'kind' => $t['kind'], 'size_squares' => (int)$t['size_squares'],
        'member_id' => $t['member_id'] !== null ? (int)$t['member_id'] : null, 'entry_id' => $t['entry_id'] !== null ? (int)$t['entry_id'] : null,
        'is_secret' => (bool)(int)$t['is_secret'], 'image_url' => $url, 'credit' => $url !== null ? attachment_credit($t) : null,
        'groups' => $t['group_ids'] !== null ? array_map('intval', explode(',', $t['group_ids'])) : []];
}
/** Every token of campaign $cid, by name. */
function tokens_list(int $cid): array {
    $st = db()->prepare(TOKEN_SELECT . ' ORDER BY t.name, t.id');
    $st->execute([$cid]);
    return array_map(fn($t) => token_out($t, true), $st->fetchAll());
}
/** The picture addresses of the tokens this member may see, as ['member' => user id => url, 'entry' => entry id => url].
 * An entry with no token shows its portrait instead (the picture picked on its character's sheet, else its first
 * picture, as the Encyclopedia shows it), so an entry's face is the same wherever it is drawn; a player gets none for a
 * GM-only entry or picture. */
function token_urls(int $cid, bool $isGm): array {
    $out = ['member' => [], 'entry' => []];
    $st = db()->prepare('SELECT t.member_id, t.entry_id, t.image_id, a.frame_x, a.frame_y, a.frame_zoom FROM tokens t LEFT JOIN encyclopedia_entries e ON e.id=t.entry_id
        LEFT JOIN attachments a ON a.id=t.image_id WHERE t.campaign_id=? AND t.image_id IS NOT NULL AND (t.member_id IS NOT NULL OR t.entry_id IS NOT NULL)'
        . ($isGm ? '' : ' AND t.is_secret=0 AND (e.id IS NULL OR e.is_secret=0)') . ' ORDER BY t.id ASC');   // the first-assigned (lowest id) token wins a member or entry
    $st->execute([$cid]);
    foreach ($st->fetchAll() as $r) {
        $url = pic_url($cid, (int)$r['image_id'], $r);
        if ($r['member_id'] !== null) $out['member'][(int)$r['member_id']] ??= $url;
        if ($r['entry_id'] !== null) $out['entry'][(int)$r['entry_id']] ??= $url;
    }
    $st = db()->prepare('SELECT c.entry_id, c.portrait_id, pa.frame_x, pa.frame_y, pa.frame_zoom FROM sheet_characters c JOIN encyclopedia_entries e ON e.id=c.entry_id
        JOIN attachments pa ON pa.id=c.portrait_id AND pa.campaign_id=c.campaign_id AND pa.parent_type=\'encyclopedia\' AND pa.parent_id=c.entry_id
        WHERE c.campaign_id=?' . ($isGm ? '' : ' AND e.is_secret=0 AND pa.is_secret=0'));
    $st->execute([$cid]);
    foreach ($st->fetchAll() as $r)
        $out['entry'][(int)$r['entry_id']] ??= pic_url($cid, (int)$r['portrait_id'], $r);
    $st = db()->prepare('SELECT p.parent_id, p.id, p.frame_x, p.frame_y, p.frame_zoom FROM attachments p JOIN (SELECT MIN(a.id) AS id FROM attachments a
        JOIN encyclopedia_entries e ON e.id=a.parent_id AND e.campaign_id=a.campaign_id
        WHERE a.campaign_id=? AND a.parent_type=\'encyclopedia\' AND (a.kind=\'image\' OR (a.kind=\'embed\' AND a.embed_src IS NOT NULL))'
        . ($isGm ? '' : ' AND a.is_secret=0 AND e.is_secret=0') . ' GROUP BY a.parent_id) f ON f.id=p.id');
    $st->execute([$cid]);
    foreach ($st->fetchAll() as $r)
        $out['entry'][(int)$r['parent_id']] ??= pic_url($cid, (int)$r['id'], $r);
    return $out;
}
/** A token's name from its file's: no extension, _ and - as spaces, a capital first letter ("pip-the-bold.png": "Pip the bold"). */
/** The credit for a token picture drawn from a game-icons.net icon ("artist/name", from static/vendor/game-icons/index.json):
 * the icon, its artist and licence, as attachments columns. An icon that isn't in the set is refused. */
function game_icon_credit(string $icon): array {
    if (!preg_match('~^([a-z0-9-]{1,40})/([a-z0-9-]{1,80})$~', $icon, $m)) fail('That isn\'t one of the game icons', 400, 'bad_icon');
    $index = json_decode((string)@file_get_contents(__DIR__ . '/../static/vendor/game-icons/index.json'), true);
    $artist = $index['artists'][$m[1]] ?? null;
    if (!$artist || !in_array($icon, $index['icons'] ?? [], true)) fail('That isn\'t one of the game icons', 400, 'bad_icon');
    $cc0 = $artist['licence'] === 'CC0';
    return ['credit_title' => ucfirst(str_replace('-', ' ', $m[2])), 'credit_author' => $artist['name'], 'credit_author_url' => $artist['url'],
        'credit_license' => $cc0 ? 'CC0 1.0' : 'CC BY 3.0',
        'credit_license_url' => $cc0 ? 'https://creativecommons.org/publicdomain/zero/1.0/' : 'https://creativecommons.org/licenses/by/3.0/',
        'credit_source' => 'game-icons.net', 'credit_source_url' => "https://game-icons.net/1x1/{$m[1]}/{$m[2]}.html"];
}
function token_name_from_file(string $file): string {
    $base = pathinfo($file, PATHINFO_FILENAME);
    $base = trim(preg_replace('/[\s_-]+/u', ' ', $base) ?? '');
    if ($base === '') return 'Token';
    return mb_strtoupper(mb_substr($base, 0, 1)) . mb_substr($base, 1, 99);
}
/** Add a token (GM) from one uploaded picture, in one go. Returns the token as the browser gets it. */
function token_upload(int $cid): array {
    [$f, $size] = upload_received();
    $file = upload_name((string)($f['name'] ?? ''));
    [$mime, $kind, $w, $h] = upload_type($f['tmp_name'], $file);
    if ($kind !== 'image') fail('A token needs a picture: JPEG, PNG, GIF or WebP', 415, 'unsupported_type');
    $name = trim((string)($_POST['name'] ?? '')) !== '' ? trim((string)str_in($_POST['name'], 100)) : token_name_from_file($file);
    $tkind = (string)($_POST['kind'] ?? '') !== '' ? (string)$_POST['kind'] : 'creature';
    if (!in_array($tkind, TOKEN_KINDS, true)) fail('Pick party, character, creature or object');
    $credit = (string)($_POST['icon'] ?? '') !== '' ? game_icon_credit((string)$_POST['icon']) : [];
    attachment_room($cid, 'token', 0, $size);   // the campaign's and the account's room; the token itself starts with no files
    db()->beginTransaction();
    try {
        db()->prepare('INSERT INTO tokens (campaign_id, name, kind, created_by) VALUES (?,?,?,?)')->execute([$cid, mb_substr($name, 0, 100), $tkind, me()['id']]);
        $id = (int)db()->lastInsertId();
        $pic = attachment_store($cid, $f['tmp_name'], ['parent_type' => 'token', 'parent_id' => $id, 'original_name' => $file, 'mime' => $mime,
            'kind' => 'image', 'size_bytes' => $size, 'width' => $w, 'height' => $h, 'is_secret' => 0] + $credit, true);
        db()->prepare('UPDATE tokens SET image_id=? WHERE id=?')->execute([$pic['id'], $id]);
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
    touch_campaign($cid);
    return token_out(token_row($cid, $id), true);
}
/** Add a token (GM), or change the fields of token $id that the request names. group_ids: the party groups that use it
 * (the others that did let go). Returns the token as the browser gets it. */
function token_save(int $cid): array {
    $body = body();
    $has = fn($k) => array_key_exists($k, $body);
    $old = isset($body['id']) ? token_row($cid, int_in($body['id'], 1)) : null;
    $t = $old ?? ['id' => null, 'name' => '', 'image_id' => null, 'kind' => 'creature', 'size_squares' => 1, 'member_id' => null, 'entry_id' => null, 'is_secret' => 0];
    if ($has('name') || !$old) {
        $t['name'] = trim((string)str_in($body['name'] ?? null, 100));
        if ($t['name'] === '') fail('Give the token a name');
    }
    if ($has('kind')) {
        if (!in_array($body['kind'], TOKEN_KINDS, true)) fail('Pick party, character, creature or object');
        $t['kind'] = $body['kind'];
    }
    if ($has('size_squares')) {
        if (!is_numeric($body['size_squares']) || (float)$body['size_squares'] != (int)$body['size_squares']) fail('The size must be a whole number of squares');
        $t['size_squares'] = int_in($body['size_squares'], 1, 4);
    }
    if ($has('is_secret')) $t['is_secret'] = !empty($body['is_secret']) ? 1 : 0;
    if ($has('member_id')) {
        if ($body['member_id'] === null || $body['member_id'] === '') $t['member_id'] = null;
        else {
            $st = db()->prepare('SELECT 1 FROM campaign_members WHERE campaign_id=? AND user_id=?');
            $st->execute([$cid, int_in($body['member_id'], 1)]);
            if (!$st->fetchColumn()) fail('That person isn\'t in this campaign', 400);
            $t['member_id'] = (int)$body['member_id'];
        }
    }
    if ($has('entry_id')) {
        if ($body['entry_id'] === null || $body['entry_id'] === '') $t['entry_id'] = null;
        else {
            $st = db()->prepare('SELECT 1 FROM encyclopedia_entries WHERE id=? AND campaign_id=?');
            $st->execute([int_in($body['entry_id'], 1), $cid]);
            if (!$st->fetchColumn()) fail('That entry isn\'t one of this campaign\'s', 400);
            $t['entry_id'] = (int)$body['entry_id'];
        }
    }
    if ($has('image_id')) {
        if ($body['image_id'] === null || $body['image_id'] === '') $t['image_id'] = null;
        else {
            if (!$old) fail('Save the token first, then add its picture');
            $st = db()->prepare("SELECT id FROM attachments WHERE id=? AND campaign_id=? AND parent_type='token' AND parent_id=? AND kind='image' AND is_secret=0");
            $st->execute([int_in($body['image_id'], 1), $cid, $old['id']]);
            if (!$st->fetchColumn()) fail("That picture isn't one of this token's pictures", 400);
            $t['image_id'] = (int)$body['image_id'];
        }
    }
    $groups = null;
    if ($has('group_ids')) {
        if (!is_array($body['group_ids'])) fail('Expected a list of groups');
        party_rows($cid);
        $groups = array_values(array_unique(array_map(fn($g) => int_in($g, 1), $body['group_ids'])));
        if ($groups) {
            $st = db()->prepare('SELECT COUNT(*) FROM party_groups WHERE campaign_id=? AND id IN (' . implode(',', array_fill(0, count($groups), '?')) . ')');
            $st->execute([$cid, ...$groups]);
            if ((int)$st->fetchColumn() !== count($groups)) fail('That group isn\'t one of this campaign\'s', 400);
        }
    }
    db()->beginTransaction();
    try {
        if ($t['member_id'] !== null)   // a character has one token: the old one lets go
            db()->prepare('UPDATE tokens SET member_id=NULL WHERE campaign_id=? AND member_id=? AND id<>?')->execute([$cid, $t['member_id'], $old['id'] ?? 0]);
        $cols = [$t['name'], $t['image_id'], $t['kind'], $t['size_squares'], $t['member_id'], $t['entry_id'], $t['is_secret']];
        if ($old) {
            db()->prepare('UPDATE tokens SET name=?, image_id=?, kind=?, size_squares=?, member_id=?, entry_id=?, is_secret=? WHERE id=?')->execute([...$cols, $old['id']]);
            $id = (int)$old['id'];
        } else {
            db()->prepare('INSERT INTO tokens (name, image_id, kind, size_squares, member_id, entry_id, is_secret, campaign_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
                ->execute([...$cols, $cid, me()['id']]);
            $id = (int)db()->lastInsertId();
        }
        if ($groups !== null) {
            db()->prepare('UPDATE party_groups SET token_id=NULL WHERE campaign_id=? AND token_id=?')->execute([$cid, $id]);
            if ($groups) db()->prepare('UPDATE party_groups SET token_id=? WHERE campaign_id=? AND id IN (' . implode(',', array_fill(0, count($groups), '?')) . ')')->execute([$id, $cid, ...$groups]);
        }
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        throw $e;
    }
    if ($old && $old['image_id'] !== null && (int)$old['image_id'] !== $t['image_id']) attachment_remove($cid, (int)$old['image_id']);   // the old picture is no longer wanted
    touch_campaign($cid);
    return token_out(token_row($cid, $id), true);
}
