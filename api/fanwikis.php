<?php
/**
 * fanwikis.php — Fan wikis: an Encyclopedia entry's name looked up on a setting's fan wiki (Wookieepedia, Memory Alpha,
 * Tolkien Gateway…), for a summary of the article's opening to add to the notes, and for pictures to copy to the entry.
 *
 * A module of its own, so it can be switched off or taken out without touching the rest of the app:
 *   - 'fan_wikis' => ['enabled' => false] in the config turns all of it off (the buttons and the About page's list go);
 *   - 'fan_wikis' => ['open_only' => true] keeps only openly licensed text and pictures (for a commercial version);
 *   - tools/fanwiki-kill-switch.sh --non-open deletes api/fanwikis-nonopen.php, which holds every wiki and every use
 *     that isn't openly licensed, and --all deletes the module. index.php, images.php and app.js each check it is here.
 *
 * The wikis are listed in fanwikis-open.php and fanwikis-nonopen.php. Each one is asked for its own licence (MediaWiki's
 * siteinfo rightsinfo) when it is used, so text is credited with the licence the wiki states today; if that turns out
 * not to be open and the non-open file is gone (or open_only is set), its text is refused. Pictures are judged one by
 * one from their file page's licence or licensing categories: an open one is copied with its credit, any other only as
 * "Personal fair use" while fanwikis-nonopen.php allows it.
 *
 * The server does every request (so the browser needs no new connect-src or img-src, and the reader's address never
 * reaches the wikis); thumbnails come through fanwiki_thumb. When the config names a fan_wikis.stub file (the tests
 * do), that file's function answers instead and nothing leaves the machine.
 */

const FANWIKI_ACTIONS = ['fanwiki_wikis', 'fanwiki_search', 'fanwiki_summary', 'fanwiki_images', 'fanwiki_thumb'];
/** Actions that only read, so index.php takes them as GET. */
const FANWIKI_READ_ACTIONS = FANWIKI_ACTIONS;
const FANWIKI_HITS = 8;
const FANWIKI_IMAGES = 20;
/** How long a wiki's api.php address, article path and licence are trusted before they are asked again, in seconds. */
const FANWIKI_RECHECK = 86400;
/** The credit a picture or text gets when it has no open licence and is kept only for the campaign's own use. */
const FANWIKI_FAIR_USE = 'Personal fair use, not openly licensed';
const FANWIKI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function fanwiki_cfg(): array { return (array)cfg('fan_wikis', []) + ['enabled' => true, 'open_only' => false]; }
function fanwiki_on(): bool { return !empty(fanwiki_cfg()['enabled']); }
/** fanwikis-nonopen.php's list, or [] when it has been removed or the config keeps to open sources. */
function fanwiki_nonopen(): array {
    static $n = null;
    $file = __DIR__ . '/fanwikis-nonopen.php';
    return $n ??= empty(fanwiki_cfg()['open_only']) && is_file($file) ? (array)require $file : [];
}
/** Whether what isn't openly licensed may be used at all: non-commercial text, text with no licence, fair-use pictures. */
function fanwiki_fair_use(): bool { return !empty(fanwiki_nonopen()['fair_use']); }
/** Every wiki that may be used, by key: the open ones, and the others while fanwikis-nonopen.php allows them. */
function fanwiki_list(): array {
    static $list = null;
    if ($list !== null) return $list;
    $list = [];
    foreach ((array)require __DIR__ . '/fanwikis-open.php' as $k => $w) $list[$k] = ['key' => $k, 'listed' => 'open', 'kind' => 'mediawiki'] + $w;
    foreach ((array)(fanwiki_nonopen()['wikis'] ?? []) as $k => $w) $list[$k] = ['key' => $k, 'listed' => 'nonopen', 'kind' => 'mediawiki'] + $w;
    return $list;
}
function fanwiki_wiki(string $key): array {
    $w = fanwiki_list()[$key] ?? null;
    if (!$w) fail('That fan wiki isn\'t available', 400, 'unknown_wiki');
    return $w;
}
/** A wiki as the browser and the About page get it. */
function fanwiki_public(array $w): array {
    [$label, $url] = $w['license'] ?? [null, null];
    return ['key' => $w['key'], 'name' => $w['name'], 'settings' => $w['settings'], 'host' => $w['host'], 'site' => $w['site'],
        'license' => $label, 'license_url' => $url, 'open' => $w['listed'] === 'open', 'note' => $w['note'] ?? null];
}

