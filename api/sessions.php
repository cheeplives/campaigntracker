<?php
/**
 * Play sessions and their notes.
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

// ---------- play sessions ----------
// A session is one game night: the GM's quick notes taken during it (notes_text, one text box, GMs only; older
// sessions' notes are rows in session_notes until the page folds them into it) and the summary written from them
// afterwards, which players read once it is published. A campaign has at most one open session (last_day NULL).
// first_shift and last_shift are the absolute shifts it started and ended on (migration 027); NULL on older sessions,
// which cover their first and last days whole.

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
        'first_shift' => $s['first_shift'] === null ? null : (int)$s['first_shift'],
        'last_shift' => $s['last_shift'] === null ? null : (int)$s['last_shift'],
        'is_published' => (bool)(int)$s['is_published'], 'version' => (int)$s['version']];
    if ($full) {
        $o['summary'] = (string)rich_for($s['summary'], $isGm);
        if (array_key_exists('rewards', $s)) { // the Session Rewards and Loot Found columns, once install.php has added them
            $o['rewards'] = (string)rich_for($s['rewards'], $isGm);
            $o['loot'] = (string)rich_for($s['loot'], $isGm);
        }
    }
    if ($full && $isGm) $o['notes_text'] = $s['notes_text'] ?? null;   // null: never saved, so the page folds the old rows in
    return $o;
}
function snote_out(array $n): array {
    return ['id' => (int)$n['id'], 'session_id' => (int)$n['session_id'], 'position' => (int)$n['position'], 'depth' => (int)$n['depth'],
        'text' => $n['text'], 'abs_shift' => (int)$n['abs_shift'], 'is_covered' => (bool)(int)$n['is_covered']];
}
function snotes(int $sid): array {
    $st = db()->prepare('SELECT * FROM session_notes WHERE session_id=? ORDER BY position, id');
    $st->execute([$sid]);
    return array_map('snote_out', $st->fetchAll());
}
/** End the open sessions of the campaign (or only session $id) at the current shift: its day, and the shift itself. */
function sessions_end_all(int $cid, ?int $id = null): void {
    $c = campaign_row($cid);
    $now = (int)$c['current_shift'];
    $day = floordiv($now, slots_per_day(dec($c['calendar_json'])));
    $where = $id === null ? 'campaign_id=?' : 'id=?';
    db()->prepare("UPDATE play_sessions SET last_day=GREATEST(first_day, ?), last_shift=IF(first_shift IS NULL, NULL, GREATEST(first_shift, ?))
        WHERE $where AND last_day IS NULL")->execute([$day, $now, $id ?? $cid]);
}
/** A new open session (any open one ended first), numbered after the campaign's last. It starts on the current shift
 * when that falls on $firstDay, and on the day's first shift otherwise. */
function session_create(int $cid, int $firstDay, string $title = '', ?string $playedOn = null): int {
    sessions_end_all($cid);
    $st = db()->prepare('SELECT COALESCE(MAX(number), 0) + 1 FROM play_sessions WHERE campaign_id=? FOR UPDATE');
    $st->execute([$cid]);
    $number = (int)$st->fetchColumn();
    $c = campaign_row($cid);
    $now = (int)$c['current_shift'];
    $spd = slots_per_day(dec($c['calendar_json']));
    db()->prepare('INSERT INTO play_sessions (campaign_id, number, title, played_on, first_day, first_shift, created_by) VALUES (?,?,?,?,?,?,?)')
        ->execute([$cid, $number, $title, $playedOn ?? date('Y-m-d'), $firstDay, floordiv($now, $spd) === $firstDay ? $now : $firstDay * $spd, me()['id']]);
    return (int)db()->lastInsertId();
}
/** A session's first and last shifts after its days were changed to $first and $last: a shift that no longer falls on
 * its day becomes that day's first (or last) shift; a session from before 027 keeps none. */
function session_shifts_for_days(array $s, int $cid, int $first, ?int $last): array {
    if ($s['first_shift'] === null) return [null, null];
    $spd = slots_per_day(dec(campaign_row($cid)['calendar_json']));
    $a = (int)$s['first_shift'];
    if (floordiv($a, $spd) !== $first) $a = $first * $spd;
    if ($last === null) return [$a, null];
    $b = $s['last_shift'] === null ? ($last + 1) * $spd - 1 : (int)$s['last_shift'];
    if (floordiv($b, $spd) !== $last) $b = ($last + 1) * $spd - 1;
    return [$a, max($a, $b)];
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
    case 'sessions': // newest first; a player gets the published ones only
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $st = db()->prepare('SELECT * FROM play_sessions WHERE campaign_id=?' . ($isGm ? '' : ' AND is_published=1') . ' ORDER BY number DESC');
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
        // GMs get the old note rows too while the notes haven't been saved as text, for the page to fold in
        out(['session' => session_out($s, true, $isGm) + ['files' => $files], 'uploads' => upload_info()]
            + ($isGm ? ['notes' => ($s['notes_text'] ?? null) === null ? snotes((int)$s['id']) : []] : []));

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
            [$fs, $ls] = session_shifts_for_days($s, $cid, $first, $last);
            db()->prepare('UPDATE play_sessions SET first_shift=?, last_shift=? WHERE id=?')->execute([$fs, $ls, $s['id']]);
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

    case 'session_notes_save': // GMs: the notes box's text, saved as it is typed. base is the text this copy last had from the
        // server (null for a session never saved as text); when the notes have changed since, nothing is saved (stale)
        $cid = cid();
        need_gm($cid);
        $s = session_row($cid, int_in(p('id'), 1));
        $text = (string)str_in(p('notes_text'), 500_000, false);
        $base = p('base') === null ? null : (string)str_in(p('base'), 500_000, false);
        $st = db()->prepare('UPDATE play_sessions SET notes_text=? WHERE id=? AND notes_text <=> ?');
        $st->execute([$text, $s['id'], $base]);
        if (!$st->rowCount()) {                       // no row changed: already this text, or changed elsewhere
            $now = session_row($cid, (int)$s['id'])['notes_text'];
            if ($now !== $text) fail('These notes were changed in another tab or on another device after this page loaded', 409, 'stale');
        }
        out(['ok' => true, 'notes_text' => $text]);

    case 'session_end': // GMs: the open session (or the one named) ends on the current shift
        $cid = cid();
        need_gm($cid);
        if (p('id')) sessions_end_all($cid, (int)session_row($cid, int_in(p('id'), 1))['id']);
        else sessions_end_all($cid);
        out(['ok' => true]);

    case 'session_delete': // GMs: the session and its notes
        $cid = cid();
        need_gm($cid);
        $s = session_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM play_sessions WHERE id=?')->execute([$s['id']]);
        attachments_purge($cid, 'session', (int)$s['id']);   // files have no foreign key to cascade
        out(['ok' => true]);
    }
}
