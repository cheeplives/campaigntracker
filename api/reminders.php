<?php
/**
 * Reminders: notes due at a time in the campaign, for oneself, the GMs or everyone.
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

// ---------- reminders ----------
const REMINDER_AUDIENCES = ['me', 'gm', 'all'];
/** once: pops up when the clock reaches it; shift: on every shift (or hour) from then on, until dismissed or done. */
const REMINDER_REPEATS = ['once', 'shift'];
/** SQL condition for the reminders user $uid may see (alias r): their own, the GMs' if they are a GM, and everyone's. */
function reminder_visible_sql(bool $isGm): string {
    return "(r.audience='all' OR r.created_by=?" . ($isGm ? " OR r.audience='gm'" : '') . ')';
}
/** A reminder this user may change: one they made, or as a GM one shared with the GMs or everyone. Fails otherwise. */
function editable_reminder(int $cid, int $id, string $role): array {
    $st = db()->prepare('SELECT id, due_shift, repeat_every, audience, created_by, done_at FROM reminders WHERE id=? AND campaign_id=?');
    $st->execute([$id, $cid]);
    $r = $st->fetch();
    $mine = $r && (int)$r['created_by'] === me()['id'];
    if (!$r || (!$mine && !($role === 'gm' && $r['audience'] !== 'me'))) fail('Reminder not found', 404);
    return $r;
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function reminders_action(string $action): void {
    switch ($action) {
    case 'reminders':
        // Everything this user may see, with whether it is due (the clock has reached it and it isn't done), whether they
        // dismissed it for good, and the shift they last saw a repeating one on (seen_shift: it stays away until the clock moves).
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $uid = me()['id'];
        $now = (int)campaign_row($cid)['current_shift'];
        $st = db()->prepare('SELECT r.id, r.due_shift, r.repeat_every, r.title, r.body, r.audience, r.created_by, ' . AUTHOR_SQL . ' AS author, ' . user_name_sql() . ' AS player,
                (r.done_at IS NOT NULL) AS done, (dm.user_id IS NOT NULL AND dm.seen_shift IS NULL) AS dismissed, dm.seen_shift
            FROM reminders r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN campaign_members m ON m.campaign_id=r.campaign_id AND m.user_id=r.created_by
            LEFT JOIN reminder_dismissals dm ON dm.reminder_id=r.id AND dm.user_id=?
            WHERE r.campaign_id=? AND ' . reminder_visible_sql($isGm) . ' ORDER BY r.due_shift, r.id');
        $st->execute([$uid, $cid, $uid]);
        $rows = array_map(function ($r) use ($now) {
            foreach (['id', 'due_shift'] as $k) $r[$k] = (int)$r[$k];
            $r['created_by'] = $r['created_by'] !== null ? (int)$r['created_by'] : null;
            $r['dismissed'] = (bool)$r['dismissed'];
            $r['done'] = (bool)$r['done'];
            $r['seen_shift'] = $r['seen_shift'] !== null ? (int)$r['seen_shift'] : null;
            $r['due'] = $r['due_shift'] <= $now && !$r['done'];
            return $r;
        }, $st->fetchAll());
        out(['reminders' => $rows, 'current_shift' => $now]);

    case 'reminder_save':
        // Anyone can keep reminders for themselves; a GM can also share one with the GMs or with everyone.
        $cid = cid();
        $role = role($cid);
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? editable_reminder($cid, $id, $role) : null;
        $title = trim((string)str_in(p('title'), 200, false));
        if ($title === '') fail('Give the reminder a title');
        $audience = (string)p('audience', 'me');
        if (!in_array($audience, REMINDER_AUDIENCES, true)) fail('Pick who the reminder is for');
        if ($role !== 'gm' && $audience !== 'me') fail('Only a GM can share a reminder', 403);
        $repeat = (string)p('repeat_every', $old['repeat_every'] ?? 'once');
        if (!in_array($repeat, REMINDER_REPEATS, true)) fail('Pick how often the reminder pops up');
        $due = int_in(p('due_shift'));
        $moved = !$old || (int)$old['due_shift'] !== $due;
        if ($moved && $due <= (int)campaign_row($cid)['current_shift']) fail('Pick a time after now: the clock has already passed that one');
        db()->beginTransaction();
        if ($old) {
            db()->prepare('UPDATE reminders SET due_shift=?, repeat_every=?, title=?, body=?, audience=? WHERE id=?')->execute([$due, $repeat, $title, str_in(p('body'), 5000), $audience, $id]);
            // moved to a new time: it pops up again for everyone, even those who dismissed it, and is no longer done
            if ($moved) {
                db()->prepare('DELETE FROM reminder_dismissals WHERE reminder_id=?')->execute([$id]);
                db()->prepare('UPDATE reminders SET done_at=NULL WHERE id=?')->execute([$id]);
            }
        } else {
            db()->prepare('INSERT INTO reminders (campaign_id, due_shift, repeat_every, title, body, audience, created_by) VALUES (?,?,?,?,?,?,?)')
                ->execute([$cid, $due, $repeat, $title, str_in(p('body'), 5000), $audience, me()['id']]);
            $id = (int)db()->lastInsertId();
        }
        if ($role === 'gm' && ($audience !== 'me' || ($old && $old['audience'] !== 'me'))) touch_campaign($cid);
        db()->commit();
        out(['ok' => true, 'id' => $id]);

    case 'reminder_delete':
        $cid = cid();
        $role = role($cid);
        $r = editable_reminder($cid, int_in(p('id'), 1), $role);
        db()->prepare('DELETE FROM reminders WHERE id=?')->execute([$r['id']]);
        if ($role === 'gm' && $r['audience'] !== 'me') touch_campaign($cid);
        out(['ok' => true]);

    case 'reminder_dismiss':
        // This user has read these reminders: they stop popping up for them (and only them). With seen, only for now:
        // a repeating reminder seen on this shift comes back on the next one (one dismissed for good stays dismissed).
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $uid = me()['id'];
        $ids = array_slice(array_map('intval', (array)p('ids', [])), 0, 200);
        $now = (int)campaign_row($cid)['current_shift'];
        $seen = db()->prepare('SELECT r.id FROM reminders r WHERE r.id=? AND r.campaign_id=? AND ' . reminder_visible_sql($isGm));
        $ins = p('seen')
            ? db()->prepare('INSERT INTO reminder_dismissals (reminder_id, user_id, seen_shift) VALUES (?,?,?) ON DUPLICATE KEY UPDATE seen_shift=IF(seen_shift IS NULL, NULL, ?)')
            : db()->prepare('INSERT INTO reminder_dismissals (reminder_id, user_id, seen_shift) VALUES (?,?,NULL) ON DUPLICATE KEY UPDATE seen_shift=NULL');
        foreach ($ids as $rid) {
            $seen->execute([$rid, $cid, $uid]);
            if ($seen->fetchColumn()) $ins->execute(p('seen') ? [$rid, $uid, $now, $now] : [$rid, $uid]);
        }
        out(['ok' => true]);

    case 'reminder_done':
        // Whoever may change a reminder marks it done (it stops popping up for everyone it is for), or opens it again.
        $cid = cid();
        $role = role($cid);
        $r = editable_reminder($cid, int_in(p('id'), 1), $role);
        $done = (bool)p('done', 1);
        db()->prepare('UPDATE reminders SET done_at=' . ($done ? 'NOW()' : 'NULL') . ' WHERE id=?')->execute([$r['id']]);
        // opened again: it pops up again for those who dismissed it
        if (!$done) db()->prepare('DELETE FROM reminder_dismissals WHERE reminder_id=?')->execute([$r['id']]);
        if ($role === 'gm' && $r['audience'] !== 'me') touch_campaign($cid);
        out(['ok' => true]);
    }
}