// --- licences --------------------------------------------------------------------------------------------------
/** A licence from its wording and/or address: [label, deed URL, open, non-commercial], or null when it names none this
 * knows. Open: CC0, public domain, CC BY, CC BY-SA and the GNU FDL. */
function fanwiki_classify(string $text, ?string $url = null): ?array {
    $s = strtolower(trim("$text " . ($url ?? '')));
    if ($s === '') return null;
    $ver = preg_match('/\b(\d\.\d)\b/', $s, $m) ? $m[1] : '';
    if (preg_match('~cc0|publicdomain/zero|public[ _-]domain|\bpd\b~', $s)) return ['Public domain', $url ?: 'https://creativecommons.org/publicdomain/mark/1.0/', true, false];
    if (preg_match('~gfdl|gnu free documentation|licenses/(old-licenses/)?fdl~', $s)) return [trim("GNU FDL $ver"), $url ?: 'https://www.gnu.org/licenses/fdl.html', true, false];
    if (preg_match('~creativecommons\.org/licenses|creative[ _-]commons|\bcc[ _-]?by~', $s)) {
        $nc = (bool)preg_match('~by-nc|non-?commercial|[ _-]nc\b~', $s);
        $nd = (bool)preg_match('~-nd\b|no[ _-]?deriv~', $s);
        $sa = (bool)preg_match('~-sa\b|share[ _-]?alike~', $s);
        $code = 'by' . ($nc ? '-nc' : '') . ($nd ? '-nd' : '') . ($sa ? '-sa' : '');
        [$label, $deed] = image_license($code, $ver);
        if ($ver === '') $label = preg_replace('/ \d\.\d$/', '', $label);
        return [$label, $url && preg_match('~^https?://~', $url) ? $url : $deed, !$nc && !$nd, $nc];
    }
    return null;
}
/** The licence wiki $w states: what it says itself when it can be asked, else what its list says; never null. */
function fanwiki_license(array $w, ?array $site = null): array {
    [$label, $url] = $w['license'] ?? [null, null];
    $listed = fanwiki_classify((string)$label, $url);
    $own = $site['license'] ?? null;
    // Fandom says only "CC-BY-SA": the list's version is kept when the wiki's own answer is the same licence without one.
    if ($own && $listed && str_starts_with($listed[0], $own[0] . ' ')) return $listed;
    return $own ?? $listed ?? [$label ?: 'No licence stated', $url, false, false];
}
/** How text from a wiki under $lic may be credited: [credit, licence URL, fair use]; fails when it may not be used. */
function fanwiki_terms(array $lic, string $name): array {
    [$label, $url, $open, $nc] = $lic;
    if ($open) return [$label, $url, false];
    if (!fanwiki_fair_use()) fail("$name isn't openly licensed ($label), so its text can't be used on this server", 403, 'not_open');
    return $nc ? ["$label, non-commercial use", $url, false] : ['personal fair use (no open licence)', null, true];
}

