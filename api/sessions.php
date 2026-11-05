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
// which cover their first and last days whole. session_shifts (migration 028) holds the shifts a session takes in
// outside that run: a flashback, or a split party's other half played another night.

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
/** The shifts each of these sessions takes in outside its run, ascending: session id => [abs shift, ...]. */
function session_extras(array $ids): array {
    $ids = array_values(array_unique(array_map('intval', $ids)));
    if (!$ids) return [];
    $st = db()->prepare('SELECT session_id, abs_shift FROM session_shifts WHERE session_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ') ORDER BY abs_shift');
    $st->execute($ids);
    $out = [];
    foreach ($st->fetchAll() as $r) $out[(int)$r['session_id']][] = (int)$r['abs_shift'];
    return $out;
}
/** The run a session covers, as absolute shifts [first, last]: an older session (no first_shift) its days whole, and an
 * open one up to the clock ($now). */
function session_span(array $s, int $spd, int $now): array {
    $a = $s['first_shift'] !== null ? (int)$s['first_shift'] : (int)$s['first_day'] * $spd;
    $b = $s['last_shift'] !== null ? (int)$s['last_shift'] : ($s['last_day'] !== null ? ((int)$s['last_day'] + 1) * $spd - 1 : $now);
    return [$a, max($a, $b)];
}
/** A session as the browser gets it: the summary only when $full, without its secret paragraphs for a player.
 * $extra: its shifts outside the run, when already looked up (session_extras). */
