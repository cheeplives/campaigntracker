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
            (SELECT COUNT(*) FROM characters c WHERE c.template_id=t.id) AS uses,
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
                $where .= ' AND (t.name LIKE ? OR t.game LIKE ?)';
                $like = '%' . addcslashes($q, '%_\\') . '%';
                array_push($args, $like, $like);
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
            $st = db()->prepare('SELECT COUNT(*) FROM characters WHERE template_id=?');
            $st->execute([$t['id']]);
            if ((int)$st->fetchColumn()) fail('Characters use this template. Unlist it instead', 409, 'in_use');
            db()->prepare('DELETE FROM sheet_templates WHERE id=?')->execute([$t['id']]);
            out(['ok' => true]);
    }
}