// --- talking to the wikis --------------------------------------------------------------------------------------
function fanwiki_http(string $url, string $accept = 'application/json'): array {
    static $stub = null;
    $file = (string)(fanwiki_cfg()['stub'] ?? '');
    if ($file !== '') return ($stub ??= require $file)('GET', $url, []);
    $contact = trim((string)(image_cfg()['contact'] ?? ''));
    return http_request('GET', $url, ['headers' => ['User-Agent: CampaignChronicle/1.0 (fan wiki lookups' . ($contact !== '' ? "; $contact" : '') . ')',
        "Accept: $accept"], 'compress' => true, 'timeout' => 15]);
}
function fanwiki_json(string $url): array {
    $r = fanwiki_http($url);
    $data = json_decode($r['body'], true);
    $where = parse_url($url, PHP_URL_HOST) . parse_url($url, PHP_URL_PATH);
    if ($r['status'] !== 200 || !is_array($data)) {
        error_log("fan wikis: $where answered {$r['status']} {$r['error']}");
        throw new ImageSourceDown("$where answered " . ($r['error'] !== '' ? $r['error'] : ($r['status'] === 200 ? 'something that isn\'t JSON' : "HTTP {$r['status']}")));
    }
    // A page that isn't there is an answer, not an outage.
    if (in_array($data['error']['code'] ?? '', ['missingtitle', 'invalidtitle'], true)) return ['missing' => true];
    if (is_array($data['error'] ?? null)) throw new ImageSourceDown("$where said " . image_text($data['error']['info'] ?? $data['error']['code'] ?? 'error', 120));
    return $data;
}
/** A small cache of what each wiki said about itself, in the uploads folder (outside the web root); not with a stub. */
function fanwiki_cache(string $key, ?array $val = null): ?array {
    static $mem = null, $file = null;
    if ($mem === null) {
        $dir = (fanwiki_cfg()['stub'] ?? '') === '' ? upload_dir()['dir'] : null;
        $file = $dir ? "$dir/.fanwiki-cache.json" : null;
        $mem = $file && is_file($file) ? (json_decode((string)@file_get_contents($file), true) ?: []) : [];
    }
    if ($val === null) return ($mem[$key]['until'] ?? 0) > time() ? $mem[$key]['data'] : null;
    $mem[$key] = ['until' => time() + FANWIKI_RECHECK, 'data' => $val];
    if ($file && @file_put_contents($file, json_encode($mem), LOCK_EX) !== false) @chmod($file, 0600);
    return $val;
}
/** https://… from a MediaWiki "server" value, which may leave out the scheme. */
function fanwiki_abs(string $u): string { return str_starts_with($u, '//') ? "https:$u" : $u; }
/** Where a MediaWiki wiki's api.php is, its article path and its licence: ['api', 'article', 'license'], asked once a
 * day. The address in the list is tried first; when it doesn't answer, the site's own page names it (its EditURI link). */
function fanwiki_site(array $w): array {
    if ($w['kind'] !== 'mediawiki') return ['api' => $w['api'], 'article' => null, 'license' => null];
    if ($hit = fanwiki_cache("site:{$w['key']}")) return $hit;
    $ask = fn(string $api) => fanwiki_json($api . '?' . http_build_query(['action' => 'query', 'meta' => 'siteinfo', 'siprop' => 'general|rightsinfo',
        'format' => 'json', 'formatversion' => 2]));
    $api = $w['api'];
    try { $info = $ask($api); }
    catch (ImageSourceDown $first) {
        $page = fanwiki_http($w['site'], 'text/html');
        if ($page['status'] !== 200 || !preg_match('~<link[^>]+rel="EditURI"[^>]+href="([^"]+?)api\.php\?action=rsd"~i', $page['body'], $m)) throw $first;
        $api = fanwiki_abs(html_entity_decode($m[1])) . 'api.php';
        $info = $ask($api);
    }
    $g = (array)($info['query']['general'] ?? []);
    $r = (array)($info['query']['rightsinfo'] ?? []);
    $server = fanwiki_abs((string)($g['server'] ?? ''));
    $article = preg_match('~^https?://~', $server) && str_contains((string)($g['articlepath'] ?? ''), '$1') ? $server . $g['articlepath'] : null;
    return fanwiki_cache("site:{$w['key']}", ['api' => $api, 'article' => $article,
        'license' => fanwiki_classify((string)($r['text'] ?? ''), ($r['url'] ?? '') !== '' ? fanwiki_abs((string)$r['url']) : null)]);
}
function fanwiki_api(array $w, array $params): array {
    return fanwiki_json(fanwiki_site($w)['api'] . '?' . http_build_query($params + ['format' => 'json', 'formatversion' => 2]));
}
/** The address of page $title on wiki $w. */
function fanwiki_page_url(array $w, string $title): string {
    $path = str_replace(['%2F', '%3A', '%2C', '%28', '%29', '%27'], ['/', ':', ',', '(', ')', "'"], rawurlencode(str_replace(' ', '_', $title)));
    $article = fanwiki_site($w)['article'] ?? null;
    return $article ? str_replace('$1', $path, $article) : rtrim(preg_replace('~/(wiki/)?Main_Page$~', '/', $w['site']), '/') . "/wiki/$path";
}
/** Whether $url is a picture on wiki $w's own hosts (or, with the test stub, at img.test). */
function fanwiki_host_ok(array $w, ?string $url): bool {
    if (!$url || !str_starts_with($url, 'https://')) return false;
    $host = strtolower((string)parse_url($url, PHP_URL_HOST));
    if ((fanwiki_cfg()['stub'] ?? '') !== '' && $host === 'img.test') return true;
    foreach (array_merge($w['images'] ?? [], [parse_url($w['site'], PHP_URL_HOST)]) as $h) if ($host === $h || str_ends_with($host, ".$h")) return true;
    return false;
}

