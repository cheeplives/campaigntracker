<?php
/**
 * Import from Scabard (see docs/superpowers/specs/2026-10-25-scabard-import-design.md).
 *
 * Scabard's Export campaign writes a JSON file of pages (characters, places, groups, items, notes, adventures, events)
 * and the connections between them. static/scabard.js trims it and sends it here, GMs only, in two passes: the pages
 * first (each becomes an Encyclopedia entry, or a Session when its name starts with a date), then the connections
 * (each becomes a connection between two entries, a tag, or a line in a session's summary). Everything is matched by
 * name, so the same file can be imported again: an entry that exists is kept (a blank one is filled in), a session
 * with the same date and title is kept, and tags and connections are only added where missing. Nothing is deleted.
 *
 * Pictures come in a third pass, one request each (scabard_picture), fetched from scabard.com only.
 */
declare(strict_types=1);

/** Scabard's kinds of page that become Encyclopedia entries, and the tag each gets. */
const SCABARD_CONCEPTS = ['Character' => 'Person', 'Place' => 'Location', 'Group' => 'Group', 'Item' => 'Item', 'Note' => 'Note',
    'Adventure' => 'Adventure', 'Event' => 'Event'];
/** Scabard's connections that are its own housekeeping, not facts about the world. */
const SCABARD_SKIP = ['CONCEPT_OF', 'FOLDER_OF', 'CATEGORY_OF', 'TAB_OF', 'COMMENT_OF', 'CLONE_OF'];
/** "A RELATION_OF B": the connection kind here, reading from A, then from B ('' when it reads the same both ways). */
const SCABARD_RELATIONS = [
    'PARTICIPANT_OF' => ['Participant in', 'Has participant'], 'PROTAGONIST_OF' => ['Protagonist of', 'Has protagonist'],
    'ANTAGONIST_OF' => ['Antagonist of', 'Has antagonist'], 'SETTING_OF' => ['Setting of', 'Set in'], 'PROP_OF' => ['Prop in', 'Has prop'],
    'SUBREGION_OF' => ['Located in', 'Contains'], 'LOCATION_OF' => ['Has resident', 'Resident of'],
    'HEADQUARTERS_OF' => ['Headquarters of', 'Headquartered at'], 'BIRTHPLACE_OF' => ['Birthplace of', 'Born in'],
    'LEADER_OF' => ['Leader of', 'Led by'], 'OWNER_OF' => ['Owns', 'Owned by'], 'MEMBER_OF' => ['Member of', 'Has member'],
    'STEWARD_OF' => ['Steward of', 'Has steward'], 'SEEKER_OF' => ['Seeks', 'Sought by'], 'MAKER_OF' => ['Maker of', 'Made by'],
    'AGENT_OF' => ['Agent of', 'Has agent'], 'NOTE_OF' => ['Note on', 'Has note'], 'BRANCH_OF' => ['Branch of', 'Has branch'],
    'ENCOUNTER_OF' => ['Part of', 'Has part'], 'SUB_EVENT_OF' => ['Part of', 'Has part'], 'NEXT_EVENT_OF' => ['Follows', 'Followed by'],
    'NEIGHBOR_OF' => ['Neighbor of', ''], 'RIVAL_OF' => ['Rival of', ''], 'COMPANION_OF' => ['Companion of', ''],
    'ALLY_OF' => ['Ally of', ''], 'ENEMY_OF' => ['Enemy of', ''], 'RELATED_ITEM_OF' => ['Related to', ''], 'RELATED_OF' => ['Related to', ''],
];
/** The line a connection to a session writes in its summary: "Participants: Figol, Chanceux". */
const SCABARD_CAST = ['PARTICIPANT_OF' => 'Participants', 'PROTAGONIST_OF' => 'Protagonists', 'ANTAGONIST_OF' => 'Antagonists',
    'SETTING_OF' => 'Setting', 'PROP_OF' => 'Props', 'LOCATION_OF' => 'Location'];
