<?php
/**
 * Import from Markdown: notes from an Obsidian vault, a folder of .md files or our own Markdown export become
 * Encyclopedia entries, with their other names, tags, Category, GM notes and the connections between them.
 *
 * static/mdimport.js reads the files in the browser (a zip is opened there, front matter and Markdown become rich text)
 * and sends the result here, GMs only, in two passes like the Scabard import: the entries first (up to 200 a request),
 * then the links between them by name (up to 3000). Everything is matched by name or another name, so the same files
 * can be imported again: an entry that exists is kept (one with nothing written in it is filled in), and tags and
 * connections are only added where missing. Nothing is deleted or overwritten. Pictures are not part of it.
 *
 * It uses the Scabard import's helpers for names, the entry index and tags (api/scabard.php).
 */
declare(strict_types=1);

const MDIMPORT_ENTRIES_MAX = 200;
const MDIMPORT_LINKS_MAX = 3000;

function mdimport_report(): array {
    return ['entries' => ['added' => 0, 'filled' => 0, 'kept' => 0], 'tags' => 0, 'connections' => 0, 'skipped' => ['entries' => 0, 'connections' => 0, 'unresolved' => 0]];
}

/** Entries and/or links as mdimport.js sends them. Returns the report, which the browser adds up across calls. */
function mdimport(int $cid, array $b): array {
    $entries = $b['entries'] ?? [];
    $links = $b['links'] ?? [];
    if (!is_array($entries) || !is_array($links)) fail('Expected entries and links');
    if (count($entries) > MDIMPORT_ENTRIES_MAX) fail('Send up to ' . MDIMPORT_ENTRIES_MAX . ' entries at a time');
    if (count($links) > MDIMPORT_LINKS_MAX) fail('Send up to ' . MDIMPORT_LINKS_MAX . ' links at a time');
    $r = mdimport_report();
    db()->beginTransaction();
    db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]); // one import at a time
    $idx = scabard_index($cid);
    $tags = [];
    foreach ($entries as $e) {
        if (!is_array($e)) fail('Expected a list of entries');
        mdimport_entry($cid, $e, $idx, $tags, $r);
    }
    foreach ($links as $l) {
        if (!is_array($l)) fail('Expected a list of links');
        mdimport_link($cid, $l, $idx, $r);
    }
    db()->commit();
    return $r;
}

/** One entry: new, filled in (it was blank) or kept; its Category (where it has none) and tags are added. */
function mdimport_entry(int $cid, array $p, array &$idx, array &$tags, array &$r): void {
    $name = scabard_name($p['name'] ?? '');
    if ($name === '') { $r['skipped']['entries']++; return; }
    $notes = is_string($p['notes'] ?? null) ? (rich_html_clean($p['notes']) ?: null) : null;
    $gm = is_string($p['gm_notes'] ?? null) ? (rich_html_clean($p['gm_notes']) ?: null) : null;
    $isSecret = !empty($p['is_secret']);
    $cat = mb_strtolower(trim((string)($p['category'] ?? '')));
    $cat = in_array($cat, ENTRY_CATEGORIES, true) ? $cat : null;
    $aliases = scabard_aliases(implode(', ', array_filter(array_map('strval', is_array($p['aliases'] ?? null) ? array_slice($p['aliases'], 0, 30) : []))), $name);
    $e = scabard_entry($idx, $name);
    // other names already belonging to something else are left out rather than refused
    $keep = array_values(array_filter($aliases, fn($a) => !($o = scabard_entry($idx, $a)) || ($e && $o['id'] === $e['id'])));
    if ($e && (!$e['blank'] || ($notes === null && $gm === null && !array_diff($keep, $e['aliases'])))) {
        $r['entries']['kept']++;
        $id = $e['id'];
    } elseif ($e) {
        $all = array_values(array_unique(array_merge($e['aliases'], $keep)));
        db()->prepare('UPDATE encyclopedia_entries SET aliases_json=?, notes=?, gm_notes=?' . entry_bump() . ' WHERE id=?')
            ->execute([$all ? json_encode($all, JSON_UNESCAPED_UNICODE) : null, $notes, $gm, $e['id']]);
        $id = $e['id'];
        $idx['rows'][$id]['blank'] = $notes === null && $gm === null;
        $idx['rows'][$id]['aliases'] = $all;
        entry_alias_forget($cid);
        $r['entries']['filled']++;
    } else {
        db()->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, aliases_json, notes, gm_notes, is_secret, category, created_by) VALUES (?,?,?,?,?,?,?,?)')
            ->execute([$cid, $name, $keep ? json_encode($keep, JSON_UNESCAPED_UNICODE) : null, $notes, $gm, $isSecret ? 1 : 0, $cat, me()['id']]);
        $id = (int)db()->lastInsertId();
        $idx['rows'][$id] = ['id' => $id, 'name' => $name, 'aliases' => $keep, 'is_secret' => $isSecret, 'blank' => $notes === null && $gm === null];
        $idx['by'][mb_strtolower($name)] = $id;
        if ($keep) entry_alias_forget($cid);
        $r['entries']['added']++;
    }
    foreach ($keep as $a) $idx['by'][mb_strtolower($a)] ??= $id;
    if ($cat) db()->prepare('UPDATE encyclopedia_entries SET category=? WHERE id=? AND category IS NULL')->execute([$cat, $id]);
    foreach (is_array($p['tags'] ?? null) ? array_slice($p['tags'], 0, 20) : [] as $t) if (is_string($t) && scabard_tag($cid, $id, $t, $tags)) $r['tags']++;
}

