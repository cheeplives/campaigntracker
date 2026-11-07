<?php
/**
 * Connections between Encyclopedia entries, and their types.
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

// ---------- connections between Encyclopedia entries ----------
// A relationship type reads one way from each end: London "Has resident" Gunther, Gunther "Resident of" London. A
// symmetric one ("Ally of") reads the same both ways and keeps each pair once, in either order: from_id is the entry it
// was made on, so a symmetric type given an inverse label later still reads from the end people meant. Every member can connect the
// entries they can see; removing a connection is for whoever made it and for GMs. A connection marked GM only, or one
// that touches a secret entry, is never sent to players: the filter is in the SQL, so making an entry secret hides its
// connections at once.

/** Relationships every campaign is offered before it makes its own: [label, inverse label ('' when symmetric), colour]. */
const RELATION_STARTER_TYPES = [
    ['Has resident', 'Resident of', '#16a34a'], ['Contains', 'Located in', '#15803d'], ['Has member', 'Member of', '#9333ea'],
    ['Rules', 'Ruled by', '#b45309'], ['Owns', 'Owned by', '#d97706'], ['Serves', 'Served by', '#2563eb'],
    ['Worships', 'Worshipped by', '#0891b2'], ['Parent of', 'Child of', '#db2777'], ['Partner of', '', '#be185d'], ['Sibling of', '', '#a21caf'],
    ['Ally of', '', '#059669'], ['Enemy of', '', '#dc2626'], ['Related to', '', '#6b7280'],
];
/** SQL (aliases r, a, b) for the connections of campaign ? that this member may see. */
function relations_visible_sql(bool $isGm): string {
    return 'FROM encyclopedia_relations r JOIN encyclopedia_entries a ON a.id=r.from_id JOIN encyclopedia_entries b ON b.id=r.to_id
        WHERE r.campaign_id=?' . ($isGm ? '' : ' AND r.is_secret=0 AND a.is_secret=0 AND b.is_secret=0');
}
function relation_out(array $r): array {
    return ['id' => (int)$r['id'], 'from_id' => (int)$r['from_id'], 'to_id' => (int)$r['to_id'], 'type_id' => (int)$r['type_id'],
        'note' => $r['note'], 'is_secret' => (bool)$r['is_secret'], 'created_by' => $r['created_by'] !== null ? (int)$r['created_by'] : null];
}
/** Every connection this member may see. */
function relations_list(int $cid, bool $isGm): array {
    $st = db()->prepare('SELECT r.* ' . relations_visible_sql($isGm) . ' ORDER BY r.id');
    $st->execute([$cid]);
    return array_map('relation_out', $st->fetchAll());
}
function relation_type_out(array $t): array {
    return ['id' => $t['id'] !== null ? (int)$t['id'] : null, 'label' => $t['label'], 'inverse_label' => $t['inverse_label'],
        'symmetric' => $t['inverse_label'] === '', 'color' => $t['color']];
}
/** The campaign's relationships plus any starter it hasn't used yet (id null). Players get only the ones used by a
 * connection they can see, and the starters, so a label a GM made up for a secret connection never reaches them. */
function relation_types(int $cid, bool $isGm): array {
    $sql = 'SELECT id, label, inverse_label, color FROM encyclopedia_relation_types WHERE campaign_id=?';
    $args = [$cid];
    if (!$isGm) { $sql .= ' AND id IN (SELECT r.type_id ' . relations_visible_sql(false) . ')'; $args[] = $cid; }
    $st = db()->prepare($sql);
    $st->execute($args);
    $types = [];
    $key = fn($l, $i) => mb_strtolower($l) . "\0" . mb_strtolower($i);
    foreach ($st->fetchAll() as $t) $types[$key($t['label'], $t['inverse_label'])] = relation_type_out($t);
    foreach (RELATION_STARTER_TYPES as [$l, $i, $c]) $types[$key($l, $i)] ??= relation_type_out(['id' => null, 'label' => $l, 'inverse_label' => $i, 'color' => $c]);
    $types = array_values($types);
    usort($types, fn($a, $b) => strcasecmp($a['label'], $b['label']));
    return $types;
}
/** A relationship label as sent: trimmed, spaces run together, 1–40 characters ('' allowed when $optional). */
function relation_label($v, bool $optional = false): string {
    $l = trim(preg_replace('/\s+/u', ' ', (string)str_in($v, 200, false)) ?? '');
    if ($l === '' && !$optional) fail('Name the connection');
    if (mb_strlen($l) > 40) fail('Connection names are 40 characters at most');
    return $l;
}
/** The id of the relationship sent as {id} or {label, inverse_label?, symmetric?, color?}, made if it is new. A type
 * given one label, or the same label twice, reads the same from both ends: it is symmetric. $flip is set when the
 * labels sent are an existing type's the other way round, so the entry sending them is at its "to" end. */