function session_out(array $s, bool $full, bool $isGm, ?array $extra = null): array {
    $o = ['id' => (int)$s['id'], 'number' => (int)$s['number'], 'title' => $s['title'], 'played_on' => $s['played_on'],
        'first_day' => (int)$s['first_day'], 'last_day' => $s['last_day'] === null ? null : (int)$s['last_day'],
        'first_shift' => $s['first_shift'] === null ? null : (int)$s['first_shift'],
        'last_shift' => $s['last_shift'] === null ? null : (int)$s['last_shift'],
        'is_published' => (bool)(int)$s['is_published'], 'version' => (int)$s['version'], 'undated' => (bool)(int)($s['undated'] ?? 0),
        'extra_shifts' => $extra ?? (session_extras([(int)$s['id']])[(int)$s['id']] ?? [])];
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
/** A new session, numbered after the campaign's last. Open (any open one ended first), it starts on $firstShift, or on the
 * current shift when that falls on $firstDay and the day's first shift otherwise. Given $lastShift too, it is written up
 * afterwards for shifts already played: it ends there, and an open session stays open. */
function session_create(int $cid, int $firstDay, string $title = '', ?string $playedOn = null, ?int $firstShift = null, ?int $lastShift = null): int {
    if ($lastShift === null) sessions_end_all($cid);
    $st = db()->prepare('SELECT COALESCE(MAX(number), 0) + 1 FROM play_sessions WHERE campaign_id=? FOR UPDATE');
    $st->execute([$cid]);
    $number = (int)$st->fetchColumn();
    $c = campaign_row($cid);
    $now = (int)$c['current_shift'];
    $spd = slots_per_day(dec($c['calendar_json']));
    $first = $firstShift ?? (floordiv($now, $spd) === $firstDay ? $now : $firstDay * $spd);
    $last = $lastShift === null ? null : max($first, $lastShift);
    db()->prepare('INSERT INTO play_sessions (campaign_id, number, title, played_on, first_day, last_day, first_shift, last_shift, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
        ->execute([$cid, $number, $title, $playedOn ?? date('Y-m-d'), floordiv($first, $spd), $last === null ? null : floordiv($last, $spd), $first, $last, me()['id']]);
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
/** The sessions that cover some of day $ad of campaign row $c (a player: the published ones), for the day's shift chips:
 * [id, number, title, slots: the day's shifts it covers]. */
function day_sessions(int $cid, array $c, int $ad, bool $isGm): array {
    $spd = camp_spd($c);
    $lo = $ad * $spd; $hi = $lo + $spd - 1;
    $st = db()->prepare('SELECT * FROM play_sessions WHERE campaign_id=? AND first_day <= ? AND (last_day IS NULL OR last_day >= ?)' . ($isGm ? '' : ' AND is_published=1')
        . ' UNION SELECT s.* FROM play_sessions s JOIN session_shifts x ON x.session_id=s.id WHERE s.campaign_id=? AND x.abs_shift BETWEEN ? AND ?' . ($isGm ? '' : ' AND s.is_published=1')
        . ' ORDER BY number');
    $st->execute([$cid, $ad, $ad, $cid, $lo, $hi]);
    $rows = $st->fetchAll();
    $extras = session_extras(array_column($rows, 'id'));
    $out = [];
    foreach ($rows as $s) {
        [$a, $b] = session_span($s, $spd, (int)$c['current_shift']);
        $slots = [];
        if (!(int)($s['undated'] ?? 0)) for ($x = max($a, $lo); $x <= min($b, $hi); $x++) $slots[] = $x - $lo;   // undated: its extra shifts alone
        foreach ($extras[(int)$s['id']] ?? [] as $x) if ($x >= $lo && $x <= $hi) $slots[] = $x - $lo;
        if (!$slots) continue;
        sort($slots);
        $out[] = ['id' => (int)$s['id'], 'number' => (int)$s['number'], 'title' => $s['title'], 'slots' => array_values(array_unique($slots))];
    }
    return $out;
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
        $rows = $st->fetchAll();
        $extras = session_extras(array_column($rows, 'id'));
        out(['sessions' => array_map(fn($x) => session_out($x, false, $isGm, $extras[(int)$x['id']] ?? []), $rows)]);

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
            // in-game dates set by hand (or reopening it) date it again; undated: true takes them away
            $undated = array_key_exists('undated', body()) ? (p('undated') ? 1 : 0)
                : (array_key_exists('first_day', body()) || array_key_exists('last_day', body()) || p('reopen') ? 0 : (int)($s['undated'] ?? 0));
            db()->prepare('UPDATE play_sessions SET title=?, played_on=?, first_day=?, last_day=?, is_published=?, undated=? WHERE id=?')
                ->execute([$title, $played, $first, $last, $pub, $undated, $s['id']]);
            [$fs, $ls] = session_shifts_for_days($s, $cid, $first, $last);
            db()->prepare('UPDATE play_sessions SET first_shift=?, last_shift=? WHERE id=?')->execute([$fs, $ls, $s['id']]);
            $id = (int)$s['id'];
        } else {
            db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]); // one new session at a time
            $c = campaign_row($cid);
            $spd = slots_per_day(dec($c['calendar_json']));
            // first_shift: started at a shift picked (+ New session's Starting when?, or A new session on a shift); with
            // last_shift too, written up afterwards for shifts already played
            $fs = p('first_shift') === null ? null : int_in(p('first_shift'));
            $ls = $fs === null || p('last_shift') === null ? null : int_in(p('last_shift'));
            $first = $fs !== null ? floordiv($fs, $spd) : (array_key_exists('first_day', body()) ? int_in(p('first_day')) : floordiv((int)$c['current_shift'], $spd));
            $id = session_create($cid, $first, trim((string)str_in(p('title'), 200)), date_in(p('played_on')), $fs, $ls);
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

    case 'session_shift_add': // GMs: a shift for the session to take in; one inside its run is already covered
        $cid = cid();
        need_gm($cid);
        $s = session_row($cid, int_in(p('id'), 1));
        $a = int_in(p('abs_shift'));
        $c = campaign_row($cid);
        [$from, $to] = session_span($s, slots_per_day(dec($c['calendar_json'])), (int)$c['current_shift']);
        if ((int)($s['undated'] ?? 0) || $a < $from || $a > $to) {
            $st = db()->prepare('SELECT COUNT(*) FROM session_shifts WHERE session_id=?');
            $st->execute([$s['id']]);
            if ((int)$st->fetchColumn() >= 500) fail('A session can take in at most 500 shifts outside its run');
            db()->prepare('INSERT IGNORE INTO session_shifts (session_id, abs_shift) VALUES (?,?)')->execute([$s['id'], $a]);
        }
        out(['ok' => true, 'session' => session_out(session_row($cid, (int)$s['id']), false, true)]);

    case 'session_shift_remove': // GMs: a shift outside the run taken back out of the session
        $cid = cid();
        need_gm($cid);
        $s = session_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM session_shifts WHERE session_id=? AND abs_shift=?')->execute([$s['id'], int_in(p('abs_shift'))]);
        out(['ok' => true, 'session' => session_out(session_row($cid, (int)$s['id']), false, true)]);

    case 'session_delete': // GMs: the session and its notes
        $cid = cid();
        need_gm($cid);
        $s = session_row($cid, int_in(p('id'), 1));
        db()->prepare('DELETE FROM play_sessions WHERE id=?')->execute([$s['id']]);
        attachments_purge($cid, 'session', (int)$s['id']);   // files have no foreign key to cascade
        out(['ok' => true]);
    }
}
