<?php
/**
 * history.php — edit history: the earlier versions of an Encyclopedia entry, a Library tome, a session's summary and
 * notes, and a day's notes, with who saved each and when, so a GM can read one, see what changed and put it back.
 *
 * Every save of one of those keeps the text it was saved as in content_versions (history_record, called from the save
 * itself, inside its transaction). The first save of an item that was written before history began first keeps what it
 * had as a "before history" version (history_before), since there is nothing earlier to show. Saves by the same person
 * within ten minutes are one version, so a note saved as it is typed is a handful of versions, not hundreds; the newest
 * 50 per item are kept. A restore is a new version, so nothing is ever lost by restoring.
 *
 * GMs only: an old version can hold GM notes and secret paragraphs, which a player is never sent. A version is the
 * item's text fields, not its tags, pictures, connections or dates.
 */
declare(strict_types=1);

const HISTORY_KINDS = ['entry', 'tome', 'session', 'day'];
const HISTORY_KEEP = 50;            // versions kept per item
const HISTORY_JOIN_SECONDS = 600;   // a second save by the same person this soon after the last replaces it

/** The fields of an item as they are now, or null when it isn't there. ref: the entry, tome or session id, or the day's
 * absolute day number. */
function history_live(int $cid, string $kind, int $ref): ?array {
    $queries = [
        'entry' => 'SELECT name, aliases_json AS aliases, notes, gm_notes, is_secret, category FROM encyclopedia_entries WHERE campaign_id=? AND id=?',
        'tome' => 'SELECT kind, title, description, body FROM library_tomes WHERE campaign_id=? AND id=?',
        'session' => 'SELECT title, summary, rewards, loot, notes_text FROM play_sessions WHERE campaign_id=? AND id=?',
        'day' => 'SELECT notes, notes_format, gm_notes, gm_notes_format FROM days WHERE campaign_id=? AND abs_day=?',
    ];
    if (!isset($queries[$kind])) return null;
    $st = db()->prepare($queries[$kind]);
    $st->execute([$cid, $ref]);
    $row = $st->fetch();
    if (!$row) return null;
    if (isset($row['is_secret'])) $row['is_secret'] = (int)$row['is_secret'];
    return $row;
}

/** Call before the first change to an item: when it has no versions yet, keep what it holds now as the version from
 * before history began. */