// --- text -------------------------------------------------------------------------------------------------------
/** Articles matching $q: [{page, title, line}], page being what fanwiki_summary takes. */
function fanwiki_search(array $w, string $q): array {
    if ($w['kind'] === 'wordpress') {
        $hits = fanwiki_json($w['api'] . '/search?' . http_build_query(['search' => $q, 'per_page' => FANWIKI_HITS, 'type' => 'post', '_fields' => 'id,title,subtype']));
        return array_values(array_filter(array_map(fn($h) => is_array($h) && in_array($h['subtype'] ?? '', ['post', 'page'], true) && (int)($h['id'] ?? 0) > 0
            ? ['page' => "{$h['subtype']}:" . (int)$h['id'], 'title' => image_text($h['title'] ?? '', 200), 'line' => ''] : null, $hits)));
    }
    $data = fanwiki_api($w, ['action' => 'query', 'list' => 'search', 'srsearch' => $q, 'srlimit' => FANWIKI_HITS, 'srnamespace' => 0, 'srprop' => 'snippet']);
    return array_values(array_map(fn($h) => ['page' => (string)$h['title'], 'title' => (string)$h['title'], 'line' => image_text($h['snippet'] ?? '', 200)],
        array_filter((array)($data['query']['search'] ?? []), fn($h) => is_array($h) && ($h['title'] ?? '') !== '')));
}
/** The opening paragraphs of an article's HTML, without its infobox, tables, pictures, footnote marks and notices. */
function fanwiki_lead(string $html, int $max = 1500): array {
    if (trim($html) === '') return [];
    $doc = new DOMDocument();
    libxml_use_internal_errors(true);
    $doc->loadHTML('<?xml encoding="utf-8"?><div>' . $html . '</div>', LIBXML_NONET | LIBXML_NOERROR);
    libxml_clear_errors();
    $x = new DOMXPath($doc);
    $drop = ['aside', 'table', 'figure', 'style', 'script', 'sup', 'dl', 'blockquote'];
    $cls = ['reference', 'mw-editsection', 'noprint', 'toc', 'navbox', 'portable-infobox', 'infobox', 'thumb', 'notice', 'hatnote', 'dablink', 'quote', 'mw-empty-elt'];
    $q = implode(' | ', array_merge(array_map(fn($t) => "//$t", $drop), array_map(fn($c) => "//*[contains(concat(' ', normalize-space(@class), ' '), ' $c ')]", $cls)));
    foreach (iterator_to_array($x->query($q)) as $n) $n->parentNode?->removeChild($n);
    $out = [];
    $len = 0;
    foreach ($x->query('//p') as $p) {
        $t = trim(preg_replace('/\s+/u', ' ', $p->textContent) ?? '');
        $t = trim(preg_replace('/\s+([,.;:])/u', '$1', $t) ?? '');
        if (mb_strlen($t) < 40) continue;
        if ($len + mb_strlen($t) > $max) {
            if ($out) break;
            $cut = mb_substr($t, 0, $max);
            $t = preg_match('/^(.*[.!?])\s/su', $cut, $m) ? $m[1] : rtrim($cut) . '…';
        }
        $out[] = $t;
        $len += mb_strlen($t);
        if (count($out) >= 3 || $len >= 600) break;
    }
    return $out;
}
/** Article $page's opening: ['title', 'url', 'paragraphs'], or null when it has none. */
function fanwiki_summary(array $w, string $page): ?array {
    if ($w['kind'] === 'wordpress') {
        if (!preg_match('/^(post|page):(\d+)$/', $page, $m)) return null;
        $p = fanwiki_json("{$w['api']}/{$m[1]}s/{$m[2]}?" . http_build_query(['_fields' => 'title,content,link']));
        $paras = fanwiki_lead((string)($p['content']['rendered'] ?? ''));
        $link = (string)($p['link'] ?? '');
        return $paras ? ['title' => image_text($p['title']['rendered'] ?? '', 200), 'url' => fanwiki_host_ok($w, $link) ? $link : $w['site'], 'paragraphs' => $paras] : null;
    }
    $data = fanwiki_api($w, ['action' => 'parse', 'page' => $page, 'prop' => 'text', 'section' => 0, 'redirects' => 1, 'disablelimitreport' => 1, 'disableeditsection' => 1]);
    $title = (string)($data['parse']['title'] ?? $page);
    $paras = fanwiki_lead((string)($data['parse']['text'] ?? ''));
    return $paras ? ['title' => $title, 'url' => fanwiki_page_url($w, $title), 'paragraphs' => $paras] : null;
}

