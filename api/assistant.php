<?php
/**
 * The Assistant: a helper for GMs that reads a campaign and drafts Encyclopedia entries, connections and ideas with
 * Claude. Helpers for the actions in api/index.php's switch, which say who may use them in api/actions.php: GMs only.
 *
 * The model is called from the GM's browser with their own Anthropic key (static/assistant.js), never from here, so
 * this file sends nothing anywhere. It keeps the campaign guide (what the assistant should always know, written by the
 * GM), offers the genre packs in db/genre-packs, and gives the browser what the assistant reads: a short index of the
 * campaign, one entry or session in full, and a search. Nothing here writes to the campaign but the guide: what the
 * assistant proposes is saved, once a GM accepts it, by the same actions the pages use (entry_save, relations_save).
 *
 * A GM switches it on in Settings (settings.assistant.enabled); until then the reading actions refuse.
 * db/migrations/060_campaign_guides.sql describes the guide's table (061_guide_prompt.sql gave it room for the campaign prompt).
 */
declare(strict_types=1);

/** The guide's parts, in the order the form shows them: key => the most characters it holds. */
const ASSISTANT_GUIDE = ['prompt' => 12000, 'premise' => 2000, 'power' => 2000, 'lines' => 2000, 'style' => 2000, 'canon' => 4000, 'rules' => 2000, 'secrets' => 4000];
const ASSISTANT_READ_MAX = 24000;     // the most characters of one entry or session handed over
const ASSISTANT_INDEX_MAX = 3000;     // the most entries in the index
const ASSISTANT_LINKS_MAX = 3000;     // the most connections in the index

/** Whether a GM has switched the assistant on for campaign $cid. */
function assistant_on(int $cid): bool {
    $a = campaign_settings($cid)['assistant'] ?? null;
    return is_array($a) && !empty($a['enabled']);
}
function assistant_need_on(int $cid): void {
    if (!assistant_on($cid)) fail('The assistant is switched off for this campaign. A GM can switch it on in Settings, Assistant.', 403, 'assistant_off');
}

/** The genre packs: key => ['name' => its first line, 'text' => the rest]. */
function assistant_packs(): array {
    static $packs = null;
    if ($packs !== null) return $packs;
    $packs = [];
    foreach (glob(dirname(__DIR__) . '/db/genre-packs/*.md') ?: [] as $file) {
        $key = basename($file, '.md');
        if (!preg_match('/^[a-z0-9-]+$/', $key)) continue;   // README.md is the folder's own notes
        $text = trim((string)file_get_contents($file));
        if (!preg_match('/^# (.+)\n/', $text, $m)) continue;
        $packs[$key] = ['name' => trim($m[1]), 'text' => trim(substr($text, strlen($m[0])))];
    }
    uasort($packs, fn($a, $b) => strcasecmp($a['name'], $b['name']));
    return $packs;
}

