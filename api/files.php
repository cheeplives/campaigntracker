<?php
/**
 * Pictures and files attached to entries, tomes, sessions, maps and tokens: uploads, storage on disk and credits.
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

// ---------- pictures and files ----------
// A file hangs off a parent (an Encyclopedia entry, for now) and is seen by exactly the people who see that parent:
// a file on a secret entry, or one a GM marked GM only, never reaches players. Uploads are checked by their contents
// (images must decode as the type they claim), kept outside the web root under a random name, and only sent by the
// 'file' action below with headers that stop the browser running or sniffing them.

/** What a file can hang off. Add a kind here and a case to attachment_parent(). */
const ATTACHMENT_PARENTS = ['encyclopedia', 'library', 'session', 'map', 'token'];
/** The types allowed, by the type the contents show: [extensions, 'image' (shown on the page) or 'file' (downloaded)].
 * No SVG or HTML: both can carry scripts. Text files are checked to be text and always downloaded. */
const UPLOAD_TYPES = [
    'image/jpeg' => [['jpg', 'jpeg'], 'image'], 'image/png' => [['png'], 'image'], 'image/gif' => [['gif'], 'image'],
    'image/webp' => [['webp'], 'image'], 'application/pdf' => [['pdf'], 'file'], 'text/plain' => [['txt', 'md', 'csv'], 'file'],
];
const ATTACHMENTS_PER_PARENT = 50;

/** The thing a file hangs off, checked: this member must be able to see it (or it fails as not found). secret: only
 * GMs may see it, so its files are GM only too; manage_any: every member may change or remove its files, not only
 * whoever uploaded them and the GMs; gm_adds: only GMs may add files to it. */