/** And from a session to an entry: "Part of: Quest to the Petrified Forest". */
const SCABARD_CAST_FROM = ['ENCOUNTER_OF' => 'Part of', 'SUB_EVENT_OF' => 'Part of'];
const SCABARD_HOSTS = ['scabard.com', 'www.scabard.com'];
const SCABARD_PAGES_MAX = 300;
const SCABARD_CONNS_MAX = 3000;

/** A name as Scabard wrote it, as an entry name here: trimmed, spaces run together, 150 characters at most ('' for none). */
function scabard_name($v): string {
    if (!is_string($v) && !is_numeric($v)) return '';
    $n = trim(preg_replace('/\s+/u', ' ', (string)$v) ?? '');
    return mb_strlen($n) > 150 ? rtrim(mb_substr($n, 0, 150)) : $n;
}
/** A dated event name, "2025-10-05: Final Preparations", as ['date' => '2025-10-05', 'title' => 'Final Preparations'], or null. */
function scabard_session_of(string $name): ?array {
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})(?:\s*[:\-–—.]\s*|\s+|$)(.*)$/su', $name, $m)) return null;
    if (!checkdate((int)$m[2], (int)$m[3], (int)$m[1])) return null;
    return ['date' => "$m[1]-$m[2]-$m[3]", 'title' => trim($m[4])];
}
/** Scabard's text as rich text here: the brief summary as a first paragraph (unless the description starts with it),
 * then the description, cleaned to the allow-list. */
function scabard_rich($brief, $html): string {
    $brief = trim((string)(is_string($brief) ? $brief : ''));
    $html = (string)(is_string($html) ? $html : '');
    $parts = [];
    if ($brief !== '') {
        $b = str_contains($brief, '<') ? $brief : '<p>' . htmlspecialchars($brief, ENT_QUOTES | ENT_HTML5, 'UTF-8') . '</p>';
        // left out when the description opens with the very same line
        $line = fn(string $h) => trim(preg_replace('/\s+/u', ' ', explode("\n", rich_html_plain($h), 2)[0]) ?? '');
        if ($line($html) !== $line($b)) $parts[] = $b;
    }
    $parts[] = $html;
    return rich_html_clean(implode('', $parts));
}
/** Cleaned rich text with each of its top-level blocks wrapped as a GM-only paragraph ('' when there is nothing). */
function scabard_secret_blocks(string $html): string {
    $clean = rich_html_clean($html);
    if ($clean === '') return '';
    $top = rich_nodes($clean);
    $out = '';
    foreach ($top['nodes'] as $n) {
        $h = $top['doc']->saveHTML($n);
        if (trim($h) === '') continue;
        $out .= $n instanceof DOMElement && strtolower($n->nodeName) === 'aside' ? $h : "<aside>$h</aside>";
    }
    return $out;
}
/** Scabard's other names ("Hoffmann, the innkeeper") as a list, without the entry's own name or repeats. */
function scabard_aliases($v, string $own): array {
    if (!is_string($v) || trim($v) === '') return [];
    $out = []; $seen = [mb_strtolower($own) => true];
    foreach (preg_split('/\s*[,;]\s*/u', $v) ?: [] as $a) {
        $a = scabard_name($a);
        if ($a === '' || isset($seen[mb_strtolower($a)])) continue;
        $seen[mb_strtolower($a)] = true;
        $out[] = $a;
        if (count($out) === 30) break;
    }
    return $out;
}

