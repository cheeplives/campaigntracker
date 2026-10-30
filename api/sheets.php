<?php
/**
 * Character sheets (see docs/superpowers/specs/2026-10-29-character-sheets-design.md).
 *
 * Sheet templates are site-wide: anyone can use or fork one, only its author or a site admin changes it. A character
 * is one filled-in copy of a template in a campaign, with its own Encyclopedia entry (which holds its name), marked PC
 * or NPC. Values save one field at a time (character_field); the sheet's settings save with a version check. Fields
 * and sections the owner hides, and an NPC sheet not shown to players, never leave the server for other members.
 */
declare(strict_types=1);

function has_sheets(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW COLUMNS FROM campaign_members LIKE 'active_character_id'")->fetchColumn();
}
function need_sheets(): void {
    if (!has_sheets()) fail('Character sheets need a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}

// ---------- Layouts: the same rules as static/sheetlayout.js, which only gives the editor its messages ----------

const SHEET_TYPES = ['text', 'longtext', 'number', 'counter', 'pips', 'checkbox', 'choice', 'list'];
const SHEET_LIMITS = ['sections' => 50, 'fields' => 1000, 'label' => 100, 'option' => 60, 'options' => 50, 'columns' => 10,
    'pips' => 30, 'rows' => 200, 'text' => 500, 'longtext' => 20000];
const SHEET_KEY = '/^[a-z][a-z0-9_]{0,39}$/';
// A field's optional mapping to a VTT's character data, for importing and syncing later: VTT name => {system, path}.
const SHEET_VTT_NAME = '/^[a-z][a-z0-9_]{0,19}$/';
const SHEET_VTT_SYSTEM = '/^[A-Za-z0-9_.-]{1,60}$/';
const SHEET_VTT_PATH = '/^[A-Za-z0-9_.\[\]-]{1,200}$/';
const SHEET_VTT_MAX = 8;

/** A layout as sent, checked and with only the properties it may have; fails with the first problem. */
function sheet_layout_in($layout): array {
    $L = SHEET_LIMITS;
    if (!is_array($layout) || !isset($layout['sections']) || !is_array($layout['sections']) || !array_is_list($layout['sections']))
        fail('A template needs a list of sections');
    if (count($layout['sections']) > $L['sections']) fail("A template can have {$L['sections']} sections at most");
    $keys = [];
    $key = function ($k, string $what) use (&$keys): string {
        if (!is_string($k) || !preg_match(SHEET_KEY, $k)) fail("$what has a key that isn't lower-case letters, digits and _ (starting with a letter, 40 at most)");
        if (isset($keys[$k])) fail("The key \"$k\" is used twice");
        $keys[$k] = true;
        return $k;
    };
    $label = function ($s, string $what) use ($L): string {
        if (!is_string($s) || trim($s) === '' || mb_strlen($s) > $L['label']) fail("$what are 1 to {$L['label']} characters");
        return $s;
    };
    $out = [];
    $n = 0;
    foreach ($layout['sections'] as $s) {
        if (!is_array($s) || !isset($s['fields']) || !is_array($s['fields']) || !array_is_list($s['fields'])) fail('Each section needs a list of fields');
        $sec = ['key' => $key($s['key'] ?? null, 'A section'), 'title' => $label($s['title'] ?? null, 'Section titles'), 'fields' => []];
        foreach ($s['fields'] as $f) {
            if (++$n > $L['fields']) fail("A template can have {$L['fields']} fields at most");
            if (!is_array($f)) fail('A field is not a field');
            $name = 'Field "' . (is_string($f['label'] ?? null) ? $f['label'] : '?') . '"';
            $field = ['key' => $key($f['key'] ?? null, $name), 'label' => $label($f['label'] ?? null, 'Field labels')];
            $type = $f['type'] ?? null;
            if (!in_array($type, SHEET_TYPES, true)) fail("$name has a type this app doesn't know: " . json_encode($type));
            $field['type'] = $type;
            foreach (['play', 'summary'] as $b) if (!empty($f[$b])) $field[$b] = true;
            foreach (['min', 'max'] as $b) if (isset($f[$b])) {
                if (!is_int($f[$b]) && !is_float($f[$b])) fail("$name: $b must be a number");
                $field[$b] = $f[$b];
            }
            if ($type === 'pips') {
                if (!is_int($f['count'] ?? null) || $f['count'] < 1 || $f['count'] > $L['pips']) fail("$name needs 1 to {$L['pips']} pips");
                $field['count'] = $f['count'];
            }
            if ($type === 'choice') {
                $o = $f['options'] ?? null;
                if (!is_array($o) || !array_is_list($o) || !$o || count($o) > $L['options']) fail("$name needs 1 to {$L['options']} options");
                foreach ($o as $x) if (!is_string($x) || trim($x) === '' || mb_strlen($x) > $L['option']) fail("$name: options are 1 to {$L['option']} characters");
                $field['options'] = $o;
            }
            if ($type === 'list') {
                $c = $f['columns'] ?? null;
                if (!is_array($c) || !array_is_list($c) || !$c || count($c) > $L['columns']) fail("$name needs 1 to {$L['columns']} columns");
                $ck = [];
                foreach ($c as $col) {
                    if (!is_array($col) || !is_string($col['key'] ?? null) || !preg_match(SHEET_KEY, $col['key']) || isset($ck[$col['key']]))
                        fail("$name has a column without a proper key");
                    $ck[$col['key']] = true;
                    $field['columns'][] = ['key' => $col['key'], 'label' => $label($col['label'] ?? null, 'Column labels')];
                }
            }
            if (isset($f['size'])) {
                if (!in_array($f['size'], ['small', 'medium', 'large'], true)) fail("$name: a box size is small, medium or large");
                if ($f['size'] !== 'medium') $field['size'] = $f['size'];   // medium is the usual size, so it isn't kept
            }
            if (isset($f['vtt'])) {
                $v = $f['vtt'];
                if (!is_array($v) || array_is_list($v) || count($v) > SHEET_VTT_MAX) fail("$name: a VTT mapping names each VTT (" . SHEET_VTT_MAX . ' at most) with its system and path');
                foreach ($v as $vtt => $m) {
                    if (!preg_match(SHEET_VTT_NAME, (string)$vtt) || !is_array($m) || !is_string($m['system'] ?? null) || !is_string($m['path'] ?? null)
                        || !preg_match(SHEET_VTT_SYSTEM, $m['system']) || !preg_match(SHEET_VTT_PATH, $m['path']))
                        fail("$name: each VTT mapping needs a lower-case VTT name, a system and a data path (letters, digits, _ . - [ ])");
                    $field['vtt'][(string)$vtt] = ['system' => $m['system'], 'path' => $m['path']];
                }
            }
            $sec['fields'][] = $field;
        }
        $out[] = $sec;
    }
    $layout = ['sections' => $out];
    if (strlen(json_encode($layout, JSON_UNESCAPED_UNICODE)) > 1_000_000) fail('That template is too large', 413);
    return $layout;
}

// ---------- Templates ----------

/** Templates with their author, use and fork counts and the template each was forked from; $where is SQL on t. */
function templates_query(string $where, array $args): array {
    $st = db()->prepare("SELECT t.id, t.name, t.game, t.edition, t.author_id, t.forked_from_id, t.version, t.is_listed, t.starter_key, t.updated_at,
            u.display_name AS author, o.name AS forked_from_name,
            (SELECT COUNT(*) FROM sheet_characters c WHERE c.template_id=t.id) AS uses,
            (SELECT COUNT(*) FROM sheet_templates f WHERE f.forked_from_id=t.id) AS forks
        FROM sheet_templates t LEFT JOIN users u ON u.id=t.author_id LEFT JOIN sheet_templates o ON o.id=t.forked_from_id
        WHERE $where ORDER BY uses DESC, t.name");
    $st->execute($args);
    return array_map('template_out', $st->fetchAll());
}
function template_out(array $t): array {
    $me = me();
    $mine = $t['author_id'] !== null && (int)$t['author_id'] === $me['id'];
    return ['id' => (int)$t['id'], 'name' => $t['name'], 'game' => $t['game'], 'edition' => $t['edition'],
        'author' => $t['author_id'] === null ? ($t['starter_key'] !== null ? 'Campaign Chronicle' : 'Someone') : (string)$t['author'],
        'mine' => $mine, 'can_edit' => $mine || $me['is_admin'], 'is_listed' => (bool)$t['is_listed'], 'version' => (int)$t['version'],
        'uses' => (int)$t['uses'], 'forks' => (int)$t['forks'],
        'forked_from' => $t['forked_from_id'] !== null ? ['id' => (int)$t['forked_from_id'], 'name' => $t['forked_from_name']] : null,
        'starter' => $t['starter_key'] !== null, 'updated_at' => $t['updated_at']];
}
/** One template's row, with its layout decoded; 404 when there is none. */
function template_row(int $id): array {
    $st = db()->prepare('SELECT * FROM sheet_templates WHERE id=?');
    $st->execute([$id]);
    $t = $st->fetch() ?: fail('Template not found', 404);
    $t['layout'] = json_decode($t['layout'], true);
    return $t;
}
function template_full(int $id): array {
    return (templates_query('t.id=?', [$id])[0] ?? fail('Template not found', 404)) + ['layout' => template_row($id)['layout']];
}
function need_template_editor(array $t): void {
    $me = me();
    if (!$me['is_admin'] && ($t['author_id'] === null || (int)$t['author_id'] !== $me['id']))
        fail('Only its author can change this template. Fork it to make your own', 403);
}

/** The template actions; none belongs to a campaign. */
function templates_action(string $action): void {
    need_sheets();
    $me = me();
    switch ($action) {
        case 'templates':
            $q = trim((string)str_in($_GET['q'] ?? null, 100));
            $where = '(t.is_listed=1 OR t.author_id=?)';
            $args = [$me['id']];
            if ($q !== '') {
                $where .= ' AND (t.name LIKE ? OR t.game LIKE ? OR t.edition LIKE ?)';
                $like = '%' . addcslashes($q, '%_\\') . '%';
                array_push($args, $like, $like, $like);
            }
            out(['templates' => templates_query($where, $args)]);
        case 'template':
            $id = int_in($_GET['id'] ?? null, 1);
            out(['template' => template_full($id), 'forks' => templates_query('t.forked_from_id=? AND (t.is_listed=1 OR t.author_id=?)', [$id, $me['id']])]);
        case 'template_save':
            $name = trim(preg_replace('/\s+/u', ' ', (string)str_in(p('name'), 150, false)));
            $game = trim(preg_replace('/\s+/u', ' ', (string)str_in(p('game'), 100, false)));
            if ($name === '') fail('Give the template a name');
            if ($game === '') fail('Say which game it is for');
            $edition = trim((string)str_in(p('edition'), 60));
            $layout = json_encode(sheet_layout_in(p('layout')), JSON_UNESCAPED_UNICODE);
            $id = p('id') ? int_in(p('id'), 1) : null;
            if ($id) {
                $t = template_row($id);
                need_template_editor($t);
                $listed = p('is_listed') === null ? (int)$t['is_listed'] : (p('is_listed') ? 1 : 0);
                $st = db()->prepare('UPDATE sheet_templates SET name=?, game=?, edition=?, layout=?, is_listed=?, version=version+1 WHERE id=? AND version=?');
                $st->execute([$name, $game, $edition, $layout, $listed, $id, int_in(p('version'), 1)]);
                if (!$st->rowCount()) fail('This template was saved by someone else after you opened it. Reload it and make your change again', 409, 'stale');
            } else {
                db()->prepare('INSERT INTO sheet_templates (name, game, edition, author_id, layout, is_listed) VALUES (?,?,?,?,?,?)')
                    ->execute([$name, $game, $edition, $me['id'], $layout, p('is_listed') === false ? 0 : 1]);
                $id = (int)db()->lastInsertId();
            }
            out(['ok' => true, 'template' => template_full($id)]);
        case 'template_fork':
            $t = template_row(int_in(p('id'), 1));
            db()->prepare('INSERT INTO sheet_templates (name, game, edition, author_id, forked_from_id, layout) VALUES (?,?,?,?,?,?)')
                ->execute([$t['name'], $t['game'], $t['edition'], $me['id'], $t['id'], json_encode($t['layout'], JSON_UNESCAPED_UNICODE)]);
            out(['ok' => true, 'template' => template_full((int)db()->lastInsertId())]);
        case 'template_delete':
            $t = template_row(int_in(p('id'), 1));
            need_template_editor($t);
            $st = db()->prepare('SELECT COUNT(*) FROM sheet_characters WHERE template_id=?');
            $st->execute([$t['id']]);
            if ((int)$st->fetchColumn()) fail('Characters use this template. Unlist it instead', 409, 'in_use');
            db()->prepare('DELETE FROM sheet_templates WHERE id=?')->execute([$t['id']]);
            out(['ok' => true]);
    }
}

// ---------- Values: the same rules as SheetLayout.coerce / reconcile / visibleTo ----------

/** [ok, value as stored] for a value of field $f. */
function sheet_value(array $f, $v): array {
    $num = function ($x): array {
        if ($x === null || $x === '') return [true, null];
        if (is_int($x) || is_float($x)) return [true, $x];
        return is_string($x) && is_numeric(trim($x)) ? [true, trim($x) + 0] : [false, null];
    };
    switch ($f['type']) {
        case 'text': case 'longtext':
            if ($v === null) return [true, ''];
            return is_string($v) && mb_strlen($v) <= SHEET_LIMITS[$f['type']] ? [true, $v] : [false, null];
        case 'number': return $num($v);
        case 'counter':
            if (!is_array($v) || array_is_list($v) && $v) return [false, null];
            [$ok1, $c] = $num($v['cur'] ?? null);
            [$ok2, $m] = $num($v['max'] ?? null);
            return $ok1 && $ok2 ? [true, ['cur' => $c, 'max' => $m]] : [false, null];
        case 'pips': return is_int($v) && $v >= 0 && $v <= $f['count'] ? [true, $v] : [false, null];
        case 'checkbox': return is_bool($v) ? [true, $v] : [false, null];
        // one of its options, or a custom entry typed in its place
        case 'choice': return $v === null || is_string($v) && mb_strlen($v) <= SHEET_LIMITS['text'] ? [true, $v] : [false, null];
        case 'list':
            if (!is_array($v) || !array_is_list($v) || count($v) > SHEET_LIMITS['rows']) return [false, null];
            $cols = array_column($f['columns'] ?? [], 'key');
            $rows = [];
            foreach ($v as $r) {
                if (!is_array($r) || (array_is_list($r) && $r)) return [false, null];
                $row = [];
                foreach ($cols as $k) {
                    if (!isset($r[$k])) continue;
                    if (!is_string($r[$k]) && !is_int($r[$k]) && !is_float($r[$k])) return [false, null];
                    $s = (string)$r[$k];
                    if (mb_strlen($s) > SHEET_LIMITS['text']) return [false, null];
                    $row[$k] = $s;
                }
                $rows[] = (object)$row;
            }
            return [true, $rows];
    }
    return [false, null];
}
/** key => [field, section key] for every field of a layout. */
function sheet_fields(array $layout): array {
    $out = [];
    foreach ($layout['sections'] as $s) foreach ($s['fields'] as $f) $out[$f['key']] = [$f, $s['key']];
    return $out;
}
/** [values that fit the layout, old: [{key, value}] that no longer do]. */
function sheet_reconcile(array $layout, array $values): array {
    $f = sheet_fields($layout);
    $ok = [];
    $old = [];
    foreach ($values as $k => $v) {
        [$fits, $val] = isset($f[$k]) ? sheet_value($f[$k][0], $v) : [false, null];
        if ($fits) $ok[$k] = $val;
        if (!$fits || sheet_stale_list($f[$k][0], $v)) $old[] = ['key' => (string)$k, 'value' => $v];
    }
    return [$ok, $old];
}
/** Whether a list's stored rows hold a column the field no longer has (a renamed or removed column), which reading
 * it with the current columns would drop. */
function sheet_stale_list(array $f, $v): bool {
    if ($f['type'] !== 'list' || !is_array($v)) return false;
    $cols = array_flip(array_column($f['columns'] ?? [], 'key'));
    foreach ($v as $r) if (is_array($r)) foreach ($r as $k => $_) if (!isset($cols[$k])) return true;
    return false;
}
/** The values someone may see: hidden fields, and the fields of hidden sections, left out unless $full. */
function sheet_visible(array $layout, array $values, array $hidden, bool $full): array {
    if ($full) return $values;
    $h = array_flip($hidden);
    $out = [];
    foreach ($layout['sections'] as $s) {
        if (isset($h[$s['key']])) continue;
        foreach ($s['fields'] as $f) if (!isset($h[$f['key']]) && array_key_exists($f['key'], $values)) $out[$f['key']] = $values[$f['key']];
    }
    return $out;
}

// ---------- Characters ----------

/** A character of campaign $cid with its entry's name and secrecy and its template; 404 when this member can't see it. */
function character_row(int $cid, int $id, bool $isGm): array {
    $c = character_rows($cid, $isGm, $id)[0] ?? null;
    if (!$c) fail('Character not found', 404);
    return $c;
}
/** The characters of campaign $cid this member can see (players don't see those of GM-only entries), or just $id. */
function character_rows(int $cid, bool $isGm, ?int $id = null): array {
    $st = db()->prepare('SELECT c.*, e.name, e.is_secret AS entry_secret, t.name AS template_name, t.game, t.layout, t.version AS tversion,
            u.display_name AS owner_name, m.user_id IS NOT NULL AS owner_in_campaign
        FROM sheet_characters c JOIN encyclopedia_entries e ON e.id=c.entry_id JOIN sheet_templates t ON t.id=c.template_id
        LEFT JOIN users u ON u.id=c.owner_id LEFT JOIN campaign_members m ON m.campaign_id=c.campaign_id AND m.user_id=c.owner_id
        WHERE c.campaign_id=?' . ($isGm ? '' : ' AND (e.is_secret=0 OR c.owner_id=?)') . ($id !== null ? ' AND c.id=?' : '') . ' ORDER BY c.id');
    $st->execute(array_merge([$cid], $isGm ? [] : [(int)me()['id']], $id !== null ? [$id] : []));
    return $st->fetchAll();
}
/** Whether this member sees the whole sheet (its owner or a GM) and may change it. */
function character_full(array $c, bool $isGm): bool {
    return $isGm || ($c['owner_id'] !== null && (int)$c['owner_id'] === me()['id']);
}
/** The card: who and what it is, its Play and Summary fields as this member may see them. */
function character_card(array $c, bool $isGm, array $pics = []): array {
    $full = character_full($c, $isGm);
    $visible = $full || $c['kind'] === 'pc' || (int)$c['sheet_public'];
    $layout = json_decode($c['layout'], true);
    [$values] = sheet_reconcile($layout, json_decode($c['field_values'], true) ?: []);
    $values = $visible ? sheet_visible($layout, $values, json_decode($c['hidden'], true) ?: [], $full) : [];
    $play = [];
    $summary = [];
    if ($visible) foreach (sheet_fields($layout) as $k => [$f]) {
        if (!array_key_exists($k, $values)) continue;
        if (!empty($f['play'])) $play[] = ['key' => $k, 'label' => $f['label'], 'type' => $f['type'], 'value' => $values[$k]] + (isset($f['count']) ? ['count' => $f['count']] : []);
        if (!empty($f['summary'])) $summary[] = ['key' => $k, 'label' => $f['label'], 'value' => $values[$k]];
    }
    return ['id' => (int)$c['id'], 'entry_id' => (int)$c['entry_id'], 'name' => $c['name'], 'kind' => $c['kind'],
        'owner' => $c['owner_id'] !== null ? ['id' => (int)$c['owner_id'], 'name' => (string)$c['owner_name']] : null,
        'owner_in_campaign' => (bool)$c['owner_in_campaign'], 'secret' => (bool)(int)$c['entry_secret'],
        'template' => ['id' => (int)$c['template_id'], 'name' => $c['template_name'], 'game' => $c['game']],
        'play' => $play, 'summary' => $summary, 'sheet_visible' => $visible, 'sheet_public' => (bool)(int)$c['sheet_public'],
        'can_edit' => $full, 'version' => (int)$c['version'], 'pic' => $pics[(int)$c['entry_id']] ?? null];
}
/** Each entry's character for the Encyclopedia, as entry id => {id, kind, sheet_visible, owner, game, summary}: the
 * Summary fields as this member may see them (none when the sheet is hidden from them). */
function characters_by_entry(int $cid, bool $isGm): array {
    if (!has_sheets()) return [];
    $out = [];
    foreach (character_rows($cid, $isGm) as $c) {
        $card = character_card($c, $isGm);
        $out[$card['entry_id']] = ['id' => $card['id'], 'kind' => $card['kind'], 'sheet_visible' => $card['sheet_visible'],
            'owner' => $card['owner'], 'game' => $card['template']['game'], 'summary' => $card['summary']];
    }
    return $out;
}
/** Write a character's name into character_name for every member whose active character it is. */
function character_names_sync(int $entryId): void {
    if (!has_sheets()) return;
    db()->prepare('UPDATE campaign_members m JOIN sheet_characters c ON c.id=m.active_character_id JOIN encyclopedia_entries e ON e.id=c.entry_id
        SET m.character_name=e.name WHERE c.entry_id=? AND c.owner_id=m.user_id AND e.is_secret=0')->execute([$entryId]);
}
/** A name for a character's entry that no other entry of the campaign has (but $exceptEntry). */
function character_name_in(int $cid, $v, bool $isGm, ?int $exceptEntry = null): string {
    $name = entry_name($v);
    $e = entry_by_name($cid, $name);
    if ($e && (int)$e['id'] !== $exceptEntry) fail($isGm || !(int)$e['is_secret'] ? 'An entry is already called that. Pick another name, or add a sheet to that entry' : 'Pick another name', 409, 'name_taken');
    return $name;
}
function member_role(int $cid, int $uid): ?string {
    $st = db()->prepare('SELECT role FROM campaign_members WHERE campaign_id=? AND user_id=?');
    $st->execute([$cid, $uid]);
    return $st->fetchColumn() ?: null;
}
const PRESENCE_SECONDS = 40;

/** The character actions of campaign $cid. */
function characters_action(string $action, int $cid): void {
    need_sheets();
    $role = role($cid);
    $isGm = $role === 'gm';
    $me = me();
    switch ($action) {
        case 'characters':
            $pics = entry_pics($cid, $isGm);
            out(['characters' => array_map(fn($c) => character_card($c, $isGm, $pics), character_rows($cid, $isGm))]);

        case 'character':
            $c = character_row($cid, int_in($_GET['id'] ?? null, 1), $isGm);
            out(character_out($c, $isGm, true));

        case 'character_create':
            $t = template_row(int_in(p('template_id'), 1));
            $kind = p('kind', 'pc');
            if (!in_array($kind, ['pc', 'npc'], true)) fail('A character is a PC or an NPC');
            if (!$isGm && ($kind !== 'pc' || p('entry_id') || (p('owner_id') && (int)p('owner_id') !== $me['id']))) fail('Players make their own PCs', 403);
            $owner = p('owner_id') ? int_in(p('owner_id'), 1) : $me['id'];
            if ($owner !== $me['id'] && !member_role($cid, $owner)) fail('Pick someone in this campaign');
            $pdo = db();
            $pdo->beginTransaction();
            if (p('entry_id')) {
                $e = entry_row($cid, int_in(p('entry_id'), 1), $role);
                if (!in_array($e['category'] ?? null, [null, 'person'], true)) fail('Only a Person entry can have a character sheet');
                $chk = $pdo->prepare('SELECT 1 FROM sheet_characters WHERE entry_id=?');
                $chk->execute([$e['id']]);
                if ($chk->fetchColumn()) fail('That entry already has a character sheet', 409);
                if (has_categories()) $pdo->prepare("UPDATE encyclopedia_entries SET category='person' WHERE id=?")->execute([$e['id']]);
                $entry = (int)$e['id'];
            } else {
                $name = character_name_in($cid, p('name'), $isGm);
                $pdo->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, created_by) VALUES (?,?,?)')->execute([$cid, $name, $me['id']]);
                $entry = (int)$pdo->lastInsertId();
                if (has_categories()) $pdo->prepare("UPDATE encyclopedia_entries SET category='person' WHERE id=?")->execute([$entry]);
            }
            $pdo->prepare("INSERT INTO sheet_characters (campaign_id, owner_id, template_id, entry_id, kind, sheet_public, template_version, field_values, field_stamps, hidden)
                VALUES (?,?,?,?,?,?,?,'{}','{}','[]')")->execute([$cid, $owner, $t['id'], $entry, $kind, $kind === 'pc' ? 1 : 0, $t['version']]);
            $id = (int)$pdo->lastInsertId();
            $pdo->commit();
            out(['ok' => true, 'character' => character_out(character_row($cid, $id, $isGm), $isGm)['character']]);

        case 'character_field':
            $c = character_row($cid, int_in(p('id'), 1), $isGm);
            if (!character_full($c, $isGm)) fail('Only its player or a GM can change this sheet', 403);
            $mine = $c['owner_id'] !== null && (int)$c['owner_id'] === $me['id'];
            if (!$mine) {
                $st = db()->prepare('SELECT 1 FROM sheet_presence WHERE character_id=? AND user_id=? AND editing=1 AND seen_at > NOW() - INTERVAL ' . PRESENCE_SECONDS . ' SECOND');
                $st->execute([$c['id'], $me['id']]);
                if (!$st->fetchColumn()) fail('Press Edit first', 409, 'not_editing');
            }
            $key = (string)p('key');
            $fields = sheet_fields(json_decode($c['layout'], true));
            if (!isset($fields[$key])) fail('This sheet has no such field');
            [$ok, $value] = sheet_value($fields[$key][0], p('value'));
            if (!$ok) fail("That doesn't fit the field " . $fields[$key][0]['label']);
            $path = '$."' . $key . '"';
            // a value kept from before a template change, which no longer fits this field, stays among the old fields
            $stored = json_decode($c['field_values'], true) ?: [];
            if (array_key_exists($key, $stored) && (!sheet_value($fields[$key][0], $stored[$key])[0] || sheet_stale_list($fields[$key][0], $stored[$key]))) {
                for ($n = 1, $keep = "$key~old"; array_key_exists($keep, $stored); $keep = "$key~old" . ++$n);
                db()->prepare('UPDATE sheet_characters SET field_values=JSON_SET(field_values, ?, JSON_EXTRACT(field_values, ?)) WHERE id=?')
                    ->execute(['$."' . $keep . '"', $path, $c['id']]);
            }
            db()->prepare('UPDATE sheet_characters SET field_values=JSON_SET(field_values, ?, CAST(? AS JSON)), field_stamps=JSON_SET(field_stamps, ?, JSON_ARRAY(?, ?)) WHERE id=?')
                ->execute([$path, json_encode($value, JSON_UNESCAPED_UNICODE), $path, $me['id'], (int)floor(microtime(true) * 1000), $c['id']]);
            out(['ok' => true, 'value' => $value]);

        case 'character_save':
            $c = character_row($cid, int_in(p('id'), 1), $isGm);
            if (!character_full($c, $isGm)) fail('Only its player or a GM can change this sheet', 403);
            $set = [];
            $args = [];
            $renamed = false;
            $handed = null;
            if (p('name') !== null) {
                $name = character_name_in($cid, p('name'), $isGm, (int)$c['entry_id']);
                $renamed = $name !== $c['name'];
            }
            $kind = p('kind', $c['kind']);
            if (!in_array($kind, ['pc', 'npc'], true)) fail('A character is a PC or an NPC');
            if ($kind !== $c['kind']) {
                array_push($set, 'kind=?', 'sheet_public=?');
                array_push($args, $kind, $kind === 'pc' ? 1 : (p('sheet_public') ? 1 : 0));
            } elseif (p('sheet_public') !== null) {
                $set[] = 'sheet_public=?';
                $args[] = p('sheet_public') ? 1 : 0;
            }
            if (p('owner_id') !== null) {
                $owner = int_in(p('owner_id'), 1);
                $to = member_role($cid, $owner);
                if (!$to) fail('Pick someone in this campaign');
                if (!$isGm && $to !== 'gm' && $owner !== $me['id']) fail('You can hand your sheet to a GM; only a GM can give it to another player', 403);
                $set[] = 'owner_id=?';
                $args[] = $owner;
                $handed = $owner;
            }
            if (p('hidden') !== null) {
                if ($c['owner_id'] !== null && (int)$c['owner_id'] !== $me['id']) fail('Only its player can hide or show parts of their sheet', 403);
                $h = p('hidden');
                if (!is_array($h) || !array_is_list($h) || count($h) > 1100) fail('Send the hidden fields as a list');
                $known = [];
                foreach (json_decode($c['layout'], true)['sections'] as $s) { $known[$s['key']] = true; foreach ($s['fields'] as $f) $known[$f['key']] = true; }
                $set[] = 'hidden=?';
                $args[] = json_encode(array_values(array_unique(array_filter($h, fn($k) => is_string($k) && isset($known[$k])))));
            }
            $pdo = db();
            $pdo->beginTransaction();
            $st = $pdo->prepare('UPDATE sheet_characters SET ' . implode(', ', array_merge($set, ['version=version+1'])) . ' WHERE id=? AND version=?');
            $st->execute(array_merge($args, [$c['id'], int_in(p('version'), 1)]));
            if (!$st->rowCount()) { $pdo->rollBack(); fail('Someone changed this sheet\'s settings after you opened it. Reload it and try again', 409, 'stale'); }
            if ($handed !== null) $pdo->prepare('UPDATE campaign_members SET active_character_id=NULL WHERE active_character_id=? AND user_id<>?')->execute([$c['id'], $handed]);
            if ($renamed) {
                $pdo->prepare('UPDATE encyclopedia_entries SET name=? WHERE id=?')->execute([$name, $c['entry_id']]);
                character_names_sync((int)$c['entry_id']);
            }
            $pdo->commit();
            out(['ok' => true, 'character' => character_out(character_row($cid, (int)$c['id'], $isGm), $isGm)['character']]);

        case 'character_delete':
            $c = character_row($cid, int_in(p('id'), 1), $isGm);
            if (!character_full($c, $isGm)) fail('Only its player or a GM can delete this sheet', 403);
            $pdo = db();
            $pdo->beginTransaction();
            $pdo->prepare('UPDATE campaign_members SET active_character_id=NULL WHERE active_character_id=?')->execute([$c['id']]);
            $pdo->prepare('DELETE FROM sheet_characters WHERE id=?')->execute([$c['id']]);
            $pdo->commit();
            out(['ok' => true]);

        case 'character_presence':
            $c = character_row($cid, int_in(p('id'), 1), $isGm);
            $mine = $c['owner_id'] !== null && (int)$c['owner_id'] === $me['id'];
            $editing = p('editing') && $isGm && !$mine ? 1 : 0;
            $pdo = db();
            $pdo->prepare('DELETE FROM sheet_presence WHERE character_id=? AND seen_at < NOW() - INTERVAL 60 SECOND')->execute([$c['id']]);
            $pdo->prepare('INSERT INTO sheet_presence (character_id, user_id, seen_at, editing) VALUES (?,?,NOW(),?)
                ON DUPLICATE KEY UPDATE seen_at=NOW(), editing=VALUES(editing)')->execute([$c['id'], $me['id'], $editing]);
            $st = $pdo->prepare("SELECT COALESCE(NULLIF(m.character_name, ''), u.display_name) AS name, COALESCE(m.role, 'gm') AS role, s.editing
                FROM sheet_presence s JOIN users u ON u.id=s.user_id LEFT JOIN campaign_members m ON m.campaign_id=? AND m.user_id=s.user_id
                WHERE s.character_id=? AND s.user_id<>? AND s.seen_at > NOW() - INTERVAL " . PRESENCE_SECONDS . ' SECOND ORDER BY name');
            $st->execute([$cid, $c['id'], $me['id']]);
            $viewers = array_map(fn($v) => ['name' => $v['name'], 'role' => $v['role'], 'editing' => (bool)(int)$v['editing']], $st->fetchAll());
            $now = (int)floor(microtime(true) * 1000);
            $changes = [];
            $since = p('since');
            $full = character_full($c, $isGm);
            if ($since !== null && ($full || $c['kind'] === 'pc' || (int)$c['sheet_public'])) {
                $since = (int)$since;
                $layout = json_decode($c['layout'], true);
                $values = sheet_visible($layout, json_decode($c['field_values'], true) ?: [], json_decode($c['hidden'], true) ?: [], $full);
                $by = [];
                foreach (json_decode($c['field_stamps'], true) ?: [] as $k => [$uid, $ms]) {
                    if ($ms <= $since || (int)$uid === $me['id'] || !array_key_exists($k, $values)) continue;
                    if (!isset($by[$uid])) {
                        $n = $pdo->prepare("SELECT COALESCE(NULLIF(m.character_name, ''), u.display_name) FROM users u LEFT JOIN campaign_members m ON m.campaign_id=? AND m.user_id=u.id WHERE u.id=?");
                        $n->execute([$cid, $uid]);
                        $by[$uid] = (string)$n->fetchColumn();
                    }
                    $changes[$k] = ['value' => $values[$k], 'by' => $by[$uid]];
                }
            }
            out(['viewers' => $viewers, 'changes' => (object)$changes, 'stamp' => (string)$now]);

        case 'member_active_character':
            $id = p('character_id');
            if ($id === null) {
                db()->prepare('UPDATE campaign_members SET active_character_id=NULL WHERE campaign_id=? AND user_id=?')->execute([$cid, $me['id']]);
                out(['ok' => true]);
            }
            $c = character_row($cid, int_in($id, 1), $isGm);
            if ($c['owner_id'] === null || (int)$c['owner_id'] !== $me['id']) fail('Pick one of your own characters', 403);
            if ((int)$c['entry_secret']) fail("A GM-only character can't be your active character", 409);
            db()->prepare('UPDATE campaign_members SET active_character_id=?, character_name=? WHERE campaign_id=? AND user_id=?')
                ->execute([$c['id'], $c['name'], $cid, $me['id']]);
            out(['ok' => true]);
    }
}
/** A character in full as this member may see it, with its values reconciled against its template now. */
function character_out(array $c, bool $isGm, bool $seen = false): array {
    $full = character_full($c, $isGm);
    $layout = json_decode($c['layout'], true);
    [$values, $old] = sheet_reconcile($layout, json_decode($c['field_values'], true) ?: []);
    $hidden = json_decode($c['hidden'], true) ?: [];
    $card = character_card($c, $isGm);
    $changed = (int)$c['template_version'] !== (int)$c['tversion'];
    if ($seen && $full && $changed) db()->prepare('UPDATE sheet_characters SET template_version=? WHERE id=?')->execute([$c['tversion'], $c['id']]);
    // the rest of the party isn't told which fields and sections are hidden, or that they exist
    if (!$full) foreach ($layout['sections'] as $i => $sec) {
        if (in_array($sec['key'], $hidden, true)) { unset($layout['sections'][$i]); continue; }
        $layout['sections'][$i]['fields'] = array_values(array_filter($sec['fields'], fn($f) => !in_array($f['key'], $hidden, true)));
    }
    $layout['sections'] = array_values($layout['sections']);
    $out = $card + ['layout' => $layout, 'values' => $card['sheet_visible'] ? (object)sheet_visible($layout, $values, $hidden, $full) : null,
        'old' => $full ? $old : []];
    if ($full) $out['hidden'] = $hidden;
    return ['character' => $out, 'template_changed' => $full && $changed];
}

// ---------- The starter library: db/starter-templates/<starter_key>.json, loaded by a site admin ----------

const STARTER_DIR = __DIR__ . '/../db/starter-templates';
/** Every starter file, as starter_key => its decoded contents, in file-name order. */
function starter_files(): array {
    $out = [];
    foreach (glob(STARTER_DIR . '/*.json') ?: [] as $f) {
        $key = basename($f, '.json');
        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,74}$/', $key)) continue;
        $t = json_decode((string)file_get_contents($f), true);
        if (is_array($t)) $out[$key] = $t;
    }
    ksort($out);
    return $out;
}
/** Admins: add the starter files that aren't in the library yet and update the ones that changed. */
function starter_templates_load(): void {
    need_admin();
    need_sheets();
    $added = $updated = $unchanged = 0;
    $pdo = db();
    $pdo->beginTransaction();
    foreach (starter_files() as $key => $t) {
        $name = trim((string)($t['name'] ?? ''));
        $game = trim((string)($t['game'] ?? ''));
        if ($name === '' || $game === '') { $pdo->rollBack(); fail("The starter file $key.json needs a name and a game"); }
        $edition = mb_substr(trim((string)($t['edition'] ?? '')), 0, 60);
        $layout = json_encode(sheet_layout_in($t['layout'] ?? null), JSON_UNESCAPED_UNICODE);
        $st = $pdo->prepare('SELECT id, name, game, edition, layout FROM sheet_templates WHERE starter_key=?');
        $st->execute([$key]);
        $row = $st->fetch();
        if (!$row) {
            $pdo->prepare('INSERT INTO sheet_templates (name, game, edition, author_id, layout, is_listed, starter_key) VALUES (?,?,?,NULL,?,1,?)')
                ->execute([mb_substr($name, 0, 150), mb_substr($game, 0, 100), $edition, $layout, $key]);
            $added++;
        } elseif ([$row['name'], $row['game'], (string)$row['edition']] !== [$name, $game, $edition] || json_decode($row['layout'], true) !== json_decode($layout, true)) {
            $pdo->prepare('UPDATE sheet_templates SET name=?, game=?, edition=?, layout=?, version=version+1 WHERE id=?')
                ->execute([mb_substr($name, 0, 150), mb_substr($game, 0, 100), $edition, $layout, $row['id']]);
            $updated++;
        } else $unchanged++;
    }
    $pdo->commit();
    out(['ok' => true, 'added' => $added, 'updated' => $updated, 'unchanged' => $unchanged]);
}
/** For the About page, signed in or not: each starter template's game and the sheet it was built from. */
function starter_sources(): void {
    $out = [];
    foreach (starter_files() as $t) {
        $s = is_array($t['source'] ?? null) ? $t['source'] : [];
        $out[] = ['game' => (string)($t['game'] ?? ''), 'edition' => (string)($t['edition'] ?? ''),
            'source' => ['title' => (string)($s['title'] ?? ''), 'owner' => (string)($s['owner'] ?? ''), 'url' => (string)($s['url'] ?? ''),
                'licence' => isset($s['licence']) && is_string($s['licence']) ? $s['licence'] : null]];
    }
    out(['starters' => $out]);
}
