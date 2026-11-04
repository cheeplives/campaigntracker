<?php
/**
 * The Library: the campaign's books, journals and notes ("tomes").
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

// ---------- the Library ----------
// The campaign's books, journals and notes ("tomes"): a title, a short description and a rich-text body. Every member,
// GM or player, can add one and change any of them; deleting is for whoever added it, or a GM, as with Encyclopedia entries.

const TOME_KINDS = ['book', 'journal', 'note'];
function tome_row(int $cid, int $id): array {
    return row_of('library_tomes', $cid, $id, 'Tome not found');
}
/** A tome as the browser gets it, without its secret paragraphs for a player; the body only when $full (the list sends a word count instead). */
function tome_out(array $t, bool $full, bool $isGm): array {
    $t['body'] = rich_for($t['body'], $isGm);
    $plain = rich_html_plain((string)$t['body']);
    $o = ['id' => (int)$t['id'], 'kind' => $t['kind'], 'title' => $t['title'], 'description' => (string)$t['description'],
        'version' => (int)$t['version'], 'created_by' => $t['created_by'] !== null ? (int)$t['created_by'] : null,
        'created_at' => $t['created_at'], 'updated_at' => $t['updated_at'], 'author' => $t['author'] ?? null, 'player' => $t['player'] ?? null,
        'editor' => $t['editor'] ?? null, 'words' => $plain === '' ? 0 : count(preg_split('/\s+/u', $plain))];
    if ($full) $o['body'] = (string)$t['body'];
    return $o;
}
/** Tomes of campaign $cid with who added and who last changed each (character name first); one tome when $id is given. */
function tomes(int $cid, ?int $id = null): array {
    $st = db()->prepare('SELECT t.*, ' . AUTHOR_SQL . ' AS author, u.display_name AS player, COALESCE(NULLIF(m2.character_name, \'\'), u2.display_name) AS editor
        FROM library_tomes t LEFT JOIN users u ON u.id=t.created_by LEFT JOIN campaign_members m ON m.campaign_id=t.campaign_id AND m.user_id=t.created_by
        LEFT JOIN users u2 ON u2.id=t.updated_by LEFT JOIN campaign_members m2 ON m2.campaign_id=t.campaign_id AND m2.user_id=t.updated_by
        WHERE t.campaign_id=?' . ($id ? ' AND t.id=?' : '') . ' ORDER BY t.title');
    $st->execute($id ? [$cid, $id] : [$cid]);
    return $st->fetchAll();
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function library_action(string $action): void {
    switch ($action) {
    case 'library':
        $cid = cid();
        $isGm = role($cid) === 'gm';
        out(['tomes' => array_map(fn($t) => tome_out($t, false, $isGm), tomes($cid))]);

    case 'tome':
        $cid = cid();
        $role = role($cid);
        $t = tomes($cid, int_in($_GET['id'] ?? null, 1))[0] ?? fail('Tome not found', 404);
        $files = [];
        $st = db()->prepare("SELECT * FROM attachments WHERE campaign_id=? AND parent_type='library' AND parent_id=?" . ($role === 'gm' ? '' : ' AND is_secret=0') . ' ORDER BY id');
        $st->execute([$cid, (int)$t['id']]);
        $files = array_map('attachment_out', $st->fetchAll());
        out(['tome' => tome_out($t, true, $role === 'gm') + ['files' => $files], 'uploads' => upload_info()]);

    case 'tome_save':
        // A new tome, or a change to one, by any member. version is the copy the browser opened: when someone else has
        // saved since, the save is refused so it doesn't overwrite their words.
        $cid = cid();
        $isGm = role($cid) === 'gm';
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? tome_row($cid, $id) : null;
        $kind = (string)p('kind', $old['kind'] ?? 'book');
        if (!in_array($kind, TOME_KINDS, true)) fail('Pick a book, a journal or a note');
        $title = trim(preg_replace('/\s+/u', ' ', (string)str_in(p('title'), 200, false)));
        if ($title === '') fail('Title required');
        $desc = trim((string)str_in(p('description'), 1000)) ?: null;
        $body = rich_html_clean((string)str_in(p('body'), 2_000_000));
        // a player never had the GM's secret paragraphs to send back, so they are kept from the stored copy
        $body = ($isGm ? $body : rich_keep_secrets($old['body'] ?? null, $body)) ?: null;
        $uid = me()['id'];
        if ($old) {
            $st = db()->prepare('UPDATE library_tomes SET kind=?, title=?, description=?, body=?, version=version+1, updated_by=? WHERE id=? AND version=?');
            $st->execute([$kind, $title, $desc, $body, $uid, $id, int_in(p('version'), 1)]);
            if (!$st->rowCount()) {
                $now = tomes($cid, $id)[0];
                fail(($now['editor'] ?: 'Someone') . ' saved this tome after you opened it. Copy what you wrote, reload, and add it again', 409, 'stale');
            }
        } else {
            db()->prepare('INSERT INTO library_tomes (campaign_id, kind, title, description, body, created_by, updated_by) VALUES (?,?,?,?,?,?,?)')
                ->execute([$cid, $kind, $title, $desc, $body, $uid, $uid]);
            $id = (int)db()->lastInsertId();
        }
        out(['ok' => true, 'tome' => tome_out(tomes($cid, $id)[0], true, $isGm)]);

    case 'tome_delete':
        $cid = cid();
        $role = role($cid);
        $t = tome_row($cid, int_in(p('id'), 1));
        if ($role !== 'gm' && (int)$t['created_by'] !== me()['id']) fail('Only a GM can delete a tome someone else added', 403);
        db()->prepare('DELETE FROM library_tomes WHERE id=?')->execute([$t['id']]);
        attachments_purge($cid, 'library', (int)$t['id']);   // files have no foreign key to cascade
        out(['ok' => true]);
    }
}