// --- pictures ---------------------------------------------------------------------------------------------------
const FANWIKI_IMAGEINFO = ['prop' => 'imageinfo|categories', 'iiprop' => 'url|extmetadata|mime', 'iiurlwidth' => 400, 'cllimit' => 'max'];
/** A file page's licence: its own licence fields when the wiki has them, else its licensing categories. A file in a
 * fair-use or copyright category is never taken as open, whatever else it says. */
function fanwiki_file_license(array $page): ?array {
    $meta = (array)($page['imageinfo'][0]['extmetadata'] ?? []);
    $v = fn(string $k) => image_text($meta[$k]['value'] ?? '', 200);
    $cats = implode(' ', array_map(fn($c) => (string)($c['title'] ?? ''), array_filter((array)($page['categories'] ?? []), 'is_array')));
    if (preg_match('/fair[ _-]?use|non[ _-]?free|copyright(ed)?[ _]|all rights reserved|screenshots?\b/i', "$cats " . $v('UsageTerms'))) return null;
    return fanwiki_classify(trim($v('LicenseShortName') . ' ' . $v('UsageTerms')), ($meta['LicenseUrl']['value'] ?? '') !== '' ? (string)$meta['LicenseUrl']['value'] : null)
        ?? fanwiki_classify($cats);
}
/** One picture as Find Image lists it (image_item()), with fair_use: it isn't open but may be copied for the campaign's own use. */
function fanwiki_image_item(array $w, string $id, string $title, ?array $lic, ?string $author, ?string $landing, ?string $thumb, ?string $full): ?array {
    if (!fanwiki_host_ok($w, $full)) return null;
    $open = $lic && $lic[2];
    if (!$open && !fanwiki_fair_use()) return null;              // nothing it could do with it
    $label = $open ? $lic[0] : ($lic ? "{$lic[0]}, personal use" : FANWIKI_FAIR_USE);
    $item = image_item('fanwiki', "{$w['key']}|$id", ['title' => preg_replace('/\.(jpe?g|png|gif|webp)$/i', '', $title), 'author' => $author,
        'license' => [$label, $lic[1] ?? null, $open], 'via' => $w['name'], 'landing_url' => $landing,
        'thumb' => fanwiki_host_ok($w, $thumb) ? $thumb : $full, 'full' => $full]);
    return $item + ['fair_use' => !$open];
}
function fanwiki_mw_image(array $w, array $page): ?array {
    $ii = (array)($page['imageinfo'][0] ?? []);
    if (!in_array($ii['mime'] ?? '', FANWIKI_IMAGE_TYPES, true)) return null;
    $artist = image_text($ii['extmetadata']['Artist']['value'] ?? '', 200);
    $title = preg_replace('/^[^:]+:/', '', (string)($page['title'] ?? ''));
    return fanwiki_image_item($w, (string)$page['title'], $title, fanwiki_file_license($page), $artist ?: null,
        $ii['descriptionurl'] ?? fanwiki_page_url($w, (string)$page['title']), $ii['thumburl'] ?? null, $ii['url'] ?? null);
}
function fanwiki_wp_image(array $w, array $m): ?array {
    if (!in_array($m['mime_type'] ?? '', FANWIKI_IMAGE_TYPES, true) || (int)($m['id'] ?? 0) < 1) return null;
    $sizes = (array)($m['media_details']['sizes'] ?? []);
    $thumb = $sizes['medium']['source_url'] ?? $sizes['thumbnail']['source_url'] ?? null;
    return fanwiki_image_item($w, 'media:' . (int)$m['id'], image_text($m['title']['rendered'] ?? '', 200), fanwiki_license($w), null,
        $m['link'] ?? null, $thumb, $m['source_url'] ?? null);
}
/** Pictures for $q: those on the best-matching articles first, then files whose names match. */
function fanwiki_images(array $w, string $q): array {
    if ($w['kind'] === 'wordpress') {
        $list = fanwiki_json($w['api'] . '/media?' . http_build_query(['search' => $q, 'per_page' => FANWIKI_IMAGES, 'media_type' => 'image',
            '_fields' => 'id,title,source_url,media_details,link,mime_type']));
        return array_values(array_filter(array_map(fn($m) => is_array($m) ? fanwiki_wp_image($w, $m) : null, $list)));
    }
    $pages = [];
    $add = function (array $data) use (&$pages) {
        foreach ((array)($data['query']['pages'] ?? []) as $p) if (is_array($p) && !isset($pages[$p['title'] ?? ''])) $pages[(string)$p['title']] = $p;
    };
    $hits = fanwiki_api($w, ['action' => 'query', 'list' => 'search', 'srsearch' => $q, 'srlimit' => 2, 'srnamespace' => 0, 'srprop' => '']);
    $titles = array_column(array_filter((array)($hits['query']['search'] ?? []), 'is_array'), 'title');
    if ($titles) $add(fanwiki_api($w, ['action' => 'query', 'generator' => 'images', 'titles' => implode('|', $titles), 'gimlimit' => 30] + FANWIKI_IMAGEINFO));
    $add(fanwiki_api($w, ['action' => 'query', 'generator' => 'search', 'gsrsearch' => $q, 'gsrnamespace' => 6, 'gsrlimit' => FANWIKI_IMAGES] + FANWIKI_IMAGEINFO));
    return array_slice(array_values(array_filter(array_map(fn($p) => fanwiki_mw_image($w, $p), $pages))), 0, FANWIKI_IMAGES);
}
/** One picture, looked up again from its wiki by "key|File:…" (never taken from the browser), with its full address. */
function fanwiki_image_lookup(string $id): ?array {
    [$key, $file] = array_pad(explode('|', $id, 2), 2, '');
    $w = fanwiki_list()[$key] ?? null;
    if (!$w || $file === '') return null;
    if ($w['kind'] === 'wordpress') {
        if (!preg_match('/^media:(\d+)$/', $file, $m)) return null;
        return fanwiki_wp_image($w, fanwiki_json("{$w['api']}/media/{$m[1]}?" . http_build_query(['_fields' => 'id,title,source_url,media_details,link,mime_type'])));
    }
    $data = fanwiki_api($w, ['action' => 'query', 'titles' => $file] + FANWIKI_IMAGEINFO);
    $page = array_values(array_filter((array)($data['query']['pages'] ?? []), fn($p) => is_array($p) && empty($p['missing'])))[0] ?? null;
    return $page ? fanwiki_mw_image($w, $page) : null;
}
/** A result as the browser gets it: no full address, and the thumbnail through fanwiki_thumb. */
function fanwiki_image_public(array $i): array {
    [$key] = explode('|', $i['id'], 2);
    return ['thumb' => 'api/index.php?' . http_build_query(['a' => 'fanwiki_thumb', 'wiki' => $key, 'src' => $i['thumb']])] + image_public($i);
}

