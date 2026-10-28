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
/** This campaign's maps (a player's without the GM-only ones), oldest first, each with how many pins it has. */
function maps_list(int $cid, bool $isGm): array {
    $st = db()->prepare('SELECT m.*, (SELECT COUNT(*) FROM map_pins p WHERE p.map_id=m.id' . ($isGm ? '' : ' AND p.is_secret=0') . ') AS pins
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