/** The campaign's entries by every name they go by (lower case), with what the import needs to know of each. */
function scabard_index(int $cid): array {
    $st = db()->prepare("SELECT id, name, aliases_json, is_secret, (COALESCE(notes, '') = '' AND COALESCE(gm_notes, '') = '') AS blank FROM encyclopedia_entries WHERE campaign_id=?");
    $st->execute([$cid]);
    $idx = ['by' => [], 'rows' => []];
    foreach ($st->fetchAll() as $e) {
        $id = (int)$e['id'];
        $idx['rows'][$id] = ['id' => $id, 'name' => $e['name'], 'aliases' => entry_aliases($e), 'is_secret' => (bool)$e['is_secret'], 'blank' => (bool)$e['blank']];
        $idx['by'][mb_strtolower($e['name'])] = $id;
    }
    foreach ($idx['rows'] as $id => $e) foreach ($e['aliases'] as $a) $idx['by'][mb_strtolower($a)] ??= $id;
    return $idx;
}
/** The entry a name is the name or another name of, or null. */
function scabard_entry(array $idx, string $name): ?array {
    $id = $idx['by'][mb_strtolower($name)] ?? null;
    return $id !== null ? $idx['rows'][$id] : null;
}
/** Tag entry $eid with $name, making the tag if the campaign hasn't got it (a starter's colour where the name is one). True when added. */
function scabard_tag(int $cid, int $eid, string $name, array &$tags): bool {
    $name = mb_substr(scabard_name($name), 0, 40);
    if ($name === '') return false;
    $k = mb_strtolower($name);
    if (!isset($tags[$k])) {
        $st = db()->prepare('SELECT id FROM encyclopedia_tag_names WHERE campaign_id=? AND name=?');
        $st->execute([$cid, $name]);
        $id = $st->fetchColumn();
        if ($id === false) {
            $color = '#6b7280';
            foreach (ENTRY_STARTER_TAGS as $n => $c) if (strcasecmp($n, $name) === 0) { $color = $c; $name = $n; }
            db()->prepare('INSERT INTO encyclopedia_tag_names (campaign_id, name, color) VALUES (?,?,?)')->execute([$cid, $name, $color]);
            $id = db()->lastInsertId();
        }
        $tags[$k] = (int)$id;
    }
    $st = db()->prepare('INSERT IGNORE INTO encyclopedia_tags (entry_id, tag_id) VALUES (?,?)');
    $st->execute([$eid, $tags[$k]]);
    return $st->rowCount() > 0;
}
/** The session (id, summary, version) played on $date with $title, or null. */
function scabard_session(int $cid, string $date, string $title): ?array {
    $st = db()->prepare('SELECT id, summary, version FROM play_sessions WHERE campaign_id=? AND played_on=? AND title=? ORDER BY id LIMIT 1');
    $st->execute([$cid, $date, $title]);
    return $st->fetch() ?: null;
}
/** A fresh report, which the browser adds up across calls. */
function scabard_report(): array {
    return ['entries' => ['added' => 0, 'filled' => 0, 'kept' => 0], 'sessions' => ['added' => 0, 'kept' => 0], 'tags' => 0, 'connections' => 0,
        'lines' => 0, 'skipped' => ['pages' => 0, 'connections' => 0, 'unresolved' => 0], 'pictures' => [], 'elsewhere' => []];
}

/** Pages and connections from a Scabard export, as scabard.js sends them. Returns the report. */
function scabard_import(int $cid, array $b): array {
    need_encyclopedia();
    need_relations();
    $opts = is_array($b['options'] ?? null) ? $b['options'] : [];
    $asSessions = ($opts['sessions'] ?? 'sessions') !== 'entries';
    $pages = $b['pages'] ?? [];
    $conns = $b['conns'] ?? [];
    if (!is_array($pages) || !is_array($conns)) fail('Expected pages and connections');
    if (count($pages) > SCABARD_PAGES_MAX) fail('Send up to ' . SCABARD_PAGES_MAX . ' pages at a time');
    if (count($conns) > SCABARD_CONNS_MAX) fail('Send up to ' . SCABARD_CONNS_MAX . ' connections at a time');
    $r = scabard_report();
    db()->beginTransaction();
    db()->prepare('SELECT id FROM campaigns WHERE id=? FOR UPDATE')->execute([$cid]); // one import at a time
    $idx = scabard_index($cid);
    $tags = [];
    foreach ($pages as $p) {
        if (!is_array($p)) fail('Expected a list of pages');
        scabard_page($cid, $p, $asSessions, $idx, $tags, $r);
    }
    $lines = []; // session id => label => [names]
    foreach ($conns as $c) {
        if (!is_array($c)) fail('Expected a list of connections');
        scabard_conn($cid, $c, $asSessions, $idx, $tags, $lines, $r);
    }
    foreach ($lines as $sid => $byLabel) $r['lines'] += scabard_cast_lines($cid, (int)$sid, $byLabel);
    db()->commit();
    return $r;
}