/** The connection kind a label is: an existing kind of the campaign or a starter (read from either end), else a new
 * two-way one. Returns [type id, whether the label is the kind's far end, so the connection runs the other way]. */
function mdimport_kind(int $cid, string $label): array {
    $st = db()->prepare('SELECT id, label, inverse_label FROM encyclopedia_relation_types WHERE campaign_id=? AND (label=? OR inverse_label=?) ORDER BY id LIMIT 1');
    $st->execute([$cid, $label, $label]);
    if ($row = $st->fetch()) return [(int)$row['id'], $row['inverse_label'] !== '' && strcasecmp($row['label'], $label) !== 0];
    foreach (RELATION_STARTER_TYPES as [$l, $i]) {
        if (strcasecmp($l, $label) === 0 || ($i !== '' && strcasecmp($i, $label) === 0)) {
            $flip = false;
            $tid = relation_type_id($cid, ['label' => $l, 'inverse_label' => $i, 'symmetric' => $i === ''], $flip);
            return [$tid, $i !== '' && strcasecmp($l, $label) !== 0];
        }
    }
    $flip = false;
    return [relation_type_id($cid, ['label' => $label, 'symmetric' => true], $flip), false];
}

/** One link between two entries, by name. */
function mdimport_link(int $cid, array $l, array &$idx, array &$r): void {
    $from = scabard_entry($idx, scabard_name($l['from'] ?? ''));
    $to = scabard_entry($idx, scabard_name($l['to'] ?? ''));
    if (!$from || !$to) { $r['skipped']['unresolved']++; return; }
    if ($from['id'] === $to['id']) { $r['skipped']['connections']++; return; }
    $label = trim(preg_replace('/\s+/u', ' ', (string)($l['label'] ?? '')) ?? '');
    if ($label === '') $label = 'Related to';
    $label = mb_substr($label, 0, 40);
    [$tid, $far] = mdimport_kind($cid, $label);
    [$f, $t] = $far ? [$to['id'], $from['id']] : [$from['id'], $to['id']];
    // the pair is there already, either way round
    $st = db()->prepare('SELECT 1 FROM encyclopedia_relations WHERE type_id=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) LIMIT 1');
    $st->execute([$tid, $f, $t, $t, $f]);
    if ($st->fetchColumn()) { $r['skipped']['connections']++; return; }
    $note = trim((string)($l['note'] ?? ''));
    $secret = !empty($l['secret']) || $from['is_secret'] || $to['is_secret'] ? 1 : 0;
    $ins = db()->prepare('INSERT IGNORE INTO encyclopedia_relations (campaign_id, from_id, to_id, type_id, note, is_secret, created_by) VALUES (?,?,?,?,?,?,?)');
    $ins->execute([$cid, $f, $t, $tid, $note === '' ? null : mb_substr($note, 0, 200), $secret, me()['id']]);
    if ($ins->rowCount() > 0) $r['connections']++;
}