// --- actions ----------------------------------------------------------------------------------------------------
/** Answer one of FANWIKI_ACTIONS (and exit); false for any other action. */
function fanwiki_action(string $action): bool {
    if (!in_array($action, FANWIKI_ACTIONS, true)) return false;
    // The list is public, like the About page that shows it; it is empty while the module is switched off.
    if ($action === 'fanwiki_wikis')
        out(['enabled' => fanwiki_on(), 'open_only' => !fanwiki_fair_use(), 'wikis' => fanwiki_on() ? array_values(array_map('fanwiki_public', fanwiki_list())) : []]);
    if (!fanwiki_on()) fail('Fan wikis are switched off on this server', 404, 'fan_wikis_off');
    if ($action === 'fanwiki_thumb') fanwiki_thumb();
    $cid = cid();
    role($cid);
    $w = fanwiki_wiki((string)($_GET['wiki'] ?? ''));
    rate_limit('fanwiki', (string)me()['id'], 30, 60);
    $down = fn(ImageSourceDown $e) => fail("{$w['name']} couldn't be reached just now. Try again later." . (me()['is_admin'] ? ' (' . $e->getMessage() . ')' : ''), 502, 'source_unavailable');
    try {
        if ($action === 'fanwiki_summary') {
            $page = trim((string)str_in($_GET['page'] ?? '', 300));
            if ($page === '') fail('Pick an article');
            $site = fanwiki_site($w);
            [$credit, $licUrl, $fair] = fanwiki_terms(fanwiki_license($w, $site), $w['name']);
            $s = fanwiki_summary($w, $page);
            if (!$s) fail("{$w['name']} has no summary for \"$page\". Pick another.", 404, 'no_summary');
            out($s + ['wiki' => $w['name'], 'license' => $credit, 'license_url' => $licUrl, 'fair_use' => $fair, 'note' => $w['note'] ?? null]);
        }
        $q = trim((string)str_in($_GET['q'] ?? '', 200));
        if ($q === '') fail('Type something to search for');
        if ($action === 'fanwiki_search') {
            fanwiki_terms(fanwiki_license($w, fanwiki_site($w)), $w['name']);
            out(['hits' => fanwiki_search($w, $q)]);
        }
        out(['results' => array_map('fanwiki_image_public', fanwiki_images($w, $q))]);   // fanwiki_images
    } catch (ImageSourceDown $e) { $down($e); }
}
/** A search result's thumbnail, fetched from the wiki's own picture host and passed on, so the page needs no img-src
 * for every wiki and the reader's address never reaches them. */
function fanwiki_thumb(): void {
    me();
    $w = fanwiki_wiki((string)($_GET['wiki'] ?? ''));
    $src = (string)($_GET['src'] ?? '');
    if (strlen($src) > 1000 || !fanwiki_host_ok($w, $src)) fail('Not a picture from that wiki', 400);
    rate_limit('fanwiki_thumb', (string)me()['id'], 240, 60);
    try { $tmp = image_download($src, 2 << 20); }
    catch (ImageSourceDown | LengthException) { fail('That picture couldn\'t be fetched', 502, 'source_unavailable'); }
    $mime = @getimagesize($tmp)['mime'] ?? '';
    if (!in_array($mime, FANWIKI_IMAGE_TYPES, true)) { @unlink($tmp); fail('That isn\'t a picture', 415, 'unsupported_type'); }
    header("Content-Type: $mime");
    header('Content-Length: ' . filesize($tmp));
    header('Cache-Control: private, max-age=86400');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'");
    readfile($tmp);
    @unlink($tmp);
    exit;
}