/** The guide's row for campaign $cid, or a blank one that has never been saved (version 0). */
function assistant_guide(int $cid): array {
    $st = db()->prepare('SELECT g.guide_json, g.version, g.updated_at, ' . user_name_sql() . ' AS by_name
        FROM campaign_guides g LEFT JOIN users u ON u.id=g.updated_by WHERE g.campaign_id=?');
    $st->execute([$cid]);
    $r = $st->fetch();
    $saved = $r ? dec($r['guide_json']) : null;
    $guide = [];
    foreach (ASSISTANT_GUIDE as $k => $max) $guide[$k] = is_array($saved) && is_string($saved[$k] ?? null) ? $saved[$k] : '';
    return ['guide' => $guide, 'version' => $r ? (int)$r['version'] : 0, 'updated_at' => $r['updated_at'] ?? null, 'updated_by' => $r['by_name'] ?? null];
}
/** A guide sent by the browser: only its known parts, each trimmed plain text within its length. */
function assistant_guide_in($v): array {
    if (!is_array($v)) fail('Expected the campaign guide');
    $out = [];
    foreach (ASSISTANT_GUIDE as $k => $max) {
        $t = str_replace(["\r\n", "\r"], "\n", (string)str_in($v[$k] ?? '', $max + 200, false));
        $t = trim(preg_replace("/\n{3,}/", "\n\n", preg_replace('/[^\S\n]+/u', ' ', $t)));
        if (mb_strlen($t) > $max) fail("That part of the guide is too long (at most $max characters)");
        $out[$k] = $t;
    }
    return $out;
}

/** Stored rich text as the plain text the assistant reads: a GM-only paragraph starts "[GM only]". */
function assistant_plain(?string $html): string {
    if ($html === null || $html === '') return '';
    return rich_html_plain(preg_replace('#<aside>#i', '<aside>[GM only] ', $html));
}
/** A text cut to $max characters, saying so when it was. */
function assistant_cut(string $t, int $max): string {
    return mb_strlen($t) > $max ? rtrim(mb_substr($t, 0, $max)) . "\n[…cut here: the rest is too long to read in one go]" : $t;
}
/** The first $max characters of a text, on one line. */
function assistant_gist(string $t, int $max): string {
    $t = trim(preg_replace('/\s+/u', ' ', $t));
    return mb_strlen($t) > $max ? rtrim(mb_substr($t, 0, $max - 1)) . '…' : $t;
}

/** The campaign's connections as the assistant reads them: [[from id, label, to id, GM only], …]. */
function assistant_links(int $cid, ?int $entry = null): array {
    $st = db()->prepare('SELECT r.from_id, r.to_id, r.is_secret, t.label FROM encyclopedia_relations r JOIN encyclopedia_relation_types t ON t.id=r.type_id
        WHERE r.campaign_id=?' . ($entry ? ' AND (r.from_id=? OR r.to_id=?)' : '') . ' ORDER BY r.id LIMIT ' . ASSISTANT_LINKS_MAX);
    $st->execute($entry ? [$cid, $entry, $entry] : [$cid]);
    return array_map(fn($r) => [(int)$r['from_id'], $r['label'], (int)$r['to_id'], (bool)(int)$r['is_secret']], $st->fetchAll());
}

/** One entry in full, as text. */
function assistant_entry_text(int $cid, array $e): string {
    $fields = campaign_entry_fields($cid);
    $L = ["Entry {$e['id']}: {$e['name']}"];
    $L[] = 'Category: ' . ($e['category'] ?: 'none') . ((int)$e['is_secret'] ? '. GM only: players can\'t see this entry.' : '');
    if ($a = entry_aliases($e)) $L[] = 'Other names: ' . implode('; ', $a);
    foreach ((array)facts_out($e['facts_json'], $e['category'], $fields, true) as $k => $v) {
        if (is_scalar($v) && (string)$v !== '') $L[] = ucfirst(str_replace('_', ' ', (string)$k)) . ": $v";
    }
    $names = db()->prepare('SELECT id, name FROM encyclopedia_entries WHERE campaign_id=?');
    $names->execute([$cid]);
    $name = array_column($names->fetchAll(), 'name', 'id');
    $links = [];
    foreach (assistant_links($cid, (int)$e['id']) as [$from, $label, $to, $secret]) {
        if (isset($name[$from], $name[$to])) $links[] = "- {$name[$from]} ($from) — $label — {$name[$to]} ($to)" . ($secret ? ' [GM only]' : '');
    }
    if ($links) array_push($L, '', 'Connections:', ...$links);
    $notes = assistant_plain($e['notes']); $gm = assistant_plain($e['gm_notes']);
    array_push($L, '', 'Public notes:', $notes !== '' ? $notes : '(nothing written yet)', '', 'GM notes (players never see these):', $gm !== '' ? $gm : '(nothing written yet)');
    return assistant_cut(implode("\n", $L), ASSISTANT_READ_MAX);
}
/** One session in full, as text. */
function assistant_session_text(array $s): string {
    $L = ["Session {$s['number']}" . ($s['title'] !== '' ? ": {$s['title']}" : '') . " (id {$s['id']})"];
    if ($s['played_on']) $L[] = "Played on {$s['played_on']}";
    $L[] = (int)$s['is_published'] ? 'Published: players can read its summary.' : 'Not published: players can\'t read it yet.';
    foreach ([['summary', 'Summary'], ['rewards', 'Session rewards'], ['loot', 'Loot found']] as [$k, $label]) {
        $t = assistant_plain($s[$k] ?? null);
        if ($t !== '') array_push($L, '', "$label:", $t);
    }
    $notes = trim((string)($s['notes_text'] ?? ''));
    if ($notes !== '') array_push($L, '', 'The GM\'s own notes (players never see these):', $notes);
    if (count($L) < 4) $L[] = '(nothing written yet)';
    return assistant_cut(implode("\n", $L), ASSISTANT_READ_MAX);
}

/** The words around the first place $q is found in $text, or the text's start. */
function assistant_snippet(string $text, string $q): string {
    $text = trim(preg_replace('/\s+/u', ' ', $text));
    $at = mb_stripos($text, $q);
    if ($at === false) return assistant_gist($text, 200);
    $from = max(0, $at - 90);
    return ($from ? '…' : '') . trim(mb_substr($text, $from, 220)) . (mb_strlen($text) > $from + 220 ? '…' : '');
}

function assistant_action(string $action): void {
    $cid = cid();
    $pdo = db();
    switch ($action) {
    case 'assistant':
        // What Settings, Assistant draws: the guide and the genre packs to pick from.
        out(assistant_guide($cid) + ['packs' => array_map(fn($k, $p) => ['key' => $k, 'name' => $p['name']], array_keys(assistant_packs()), assistant_packs()),
            'limits' => ASSISTANT_GUIDE]);

    case 'assistant_guide_save':
        // The guide's text. version: the one the form was drawn from (0: never saved), so two GMs can't overwrite each other.
        $guide = assistant_guide_in(p('guide'));
        $version = int_in(p('version', 0), 0);
        $pdo->beginTransaction();
        $st = $pdo->prepare('SELECT version FROM campaign_guides WHERE campaign_id=? FOR UPDATE');
        $st->execute([$cid]);
        $has = $st->fetchColumn();
        if ((int)$has !== $version) fail('Another GM changed the guide while you were writing. Copy your changes, reload and try again.', 409, 'stale');
        $json = json_encode($guide, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($has === false) {
            $pdo->prepare('INSERT INTO campaign_guides (campaign_id, guide_json, version, updated_by) VALUES (?,?,1,?)')->execute([$cid, $json, me()['id']]);
        } else {
            history_before($cid, 'guide', $cid);
            $pdo->prepare('UPDATE campaign_guides SET guide_json=?, version=version+1, updated_by=? WHERE campaign_id=?')->execute([$json, me()['id'], $cid]);
        }
        history_record($cid, 'guide', $cid);
        $pdo->commit();
        out(['ok' => true] + assistant_guide($cid));

    case 'assistant_context':
        // What every request starts from: the campaign, its genre pack and guide, and a short index of its entries,
        // sessions and connections. The assistant opens what it needs from there (assistant_read, assistant_search).
        assistant_need_on($cid);
        $c = campaign_row($cid);
        $set = dec($c['settings_json']) ?: [];
        $pack = assistant_packs()[(string)($set['assistant']['pack'] ?? '')] ?? null;
        $st = $pdo->prepare('SELECT COUNT(*) FROM encyclopedia_entries WHERE campaign_id=?');
        $st->execute([$cid]);
        $count = (int)$st->fetchColumn();
        $gist = $count <= 400 ? 160 : ($count <= 1200 ? 80 : 0);   // a big Encyclopedia is indexed by name alone
        $st = $pdo->prepare('SELECT id, name, category, aliases_json, is_secret' . ($gist ? ", LEFT(COALESCE(NULLIF(notes, ''), gm_notes, ''), 700) AS head" : ", '' AS head")
            . ' FROM encyclopedia_entries WHERE campaign_id=? ORDER BY name LIMIT ' . ASSISTANT_INDEX_MAX);
        $st->execute([$cid]);
        $entries = array_map(fn($e) => ['id' => (int)$e['id'], 'name' => $e['name'], 'category' => $e['category'], 'aliases' => entry_aliases($e),
            'gm_only' => (bool)(int)$e['is_secret'], 'gist' => $gist ? assistant_gist(assistant_plain(entry_head($e['head'], strlen($e['head']) >= 700, true)), $gist) : ''], $st->fetchAll());
        $st = $pdo->prepare('SELECT id, number, title, played_on, is_published, LEFT(COALESCE(summary, \'\'), 900) AS head FROM play_sessions WHERE campaign_id=? ORDER BY number');
        $st->execute([$cid]);
        $sessions = array_map(fn($s) => ['id' => (int)$s['id'], 'number' => (int)$s['number'], 'title' => $s['title'], 'played_on' => $s['played_on'],
            'published' => (bool)(int)$s['is_published'], 'gist' => assistant_gist(assistant_plain(entry_head($s['head'], strlen($s['head']) >= 900, true)), 220)], $st->fetchAll());
        out(['campaign' => ['name' => $c['name'], 'description' => (string)$c['description']],
            'pack' => $pack ? ['name' => $pack['name'], 'text' => $pack['text']] : null,
            'guide' => assistant_guide($cid)['guide'], 'entries' => $entries, 'entries_total' => $count, 'sessions' => $sessions,
            'links' => assistant_links($cid)]);

    case 'assistant_read':
        // One entry or session in full, as plain text.
        assistant_need_on($cid);
        $id = int_in($_GET['id'] ?? null, 1);
        if (($_GET['kind'] ?? '') === 'session') out(['text' => assistant_session_text(session_row($cid, $id))]);
        $e = entry_row($cid, $id, 'gm');
        // notes and gm_notes: the stored rich text, which a proposal the GM accepts is added to or put in place of
        out(['text' => assistant_entry_text($cid, $e), 'name' => $e['name'], 'version' => (int)$e['version'], 'notes' => (string)$e['notes'], 'gm_notes' => (string)$e['gm_notes']]);

    case 'assistant_search':
        // Entries and sessions whose text holds q, best first (a name before the notes), with the words around it.
        assistant_need_on($cid);
        $q = trim((string)str_in($_GET['q'] ?? '', 100, false));
        if (mb_strlen($q) < 2) fail('Search for at least two letters');
        $like = '%' . addcslashes($q, '%_\\') . '%';
        $st = $pdo->prepare("SELECT id, name, category, is_secret, notes, gm_notes, (name LIKE ? OR COALESCE(aliases_json, '') LIKE ?) AS named
            FROM encyclopedia_entries WHERE campaign_id=? AND (name LIKE ? OR COALESCE(aliases_json, '') LIKE ? OR notes LIKE ? OR gm_notes LIKE ?) ORDER BY named DESC, name LIMIT 12");
        $st->execute([$like, $like, $cid, $like, $like, $like, $like]);
        $hits = [];
        foreach ($st->fetchAll() as $e) {
            $text = assistant_plain($e['notes']); $gm = assistant_plain($e['gm_notes']);
            $inGm = mb_stripos($text, $q) === false && mb_stripos($gm, $q) !== false;
            $hits[] = ['kind' => 'entry', 'id' => (int)$e['id'], 'name' => $e['name'], 'category' => $e['category'], 'gm_only' => (bool)(int)$e['is_secret'] || $inGm,
                'snippet' => assistant_snippet($inGm ? $gm : ($text !== '' ? $text : $gm), $q)];
        }
        $st = $pdo->prepare("SELECT id, number, title, summary, notes_text FROM play_sessions WHERE campaign_id=? AND (title LIKE ? OR summary LIKE ? OR notes_text LIKE ?) ORDER BY number DESC LIMIT 8");
        $st->execute([$cid, $like, $like, $like]);
        foreach ($st->fetchAll() as $s) {
            $sum = assistant_plain($s['summary']);
            $inNotes = mb_stripos($sum, $q) === false && mb_stripos((string)$s['notes_text'], $q) !== false;
            $hits[] = ['kind' => 'session', 'id' => (int)$s['id'], 'name' => "Session {$s['number']}" . ($s['title'] !== '' ? ": {$s['title']}" : ''), 'gm_only' => $inNotes,
                'snippet' => assistant_snippet($inNotes ? (string)$s['notes_text'] : $sum, $q)];
        }
        out(['q' => $q, 'hits' => $hits]);
    }
}