function attachment_parent(int $cid, string $type, int $id, string $role): array {
    switch ($type) {
        case 'encyclopedia':
            $e = entry_row($cid, $id, $role);
            return ['secret' => (bool)(int)$e['is_secret'], 'manage_any' => false];
        case 'library':                                   // every member reads and changes every tome, and its files
            tome_row($cid, $id);
            return ['secret' => false, 'manage_any' => true];
        case 'session':                                   // a map or handout from a game night: GMs add, players see a published one's
            session_row($cid, $id, $role === 'gm');
            return ['secret' => false, 'manage_any' => false, 'gm_adds' => true];
        case 'map':                                       // a map's picture: GMs add, and a GM-only map's is theirs alone
            $m = map_row($cid, $id, $role === 'gm');
            return ['secret' => (bool)(int)$m['is_secret'], 'manage_any' => false, 'gm_adds' => true];
        case 'token':                                     // a token's picture: GMs add; players may see it unless the token or its entry is GM only
            $t = token_row($cid, $id);
            if ($role !== 'gm' && token_hidden($t)) fail('Token not found', 404);   // not even its list of files
            return ['secret' => token_hidden($t), 'manage_any' => false, 'gm_adds' => true];
    }
    fail('Files can\'t be attached to that', 400);
}
/** A found picture's credit, null for a file uploaded by hand. */
function attachment_credit(array $a): ?array {
    if (($a['credit_license'] ?? null) === null && ($a['credit_source'] ?? null) === null) return null;
    return ['title' => $a['credit_title'], 'author' => $a['credit_author'], 'author_url' => $a['credit_author_url'], 'license' => $a['credit_license'],
        'license_url' => $a['credit_license_url'], 'source' => $a['credit_source'], 'source_url' => $a['credit_source_url']];
}
function attachment_out(array $a): array {
    $id = (int)$a['id'];
    return ['id' => $id, 'parent_type' => $a['parent_type'], 'parent_id' => (int)$a['parent_id'], 'name' => $a['original_name'],
        'mime' => $a['mime'], 'kind' => $a['kind'], 'size' => (int)$a['size_bytes'],
        'width' => $a['width'] !== null ? (int)$a['width'] : null, 'height' => $a['height'] !== null ? (int)$a['height'] : null,
        'caption' => $a['caption'], 'is_secret' => (bool)(int)$a['is_secret'], 'created_by' => $a['created_by'] !== null ? (int)$a['created_by'] : null,
        'credit' => attachment_credit($a), 'embed' => $a['kind'] === 'embed' ? ['url' => $a['embed_url'], 'gone' => ($a['embed_src'] ?? null) === null] : null,
        'url' => 'api/index.php?' . http_build_query(['a' => 'file', 'cid' => (int)$a['campaign_id'], 'id' => $id])];
}
/** The files on every Encyclopedia entry this member may see. */
function entry_files(int $cid, bool $isGm): array {
    $st = db()->prepare("SELECT a.* FROM attachments a JOIN encyclopedia_entries e ON e.id=a.parent_id AND e.campaign_id=a.campaign_id
        WHERE a.campaign_id=? AND a.parent_type='encyclopedia'" . ($isGm ? '' : ' AND a.is_secret=0 AND e.is_secret=0') . ' ORDER BY a.id');
    $st->execute([$cid]);
    return array_map('attachment_out', $st->fetchAll());
}
/** A file of campaign $cid this member may see, with its parent's checks, or fail. */
function attachment_row(int $cid, int $id, string $role): array {
    $a = row_of('attachments', $cid, $id, 'File not found');
    $parent = attachment_parent($cid, $a['parent_type'], (int)$a['parent_id'], $role);
    if ($role !== 'gm' && ($parent['secret'] || (int)$a['is_secret'])) fail('File not found', 404);
    return $a + ['_parent' => $parent];
}
/** Whether this member may change or remove file $a: whoever uploaded it, GMs, and anyone when its parent says so. */
function attachment_mine(array $a, string $role): bool {
    return $role === 'gm' || $a['_parent']['manage_any'] || ($a['created_by'] !== null && (int)$a['created_by'] === me()['id']);
}
/** Delete files and their rows: those of one parent, or with $type null every file of the campaign. The rows go first,
 * so a file that can't be removed from disk is only left over, never served. */
function attachments_purge(int $cid, ?string $type = null, ?int $id = null): void {
    if ($type === null) attachments_drop('campaign_id=?', [$cid]);
    else attachments_drop('campaign_id=? AND parent_type=? AND parent_id=?', [$cid, $type, $id]);
}
/** Delete one file of campaign $cid, its row and then its stored file. */
function attachment_remove(int $cid, int $id): void {
    attachments_drop('campaign_id=? AND id=?', [$cid, $id]);
}
/** The one place files are deleted: the rows matching $where, then their stored files. */
function attachments_drop(string $where, array $args): void {
    $st = db()->prepare("SELECT stored_name FROM attachments WHERE $where");
    $st->execute($args);
    $names = $st->fetchAll(PDO::FETCH_COLUMN);
    if (!$names) return;
    db()->prepare("DELETE FROM attachments WHERE $where")->execute($args);
    $dir = upload_dir()['dir'];
    if ($dir) foreach ($names as $n) if (preg_match('/^[0-9a-f]{32}$/', (string)$n)) @unlink("$dir/$n");
}
/** An uploaded file's name, safe to keep and to send back: no folders, no control characters, 200 characters at most. */
function upload_name(string $name): string {
    $name = preg_replace('/[\x00-\x1F\x7F"\\\\\/:*?<>|]+/u', '_', basename(str_replace('\\', '/', $name))) ?? '';
    $name = trim($name, " .\t");
    if ($name === '' || !mb_check_encoding($name, 'UTF-8')) $name = 'file';
    return mb_strlen($name) > 200 ? mb_substr($name, -200) : $name;
}
/** [mime, kind, width, height] of an uploaded file, from its contents and its extension, or fail when it isn't one of
 * UPLOAD_TYPES. A file whose contents and extension disagree is refused: a .jpg must be a JPEG. */
function upload_type(string $path, string $name): array {
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $mime = class_exists('finfo') ? (string)(new finfo(FILEINFO_MIME_TYPE))->file($path) : '';
    $allowed = 'Pictures can be JPEG, PNG, GIF or WebP; files can be PDF or plain text (.txt, .md, .csv)';
    if (in_array($ext, ['txt', 'md', 'csv'], true)) {
        // Plain text whatever finfo calls it (text/x-markdown, text/csv…), as long as it is text and not markup.
        $head = (string)file_get_contents($path, false, null, 0, 65536);
        if ($mime !== '' && !str_starts_with($mime, 'text/') && $mime !== 'application/csv' && $mime !== 'application/x-empty') fail("That isn't a text file. $allowed", 415, 'unsupported_type');
        if (str_contains($head, "\0") || preg_match('/^\s*<(?:!doctype|html|svg|script)/i', $head)) fail("That isn't a text file. $allowed", 415, 'unsupported_type');
        return ['text/plain', 'file', null, null];
    }
    foreach (UPLOAD_TYPES as $m => [$exts, $kind]) {
        if (!in_array($ext, $exts, true)) continue;
        if ($kind === 'image') {
            $info = @getimagesize($path);
            if (!$info || ($info['mime'] ?? '') !== $m || ($mime !== '' && $mime !== $m) || $info[0] < 1 || $info[1] < 1)
                fail("That file isn't a working ." . $ext . ' picture', 415, 'unsupported_type');
            return [$m, 'image', min(65535, (int)$info[0]), min(65535, (int)$info[1])];
        }
        if ($mime !== $m && !($m === 'application/pdf' && str_starts_with((string)file_get_contents($path, false, null, 0, 5), '%PDF-')))
            fail("That file isn't a working ." . $ext . ' file', 415, 'unsupported_type');
        return [$m, $kind, null, null];
    }
    fail("Files of that type can't be uploaded. $allowed", 415, 'unsupported_type');
}
/** What the browser needs before it sends a file: whether uploads work here, the size limit and the types allowed. */
function upload_info(): array {
    $up = upload_dir();
    $out = ['ready' => $up['dir'] !== null, 'max_bytes' => upload_max_bytes(),
        'accept' => implode(',', array_merge(array_keys(UPLOAD_TYPES), array_map(fn($e) => ".$e", array_merge(...array_column(UPLOAD_TYPES, 0)))))];
    // The folder's path is for whoever runs the server, not for every player.
    if (!$out['ready']) $out['problem'] = me()['is_admin'] ? 'Uploads aren\'t set up on this server: ' . $up['problem'] : 'Uploads aren\'t set up on this server yet. Ask whoever runs it.';
    return $out;
}

/** The file just uploaded as the form's `file` field, checked: [its $_FILES entry, its size in bytes], or fail. */
function upload_received(): array {
    $max = upload_max_bytes();
    $limit = round($max / 1048576, 1) . ' MB';
    $f = $_FILES['file'] ?? null;
    if (!is_array($f) || is_array($f['error'] ?? null)) fail('Pick a file to upload');
    if (in_array($f['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) fail("That file is too big: files can be $limit at most", 413);
    if ($f['error'] === UPLOAD_ERR_NO_FILE) fail('Pick a file to upload');
    if ($f['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) { error_log('upload failed: error ' . $f['error']); fail('The upload didn\'t arrive. Try again', 500); }
    $size = (int)filesize($f['tmp_name']);
    if ($size < 1) fail('That file is empty');
    if ($size > $max) fail("That file is too big: files can be $limit at most", 413);
    if (!upload_dir()['dir']) fail(upload_info()['problem'], 409, 'uploads_unavailable');
    return [$f, $size];
}
/** Fail unless parent ($type, $pid) has room for one more file and the campaign for $size more bytes. */
function attachment_room(int $cid, string $type, int $pid, int $size): void {
    $st = db()->prepare('SELECT COUNT(*) FROM attachments WHERE campaign_id=? AND parent_type=? AND parent_id=?');
    $st->execute([$cid, $type, $pid]);
    if ((int)$st->fetchColumn() >= ATTACHMENTS_PER_PARENT) fail('There are ' . ATTACHMENTS_PER_PARENT . ' files here already. Remove one first', 409);
    $quota = max(1, (int)(cfg('uploads', [])['campaign_mb'] ?? 500)) << 20;
    $st = db()->prepare('SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE campaign_id=?');
    $st->execute([$cid]);
    if ((int)$st->fetchColumn() + $size > $quota) fail('This campaign\'s files are using all of its ' . ($quota >> 20) . ' MB. Remove some first', 413);
    // And per person, across every campaign, since anyone can start as many campaigns as they like.
    $mine = max(1, (int)(cfg('uploads', [])['user_mb'] ?? 1000)) << 20;
    $st = db()->prepare('SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE created_by=?');
    $st->execute([me()['id']]);
    if ((int)$st->fetchColumn() + $size > $mine) fail('Your files are using all of your ' . ($mine >> 20) . ' MB across your campaigns. Remove some first', 413);
}
/** Keep the file at $tmp (already checked) under a new random name and add its row; $row holds the columns besides
 * campaign_id, stored_name and created_by. $tmp null: a row with no file (an embed). Returns the row as the browser gets it. */
function attachment_store(int $cid, ?string $tmp, array $row, bool $uploaded = false): array {
    $stored = bin2hex(random_bytes(16));
    $dest = null;
    if ($tmp !== null) {
        $up = upload_dir();
        if (!$up['dir']) fail(upload_info()['problem'], 409, 'uploads_unavailable');
        $dest = "{$up['dir']}/$stored";
        $moved = $uploaded ? move_uploaded_file($tmp, $dest) : (@rename($tmp, $dest) || (@copy($tmp, $dest) && (@unlink($tmp) || true)));
        if (!$moved) { error_log("upload: couldn't move the file to $dest"); fail('The file couldn\'t be saved on the server', 500); }
        @chmod($dest, 0600);
    }
    $row = ['campaign_id' => $cid, 'stored_name' => $stored, 'created_by' => me()['id']] + $row;
    try {
        db()->prepare('INSERT INTO attachments (' . implode(', ', array_keys($row)) . ') VALUES (' . implode(',', array_fill(0, count($row), '?')) . ')')->execute(array_values($row));
    } catch (Throwable $e) { if ($dest) @unlink($dest); throw $e; }
    $st = db()->prepare('SELECT * FROM attachments WHERE id=?');
    $st->execute([(int)db()->lastInsertId()]);
    return attachment_out($st->fetch());
}
/** A found picture's credit as attachments columns. */
function credit_columns(array $i): array {
    return ['credit_title' => mb_substr($i['title'], 0, 200), 'credit_author' => $i['author'] !== null ? mb_substr($i['author'], 0, 200) : null,
        'credit_author_url' => $i['author_url'] !== null && strlen($i['author_url']) <= 500 ? $i['author_url'] : null, 'credit_license' => mb_substr($i['license'], 0, 60),
        'credit_license_url' => $i['license_url'], 'credit_source' => mb_substr($i['via'] ?: ucfirst($i['source']), 0, 60),
        'credit_source_url' => $i['landing_url'] !== null && strlen($i['landing_url']) <= 500 ? $i['landing_url'] : null];
}
/** An embed's picture address, asked of oEmbed again once EMBED_RECHECK has passed; null once DeviantArt says it's gone. */
function embed_refresh(array $a): ?string {
    $fresh = $a['embed_checked_at'] && strtotime($a['embed_checked_at']) > time() - EMBED_RECHECK;
    if ($fresh) return embed_src_ok($a['embed_src']);
    try { $o = deviantart_oembed((string)$a['embed_url']); } catch (ImageSourceDown) { return embed_src_ok($a['embed_src']); }  // keep the last one meanwhile
    db()->prepare('UPDATE attachments SET embed_src=?, embed_checked_at=NOW() WHERE id=?')->execute([$o['src'] ?? null, $a['id']]);
    return $o['src'] ?? null;
}
/** The file name a found picture is kept under: its title, and the extension its contents call for. */
function found_name(string $title, string $path): string {
    $ext = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'][@getimagesize($path)['mime'] ?? ''] ?? 'jpg';
    $base = trim(preg_replace('/[^\p{L}\p{N} ._-]+/u', ' ', $title) ?? '') ?: 'picture';
    return upload_name(mb_substr($base, 0, 150) . ".$ext");
}

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function files_action(string $action): void {
    switch ($action) {
    case 'files': // the files on one parent that this member may see
        $cid = cid();
        $role = role($cid);
        $type = (string)($_GET['parent_type'] ?? '');
        $pid = int_in($_GET['parent_id'] ?? null, 1);
        attachment_parent($cid, $type, $pid, $role);
        $st = db()->prepare('SELECT * FROM attachments WHERE campaign_id=? AND parent_type=? AND parent_id=?' . ($role === 'gm' ? '' : ' AND is_secret=0') . ' ORDER BY id');
        $st->execute([$cid, $type, $pid]);
        out(['files' => array_map('attachment_out', $st->fetchAll()), 'uploads' => upload_info()]);

    case 'file': // the file itself, to show or download, only to someone who may see it
        $cid = cid();
        $role = role($cid);
        $a = attachment_row($cid, int_in($_GET['id'] ?? null, 1), $role);
        if ($a['kind'] === 'embed') {
            // An embedded DeviantArt work: no file here, so the browser is sent to DeviantArt's picture, and only there.
            $src = embed_refresh($a);
            if (!$src) fail('No longer on DeviantArt', 404, 'embed_gone');
            header('Cache-Control: private, no-cache');
            header('Location: ' . $src, true, 302);
            exit;
        }
        $dir = upload_dir()['dir'];
        $path = $dir && preg_match('/^[0-9a-f]{32}$/', $a['stored_name']) ? "$dir/{$a['stored_name']}" : '';
        if ($path === '' || !is_file($path)) fail('File not found', 404);
        if (!isset(UPLOAD_TYPES[$a['mime']])) fail('File not found', 404);
        // The stored file never changes, so its name is its version. no-cache: the browser asks each time, so a file
        // a GM has since hidden is refused rather than shown from the cache.
        $etag = '"' . $a['stored_name'] . '"';
        header('Cache-Control: private, no-cache');
        header('ETag: ' . $etag);
        if (trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) { http_response_code(304); exit; }
        $inline = $a['kind'] === 'image' && empty($_GET['dl']);
        $ascii = preg_replace('/[^A-Za-z0-9._ -]/', '_', $a['original_name']);
        header('Content-Type: ' . $a['mime'] . ($a['mime'] === 'text/plain' ? '; charset=utf-8' : ''));
        header('Content-Length: ' . filesize($path));
        header(sprintf('Content-Disposition: %s; filename="%s"; filename*=UTF-8\'\'%s', $inline ? 'inline' : 'attachment', $ascii, rawurlencode($a['original_name'])));
        // Even opened on its own, the file runs nothing and loads nothing, and no other site may embed it.
        header("Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
        header('Cross-Origin-Resource-Policy: same-origin');
        readfile($path);
        exit;

    case 'file_upload': // multipart form: parent_type, parent_id, file, caption, is_secret (GMs)
        $cid = cid();
        $role = role($cid);
        $max = upload_max_bytes();
        $limit = round($max / 1048576, 1) . ' MB';
        // Past post_max_size PHP drops the whole request, so all there is to go on is its length.
        if (empty($_FILES) && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) fail("That file is too big: files can be $limit at most", 413);
        $type = (string)($_POST['parent_type'] ?? '');
        $pid = int_in($_POST['parent_id'] ?? null, 1);
        $parent = attachment_parent($cid, $type, $pid, $role);
        if (!empty($parent['gm_adds']) && $role !== 'gm') fail('Only a GM can add files here', 403);
        [$f, $size] = upload_received();
        attachment_room($cid, $type, $pid, $size);
        $name = upload_name((string)($f['name'] ?? ''));
        [$mime, $kind, $w, $h] = upload_type($f['tmp_name'], $name);
        $caption = trim((string)str_in($_POST['caption'] ?? null, 200)) ?: null;
        $secret = $role === 'gm' && !empty($_POST['is_secret']) && $_POST['is_secret'] !== '0' && $_POST['is_secret'] !== 'false' ? 1 : 0;
        out(['ok' => true, 'file' => attachment_store($cid, $f['tmp_name'], ['parent_type' => $type, 'parent_id' => $pid, 'original_name' => $name, 'mime' => $mime,
            'kind' => $kind, 'size_bytes' => $size, 'width' => $w, 'height' => $h, 'caption' => $caption, 'is_secret' => $secret], true)]);

    case 'image_search': // Find Image: source (openverse, museums or deviantart), q. Results as image_item() describes.
        $cid = cid();
        role($cid);
        $source = (string)($_GET['source'] ?? '');
        if (!in_array($source, IMAGE_SOURCES, true)) fail('Unknown picture source', 400);
        $q = trim((string)str_in($_GET['q'] ?? '', 200));
        if ($q === '') fail('Type something to search for');
        rate_limit('image_search', (string)me()['id'], 30, 60);
        if ($source === 'deviantart' && !deviantart_ready())
            fail(me()['is_admin'] ? "DeviantArt isn't set up on this server: register an app at deviantart.com/developers and put its client_id and client_secret under 'image_search' => ['deviantart' => …] in the config."
                : 'DeviantArt isn\'t available on this server.', 409, 'source_not_set_up');
        try { out(['results' => image_search($source, $q)]); }
        catch (ImageSourceDown) { fail(['openverse' => 'Openverse', 'museums' => 'The museums', 'deviantart' => 'DeviantArt'][$source] . ' couldn\'t be reached just now. Try again later.', 502, 'source_unavailable'); }

    case 'image_import': // Find Image's picks: parent_type, parent_id, source, id, mode ('copy' or 'embed'), is_secret (GMs)
        $cid = cid();
        $role = role($cid);
        $type = (string)p('parent_type', '');
        $pid = int_in(p('parent_id'), 1);
        if (!empty(attachment_parent($cid, $type, $pid, $role)['gm_adds']) && $role !== 'gm') fail('Only a GM can add files here', 403);
        $source = (string)p('source', '');
        $id = (string)str_in(p('id'), 100);
        $mode = (string)p('mode', 'copy');
        // A fan wiki's picture (api/fanwikis.php), while that module is here and switched on.
        $fan = $source === 'fanwiki' && function_exists('fanwiki_on') && fanwiki_on();
        if ((!$fan && !in_array($source, IMAGE_SOURCES, true)) || !in_array($mode, ['copy', 'embed'], true)) fail('Unknown picture source', 400);
        if ($mode === 'embed' && $source !== 'deviantart') fail('Only DeviantArt works can be embedded', 400);
        if ($source === 'deviantart' && !deviantart_ready()) fail('DeviantArt isn\'t available on this server.', 409, 'source_not_set_up');
        $secret = $role === 'gm' && p('is_secret') ? 1 : 0;
        rate_limit('image_import', (string)me()['id'], 30, 60);   // each one downloads a picture from outside
        // Admins are told which call failed and how, so they can tell a refused key from a source that is down.
        $down = fn(?ImageSourceDown $e = null) => fail('That picture couldn\'t be fetched just now. Try again later.'
            . ($e && me()['is_admin'] ? ' (' . $e->getMessage() . ')' : ''), 502, 'source_unavailable');
        try { $item = $fan ? fanwiki_image_lookup($id) : image_lookup($source, $id); } catch (ImageSourceDown $e) { $down($e); }
        if (!$item) fail('That picture isn\'t there any more', 404);
        if ($mode === 'embed') {
            // oEmbed gives the picture to show; when it can't be reached, the deviation's own picture from the API will do
            // until the next recheck asks oEmbed again.
            try { $o = deviantart_oembed((string)$item['landing_url']); } catch (ImageSourceDown $e) {
                $src = embed_src_ok($item['full'] ?? null) ?? $down($e);
                $o = ['src' => $src, 'width' => null, 'height' => null];
            }
            if (!$o) fail('DeviantArt won\'t let that work be embedded', 422, 'not_embeddable');
            attachment_room($cid, $type, $pid, 0);
            out(['ok' => true, 'file' => attachment_store($cid, null, ['parent_type' => $type, 'parent_id' => $pid,
                'original_name' => upload_name($item['title']), 'mime' => 'image/jpeg', 'kind' => 'embed', 'size_bytes' => 0,
                'width' => $o['width'] ? min(65535, $o['width']) : null, 'height' => $o['height'] ? min(65535, $o['height']) : null, 'is_secret' => $secret,
                'embed_url' => $item['landing_url'], 'embed_src' => $o['src'], 'embed_checked_at' => date('Y-m-d H:i:s')] + credit_columns($item))]);
        }
        // A fan wiki's picture that isn't open comes only while fanwikis-nonopen.php allows it, credited as personal fair use.
        if (!$item['open'] && !($fan && !empty($item['fair_use']))) fail('That picture isn\'t openly licensed, so it can\'t be copied here', 403, 'not_open');
        if (!upload_dir()['dir']) fail(upload_info()['problem'], 409, 'uploads_unavailable');
        $max = upload_max_bytes();
        $tmp = null;
        // The full picture, or the thumbnail when that is too big or won't come.
        $err = null;
        foreach (array_unique(array_filter([$item['full'], $item['thumb']])) as $url) {
            try { $tmp = image_download($url, $max); break; } catch (ImageSourceDown $e) { $err = $e; } catch (LengthException) {}
        }
        if (!$tmp) $down($err);
        register_shutdown_function(fn() => is_file($tmp) && @unlink($tmp));   // when it is refused below; a kept one has moved
        $size = (int)filesize($tmp);
        attachment_room($cid, $type, $pid, $size);
        $name = found_name($item['title'], $tmp);
        [$mime, $kind, $w, $h] = upload_type($tmp, $name);
        if ($kind !== 'image') fail('That isn\'t a picture', 415, 'unsupported_type');
        out(['ok' => true, 'file' => attachment_store($cid, $tmp, ['parent_type' => $type, 'parent_id' => $pid, 'original_name' => $name, 'mime' => $mime,
            'kind' => 'image', 'size_bytes' => $size, 'width' => $w, 'height' => $h, 'is_secret' => $secret] + credit_columns($item))]);

    case 'file_update': // a file's caption, and (GMs) whether it is GM only
        $cid = cid();
        $role = role($cid);
        $a = attachment_row($cid, int_in(p('id'), 1), $role);
        if (!attachment_mine($a, $role)) fail('Only a GM can change a file someone else added', 403);
        $caption = array_key_exists('caption', body()) ? (trim((string)str_in(p('caption'), 200)) ?: null) : $a['caption'];
        $secret = $role === 'gm' && array_key_exists('is_secret', body()) ? (p('is_secret') ? 1 : 0) : (int)$a['is_secret'];
        if ($secret && !(int)$a['is_secret']) {   // a picture a map or token shows is hidden by hiding the map or token
            $st = db()->prepare('SELECT (SELECT COUNT(*) FROM maps WHERE image_id=?) + (SELECT COUNT(*) FROM tokens WHERE image_id=?)');
            $st->execute([$a['id'], $a['id']]);
            if ((int)$st->fetchColumn() > 0) fail('This picture is in use; hide the map or token instead');
        }
        db()->prepare('UPDATE attachments SET caption=?, is_secret=? WHERE id=?')->execute([$caption, $secret, $a['id']]);
        $st = db()->prepare('SELECT * FROM attachments WHERE id=?');
        $st->execute([$a['id']]);
        out(['ok' => true, 'file' => attachment_out($st->fetch())]);

    case 'file_delete':
        $cid = cid();
        $role = role($cid);
        $a = attachment_row($cid, int_in(p('id'), 1), $role);
        if (!attachment_mine($a, $role)) fail('Only a GM can remove a file someone else added', 403);
        attachment_remove($cid, (int)$a['id']);
        if ($a['parent_type'] === 'map')   // a map whose picture this was goes back to having none
            db()->prepare('UPDATE maps SET image_id=NULL, width=NULL, height=NULL WHERE image_id=? AND campaign_id=?')->execute([$a['id'], $cid]);
        if ($a['parent_type'] === 'token')   // and a token goes back to having no picture
            db()->prepare('UPDATE tokens SET image_id=NULL WHERE image_id=? AND campaign_id=?')->execute([$a['id'], $cid]);
        out(['ok' => true]);
    }
}