function relation_type_id(int $cid, $t, bool &$flip = false): int {
    if (!is_array($t)) fail('Pick a connection');
    if (!empty($t['id'])) {
        $st = db()->prepare('SELECT id FROM encyclopedia_relation_types WHERE id=? AND campaign_id=?');
        $st->execute([int_in($t['id'], 1), $cid]);
        $id = $st->fetchColumn();
        if ($id === false) fail('That connection is gone', 404);
        return (int)$id;
    }
    $label = relation_label($t['label'] ?? '');
    $inverse = !empty($t['symmetric']) ? '' : relation_label($t['inverse_label'] ?? '', true);
    if (mb_strtolower($inverse) === mb_strtolower($label)) $inverse = '';
    $st = db()->prepare('SELECT id, label, inverse_label FROM encyclopedia_relation_types WHERE campaign_id=? AND
        ((label=? AND inverse_label=?) OR (label=? AND inverse_label=?))');
    $st->execute([$cid, $label, $inverse, $inverse, $label]);
    if ($row = $st->fetch()) {
        $flip = $inverse !== '' && mb_strtolower($row['label']) !== mb_strtolower($label); // typed the other way round: "Resident of" / "Has resident"
        return (int)$row['id'];
    }
    $color = (string)($t['color'] ?? '');
    if (!preg_match(TAG_COLOR, $color)) {
        $color = '#6b7280';
        foreach (RELATION_STARTER_TYPES as [$l, $i, $c]) if (strcasecmp($l, $label) === 0 && strcasecmp($i, $inverse) === 0) $color = $c;
    }
    db()->prepare('INSERT INTO encyclopedia_relation_types (campaign_id, label, inverse_label, color) VALUES (?,?,?,?)')->execute([$cid, $label, $inverse, $color]);
    return (int)db()->lastInsertId();
}
/** Keep one row of each pair made with symmetric type $tid, the older one, where both A→B and B→A exist. */
function relations_dedupe(int $tid): void {
    db()->prepare('DELETE r1 FROM encyclopedia_relations r1 JOIN encyclopedia_relations r2 ON r2.type_id=r1.type_id AND r2.from_id=r1.to_id AND r2.to_id=r1.from_id
        WHERE r1.type_id=? AND r1.id > r2.id')->execute([$tid]);
}
/** A relationship row of campaign $cid, or fail. */
function relation_type_row(int $cid, int $id): array {
    return row_of('encyclopedia_relation_types', $cid, $id, 'That connection is gone');
}
/** A connection of campaign $cid this member may see, or fail. */
function relation_row(int $cid, int $id, bool $isGm): array {
    $st = db()->prepare('SELECT r.* ' . relations_visible_sql($isGm) . ' AND r.id=?');
    $st->execute([$cid, $id]);
    $r = $st->fetch();
    if (!$r) fail('Connection not found', 404);
    return $r;
}
/** Whether this member may remove or change connection $r: whoever made it, and GMs. */
function relation_mine(array $r, bool $isGm): bool {
    return $isGm || ($r['created_by'] !== null && (int)$r['created_by'] === me()['id']);
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function connections_action(string $action): void {
    switch ($action) {
    case 'relations_save':
        // Connect entry_id to the entries in add, and drop its connections to those in remove, all with one relationship:
        // type {id} or {label, inverse_label?, symmetric?, color?}. side 'from': entry_id reads the type's label
        // ("London Has resident …"); 'to': the inverse ("Gunther Resident of …"). A connection that touches a secret
        // entry is always GM only.
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        $me = entry_row($cid, int_in(p('entry_id'), 1), $role);
        $add = p('add', []); $remove = p('remove', []);
        if (!is_array($add) || !is_array($remove) || count($add) + count($remove) > 200) fail('Send up to 200 entries at a time');
        $note = trim((string)str_in(p('note'), 200)) ?: null;
        $wantSecret = $isGm && p('is_secret', false);
        db()->beginTransaction();
        $flip = false;
        $tid = relation_type_id($cid, p('type'), $flip);
        $symmetric = relation_type_row($cid, $tid)['inverse_label'] === '';
        $atTo = (p('side', 'from') === 'to') !== $flip;
        $pair = fn(int $other): array => $atTo && !$symmetric ? [$other, (int)$me['id']] : [(int)$me['id'], $other];
        $ins = db()->prepare('INSERT IGNORE INTO encyclopedia_relations (campaign_id, from_id, to_id, type_id, note, is_secret, created_by) VALUES (?,?,?,?,?,?,?)');
        $back = db()->prepare('SELECT 1 FROM encyclopedia_relations WHERE type_id=? AND from_id=? AND to_id=?');
        foreach ($add as $x) {
            $o = entry_row($cid, int_in($x, 1), $role);
            if ((int)$o['id'] === (int)$me['id']) continue;
            [$f, $t] = $pair((int)$o['id']);
            if ($symmetric) { // already made from the other end
                $back->execute([$tid, $t, $f]);
                if ($back->fetchColumn()) continue;
            }
            $ins->execute([$cid, $f, $t, $tid, $note, $wantSecret || (int)$o['is_secret'] || (int)$me['is_secret'] ? 1 : 0, me()['id']]);
        }
        // A symmetric pair counts in either order.
        $find = db()->prepare('SELECT r.* ' . relations_visible_sql($isGm) . ' AND r.type_id=? AND ((r.from_id=? AND r.to_id=?)' . ($symmetric ? ' OR (r.from_id=? AND r.to_id=?)' : '') . ')');
        $has = function (int $f, int $t) use ($find, $cid, $tid, $symmetric) {
            $find->execute($symmetric ? [$cid, $tid, $f, $t, $t, $f] : [$cid, $tid, $f, $t]);
            return $find->fetch();
        };
        $del = db()->prepare('DELETE FROM encyclopedia_relations WHERE id=?');
        foreach ($remove as $x) {
            [$f, $t] = $pair(int_in($x, 1));
            if (!$r = $has($f, $t)) continue;
            if (!relation_mine($r, $isGm)) fail('Only a GM can remove a connection someone else made', 403);
            $del->execute([$r['id']]);
        }
        db()->commit();
        out(['ok' => true, 'type_id' => $tid, 'relations' => relations_list($cid, $isGm), 'relation_types' => relation_types($cid, $isGm)]);

    case 'relation_update': // one connection's note, and (GMs) whether it is GM only
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $r = relation_row($cid, int_in(p('id'), 1), $isGm);
        if (!relation_mine($r, $isGm)) fail('Only a GM can change a connection someone else made', 403);
        $note = array_key_exists('note', body()) ? (trim((string)str_in(p('note'), 200)) ?: null) : $r['note'];
        $secret = (int)$r['is_secret'];
        if ($isGm && array_key_exists('is_secret', body())) {
            $st = db()->prepare('SELECT MAX(is_secret) FROM encyclopedia_entries WHERE id IN (?,?)');
            $st->execute([$r['from_id'], $r['to_id']]);
            $secret = p('is_secret') || (int)$st->fetchColumn() ? 1 : 0;
        }
        db()->prepare('UPDATE encyclopedia_relations SET note=?, is_secret=? WHERE id=?')->execute([$note, $secret, $r['id']]);
        out(['ok' => true]);

    case 'relation_delete':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $r = relation_row($cid, int_in(p('id'), 1), $isGm);
        if (!relation_mine($r, $isGm)) fail('Only a GM can remove a connection someone else made', 403);
        db()->prepare('DELETE FROM encyclopedia_relations WHERE id=?')->execute([$r['id']]);
        out(['ok' => true]);

    case 'relation_type_save':
        // GMs rename a relationship's labels or colour, or merge it into another (merge_into: its connections move there).
        $cid = cid();
        need_gm($cid);
        $t = relation_type_row($cid, int_in(p('id'), 1));
        db()->beginTransaction();
        if (p('merge_into')) {
            $into = relation_type_row($cid, int_in(p('merge_into'), 1));
            if ((int)$into['id'] === (int)$t['id']) fail('Pick another connection to merge into');
            // Merging into the same pair of labels the other way round swaps the ends.
            $flip = $into['inverse_label'] !== '' && strcasecmp($into['label'], $t['inverse_label']) === 0 && strcasecmp($into['inverse_label'], $t['label']) === 0;
            $sym = $into['inverse_label'] === '';
            db()->prepare('INSERT IGNORE INTO encyclopedia_relations (campaign_id, from_id, to_id, type_id, note, is_secret, created_by, created_at)
                SELECT campaign_id, ' . ($flip ? 'to_id, from_id' : 'from_id, to_id') . ', ?, note, is_secret, created_by, created_at
                FROM encyclopedia_relations WHERE type_id=?')->execute([$into['id'], $t['id']]);
            db()->prepare('DELETE FROM encyclopedia_relation_types WHERE id=?')->execute([$t['id']]);
            if ($sym) relations_dedupe((int)$into['id']);
        } else {
            $label = relation_label(p('label', $t['label']));
            $inverse = p('symmetric') ? '' : relation_label(p('inverse_label', $t['inverse_label']), true);
            if (mb_strtolower($inverse) === mb_strtolower($label)) $inverse = '';
            $color = (string)p('color', $t['color']);
            if (!preg_match(TAG_COLOR, $color)) fail('Pick a colour');
            if ($inverse === '' && $t['inverse_label'] !== '') {
                relations_dedupe((int)$t['id']); // becoming symmetric: A→B and B→A are now the same connection
            }
            db()->prepare('UPDATE encyclopedia_relation_types SET label=?, inverse_label=?, color=? WHERE id=?')->execute([$label, $inverse, $color, $t['id']]);
        }
        db()->commit();
        out(['ok' => true, 'relations' => relations_list($cid, true), 'relation_types' => relation_types($cid, true)]);

    case 'relation_type_delete': // GMs: the relationship and every connection made with it
        $cid = cid();
        need_gm($cid);
        $t = relation_type_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM encyclopedia_relation_types WHERE id=?')->execute([$t['id']]);
        out(['ok' => true]);
    }
}
