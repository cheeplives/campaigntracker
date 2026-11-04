<?php
/**
 * The Encyclopedia: entries, their aliases, tags and categories, and the words the Proper Noun Detector was told to ignore.
 * Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php.
 */
declare(strict_types=1);

// ---------- the Encyclopedia ----------
// Entries are the people, places, items and the like that turn up in play. Every member reads the entries that
// aren't secret and can add them and write their Public notes; GM notes, secret entries and deleting other people's
// entries are for GMs. The Proper Noun Detector (static/encyclopedia.js) runs in the browser and offers new names
// after each save; the words someone turns down are kept per campaign, one list for the GMs and one for the players.

/** SQL to add to an UPDATE of an entry's name or notes, so a copy opened before it is refused when saved (entry_save). */
function entry_bump(): string { return ', version=version+1'; }

/** A Category as sent: one of ENTRY_CATEGORIES, or null for none. */
function category_in($v): ?string {
    $c = mb_strtolower(trim((string)$v));
    if ($c === '') return null;
    if (!in_array($c, ENTRY_CATEGORIES, true)) fail('Pick a Category: ' . implode(', ', ENTRY_CATEGORIES));
    return $c;
}
/** The Encyclopedia's tags plus any starter tag the campaign hasn't used yet (id null), by name. */
function entry_tags(int $cid): array {
    $st = db()->prepare('SELECT id, name, color FROM encyclopedia_tag_names WHERE campaign_id=?');
    $st->execute([$cid]);
    $tags = [];
    foreach ($st->fetchAll() as $t) $tags[mb_strtolower($t['name'])] = ['id' => (int)$t['id'], 'name' => $t['name'], 'color' => $t['color']];
    foreach (ENTRY_STARTER_TAGS as $name => $color) $tags[mb_strtolower($name)] ??= ['id' => null, 'name' => $name, 'color' => $color];
    $tags = array_values($tags);
    usort($tags, fn($a, $b) => strcasecmp($a['name'], $b['name']));
    return $tags;
}
/** Every entry this member may see, short: what the browser needs to link names and to know which are new. */
function entry_index(int $cid, bool $isGm, array $tokens = []): array {
    // Only the start of the notes, for the 140-character preview: every campaign load reads this, so not the whole
    // Encyclopedia's text. A player's blank test needs to know whether anything outside the GM's paragraphs is there,
    // which the start shows unless it is all secret; then the rest decides, in SQL.
    $st = db()->prepare("SELECT id, name, category, aliases_json, LEFT(notes, " . ENTRY_PREVIEW_READ . ") AS notes,
        CHAR_LENGTH(notes) > " . ENTRY_PREVIEW_READ . " AS cut, is_secret, (COALESCE(notes, '') = '' AND " . ($isGm ? "COALESCE(gm_notes, '') = ''" : '1') . ') AS blank
        FROM encyclopedia_entries WHERE campaign_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY name');
    $st->execute([$cid]);
    $pics = entry_pics($cid, $isGm);
    return array_map(fn($e) => ['id' => (int)$e['id'], 'name' => $e['name'], 'category' => $e['category'], 'aliases' => entry_aliases($e), 'is_secret' => (bool)$e['is_secret'],
        'blank' => (bool)$e['blank'] || (!$isGm && !(int)$e['cut'] && rich_open($e['notes']) === ''), 'preview' => entry_preview(rich_for(entry_head($e['notes'], (bool)(int)$e['cut'], $isGm), $isGm)),
        'pic' => $pics[(int)$e['id']] ?? null, 'token_url' => $tokens[(int)$e['id']] ?? null], $st->fetchAll());
}
/** Each entry's first picture this member may see, as entry id => its file URL, for the picture on its links' tooltips. */
function entry_pics(int $cid, bool $isGm): array {
    $st = db()->prepare("SELECT a.parent_id, MIN(a.id) AS id FROM attachments a WHERE a.campaign_id=? AND a.parent_type='encyclopedia'
        AND (a.kind='image' OR (a.kind='embed' AND a.embed_src IS NOT NULL))" . ($isGm ? '' : ' AND a.is_secret=0') . ' GROUP BY a.parent_id');
    $st->execute([$cid]);
    $out = [];
    foreach ($st->fetchAll() as $r) $out[(int)$r['parent_id']] = 'api/index.php?' . http_build_query(['a' => 'file', 'cid' => $cid, 'id' => (int)$r['id']]);
    return $out;
}
/** An entry row's aliases as a list. */
function entry_aliases(array $e): array {
    $a = dec($e['aliases_json'] ?? null);
    return is_array($a) ? array_values(array_filter($a, 'is_string')) : [];
}
/** How much of an entry's notes entry_index() reads for its preview. */
const ENTRY_PREVIEW_READ = 4000;
/** The start of stored rich text, read only so far: a tag or entity the cut runs through is dropped, and so is a
 * half-read secret paragraph, which mustn't be half shown. */
function entry_head(?string $html, bool $cut, bool $isGm): ?string {
    if (!$cut || $html === null) return $html;
    $lt = strrpos($html, '<');
    if ($lt !== false && $lt > (int)strrpos($html, '>')) $html = substr($html, 0, $lt);
    $html = preg_replace('/&#?[a-z0-9]*$/i', '', $html);
    $html = mb_strcut($html, 0, strlen($html), 'UTF-8');   // nor half a character
    if ($isGm) return $html;
    // an <aside> left open by the cut is a GM paragraph whose end wasn't read: drop it, as rich_open() can't see it
    $open = strrpos($html, '<aside');
    if ($open !== false && strpos($html, '</aside>', $open) === false) $html = substr($html, 0, $open);
    return $html;
}
/** The first line or so of an entry's Public notes, for the tooltip on its links. */
function entry_preview(?string $html): string {
    $t = preg_replace('/\s+/u', ' ', rich_html_plain((string)$html));
    return mb_strlen($t) > 140 ? rtrim(mb_substr($t, 0, 139)) . '…' : $t;
}
/** Aliases as sent ([names]) checked and stored as JSON, or null for none. $ownName and $ownId are left out of the clash check. */
function aliases_in($list, int $cid, string $ownName, ?int $ownId): ?string {
    if ($list === null) return null;
    if (!is_array($list) || count($list) > 30) fail('Send up to 30 other names');
    $out = []; $seen = [mb_strtolower($ownName) => true];
    foreach ($list as $a) {
        $n = entry_name($a);
        $k = mb_strtolower($n);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $same = entry_named($cid, $n);
        if ($same && (int)$same['id'] !== $ownId) fail("\"$n\" is already a name of \"{$same['name']}\"", 409);
        $out[] = $n;
    }
    return $out ? json_encode($out, JSON_UNESCAPED_UNICODE) : null;
}
/** Which list of turned-down words this member uses: the GMs' or the players'. */
function ignore_scope(string $role): string { return $role === 'gm' ? 'gm' : 'player'; }
function ignored_terms(int $cid, string $role): array {
    $st = db()->prepare('SELECT term FROM encyclopedia_ignored WHERE campaign_id=? AND scope=? ORDER BY term');
    $st->execute([$cid, ignore_scope($role)]);
    return $st->fetchAll(PDO::FETCH_COLUMN);
}
/** An entry's name or a word to ignore, as sent: trimmed, spaces run together, 1–150 characters. */
function entry_name($v): string {
    $n = trim(preg_replace('/\s+/u', ' ', (string)str_in($v, 400, false)) ?? '');
    if ($n === '') fail('Give the entry a name');
    if (mb_strlen($n) > 150) fail('Names are 150 characters at most');
    return $n;
}
/** An entry of campaign $cid this member may see, or fail. */
function entry_row(int $cid, int $id, string $role): array {
    return row_of('encyclopedia_entries', $cid, $id, 'Entry not found', fn($e) => $role !== 'gm' && (int)$e['is_secret']);
}
/** The entry of campaign $cid named $name (any case), secret or not, or null. */
function entry_by_name(int $cid, string $name): ?array {
    $st = db()->prepare('SELECT id, name, is_secret FROM encyclopedia_entries WHERE campaign_id=? AND name=?');
    $st->execute([$cid, $name]);
    return $st->fetch() ?: null;
}
/** The entry of campaign $cid that $name is the name or an alias of (any case), secret or not, or null. */
function entry_named(int $cid, string $name): ?array {
    if ($e = entry_by_name($cid, $name)) return $e;
    return entry_alias_index($cid)[mb_strtolower($name)] ?? null;
}
/** Every alias in campaign $cid, lower-cased => its entry, read once a request: entries_add and the Scabard import ask
 * entry_named() hundreds of times in one request. entry_alias_forget() after a change to anyone's aliases. */
function entry_alias_index(int $cid, bool $forget = false): array {
    static $idx = [];
    if ($forget) { unset($idx[$cid]); return []; }
    if (!isset($idx[$cid])) {
        $idx[$cid] = [];
        $st = db()->prepare("SELECT id, name, is_secret, aliases_json FROM encyclopedia_entries WHERE campaign_id=? AND aliases_json IS NOT NULL");
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $e) foreach (entry_aliases($e) as $a) $idx[$cid][mb_strtolower($a)] ??= $e;
    }
    return $idx[$cid];
}
function entry_alias_forget(int $cid): void { entry_alias_index($cid, true); }

/** Answer one of these actions: api/index.php sends them here, once api/actions.php has let them through. */
function encyclopedia_action(string $action): void {
    switch ($action) {
    case 'encyclopedia':
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        $st = db()->prepare('SELECT e.id, e.name, e.category, e.aliases_json, e.notes, ' . ($isGm ? 'e.gm_notes, ' : '') . 'e.is_secret, e.version, e.created_by, e.updated_at, ' . AUTHOR_SQL . ' AS author, u.display_name AS player
            FROM encyclopedia_entries e LEFT JOIN users u ON u.id=e.created_by LEFT JOIN campaign_members m ON m.campaign_id=e.campaign_id AND m.user_id=e.created_by
            WHERE e.campaign_id=?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY e.name');
        $st->execute([$cid]);
        $tokens = token_urls($cid, $isGm)['entry'];
        $entries = array_map(function ($e) use ($isGm, $tokens) {
            $e['id'] = (int)$e['id'];
            $e['token_url'] = $tokens[$e['id']] ?? null;
            $e['aliases'] = entry_aliases($e);
            $e['notes'] = rich_for($e['notes'], $isGm);
            unset($e['aliases_json']);
            $e['is_secret'] = (bool)$e['is_secret'];
            $e['version'] = (int)$e['version'];
            $e['created_by'] = $e['created_by'] !== null ? (int)$e['created_by'] : null;
            return $e;
        }, $st->fetchAll());
        attach_tags($entries, 'entry');
        out(['entries' => $entries, 'tags' => entry_tags($cid), 'ignored' => ignored_terms($cid, $role),
            'relations' => relations_list($cid, $isGm), 'relation_types' => relation_types($cid, $isGm),
            'files' => entry_files($cid, $isGm), 'uploads' => upload_info(),
            'characters' => (object)characters_by_entry($cid, $isGm)]);

    case 'encyclopedia_sources':
        // Everything written in the campaign that this member may read, for the detector's full scan and for an
        // entry's "Mentioned in" list. secret: only GMs can read it, so names found only there start as GM only.
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        $out = [];
        $add = function (array $src, $text, bool $secret = false, string $format = 'plain') use (&$out) {
            if (trim((string)$text) === '') return;
            $out[] = $src + ['text' => (string)$text, 'format' => $format, 'secret' => $secret];
        };
        $st = db()->prepare("SELECT abs_day, notes, notes_format, gm_notes, gm_notes_format, locations FROM days WHERE campaign_id=?
            AND (COALESCE(notes, '') <> '' OR COALESCE(gm_notes, '') <> '' OR COALESCE(locations, '') <> '') ORDER BY abs_day");
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $d) {
            $ad = (int)$d['abs_day'];
            $add(['kind' => 'locations', 'abs_day' => $ad], $d['locations']);
            if ($d['notes_format'] === 'html') {
                $add(['kind' => 'day_notes', 'abs_day' => $ad], rich_open($d['notes']), false, 'html');
                if ($isGm) $add(['kind' => 'day_notes', 'abs_day' => $ad], rich_secrets($d['notes']), true, 'html');
            } else $add(['kind' => 'day_notes', 'abs_day' => $ad], $d['notes'], false, $d['notes_format']);
            if ($isGm) $add(['kind' => 'day_gm_notes', 'abs_day' => $ad], $d['gm_notes'], true, $d['gm_notes_format']);
        }
        $st = db()->prepare('SELECT abs_day, shift, activity' . ($isGm ? ', gm_notes' : '') . ' FROM shifts WHERE campaign_id=? ORDER BY abs_day, shift');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $s) {
            $src = ['abs_day' => (int)$s['abs_day'], 'shift' => (int)$s['shift']];
            $add(['kind' => 'activity'] + $src, $s['activity']);
            if ($isGm) $add(['kind' => 'shift_gm_notes'] + $src, $s['gm_notes'], true);
        }
        $st = db()->prepare('SELECT abs_day, shift, body FROM shift_notes WHERE campaign_id=? ORDER BY abs_day, shift, id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $n) $add(['kind' => 'shift_note', 'abs_day' => (int)$n['abs_day'], 'shift' => (int)$n['shift']], $n['body']);
        $st = db()->prepare('SELECT id, abs_day, title, body, is_secret FROM events WHERE campaign_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY abs_day, id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $e) {
            $src = ['kind' => 'event', 'id' => (int)$e['id'], 'abs_day' => (int)$e['abs_day'], 'title' => $e['title']];
            $add($src, trim($e['title'] . "\n" . $e['body']), (bool)$e['is_secret']);
        }
        $st = db()->prepare('SELECT e.id, e.abs_day, e.title, e.is_secret, n.body FROM event_notes n JOIN events e ON e.id=n.event_id
            WHERE e.campaign_id=?' . ($isGm ? '' : ' AND e.is_secret=0') . ' ORDER BY e.abs_day, n.id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $n) $add(['kind' => 'event_note', 'id' => (int)$n['id'], 'abs_day' => (int)$n['abs_day'], 'title' => $n['title']], $n['body'], (bool)$n['is_secret']);
        $uid = me()['id'];
        $spdC = camp_spd(campaign_row($cid));
        $st = db()->prepare('SELECT r.id, r.due_shift, r.title, r.body, r.audience FROM reminders r WHERE r.campaign_id=? AND ' . reminder_visible_sql($isGm) . ' ORDER BY r.due_shift, r.id');
        $st->execute([$cid, $uid]);
        foreach ($st->fetchAll() as $r) {
            $add(['kind' => 'reminder', 'id' => (int)$r['id'], 'abs_day' => floordiv((int)$r['due_shift'], $spdC), 'title' => $r['title']],
                trim($r['title'] . "\n" . $r['body']), $isGm && $r['audience'] !== 'all');
        }
        $st = db()->prepare('SELECT id, kind, title, start_shift, notes' . ($isGm ? ', gm_notes' : '') . ' FROM downtimes WHERE campaign_id=? ORDER BY start_shift, id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $d) {
            $src = ['kind' => 'downtime', 'id' => (int)$d['id'], 'abs_day' => floordiv((int)$d['start_shift'], $spdC), 'title' => $d['title'] ?: ucwords(str_replace('_', ' ', $d['kind']))];
            $add($src, trim($d['title'] . "\n" . $d['notes']));
            if ($isGm) $add(['kind' => 'downtime_gm_notes'] + $src, $d['gm_notes'], true);
        }
        // Party Holdings: short boxes (names, places, items) are read as titles, where an everyday first word isn't a name.
        $st = db()->prepare('SELECT id, name, location, description FROM holdings WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $h) {
            $add(['kind' => 'holding', 'id' => (int)$h['id'], 'title' => $h['name'], 'short' => true], trim($h['name'] . "\n" . $h['location']));
            $add(['kind' => 'holding', 'id' => (int)$h['id'], 'title' => $h['name']], $h['description']);
        }
        $st = db()->prepare('SELECT h.name, s.item FROM holding_storage s JOIN holdings h ON h.id=s.holding_id WHERE h.campaign_id=? ORDER BY s.id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $x) $add(['kind' => 'storage', 'title' => $x['name'], 'short' => true], $x['item']);
        $st = db()->prepare('SELECT item, location FROM party_gear WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $g) $add(['kind' => 'gear', 'short' => true], trim($g['item'] . "\n" . $g['location']));
        $st = db()->prepare('SELECT currency, location FROM party_funds WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $f) $add(['kind' => 'funds', 'short' => true], trim($f['currency'] . "\n" . $f['location']));
        $st = db()->prepare('SELECT id, title, description, body FROM library_tomes WHERE campaign_id=? ORDER BY title');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $t) {
            $add(['kind' => 'tome', 'id' => (int)$t['id'], 'title' => $t['title'], 'short' => true], trim($t['title'] . "\n" . $t['description']));
            $add(['kind' => 'tome', 'id' => (int)$t['id'], 'title' => $t['title']], rich_open($t['body']), false, 'html');
            if ($isGm) $add(['kind' => 'tome', 'id' => (int)$t['id'], 'title' => $t['title']], rich_secrets($t['body']), true, 'html');
        }
        // a published summary for everyone (its secret paragraphs for GMs only); the rest, and the notes, for GMs
        $st = db()->prepare('SELECT * FROM play_sessions WHERE campaign_id=?' . ($isGm ? '' : ' AND is_published=1') . ' ORDER BY number');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $x) {
            $src = ['kind' => 'session', 'id' => (int)$x['id'], 'title' => $x['title'] !== '' ? $x['title'] : "Session {$x['number']}"];
            foreach (['summary', 'rewards', 'loot'] as $f) {
                if (!array_key_exists($f, $x)) continue;
                $add($src, rich_open($x[$f]), !(int)$x['is_published'], 'html');
                if ($isGm) $add($src, rich_secrets($x[$f]), true, 'html');
            }
        }
        if ($isGm) {
            $st = db()->prepare('SELECT n.text, s.id, s.number, s.title FROM session_notes n JOIN play_sessions s ON s.id=n.session_id WHERE n.campaign_id=? ORDER BY s.number, n.position');
            $st->execute([$cid]);
            foreach ($st->fetchAll() as $x) $add(['kind' => 'session_note', 'id' => (int)$x['id'], 'title' => $x['title'] !== '' ? $x['title'] : "Session {$x['number']}", 'short' => true], $x['text'], true);
        }
        $st = db()->prepare('SELECT id, name, notes, is_secret' . ($isGm ? ', gm_notes' : '') . ' FROM encyclopedia_entries WHERE campaign_id=?' . ($isGm ? '' : ' AND is_secret=0') . ' ORDER BY name');
        $st->execute([$cid]);
        foreach ($st->fetchAll() as $e) {
            $src = ['kind' => 'entry', 'id' => (int)$e['id'], 'title' => $e['name']];
            $add($src, rich_open($e['notes']), (bool)$e['is_secret'], 'html');
            if ($isGm) $add($src, rich_secrets($e['notes']), true, 'html');
            if ($isGm) $add(['kind' => 'entry_gm_notes'] + $src, $e['gm_notes'], true, 'html');
        }
        // names (JSON list, from an entry's "Mentioned in" and "Where it was found"): only the sources that contain one of
        // them, any case, so an entry's page isn't sent the whole campaign's text; the page still decides what counts
        $names = $_GET['names'] ?? null;
        if (is_string($names) && strlen($names) <= 8000 && is_array($list = json_decode($names, true)) && $list) {
            $flat = fn(string $t): string => (string)preg_replace('/\s+/u', ' ', $t);   // a name may break across lines
            $list = array_values(array_filter(array_map(fn($n) => is_string($n) ? trim($flat($n)) : '', array_slice($list, 0, 40)), fn($n) => $n !== ''));
            $out = array_values(array_filter($out, function ($src) use ($list, $flat) {
                $text = $flat($src['format'] === 'html' ? rich_html_plain($src['text']) : $src['text']);
                foreach ($list as $n) if (mb_stripos($text, $n) !== false) return true;
                return false;
            }));
        }
        out(['sources' => $out]);

    case 'entry_save':
        // A new entry, or a change to one. Players change the name, tags and Public notes of entries that aren't
        // secret; GM notes and whether an entry is secret are only for GMs, and are kept as they were otherwise.
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? entry_row($cid, $id, $role) : null;
        $name = entry_name(p('name'));
        $same = entry_named($cid, $name);
        if ($same && (int)$same['id'] !== $id) fail($isGm || !(int)$same['is_secret'] ? "\"$name\" is already a name of \"{$same['name']}\"" : 'Pick another name', 409);
        $aliases = array_key_exists('aliases', body()) ? aliases_in(p('aliases'), $cid, $name, $id) : ($old['aliases_json'] ?? null);
        $rich = fn(string $k) => array_key_exists($k, body()) ? (rich_html_clean((string)str_in(p($k), 200000)) ?: null) : ($old[$k] ?? null);
        $notes = $rich('notes');
        // a player never had the GM's secret paragraphs to send back, so they are kept from the stored copy
        if (!$isGm && array_key_exists('notes', body())) $notes = rich_keep_secrets($old['notes'] ?? null, (string)$notes) ?: null;
        $gmNotes = $isGm ? $rich('gm_notes') : ($old['gm_notes'] ?? null);
        $secret = $isGm ? (p('is_secret', $old ? (bool)$old['is_secret'] : false) ? 1 : 0) : 0;
        $category = array_key_exists('category', body()) ? category_in(p('category')) : ($old['category'] ?? null);
        if ($old && !$isGm && $name !== $old['name']) {
            // a character's name is its player's to change
            $owner = db()->prepare('SELECT owner_id FROM sheet_characters WHERE entry_id=?');
            $owner->execute([$id]);
            $o = $owner->fetch();
            if ($o && (int)$o['owner_id'] !== me()['id']) fail('Only its player or a GM can rename this character', 403);
        }
        db()->beginTransaction();
        if ($old) {
            // version: the copy the editor opened. When someone else has saved since, the save is refused, as for tomes, so
            // it doesn't overwrite their words; a save without one (an older page) isn't checked.
            $stale = p('version') !== null ? ' AND version=' . int_in(p('version'), 1) : '';
            $st = db()->prepare('UPDATE encyclopedia_entries SET name=?, aliases_json=?, notes=?, gm_notes=?, is_secret=?' . entry_bump() . " WHERE id=?$stale");
            $st->execute([$name, $aliases, $notes, $gmNotes, $secret, $id]);
            if ($stale && !$st->rowCount()) {
                db()->rollBack();
                fail('Someone saved this entry after you opened it. Copy what you wrote, reload, and add it again', 409, 'stale');
            }
        } else {
            db()->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, aliases_json, notes, gm_notes, is_secret, created_by) VALUES (?,?,?,?,?,?,?)')
                ->execute([$cid, $name, $aliases, $notes, $gmNotes, $secret, me()['id']]);
            $id = (int)db()->lastInsertId();
        }
        db()->prepare('UPDATE encyclopedia_entries SET category=? WHERE id=?')->execute([$category, $id]);
        if (array_key_exists('tags', body())) save_event_tags($cid, $id, p('tags'), 'entry');
        if ($old) character_names_sync($id);
        $v = db()->prepare('SELECT version FROM encyclopedia_entries WHERE id=?');
        $v?->execute([$id]);
        $version = $v ? (int)$v->fetchColumn() : 1;
        db()->commit();
        out(['ok' => true, 'id' => $id, 'version' => $version]);

    case 'secret_reveal':
        // GM: make a run of GM-only paragraphs public, in an entry's public notes or a tome, and (log) note it as an
        // event on the campaign's current day. which: the indexes of those <aside>s in the stored text, with the text the
        // GM's page showed for each, so a note changed since is refused rather than the wrong paragraphs revealed.
        $cid = cid(); need_gm($cid);
        $kind = p('kind');
        $id = int_in(p('id'), 1);
        if ($kind === 'entry') { $row = entry_row($cid, $id, 'gm'); $html = (string)$row['notes']; $name = $row['name']; }
        elseif ($kind === 'tome') { $row = tome_row($cid, $id); $html = (string)$row['body']; $name = $row['title']; }
        else fail('Pick an entry or a tome');
        $which = p('which');
        if (!is_array($which) || !$which || count($which) > 200) fail('Pick the paragraphs to reveal');
        preg_match_all(RICH_SECRET_RE, $html, $m, PREG_OFFSET_CAPTURE);
        $plain = [];
        foreach ($which as $w) {
            $i = is_array($w) ? int_in($w['index'] ?? null) : -1;
            $hit = $m[0][$i] ?? null;
            $flat = fn(string $t) => trim(preg_replace('/\s+/u', ' ', $t) ?? '');
            $text = $hit ? rich_html_plain($hit[0]) : null;
            if ($text === null || $flat($text) !== $flat((string)($w['text'] ?? ''))) fail('This note has changed since you opened it. Reload and try again', 409, 'stale');
            $plain[$i] = $text;
        }
        krsort($plain);  // from the end, so the earlier offsets still hold
        foreach (array_keys($plain) as $i) {
            [$tag, $at] = $m[0][$i];
            $html = substr_replace($html, '<p>' . substr($tag, 7, -8) . '</p>', $at, strlen($tag));
        }
        if ($kind === 'entry') db()->prepare('UPDATE encyclopedia_entries SET notes=?' . entry_bump() . ' WHERE id=?')->execute([$html, $id]);
        else db()->prepare('UPDATE library_tomes SET body=?, version=version+1, updated_by=? WHERE id=?')->execute([$html, me()['id'], $id]);
        $event = null;
        if (p('log')) {
            $c = campaign_row($cid);
            $today = floordiv((int)$c['current_shift'], camp_spd($c));
            db()->prepare('INSERT INTO events (abs_day, title, body, is_secret, campaign_id, created_by) VALUES (?,?,?,0,?,?)')
                ->execute([$today, mb_substr("Revealed: $name", 0, 200), implode("\n", array_reverse($plain)), $cid, me()['id']]);
            $event = (int)db()->lastInsertId();
            save_event_tags($cid, $event, [['name' => 'Revealed']]);
        }
        out(['ok' => true, 'event_id' => $event]);

    case 'entries_add':
        // The detector's approved names: [{name, is_secret, category?, tags: [{name, color?}]}], or {name, alias_of: entry id} to add
        // the name to an entry that exists as another name for it. A name that is already a name of an entry is left as
        // it is. A player who sends the name of a secret entry is told nothing; the word joins the players' turned-down
        // list so they aren't asked about it again.
        $cid = cid();
        $role = role($cid);
        $isGm = $role === 'gm';
        $list = p('entries', []);
        if (!is_array($list) || count($list) > 500) fail('Send up to 500 entries at a time');
        $added = []; $aliased = [];
        $ins = db()->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, is_secret, created_by) VALUES (?,?,?,?)');
        $upd = db()->prepare('UPDATE encyclopedia_entries SET aliases_json=?' . entry_bump() . ' WHERE id=?');
        $cat = db()->prepare('UPDATE encyclopedia_entries SET category=? WHERE id=?');
        $ign = db()->prepare('INSERT IGNORE INTO encyclopedia_ignored (campaign_id, scope, term) VALUES (?,?,?)');
        db()->beginTransaction();
        foreach ($list as $x) {
            if (!is_array($x)) fail('Expected a list of entries');
            $name = entry_name($x['name'] ?? '');
            $same = entry_named($cid, $name);
            if ($same) {
                if (!$isGm && (int)$same['is_secret']) $ign->execute([$cid, 'player', $name]);
                continue;
            }
            if (!empty($x['alias_of'])) {
                $of = entry_row($cid, int_in($x['alias_of'], 1), $role);
                $list = entry_aliases($of);
                $list[] = $name;
                $upd->execute([aliases_in($list, $cid, $of['name'], (int)$of['id']), $of['id']]);
                entry_alias_forget($cid);
                $aliased[] = ['id' => (int)$of['id'], 'name' => $of['name'], 'alias' => $name];
                continue;
            }
            $ins->execute([$cid, $name, $isGm && !empty($x['is_secret']) ? 1 : 0, me()['id']]);
            $id = (int)db()->lastInsertId();
            if (isset($x['tags'])) save_event_tags($cid, $id, $x['tags'], 'entry');
            if (!empty($x['category'])) $cat->execute([category_in($x['category']), $id]);
            $added[] = ['id' => $id, 'name' => $name, 'category' => !empty($x['category']) ? category_in($x['category']) : null];
        }
        db()->commit();
        out(['ok' => true, 'added' => $added, 'aliased' => $aliased]);

    case 'entry_note_add':
        // A line added to the end of an entry's notes, from At the Table: anyone to its Public notes (not on a secret
        // entry), and a GM to its GM notes with gm_only.
        $cid = cid();
        $role = role($cid);
        $e = entry_row($cid, int_in(p('id'), 1), $role);
        $text = trim((string)str_in(p('body'), 5000, false));
        if ($text === '') fail('Note is empty');
        $para = '<p>' . nl2br(htmlspecialchars($text, ENT_QUOTES | ENT_HTML5, 'UTF-8'), false) . '</p>';
        $col = $role === 'gm' && p('gm_only') ? 'gm_notes' : 'notes';
        db()->prepare("UPDATE encyclopedia_entries SET $col=?" . entry_bump() . ' WHERE id=?')->execute([rich_html_clean((string)$e[$col] . $para), $e['id']]);
        out(['ok' => true, 'id' => (int)$e['id']]);

    case 'entry_delete':
        $cid = cid();
        $role = role($cid);
        $e = entry_row($cid, int_in(p('id'), 1), $role);
        if ($role !== 'gm' && (int)$e['created_by'] !== me()['id']) fail('Only a GM can delete an entry someone else added', 403);
        $st = db()->prepare('SELECT 1 FROM sheet_characters WHERE entry_id=?');
        $st->execute([$e['id']]);
        if ($st->fetchColumn()) fail('Delete its character sheet first', 409, 'has_character');
        db()->beginTransaction();
        attachments_purge($cid, 'encyclopedia', (int)$e['id']);
        db()->prepare('DELETE FROM encyclopedia_entries WHERE id=?')->execute([$e['id']]);
        db()->commit();
        out(['ok' => true]);

    case 'terms_ignore': // the detector stops offering these words to this member's side (the GMs, or the players)
        $cid = cid();
        $role = role($cid);
        $terms = p('terms', []);
        if (!is_array($terms) || count($terms) > 500) fail('Send up to 500 words at a time');
        $ins = db()->prepare('INSERT IGNORE INTO encyclopedia_ignored (campaign_id, scope, term) VALUES (?,?,?)');
        foreach ($terms as $t) $ins->execute([$cid, ignore_scope($role), entry_name($t)]);
        out(['ok' => true]);

    case 'term_restore': // offer a turned-down word again
        $cid = cid();
        $role = role($cid);
        db()->prepare('DELETE FROM encyclopedia_ignored WHERE campaign_id=? AND scope=? AND term=?')->execute([$cid, ignore_scope($role), entry_name(p('term'))]);
        out(['ok' => true]);
    }
}