function history_before(int $cid, string $kind, int $ref): void {
    $st = db()->prepare('SELECT 1 FROM content_versions WHERE campaign_id=? AND kind=? AND ref_id=? LIMIT 1');
    $st->execute([$cid, $kind, $ref]);
    if ($st->fetchColumn()) return;
    if (!$live = history_live($cid, $kind, $ref)) return;
    db()->prepare('INSERT INTO content_versions (campaign_id, kind, ref_id, data, saved_by, baseline) VALUES (?,?,?,?,NULL,1)')
        ->execute([$cid, $kind, $ref, json_encode($live, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
}

/** Call after a save: keep the item as it is now as a version by the person saving. $alone: never join it to the
 * last version (a restore stands by itself). */
function history_record(int $cid, string $kind, int $ref, bool $alone = false): void {
    if (!$live = history_live($cid, $kind, $ref)) return;
    $data = json_encode($live, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $st = db()->prepare('SELECT id, data, saved_by, baseline, UNIX_TIMESTAMP() - UNIX_TIMESTAMP(saved_at) AS age
        FROM content_versions WHERE campaign_id=? AND kind=? AND ref_id=? ORDER BY id DESC LIMIT 1');
    $st->execute([$cid, $kind, $ref]);
    $last = $st->fetch();
    if ($last && $last['data'] === $data) return;
    $me = me()['id'];
    if ($last && !$alone && !(int)$last['baseline'] && (int)$last['saved_by'] === $me && (int)$last['age'] < HISTORY_JOIN_SECONDS) {
        db()->prepare('UPDATE content_versions SET data=?, saved_at=CURRENT_TIMESTAMP WHERE id=?')->execute([$data, $last['id']]);
        return;
    }
    db()->prepare('INSERT INTO content_versions (campaign_id, kind, ref_id, data, saved_by) VALUES (?,?,?,?,?)')->execute([$cid, $kind, $ref, $data, $me]);
    // the newest HISTORY_KEEP stay: everything older than the one at that place goes
    db()->prepare('DELETE FROM content_versions WHERE campaign_id=? AND kind=? AND ref_id=? AND id < (
        SELECT id FROM (SELECT id FROM content_versions WHERE campaign_id=? AND kind=? AND ref_id=? ORDER BY id DESC LIMIT 1 OFFSET ' . (HISTORY_KEEP - 1) . ') keep)')
        ->execute([$cid, $kind, $ref, $cid, $kind, $ref]);
}

/** Forget an item's versions, when the item itself is deleted. */
function history_purge(int $cid, string $kind, int $ref): void {
    db()->prepare('DELETE FROM content_versions WHERE campaign_id=? AND kind=? AND ref_id=?')->execute([$cid, $kind, $ref]);
}

/** One version of campaign $cid as a row with who saved it, or fail. */
function history_row(int $cid, int $id): array {
    $st = db()->prepare('SELECT v.*, u.display_name AS by_name FROM content_versions v LEFT JOIN users u ON u.id=v.saved_by WHERE v.campaign_id=? AND v.id=?');
    $st->execute([$cid, $id]);
    return $st->fetch() ?: fail('That version is gone', 404);
}
function history_item_kind($v): string {
    $k = (string)$v;
    if (!in_array($k, HISTORY_KINDS, true)) fail('Pick an entry, a tome, a session or a day');
    return $k;
}
function history_out(array $r): array {
    return ['id' => (int)$r['id'], 'saved_at' => $r['saved_at'], 'by' => $r['by_name'] ?? null, 'baseline' => (bool)$r['baseline']];
}

/** Put a version's text back on its item (a restore). Fails when the item is gone or, for an entry, its name now belongs
 * to another. */
function history_apply(int $cid, array $v): void {
    $kind = $v['kind']; $ref = (int)$v['ref_id'];
    $d = json_decode((string)$v['data'], true);
    if (!is_array($d)) fail('That version can\'t be read', 500);
    if ($kind !== 'day' && !history_live($cid, $kind, $ref)) fail('The ' . ($kind === 'tome' ? 'tome' : $kind) . ' it belonged to has been deleted', 404);
    $s = fn(string $k) => isset($d[$k]) ? (string)$d[$k] : null;
    switch ($kind) {
    case 'entry':
        $name = (string)$d['name'];
        $same = entry_named($cid, $name);
        if ($same && (int)$same['id'] !== $ref) fail("\"$name\" is a name of \"{$same['name']}\" now. Rename that one first, then restore", 409, 'name_taken');
        db()->prepare('UPDATE encyclopedia_entries SET name=?, aliases_json=?, notes=?, gm_notes=?, is_secret=?, category=?' . entry_bump() . ' WHERE campaign_id=? AND id=?')
            ->execute([$name, $s('aliases'), $s('notes'), $s('gm_notes'), (int)($d['is_secret'] ?? 0) ? 1 : 0, $s('category'), $cid, $ref]);
        if (function_exists('character_names_sync')) character_names_sync($ref);
        break;
    case 'tome':
        db()->prepare('UPDATE library_tomes SET kind=?, title=?, description=?, body=?, version=version+1, updated_by=? WHERE campaign_id=? AND id=?')
            ->execute([$s('kind'), $s('title'), $s('description'), $s('body'), me()['id'], $cid, $ref]);
        break;
    case 'session':
        db()->prepare('UPDATE play_sessions SET title=?, summary=?, rewards=?, loot=?, notes_text=?, summary_format=\'html\', version=version+1 WHERE campaign_id=? AND id=?')
            ->execute([(string)$s('title'), $s('summary'), $s('rewards'), $s('loot'), $s('notes_text'), $cid, $ref]);
        break;
    case 'day':
        $has = db()->prepare('SELECT 1 FROM days WHERE campaign_id=? AND abs_day=?');
        $has->execute([$cid, $ref]);
        if (!$has->fetchColumn()) {
            need_row_room($cid, 'days', 1);
            db()->prepare('INSERT INTO days (campaign_id, abs_day, notes, notes_format, gm_notes, gm_notes_format) VALUES (?,?,?,?,?,?)')
                ->execute([$cid, $ref, $s('notes'), $s('notes_format') ?? 'plain', $s('gm_notes'), $s('gm_notes_format') ?? 'plain']);
        } else {
            db()->prepare('UPDATE days SET notes=?, notes_format=?, gm_notes=?, gm_notes_format=?, version=version+1 WHERE campaign_id=? AND abs_day=?')
                ->execute([$s('notes'), $s('notes_format') ?? 'plain', $s('gm_notes'), $s('gm_notes_format') ?? 'plain', $cid, $ref]);
        }
        break;
    }
}

function history_action(string $action): void {
    switch ($action) {
    case 'history_list': // GMs: an item's versions, newest first, without their text
        $cid = cid(); need_gm($cid);
        $kind = history_item_kind($_GET['kind'] ?? null);
        $ref = int_in($_GET['ref'] ?? null);
        $st = db()->prepare('SELECT v.id, v.saved_at, v.baseline, u.display_name AS by_name, LENGTH(v.data) AS size
            FROM content_versions v LEFT JOIN users u ON u.id=v.saved_by WHERE v.campaign_id=? AND v.kind=? AND v.ref_id=? ORDER BY v.id DESC');
        $st->execute([$cid, $kind, $ref]);
        out(['ok' => true, 'kind' => $kind, 'ref' => $ref, 'keep' => HISTORY_KEEP,
            'versions' => array_map(fn($r) => history_out($r) + ['size' => (int)$r['size']], $st->fetchAll())]);

    case 'history_get': // GMs: one version's text, the version before it, and the item as it is now
        $cid = cid(); need_gm($cid);
        $v = history_row($cid, int_in($_GET['id'] ?? null, 1));
        $prev = db()->prepare('SELECT data FROM content_versions WHERE campaign_id=? AND kind=? AND ref_id=? AND id < ? ORDER BY id DESC LIMIT 1');
        $prev->execute([$cid, $v['kind'], $v['ref_id'], $v['id']]);
        $before = $prev->fetchColumn();
        out(['ok' => true, 'version' => history_out($v) + ['kind' => $v['kind'], 'ref' => (int)$v['ref_id'], 'data' => json_decode((string)$v['data'], true)],
            'previous' => $before === false ? null : json_decode((string)$before, true),
            'current' => history_live($cid, $v['kind'], (int)$v['ref_id'])]);

    case 'history_restore': // GMs: put a version's text back; the restore is itself a new version
        $cid = cid(); need_gm($cid);
        $v = history_row($cid, int_in(p('id'), 1));
        db()->beginTransaction();
        history_before($cid, $v['kind'], (int)$v['ref_id']);
        history_apply($cid, $v);
        history_record($cid, $v['kind'], (int)$v['ref_id'], true);
        db()->commit();
        out(['ok' => true, 'kind' => $v['kind'], 'ref' => (int)$v['ref_id']]);
    }
}