/** One page: an entry (new, filled in or kept) or a session (new or kept). */
function scabard_page(int $cid, array $p, bool $asSessions, array &$idx, array &$tags, array &$r): void {
    $concept = (string)($p['concept'] ?? '');
    $name = scabard_name($p['name'] ?? '');
    if (!isset(SCABARD_CONCEPTS[$concept]) || $name === '') { $r['skipped']['pages']++; return; }
    $secrets = is_string($p['secrets'] ?? null) ? $p['secrets'] : '';
    $isSecret = !empty($p['is_secret']);
    if ($concept === 'Event' && $asSessions && ($s = scabard_session_of($name))) {
        need_sessions();
        if (scabard_session($cid, $s['date'], $s['title'])) { $r['sessions']['kept']++; return; }
        $c = campaign_row($cid);
        $day = floordiv((int)$c['current_shift'], camp_spd($c));
        $st = db()->prepare('SELECT COALESCE(MAX(number), 0) + 1 FROM play_sessions WHERE campaign_id=? FOR UPDATE');
        $st->execute([$cid]);
        $summary = scabard_rich($p['brief'] ?? '', $p['description'] ?? '') . scabard_secret_blocks($secrets);
        db()->prepare('INSERT INTO play_sessions (campaign_id, number, title, played_on, first_day, last_day, summary, summary_format, is_published, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
            ->execute([$cid, (int)$st->fetchColumn(), mb_substr($s['title'], 0, 200), $s['date'], $day, $day, $summary ?: null, 'html', $isSecret ? 0 : 1, me()['id']]);
        $r['sessions']['added']++;
        return;
    }
    $notes = scabard_rich($p['brief'] ?? '', $p['description'] ?? '') ?: null;
    $gm = rich_html_clean($secrets) ?: null;
    $aliases = scabard_aliases($p['aliases'] ?? '', $name);
    $e = scabard_entry($idx, $name);
    // other names that are already a name of something else are left out rather than refused
    $keep = array_values(array_filter($aliases, fn($a) => !($o = scabard_entry($idx, $a)) || ($e && $o['id'] === $e['id'])));
    if ($e && (!$e['blank'] || ($notes === null && $gm === null && !array_diff($keep, $e['aliases'])))) { // nothing new to write into it
        $r['entries']['kept']++;
        $id = $e['id'];
    } else {
        if ($e) {
            $all = array_values(array_unique(array_merge($e['aliases'], $keep)));
            db()->prepare('UPDATE encyclopedia_entries SET aliases_json=?, notes=?, gm_notes=? WHERE id=?')
                ->execute([$all ? json_encode($all, JSON_UNESCAPED_UNICODE) : null, $notes, $gm, $e['id']]);
            $id = $e['id'];
            $idx['rows'][$id]['blank'] = $notes === null && $gm === null;
            $idx['rows'][$id]['aliases'] = $all;
            $r['entries']['filled']++;
        } else {
            db()->prepare('INSERT INTO encyclopedia_entries (campaign_id, name, aliases_json, notes, gm_notes, is_secret, created_by) VALUES (?,?,?,?,?,?,?)')
                ->execute([$cid, $name, $keep ? json_encode($keep, JSON_UNESCAPED_UNICODE) : null, $notes, $gm, $isSecret ? 1 : 0, me()['id']]);
            $id = (int)db()->lastInsertId();
            $idx['rows'][$id] = ['id' => $id, 'name' => $name, 'aliases' => $keep, 'is_secret' => $isSecret, 'blank' => $notes === null && $gm === null];
            $idx['by'][mb_strtolower($name)] = $id;
            $r['entries']['added']++;
        }
        foreach ($keep as $a) $idx['by'][mb_strtolower($a)] ??= $id;
    }
    if (scabard_tag($cid, $id, SCABARD_CONCEPTS[$concept], $tags)) $r['tags']++;
    // Its picture, for the browser's third pass: Scabard's own pictures only; one hosted elsewhere is named in the report.
    $urls = []; $elsewhere = false;
    foreach (is_array($p['images'] ?? null) ? $p['images'] : [] as $u) {
        if (!is_string($u) || trim($u) === '') continue;
        $u = trim($u);
        if (str_starts_with($u, '/')) $u = 'https://www.scabard.com' . $u;
        $host = strtolower((string)parse_url($u, PHP_URL_HOST));
        if (in_array($host, SCABARD_HOSTS, true) && str_starts_with($u, 'https://')) $urls[] = $u;
        elseif (preg_match('#^https?://#i', $u)) $elsewhere = true;
    }
    if ($urls) $r['pictures'][] = ['name' => $name, 'urls' => array_values(array_unique($urls)), 'page_url' => is_string($p['uri'] ?? null) && str_starts_with($p['uri'], '/') ? 'https://www.scabard.com' . $p['uri'] : ''];
    elseif ($elsewhere) $r['elsewhere'][] = $name;
}

/** One end of a connection: ['entry' => row] or ['session' => id], or null when it isn't here. */
function scabard_end(int $cid, string $name, string $concept, bool $asSessions, array $idx): ?array {
    if ($name === '') return null;
    if ($concept === 'Event' && $asSessions && ($s = scabard_session_of($name))) {
        $row = has_sessions() ? scabard_session($cid, $s['date'], $s['title']) : null;
        return $row ? ['session' => (int)$row['id']] : null;
    }
    $e = scabard_entry($idx, $name);
    return $e ? ['entry' => $e] : null;
}
/** One connection: a tag (from a category), a Player line, a connection between entries, or a line in a session's summary. */
function scabard_conn(int $cid, array $c, bool $asSessions, array &$idx, array &$tags, array &$lines, array &$r): void {
    $rel = strtoupper(trim((string)($c['relationship'] ?? '')));
    $from = scabard_name($c['from'] ?? ''); $to = scabard_name($c['to'] ?? '');
    $fromc = (string)($c['fromc'] ?? ''); $toc = (string)($c['toc'] ?? '');
    if ($rel === '' || in_array($rel, SCABARD_SKIP, true) || !preg_match('/^[A-Z][A-Z0-9_]*_OF$/', $rel)) { $r['skipped']['connections']++; return; }
    $toEnd = scabard_end($cid, $to, $toc, $asSessions, $idx);
    if ($fromc === 'CCategory') { // Scabard's categories (City, NPC, PC…) are tags here
        if (!$toEnd) { $r['skipped']['unresolved']++; return; }
        if (!isset($toEnd['entry'])) { $r['skipped']['connections']++; return; } // sessions carry no tags
        if (scabard_tag($cid, $toEnd['entry']['id'], $from, $tags)) $r['tags']++;
        return;
    }
    if ($rel === 'PLAYER_OF') { // from a Scabard user, not a page: "Player: name" at the end of the character's notes
        $who = scabard_name($c['fromu'] ?? '');
        if (!$toEnd || !isset($toEnd['entry']) || $who === '') { $r['skipped']['connections']++; return; }
        $st = db()->prepare('SELECT notes FROM encyclopedia_entries WHERE id=?');
        $st->execute([$toEnd['entry']['id']]);
        $notes = (string)$st->fetchColumn();
        $line = '<p>Player: ' . htmlspecialchars($who, ENT_NOQUOTES, 'UTF-8') . '</p>';
        if (!str_contains($notes, $line)) {
            db()->prepare('UPDATE encyclopedia_entries SET notes=? WHERE id=?')->execute([$notes . $line, $toEnd['entry']['id']]);
            $idx['rows'][$toEnd['entry']['id']]['blank'] = false;
            $r['lines']++;
        }
        return;
    }
    if (!isset(SCABARD_CONCEPTS[$fromc]) || !isset(SCABARD_CONCEPTS[$toc])) { $r['skipped']['connections']++; return; }
    $fromEnd = scabard_end($cid, $from, $fromc, $asSessions, $idx);
    if (!$fromEnd || !$toEnd) { $r['skipped']['unresolved']++; return; }
    if (isset($fromEnd['session']) && isset($toEnd['session'])) { $r['skipped']['connections']++; return; } // the dates order them
    if (isset($toEnd['session'])) { $lines[$toEnd['session']][SCABARD_CAST[$rel] ?? scabard_label($rel)[0]][] = $fromEnd['entry']['name']; return; }
    if (isset($fromEnd['session'])) { $lines[$fromEnd['session']][SCABARD_CAST_FROM[$rel] ?? scabard_label($rel)[0]][] = $toEnd['entry']['name']; return; }
    $a = $fromEnd['entry']; $b = $toEnd['entry'];
    if ($a['id'] === $b['id']) { $r['skipped']['connections']++; return; }
    [$label, $inverse] = scabard_label($rel);
    // A starter kind written the other way round ("Located in" / "Contains") is used as the starter, from its other end.
    $swap = false;
    foreach (RELATION_STARTER_TYPES as [$l, $i]) if ($i !== '' && strcasecmp($l, $inverse) === 0 && strcasecmp($i, $label) === 0) { [$label, $inverse] = [$l, $i]; $swap = true; }
    $flip = false;
    $tid = relation_type_id($cid, ['label' => $label, 'inverse_label' => $inverse, 'symmetric' => $inverse === ''], $flip);
    [$f, $t] = $flip !== $swap ? [$b['id'], $a['id']] : [$a['id'], $b['id']];
    if ($inverse === '') { // a symmetric pair counts in either order
        $st = db()->prepare('SELECT 1 FROM encyclopedia_relations WHERE type_id=? AND from_id=? AND to_id=?');
        $st->execute([$tid, $t, $f]);
        if ($st->fetchColumn()) return;
    }
    $secret = !empty($c['secret']) || $a['is_secret'] || $b['is_secret'] ? 1 : 0;
    $st = db()->prepare('INSERT IGNORE INTO encyclopedia_relations (campaign_id, from_id, to_id, type_id, note, is_secret, created_by) VALUES (?,?,?,?,?,?,?)');
    $st->execute([$cid, $f, $t, $tid, !empty($c['former']) ? 'Former' : null, $secret, me()['id']]);
    if ($st->rowCount() > 0) $r['connections']++;
}
/** The kind of connection for a Scabard relationship: a known one, else "X of" / "Has x" from its name. */
function scabard_label(string $rel): array {
    if (isset(SCABARD_RELATIONS[$rel])) return SCABARD_RELATIONS[$rel];
    $word = strtolower(str_replace('_', ' ', substr($rel, 0, -3)));
    return [mb_substr(ucfirst($word) . ' of', 0, 40), mb_substr('Has ' . $word, 0, 40)];
}
/** Add "Label: name, name" paragraphs to a session's summary, each label once (a label it already has is left). Returns how many were added. */
function scabard_cast_lines(int $cid, int $sid, array $byLabel): int {
    $st = db()->prepare('SELECT summary FROM play_sessions WHERE id=? AND campaign_id=?');
    $st->execute([$sid, $cid]);
    $summary = (string)$st->fetchColumn();
    $esc = fn(string $s) => htmlspecialchars($s, ENT_NOQUOTES, 'UTF-8');
    // The cast first, in a fixed order, then whatever else the connections said.
    $first = ['Participants', 'Protagonists', 'Antagonists', 'Setting', 'Location', 'Props', 'Part of'];
    uksort($byLabel, fn($a, $b) => (array_search($a, $first, true) === false ? 99 : array_search($a, $first, true)) <=> (array_search($b, $first, true) === false ? 99 : array_search($b, $first, true)) ?: strcmp((string)$a, (string)$b));
    $added = 0;
    foreach ($byLabel as $label => $names) {
        if (str_contains($summary, '<p>' . $esc((string)$label) . ': ')) continue;
        $summary .= '<p>' . $esc((string)$label) . ': ' . $esc(implode(', ', array_values(array_unique($names)))) . '</p>';
        $added++;
    }
    if ($added) db()->prepare("UPDATE play_sessions SET summary=?, summary_format='html', version=version+1 WHERE id=?")->execute([$summary, $sid]);
    return $added;
}

/** A page's picture, fetched from scabard.com and kept on its entry, credited to Scabard: name, urls (tried in order),
 * page_url. Answers {ok, copied} or {ok, skipped: why}; an entry that has a picture already is left as it is. */
function scabard_picture(int $cid, array $b): array {
    need_encyclopedia();
    need_attachments();
    if (!upload_dir()['dir']) fail(upload_info()['problem'], 409, 'uploads_unavailable');
    $name = scabard_name($b['name'] ?? '');
    $e = $name !== '' ? entry_named($cid, $name) : null;
    if (!$e) fail('Entry not found', 404);
    $st = db()->prepare("SELECT COUNT(*) FROM attachments WHERE campaign_id=? AND parent_type='encyclopedia' AND parent_id=? AND kind IN ('image', 'embed')");
    $st->execute([$cid, $e['id']]);
    if ((int)$st->fetchColumn() > 0) return ['ok' => true, 'skipped' => 'has_picture'];
    $urls = is_array($b['urls'] ?? null) ? array_slice($b['urls'], 0, 3) : [];
    $max = upload_max_bytes();
    $tmp = null;
    foreach ($urls as $u) {
        if (!is_string($u) || !preg_match('#^https://#i', $u) || !in_array(strtolower((string)parse_url($u, PHP_URL_HOST)), SCABARD_HOSTS, true)) continue;
        try { $tmp = image_download($u, $max); break; } catch (ImageSourceDown | LengthException) {}
    }
    if (!$tmp) return ['ok' => true, 'skipped' => 'unreachable'];
    register_shutdown_function(fn() => is_file($tmp) && @unlink($tmp));
    if (!@getimagesize($tmp)) return ['ok' => true, 'skipped' => 'not_picture'];
    $size = (int)filesize($tmp);
    attachment_room($cid, 'encyclopedia', (int)$e['id'], $size);
    $file = found_name($e['name'], $tmp);
    [$mime, $kind, $w, $h] = upload_type($tmp, $file);
    if ($kind !== 'image') return ['ok' => true, 'skipped' => 'not_picture'];
    $page = is_string($b['page_url'] ?? null) && preg_match('#^https://(www\.)?scabard\.com/#', $b['page_url']) && strlen($b['page_url']) <= 500 ? $b['page_url'] : null;
    $credit = has_credits() ? ['credit_title' => mb_substr($e['name'], 0, 200), 'credit_source' => 'Scabard', 'credit_source_url' => $page] : [];
    $row = attachment_store($cid, $tmp, ['parent_type' => 'encyclopedia', 'parent_id' => (int)$e['id'], 'original_name' => $file, 'mime' => $mime,
        'kind' => 'image', 'size_bytes' => $size, 'width' => $w, 'height' => $h, 'is_secret' => 0] + $credit);
    return ['ok' => true, 'copied' => true, 'file' => $row];
}
