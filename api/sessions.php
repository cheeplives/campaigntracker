<?php
/**
 * Play sessions and their notes.
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

// ---------- play sessions ----------
// A session is one game night: the GM's quick notes taken during it (session_notes, GMs only) and the summary written
// from them afterwards, which players read once it is published. A campaign has at most one open session (last_day
// NULL); the Session notes box adds to it, and starts one when there is none.

/** A session of campaign $cid; a player only gets a published one. $lock: FOR UPDATE, inside a transaction. */
function session_row(int $cid, int $id, bool $isGm = true, bool $lock = false): array {
    $st = db()->prepare('SELECT * FROM play_sessions WHERE id=? AND campaign_id=?' . ($isGm ? '' : ' AND is_published=1') . ($lock ? ' FOR UPDATE' : ''));
    $st->execute([$id, $cid]);
    return $st->fetch() ?: fail('Session not found', 404);
}
/** The campaign's open session, or null. */
function open_session(int $cid): ?array {
    $st = db()->prepare('SELECT * FROM play_sessions WHERE campaign_id=? AND last_day IS NULL ORDER BY number DESC LIMIT 1');
    $st->execute([$cid]);
    return $st->fetch() ?: null;
}
/** A session as the browser gets it: the summary only when $full, without its secret paragraphs for a player. */
function session_out(array $s, bool $full, bool $isGm): array {
    $o = ['id' => (int)$s['id'], 'number' => (int)$s['number'], 'title' => $s['title'], 'played_on' => $s['played_on'],
        'first_day' => (int)$s['first_day'], 'last_day' => $s['last_day'] === null ? null : (int)$s['last_day'],
        'is_published' => (bool)(int)$s['is_published'], 'version' => (int)$s['version']];
    if ($full) {
        $o['summary'] = (string)rich_for($s['summary'], $isGm);
        if (array_key_exists('rewards', $s)) { // the Session Rewards and Loot Found columns, once install.php has added them
            $o['rewards'] = (string)rich_for($s['rewards'], $isGm);
            $o['loot'] = (string)rich_for($s['loot'], $isGm);
        }
    }
    if ($isGm && isset($s['notes'])) { $o['notes'] = (int)$s['notes']; $o['covered'] = (int)$s['covered']; }
    return $o;
}
function snote_out(array $n): array {
    return ['id' => (int)$n['id'], 'session_id' => (int)$n['session_id'], 'position' => (int)$n['position'], 'depth' => (int)$n['depth'],
        'text' => $n['text'], 'abs_shift' => (int)$n['abs_shift'], 'is_covered' => (bool)(int)$n['is_covered']];
}
function snote_row(int $cid, int $id): array {
    return row_of('session_notes', $cid, $id, 'Note not found');
}
function snotes(int $sid): array {
    $st = db()->prepare('SELECT * FROM session_notes WHERE session_id=? ORDER BY position, id');
    $st->execute([$sid]);
    return array_map('snote_out', $st->fetchAll());
}
/** A note's text: one line, 1 to 1000 characters. */
function snote_text($v): string {
    $t = trim(preg_replace('/\s+/u', ' ', (string)str_in($v, 1000, false)));
    if ($t === '') fail('Write something first');
    return $t;
}
/** End every open session of the campaign at the current day. */
function sessions_end_all(int $cid): void {
    $c = campaign_row($cid);
    $day = floordiv((int)$c['current_shift'], slots_per_day(dec($c['calendar_json'])));
    db()->prepare('UPDATE play_sessions SET last_day=GREATEST(first_day, ?) WHERE campaign_id=? AND last_day IS NULL')->execute([$day, $cid]);
}
/** A new open session (any open one ended first), numbered after the campaign's last. */
function session_create(int $cid, int $firstDay, string $title = '', ?string $playedOn = null): int {
    sessions_end_all($cid);
    $st = db()->prepare('SELECT COALESCE(MAX(number), 0) + 1 FROM play_sessions WHERE campaign_id=? FOR UPDATE');
    $st->execute([$cid]);
    db()->prepare('INSERT INTO play_sessions (campaign_id, number, title, played_on, first_day, created_by) VALUES (?,?,?,?,?,?)')
        ->execute([$cid, (int)$st->fetchColumn(), $title, $playedOn ?? date('Y-m-d'), $firstDay, me()['id']]);
    return (int)db()->lastInsertId();
}
/** A real-world date as YYYY-MM-DD, or null. */
function date_in($v): ?string {
    if ($v === null || $v === '') return null;
    if (!is_string($v) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) || !checkdate((int)substr($v, 5, 2), (int)substr($v, 8, 2), (int)substr($v, 0, 4))) fail('Pick a date');
    return $v;
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function sessions_action(string $action): void {
    switch ($action) {
    case 'sessions': // newest first; a player gets the published ones only, without the GMs' note counts
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $st = db()->prepare($isGm
            ? 'SELECT s.*, COUNT(n.id) AS notes, COALESCE(SUM(n.is_covered), 0) AS covered FROM play_sessions s LEFT JOIN session_notes n ON n.session_id=s.id
               WHERE s.campaign_id=? GROUP BY s.id ORDER BY s.number DESC'
            : 'SELECT * FROM play_sessions WHERE campaign_id=? AND is_published=1 ORDER BY number DESC');
        $st->execute([$cid]);
        out(['sessions' => array_map(fn($x) => session_out($x, false, $isGm), $st->fetchAll())]);

    case 'session': // one session with its summary and pictures; GMs get its notes too
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $s = session_row($cid, int_in($_GET['id'] ?? null, 1), $isGm);
        $files = [];
        $st = db()->prepare("SELECT * FROM attachments WHERE campaign_id=? AND parent_type='session' AND parent_id=?" . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY id');
        $st->execute([$cid, (int)$s['id']]);
        $files = array_map('attachment_out', $st->fetchAll());
        out(['session' => session_out($s, true, $isGm) + ['files' => $files], 'uploads' => upload_info()] + ($isGm ? ['notes' => snotes((int)$s['id'])] : []));

    case 'session_save': // GMs: a new session, or a change to one's title, dates or publishing; reopen makes it the open one
        $cid = cid();
        need_gm($cid);
        db()->beginTransaction();
        if (p('id')) {
            $s = session_row($cid, int_in(p('id'), 1), true, true);
            $title = array_key_exists('title', body()) ? trim(preg_replace('/\s+/u', ' ', (string)str_in(p('title'), 200))) : $s['title'];
            $played = array_key_exists('played_on', body()) ? date_in(p('played_on')) : $s['played_on'];
            $first = array_key_exists('first_day', body()) ? int_in(p('first_day')) : (int)$s['first_day'];
            $last = array_key_exists('last_day', body()) ? (p('last_day') === null ? null : int_in(p('last_day'))) : ($s['last_day'] === null ? null : (int)$s['last_day']);
            if (p('reopen')) { sessions_end_all($cid); $last = null; }
            if ($last !== null && $last < $first) fail('The last day can\'t be before the first');
            $pub = array_key_exists('is_published', body()) ? (p('is_published') ? 1 : 0) : (int)$s['is_published'];
            db()->prepare('UPDATE play_sessions SET title=?, played_on=?, first_day=?, last_day=?, is_published=? WHERE id=?')
                ->execute([$title, $played, $first, $last, $pub, $s['id']]);
            $id = (int)$s['id'];
        } else {
            db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]); // one new session at a time
            $c = campaign_row($cid);
            $first = array_key_exists('first_day', body()) ? int_in(p('first_day')) : floordiv((int)$c['current_shift'], slots_per_day(dec($c['calendar_json'])));
            $id = session_create($cid, $first, trim((string)str_in(p('title'), 200)), date_in(p('played_on')));
        }
        db()->commit();
        out(['ok' => true, 'session' => session_out(session_row($cid, $id), true, true)]);

    case 'session_summary_save': // GMs: the summary, from the copy the page opened (version)
        $cid = cid();
        need_gm($cid);
        $s = session_row($cid, int_in(p('id'), 1));
        $html = rich_html_clean((string)str_in(p('summary'), 2_000_000)) ?: null;
        $set = 'summary=?'; $args = [$html];
        foreach (['rewards', 'loot'] as $f) if (array_key_exists($f, body())) {
            if (!array_key_exists($f, $s)) fail('Open install.php on the server and press Install or upgrade first', 400);
            $set .= ", $f=?";
            $args[] = rich_html_clean((string)str_in(p($f), 2_000_000)) ?: null;
        }
        $st = db()->prepare("UPDATE play_sessions SET $set, summary_format='html', version=version+1 WHERE id=? AND version=?");
        $st->execute([...$args, $s['id'], int_in(p('version'), 1)]);
        if (!$st->rowCount()) fail('This summary was saved somewhere else after you opened it. Copy what you wrote, reload, and add it again', 409, 'stale');
        out(['ok' => true, 'session' => session_out(session_row($cid, (int)$s['id']), true, true)]);

    case 'session_end': // GMs: the open session (or the one named) ends on the current day
        $cid = cid();
        need_gm($cid);
        if (p('id')) {
            $s = session_row($cid, int_in(p('id'), 1));
            $c = campaign_row($cid);
            $day = floordiv((int)$c['current_shift'], slots_per_day(dec($c['calendar_json'])));
            db()->prepare('UPDATE play_sessions SET last_day=GREATEST(first_day, ?) WHERE id=? AND last_day IS NULL')->execute([$day, $s['id']]);
        } else sessions_end_all($cid);
        out(['ok' => true]);

    case 'session_delete': // GMs: the session and its notes
        $cid = cid();
        need_gm($cid);
        $s = session_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM play_sessions WHERE id=?')->execute([$s['id']]);
        attachments_purge($cid, 'session', (int)$s['id']);   // files have no foreign key to cascade
        out(['ok' => true]);

    case 'snote_add': // GMs: a quick note, at the end of the session named, else the open one, else a new one
        $cid = cid();
        need_gm($cid);
        $text = snote_text(p('text'));
        $depth = int_in(p('depth', 0), 0, 3);
        $at = int_in(p('abs_shift'));
        $key = p('key') !== null ? (string)str_in(p('key'), 40) : null;
        db()->beginTransaction();
        // The campaign's lock first, before any other read: one note (and one new session) at a time, each seeing the last.
        db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]);
        $c = campaign_row($cid);
        if ($key !== null) { // sent before, and the reply lost: the note that was saved then
            $st = db()->prepare('SELECT * FROM session_notes WHERE campaign_id=? AND client_key=?');
            $st->execute([$cid, $key]);
            if ($n = $st->fetch()) {
                db()->commit();
                out(['ok' => true, 'note' => snote_out($n), 'session' => session_out(session_row($cid, (int)$n['session_id']), false, true)]);
            }
        }
        if (p('session_id')) $s = session_row($cid, int_in(p('session_id'), 1), true, true);
        else {
            $s = open_session($cid);
            if (!$s) $s = session_row($cid, session_create($cid, floordiv($at, slots_per_day(dec($c['calendar_json'])))));
            $s = session_row($cid, (int)$s['id'], true, true);
        }
        db()->prepare('INSERT INTO session_notes (campaign_id, session_id, position, depth, text, abs_shift, client_key, created_by)
            SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ?, ?, ?, ?, ? FROM session_notes WHERE session_id=?')
            ->execute([$cid, $s['id'], $depth, $text, $at, $key, me()['id'], $s['id']]);
        $nid = (int)db()->lastInsertId();
        db()->commit();
        out(['ok' => true, 'note' => snote_out(snote_row($cid, $nid)), 'session' => session_out(session_row($cid, (int)$s['id']), false, true)]);

    case 'snote_bulk': // GMs: many notes at once (typed in the session's notes box, or taken from a day's notes), at the end of the session named
        $cid = cid();
        need_gm($cid);
        $list = p('notes');
        if (!is_array($list) || !$list) fail('There are no notes to add', 400);
        if (count($list) > 500) fail('That is more than 500 notes at once. Add them in parts', 400);
        $rows = [];
        foreach ($list as $x) {
            if (!is_array($x)) fail('Those notes could not be read', 400);
            $rows[] = [snote_text($x['text'] ?? null), int_in($x['depth'] ?? 0, 0, 3), int_in($x['abs_shift'] ?? null)];
        }
        $key = p('key') !== null ? (string)str_in(p('key'), 30) : null;
        db()->beginTransaction();
        db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]);
        $s = session_row($cid, int_in(p('session_id'), 1), true, true);
        if ($key !== null) { // sent before, and the reply lost: nothing more to add
            $st = db()->prepare('SELECT 1 FROM session_notes WHERE campaign_id=? AND client_key=?');
            $st->execute([$cid, $key . '.0']);
            if ($st->fetch()) { db()->commit(); out(['ok' => true, 'added' => 0, 'again' => true]); }
        }
        $ins = db()->prepare('INSERT INTO session_notes (campaign_id, session_id, position, depth, text, abs_shift, client_key, created_by)
            SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ?, ?, ?, ?, ? FROM session_notes WHERE session_id=?');
        foreach ($rows as $i => [$text, $depth, $at])
            $ins->execute([$cid, $s['id'], $depth, $text, $at, $key !== null ? "$key.$i" : null, me()['id'], $s['id']]);
        db()->commit();
        out(['ok' => true, 'added' => count($rows)]);

    case 'snote_save': // GMs: a note's text, indent, stamp or tick
        $cid = cid();
        need_gm($cid);
        $n = snote_row($cid, int_in(p('id'), 1));
        $text = array_key_exists('text', body()) ? snote_text(p('text')) : $n['text'];
        $depth = array_key_exists('depth', body()) ? int_in(p('depth'), 0, 3) : (int)$n['depth'];
        $at = array_key_exists('abs_shift', body()) ? int_in(p('abs_shift')) : (int)$n['abs_shift'];
        $cov = array_key_exists('is_covered', body()) ? (p('is_covered') ? 1 : 0) : (int)$n['is_covered'];
        db()->prepare('UPDATE session_notes SET text=?, depth=?, abs_shift=?, is_covered=? WHERE id=?')->execute([$text, $depth, $at, $cov, $n['id']]);
        out(['ok' => true, 'note' => snote_out(snote_row($cid, (int)$n['id']))]);

    case 'snote_move': // GMs: a note to another place in its session (position, from 1), or to the end of another session
        $cid = cid();
        need_gm($cid);
        db()->beginTransaction();
        $n = snote_row($cid, int_in(p('id'), 1));
        $sid = (int)$n['session_id'];
        if (p('session_id') && int_in(p('session_id'), 1) !== $sid) {
            $to = session_row($cid, int_in(p('session_id'), 1), true, true);
            db()->prepare('UPDATE session_notes SET session_id=?, position=(SELECT p FROM (SELECT COALESCE(MAX(position), 0) + 1 AS p FROM session_notes WHERE session_id=?) x) WHERE id=?')
                ->execute([$to['id'], $to['id'], $n['id']]);
        } else {
            session_row($cid, $sid, true, true);
            $ids = array_column(snotes($sid), 'id');
            $ids = array_values(array_filter($ids, fn($i) => $i !== (int)$n['id']));
            if (p('after_id') !== null) {               // after this note (0: first), wherever it is now
                $after = int_in(p('after_id'), 0);
                $at = $after ? array_search($after, $ids, true) : -1;
                if ($at === false) fail('That note is no longer in this session. Reload and try again', 409);
                $pos = $at + 2;
            } else $pos = int_in(p('position', count($ids) + 1), 1);
            array_splice($ids, min($pos, count($ids) + 1) - 1, 0, [(int)$n['id']]);
            $up = db()->prepare('UPDATE session_notes SET position=? WHERE id=?');
            foreach ($ids as $i => $id) $up->execute([$i + 1, $id]);
        }
        db()->commit();
        out(['ok' => true]);

    case 'snote_delete':
        $cid = cid();
        need_gm($cid);
        $n = snote_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM session_notes WHERE id=?')->execute([$n['id']]);
        out(['ok' => true]);
    }
}
