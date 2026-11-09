<?php
/**
 * images.php — Find Image: the server side of searching for a picture for an Encyclopedia entry.
 *
 * Six sources, each searched only when picked (All, the panel's first choice, asks each in turn from the browser):
 * Openverse (openly licensed pictures from Flickr, Wikimedia Commons, museums and more), Wikimedia Commons directly,
 * Pixabay and Pexels (free under their own licences; keys needed), museums' open access collections (the Art Institute
 * of Chicago, The Met, the Cleveland Museum of Art and, with keys, the Smithsonian and Europeana; public domain and open
 * works only) and DeviantArt (by tag). The server asks them, so the keys in the config's image_search block never
 * reach the browser, and every result comes back in one shape (image_item()). Only pictures under an open licence
 * (image_license()) or Pixabay's and Pexels' free licences can be copied into the app; a DeviantArt work that isn't
 * can be embedded instead, which keeps only its link and loads the picture from DeviantArt through its oEmbed API each
 * time.
 *
 * Every outbound call goes through image_http(). When the config names an image_search.stub file (the tests do), that
 * file's function answers instead and nothing leaves the machine.
 */

const IMAGE_SOURCES = ['openverse', 'commons', 'pixabay', 'museums', 'pexels', 'deviantart'];
const IMAGE_SOURCE_NAMES = ['openverse' => 'Openverse', 'commons' => 'Wikimedia Commons', 'pixabay' => 'Pixabay', 'museums' => 'The museums',
    'pexels' => 'Pexels', 'deviantart' => 'DeviantArt'];
const IMAGE_RESULTS = 20;
/** How long an embed's picture address from oEmbed is trusted before it is asked for again, in seconds. */
const EMBED_RECHECK = 6 * 3600;
/** The licences a found picture may be copied under: CC0, the Public Domain Mark, CC BY and CC BY-SA. */
const IMAGE_OPEN_LICENSES = ['cc0', 'pdm', 'by', 'by-sa'];

/** Raised when a source can't be reached or answers something that isn't what its API documents. */
final class ImageSourceDown extends RuntimeException {}

function image_cfg(): array { return (array)cfg('image_search', []); }

/** A GET or POST to a source: ['status', 'body', 'error'], from image_search.stub when the config names one. */
function image_http(string $method, string $url, array $opts = []): array {
    static $stub = null;
    $file = (string)(image_cfg()['stub'] ?? '');
    if ($file !== '') return ($stub ??= require $file)($method, $url, $opts);
    $contact = trim((string)(image_cfg()['contact'] ?? ''));
    $ua = 'CampaignChronicle/1.0' . ($contact !== '' ? " ($contact)" : '');
    $opts['headers'] = array_merge(["User-Agent: $ua", 'Accept: application/json'], $opts['headers'] ?? []);
    $opts['compress'] = true;                             // DeviantArt refuses clients that don't take gzip
    return http_request($method, $url, $opts);
}
/** A source's JSON answer, or null for a 404; throws ImageSourceDown for anything else that isn't a 200 with JSON. */
function image_json(string $url, array $opts = [], string $method = 'GET'): ?array {
    $r = image_http($method, $url, $opts);
    if ($r['status'] === 404) return null;
    $data = json_decode($r['body'], true);
    if ($r['status'] !== 200 || !is_array($data)) {
        if ($r['error'] !== '' || $r['status'] !== 200) error_log("image search: $url answered {$r['status']} {$r['error']}");
        // What went wrong, without the query (which can carry a key), for the message admins see.
        throw new ImageSourceDown(parse_url($url, PHP_URL_HOST) . parse_url($url, PHP_URL_PATH) . ' answered '
            . ($r['error'] !== '' ? $r['error'] : ($r['status'] === 200 ? 'something that isn\'t JSON' : "HTTP {$r['status']}")));
    }
    return $data;
}
/** $u when it is an http(s) address (or, from the test stub, a data: picture), else null. */
function image_url($u): ?string {
    $u = is_string($u) ? trim($u) : '';
    if ($u === '' || strlen($u) > 1000) return null;
    if (preg_match('~^https?://[^\s/]+~i', $u)) return $u;
    return (image_cfg()['stub'] ?? '') !== '' && str_starts_with($u, 'data:image/') ? $u : null;
}
function image_text($s, int $max): string {
    $s = trim(preg_replace('/\s+/u', ' ', strip_tags(html_entity_decode((string)$s, ENT_QUOTES | ENT_HTML5, 'UTF-8'))) ?? '');
    return mb_strlen($s) > $max ? rtrim(mb_substr($s, 0, $max - 1)) . '…' : $s;
}

/** A licence, from an Openverse-style code ('by-sa', 'cc0', 'pdm', 'by-nc'…) and version: [label, deed URL, open]. */
function image_license(string $code, string $version = ''): array {
    $code = strtolower(trim($code));
    $version = preg_match('/^\d(\.\d)?$/', trim($version)) ? trim($version) : '';
    $open = in_array($code, IMAGE_OPEN_LICENSES, true);
    if ($code === 'cc0') return ['CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/', true];
    if ($code === 'pdm') return ['Public Domain Mark 1.0', 'https://creativecommons.org/publicdomain/mark/1.0/', true];
    if (preg_match('/^by(-(nc|nd|sa))*$/', $code)) {
        $v = $version ?: '4.0';
        return ['CC ' . strtoupper($code) . " $v", "https://creativecommons.org/licenses/$code/$v/", $open];
    }
    return [$code === '' ? 'Unknown licence' : strtoupper($code), null, false];
}
/** DeviantArt's licence wording ("Creative Commons Attribution-Share Alike 3.0 License", "No License"…) as a code and version. */
function deviantart_license(string $s): array {
    if (preg_match('/\bCC0\b|public domain/i', $s)) return ['cc0', ''];
    if (!preg_match('/creative commons/i', $s)) return ['', ''];
    $code = 'by' . (preg_match('/non-?commercial/i', $s) ? '-nc' : '') . (preg_match('/no deriv/i', $s) ? '-nd' : '') . (preg_match('/share[- ]?alike/i', $s) ? '-sa' : '');
    return [$code, preg_match('/\b(\d\.\d)\b/', $s, $m) ? $m[1] : ''];
}

/** One result, as the browser gets it. $full (the picture to copy) stays on the server. */
function image_item(string $source, string $id, array $f): array {
    [$label, $url, $open] = $f['license'];
    return ['source' => $source, 'id' => $id, 'title' => image_text($f['title'] ?? '', 200) ?: 'Untitled',
        'author' => image_text($f['author'] ?? '', 200) ?: null, 'author_url' => image_url($f['author_url'] ?? null),
        'license' => $label, 'license_url' => $url, 'open' => $open, 'via' => image_text($f['via'] ?? '', 60),
        'landing_url' => image_url($f['landing_url'] ?? null), 'thumb' => image_url($f['thumb'] ?? null),
        'full' => image_url($f['full'] ?? null), 'mature' => !empty($f['mature'])];
}
function image_public(array $item): array { unset($item['full'], $item['mature']); return $item; }

// --- tokens and the cache -------------------------------------------------------------------------------------
/** A folder of the app's own outside the web root for Find Image's small files: the uploads folder, or the session
 * folder when uploads aren't set up, or PHP's temp folder as the last resort; [folder, suffix for its file names]. */
function image_private_dir(): array {
    $dir = upload_dir()['dir'];
    if ($dir) return [$dir, ''];
    $sess = (string)session_save_path();
    $dir = $sess !== '' && is_dir($sess) && is_writable($sess) ? rtrim($sess, '/') : rtrim(sys_get_temp_dir(), '/');
    return [$dir, '-' . substr(hash('sha256', (string)cfg('base_url', '') . __DIR__), 0, 16)];
}
/** A client-credentials access token for $name ('openverse' or 'deviantart'), kept until it expires, so a search never
 * asks for a fresh token each time; null when the config has no keys for it. */
function image_token(string $name, string $tokenUrl): ?string {
    $keys = (array)(image_cfg()[$name] ?? []);
    $id = trim((string)($keys['client_id'] ?? '')); $secret = trim((string)($keys['client_secret'] ?? ''));
    if ($id === '' || $secret === '') return null;
    [$dir, $suffix] = image_private_dir();
    $file = $suffix === '' ? "$dir/.image-search-tokens.json" : "$dir/.chronicle-image-tokens$suffix.json";
    $cache = is_file($file) ? (json_decode((string)@file_get_contents($file), true) ?: []) : [];
    $key = $name . ':' . hash('sha256', $id);
    if (($cache[$key]['until'] ?? 0) > time() + 60) return $cache[$key]['token'];
    $data = image_json($tokenUrl, ['post_fields' => http_build_query(['grant_type' => 'client_credentials', 'client_id' => $id, 'client_secret' => $secret]),
        'headers' => ['Content-Type: application/x-www-form-urlencoded']], 'POST');
    $token = (string)($data['access_token'] ?? '');
    if ($token === '') throw new ImageSourceDown('no token');
    $cache[$key] = ['token' => $token, 'until' => time() + max(60, (int)($data['expires_in'] ?? 3600))];
    if (@file_put_contents($file, json_encode($cache), LOCK_EX) !== false) @chmod($file, 0600);
    return $token;
}
/** A source's answer kept for $ttl seconds under $key (Pixabay asks that its searches be kept for a day, so the same
 * search isn't asked again): $fetch() when nothing fresh is kept. Old answers are swept out now and then. */
function image_cached(string $key, int $ttl, callable $fetch) {
    [$dir, $suffix] = image_private_dir();
    $folder = "$dir/.image-cache$suffix";
    $file = "$folder/" . hash('sha256', $key) . '.json';
    if (is_file($file) && filemtime($file) > time() - $ttl && is_array($kept = json_decode((string)@file_get_contents($file), true))) return $kept['v'] ?? null;
    $v = $fetch();
    if ((is_dir($folder) || @mkdir($folder, 0700)) && @file_put_contents($file, json_encode(['v' => $v]), LOCK_EX) !== false) {
        @chmod($file, 0600);
        if (random_int(1, 50) === 1) foreach (glob("$folder/*.json") ?: [] as $f) if (filemtime($f) < time() - 86400) @unlink($f);
    }
    return $v;
}
/** Several GETs at once (each [url, opts]), so one slow source doesn't hold up the rest: each answer as image_json()
 * gives it (the decoded JSON, or null for a 404), or the ImageSourceDown it would have thrown. */
function image_json_all(array $reqs): array {
    $out = [];
    if ((string)(image_cfg()['stub'] ?? '') !== '' || count($reqs) < 2 || !function_exists('curl_multi_init')) {
        foreach ($reqs as $k => [$url, $opts]) { try { $out[$k] = image_json($url, $opts); } catch (ImageSourceDown $e) { $out[$k] = $e; } }
        return $out;
    }
    $contact = trim((string)(image_cfg()['contact'] ?? ''));
    $ua = 'CampaignChronicle/1.0' . ($contact !== '' ? " ($contact)" : '');
    $mh = curl_multi_init();
    $hs = $bodies = [];
    foreach ($reqs as $k => [$url, $opts]) {
        $bodies[$k] = '';
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 10,
            CURLOPT_ENCODING => '', CURLOPT_HTTPHEADER => array_merge(["User-Agent: $ua", 'Accept: application/json'], $opts['headers'] ?? []),
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$bodies, $k): int {
                if (strlen($bodies[$k]) + strlen($chunk) > HTTP_MAX_BYTES) return -1;
                $bodies[$k] .= $chunk;
                return strlen($chunk);
            }]);
        curl_multi_add_handle($mh, $ch);
        $hs[$k] = $ch;
    }
    do { $st = curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh, 1.0); } while ($running && $st === CURLM_OK);
    foreach ($hs as $k => $ch) {
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_multi_remove_handle($mh, $ch);
        $url = $reqs[$k][0];
        $data = json_decode($bodies[$k], true);
        if ($status === 404) $out[$k] = null;
        elseif ($status === 200 && is_array($data)) $out[$k] = $data;
        else {
            error_log("image search: $url answered $status $err");
            $out[$k] = new ImageSourceDown(parse_url($url, PHP_URL_HOST) . parse_url($url, PHP_URL_PATH) . ' answered ' . ($err !== '' ? $err : "HTTP $status"));
        }
    }
    unset($hs, $mh);
    return $out;
}

// --- Openverse -------------------------------------------------------------------------------------------------
const OPENVERSE = 'https://api.openverse.org';
const OPENVERSE_PROVIDERS = ['flickr' => 'Flickr', 'wikimedia' => 'Wikimedia Commons', 'smithsonian' => 'Smithsonian', 'met' => 'The Met',
    'clevelandmuseum' => 'Cleveland Museum of Art', 'rijksmuseum' => 'Rijksmuseum', 'nasa' => 'NASA', 'europeana' => 'Europeana'];
function openverse_headers(): array {
    $t = image_token('openverse', OPENVERSE . '/v1/auth_tokens/token/');
    return $t ? ["Authorization: Bearer $t"] : [];
}
function openverse_item(array $r): array {
    $id = (string)($r['id'] ?? '');
    $p = strtolower((string)($r['provider'] ?? $r['source'] ?? ''));
    return image_item('openverse', $id, ['title' => $r['title'] ?? '', 'author' => $r['creator'] ?? '', 'author_url' => $r['creator_url'] ?? null,
        'license' => image_license((string)($r['license'] ?? ''), (string)($r['license_version'] ?? '')),
        'via' => (OPENVERSE_PROVIDERS[$p] ?? ucwords(str_replace('_', ' ', $p))) ?: 'Openverse',
        'landing_url' => $r['foreign_landing_url'] ?? null, 'thumb' => $r['thumbnail'] ?? (preg_match('/^[0-9a-f-]{36}$/i', $id) ? OPENVERSE . "/v1/images/$id/thumb/" : null),
        'full' => $r['url'] ?? null, 'mature' => !empty($r['mature'])]);
}
function openverse_search(string $q): array {
    $data = image_json(OPENVERSE . '/v1/images/?' . http_build_query(['q' => $q, 'license_type' => 'commercial,modification', 'mature' => 'false', 'page_size' => IMAGE_RESULTS]),
        ['headers' => openverse_headers()]);
    if (!isset($data['results']) || !is_array($data['results'])) throw new ImageSourceDown('no results list');
    return array_map('openverse_item', array_filter($data['results'], 'is_array'));
}
function openverse_lookup(string $id): ?array {
    if (!preg_match('/^[0-9a-f-]{36}$/i', $id)) return null;
    $r = image_json(OPENVERSE . "/v1/images/$id/", ['headers' => openverse_headers()]);
    return $r ? openverse_item($r) : null;
}

// --- museums ---------------------------------------------------------------------------------------------------
const ARTIC = 'https://api.artic.edu';
const ARTIC_FIELDS = 'id,title,artist_title,artist_id,image_id,is_public_domain';
const MET = 'https://collectionapi.metmuseum.org';
function artic_headers(): array {
    $contact = trim((string)(image_cfg()['contact'] ?? ''));
    return ['AIC-User-Agent: CampaignChronicle' . ($contact !== '' ? " ($contact)" : '')];
}
function artic_item(array $r, string $iiif): ?array {
    if (empty($r['is_public_domain']) || !preg_match('/^[0-9a-f-]{36}$/i', (string)($r['image_id'] ?? ''))) return null;
    $id = (int)($r['id'] ?? 0);
    $img = rtrim($iiif ?: 'https://www.artic.edu/iiif/2', '/') . '/' . $r['image_id'];
    return image_item('museums', "aic:$id", ['title' => $r['title'] ?? '', 'author' => $r['artist_title'] ?? '',
        'author_url' => !empty($r['artist_id']) ? 'https://www.artic.edu/artists/' . (int)$r['artist_id'] : null,
        'license' => image_license('cc0'), 'via' => 'Art Institute of Chicago', 'landing_url' => "https://www.artic.edu/artworks/$id",
        'thumb' => "$img/full/400,/0/default.jpg", 'full' => "$img/full/843,/0/default.jpg"]);
}
function met_item(array $r): ?array {
    if (empty($r['isPublicDomain']) || !image_url($r['primaryImageSmall'] ?? null)) return null;
    return image_item('museums', 'met:' . (int)($r['objectID'] ?? 0), ['title' => $r['title'] ?? '', 'author' => $r['artistDisplayName'] ?? '',
        'author_url' => $r['artistWikidata_URL'] ?? ($r['artistULAN_URL'] ?? null), 'license' => image_license('cc0'), 'via' => 'The Met',
        'landing_url' => $r['objectURL'] ?? null, 'thumb' => $r['primaryImageSmall'], 'full' => image_url($r['primaryImage'] ?? null) ?? $r['primaryImageSmall']]);
}
const SMITHSONIAN = 'https://api.si.edu/openaccess/api/v1.0';
function smithsonian_key(): string { return trim((string)(image_cfg()['smithsonian']['api_key'] ?? '')); }
/** A Smithsonian record (EDAN metadata) as a result: its first picture released CC0, or null when it has none. */
function smithsonian_item(array $r): ?array {
    $c = (array)($r['content'] ?? []);
    $d = (array)($c['descriptiveNonRepeating'] ?? []);
    $pic = null;
    foreach ((array)($d['online_media']['media'] ?? []) as $m)
        if (is_array($m) && strtoupper((string)($m['usage']['access'] ?? '')) === 'CC0' && preg_match('/^[A-Za-z0-9_.-]{1,120}$/', (string)($m['idsId'] ?? ''))) { $pic = $m; break; }
    $id = (string)($r['id'] ?? '');
    if (!$pic || !preg_match('/^[A-Za-z0-9_.:-]{1,120}$/', $id)) return null;
    $ids = 'https://ids.si.edu/ids/deliveryService?id=' . rawurlencode($pic['idsId']);
    $name = '';
    foreach ((array)($c['freetext']['name'] ?? []) as $n) if (is_array($n) && trim((string)($n['content'] ?? '')) !== '') { $name = $n['content']; break; }
    return image_item('museums', "si:$id", ['title' => $r['title'] ?? ($d['title']['content'] ?? ''), 'author' => $name, 'license' => image_license('cc0'),
        'via' => 'Smithsonian', 'landing_url' => $d['record_link'] ?? null, 'thumb' => "$ids&max=400", 'full' => "$ids&max=1600"]);
}
const CLEVELAND = 'https://openaccess-api.clevelandart.org/api/artworks';
/** A Cleveland Museum of Art artwork, when its picture is released CC0. */
function cleveland_item(array $r): ?array {
    if (strtoupper((string)($r['share_license_status'] ?? '')) !== 'CC0' || !image_url($r['images']['web']['url'] ?? null)) return null;
    $who = '';
    foreach ((array)($r['creators'] ?? []) as $c) if (is_array($c) && trim((string)($c['description'] ?? '')) !== '') { $who = preg_replace('/\s*\(.*$/s', '', $c['description']); break; }
    return image_item('museums', 'cma:' . (int)($r['id'] ?? 0), ['title' => $r['title'] ?? '', 'author' => $who, 'license' => image_license('cc0'),
        'via' => 'Cleveland Museum of Art', 'landing_url' => $r['url'] ?? null, 'thumb' => $r['images']['web']['url'],
        'full' => image_url($r['images']['print']['url'] ?? null) ?? $r['images']['web']['url']]);
}
// Europeana gathers thousands of European museums, libraries and archives (the Rijksmuseum and SMK among them), with a
// free key. Only openly reusable pictures are asked for (reusability=open), and each one's rights are checked again.
const EUROPEANA = 'https://api.europeana.eu/record/v2/search.json';
function europeana_key(): string { return trim((string)(image_cfg()['europeana']['api_key'] ?? '')); }
/** A rights statement's address (creativecommons.org/licenses/by-sa/4.0/, …/publicdomain/mark/1.0/) as a licence. */
function europeana_license(string $u): array {
    if (preg_match('~creativecommons\.org/publicdomain/zero/~', $u)) return image_license('cc0');
    if (preg_match('~creativecommons\.org/publicdomain/mark/~', $u)) return image_license('pdm');
    if (preg_match('~creativecommons\.org/licenses/([a-z-]+)/(\d\.\d)~', $u, $m)) return image_license($m[1], $m[2]);
    return ['Rights reserved', image_url($u), false];
}
function europeana_item(array $r): ?array {
    $first = fn($v) => is_array($v) ? (string)(reset($v) ?: '') : (string)$v;
    $id = $first($r['id'] ?? '');
    if (!preg_match('~^/[A-Za-z0-9_]+/[A-Za-z0-9_.-]+$~', $id) || !image_url($first($r['edmPreview'] ?? ''))) return null;
    return image_item('museums', "eu:$id", ['title' => $first($r['title'] ?? ''), 'author' => $first($r['dcCreator'] ?? ''),
        'license' => europeana_license($first($r['rights'] ?? '')), 'via' => ($first($r['dataProvider'] ?? '') ?: 'Europeana') . ' (Europeana)',
        'landing_url' => $r['guid'] ?? "https://www.europeana.eu/item$id", 'thumb' => $first($r['edmPreview']), 'full' => $first($r['edmIsShownBy'] ?? '') ?: null]);
}
function europeana_url(string $query): string {
    return EUROPEANA . '?' . http_build_query(['wskey' => europeana_key(), 'query' => $query, 'reusability' => 'open', 'media' => 'true', 'qf' => 'TYPE:IMAGE', 'rows' => IMAGE_RESULTS]);
}
/** The museums, searched together and taken in turn so none crowds the others out: the Art Institute of Chicago, The
 * Met and the Cleveland Museum of Art, and the Smithsonian and Europeana when the config has their keys. One that is
 * down is skipped while another answers. */
function museums_search(string $q): array {
    $reqs = [
        'aic' => [ARTIC . '/api/v1/artworks/search?' . http_build_query(['q' => $q, 'limit' => IMAGE_RESULTS, 'fields' => ARTIC_FIELDS,
            'query' => ['term' => ['is_public_domain' => 'true']]]), ['headers' => artic_headers()]],
        'met' => [MET . '/public/collection/v1/search?' . http_build_query(['hasImages' => 'true', 'q' => $q]), []],
        // cc0 is a flag that takes no value
        'cma' => [CLEVELAND . '/?' . http_build_query(['q' => $q, 'has_image' => 1, 'limit' => IMAGE_RESULTS]) . '&cc0', []],
    ];
    if (($key = smithsonian_key()) !== '')
        $reqs['si'] = [SMITHSONIAN . '/search?' . http_build_query(['q' => "$q AND online_media_type:\"Images\"", 'rows' => IMAGE_RESULTS, 'api_key' => $key]), []];
    if (europeana_key() !== '') $reqs['eu'] = [europeana_url($q), []];
    $got = image_json_all($reqs);
    $ok = fn($d) => is_array($d) ? $d : [];
    if (count(array_filter($got, fn($d) => $d instanceof ImageSourceDown)) === count($got)) throw new ImageSourceDown('every museum down');
    $lists = [];
    $d = $ok($got['aic']);
    $lists[] = array_values(array_filter(array_map(fn($r) => is_array($r) ? artic_item($r, (string)($d['config']['iiif_url'] ?? '')) : null, (array)($d['data'] ?? []))));
    // The Met's search gives only ids: the first ten are looked up together.
    $ids = array_slice(array_filter(array_map('intval', (array)($ok($got['met'])['objectIDs'] ?? []))), 0, 10);
    $objs = $ids ? image_json_all(array_map(fn($id) => [MET . "/public/collection/v1/objects/$id", []], $ids)) : [];
    $lists[] = array_values(array_filter(array_map(fn($r) => is_array($r) ? met_item($r) : null, $objs)));
    $lists[] = array_values(array_filter(array_map(fn($r) => is_array($r) ? cleveland_item($r) : null, (array)($ok($got['cma'])['data'] ?? []))));
    if (isset($got['si'])) $lists[] = array_values(array_filter(array_map(fn($r) => is_array($r) ? smithsonian_item($r) : null, (array)($ok($got['si'])['response']['rows'] ?? []))));
    if (isset($got['eu'])) $lists[] = array_values(array_filter(array_map(fn($r) => is_array($r) ? europeana_item($r) : null, (array)($ok($got['eu'])['items'] ?? []))));
    $out = [];
    for ($i = 0; count($out) < IMAGE_RESULTS * 2 && array_filter($lists, fn($l) => isset($l[$i])); $i++)
        foreach ($lists as $l) if (isset($l[$i]) && count($out) < IMAGE_RESULTS * 2) $out[] = $l[$i];
    return $out;
}
function museums_lookup(string $id): ?array {
    if (preg_match('/^aic:(\d+)$/', $id, $m)) {
        $data = image_json(ARTIC . "/api/v1/artworks/{$m[1]}?" . http_build_query(['fields' => ARTIC_FIELDS]), ['headers' => artic_headers()]);
        return $data && is_array($data['data'] ?? null) ? artic_item($data['data'], (string)($data['config']['iiif_url'] ?? '')) : null;
    }
    if (preg_match('/^met:(\d+)$/', $id, $m)) {
        $r = image_json(MET . "/public/collection/v1/objects/{$m[1]}");
        return $r ? met_item($r) : null;
    }
    if (preg_match('/^si:([A-Za-z0-9_.:-]{1,120})$/', $id, $m) && ($key = smithsonian_key()) !== '') {
        $data = image_json(SMITHSONIAN . '/content/' . rawurlencode($m[1]) . '?' . http_build_query(['api_key' => $key]));
        return $data && is_array($data['response'] ?? null) ? smithsonian_item($data['response']) : null;
    }
    if (preg_match('/^cma:(\d+)$/', $id, $m)) {
        $data = image_json(CLEVELAND . "/{$m[1]}");
        return $data && is_array($data['data'] ?? null) ? cleveland_item($data['data']) : null;
    }
    if (preg_match('~^eu:(/[A-Za-z0-9_]+/[A-Za-z0-9_.-]+)$~', $id, $m) && europeana_key() !== '') {
        $data = image_json(europeana_url('europeana_id:"' . $m[1] . '"'));
        foreach ((array)($data['items'] ?? []) as $r) if (is_array($r) && ($i = europeana_item($r)) && $i['id'] === $id) return $i;
        return null;
    }
    return null;
}

// --- Wikimedia Commons -----------------------------------------------------------------------------------------
// Searched directly as well as through Openverse, whose copy of Commons lags behind: this finds newer uploads, and
// Commons' own search takes incategory:"…" for its categories. No key; the User-Agent carries the config's contact.
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
/** Commons' licence (extmetadata's License, e.g. "cc-by-sa-4.0", "cc0", "pd") as a code and version. */
function commons_license(string $l): array {
    $l = strtolower(trim($l));
    if ($l === 'cc0' || str_starts_with($l, 'cc-zero')) return ['cc0', ''];
    if ($l === 'pd' || str_starts_with($l, 'pd-') || $l === 'public domain') return ['pdm', ''];
    if (preg_match('/^cc-(by(?:-(?:nc|nd|sa))*)(?:-(\d\.\d))?/', $l, $m)) return [$m[1], $m[2] ?? ''];
    return [$l, ''];
}
function commons_item(array $p): ?array {
    $ii = (array)($p['imageinfo'][0] ?? []);
    $meta = (array)($ii['extmetadata'] ?? []);
    $v = fn(string $k) => (string)($meta[$k]['value'] ?? '');
    $id = (int)($p['pageid'] ?? 0);
    if (!$id || !image_url($ii['thumburl'] ?? null)) return null;
    [$code, $ver] = commons_license($v('License'));
    $lic = image_license($code, $ver);
    if ($lic[0] === 'Public Domain Mark 1.0' && $code === 'pdm') $lic[0] = 'Public domain';
    if (!$lic[2] && $v('LicenseShortName') !== '') $lic[0] = image_text($v('LicenseShortName'), 60);
    // Artist is HTML, often a link to the artist's user page; its first link is kept as theirs.
    $artist = $v('Artist');
    $artistUrl = preg_match('~href="((?:https?:)?//[^"]+)"~', $artist, $m) ? (str_starts_with($m[1], '//') ? "https:{$m[1]}" : $m[1]) : null;
    $title = $v('ObjectName') ?: preg_replace(['/^File:/', '/\.[a-z0-9]{2,4}$/i'], '', (string)($p['title'] ?? ''));
    return image_item('commons', (string)$id, ['title' => $title, 'author' => $artist, 'author_url' => $artistUrl, 'license' => $lic,
        'via' => 'Wikimedia Commons', 'landing_url' => $ii['descriptionurl'] ?? null, 'thumb' => $ii['thumburl'], 'full' => $ii['responsiveUrls']['2'] ?? ($ii['url'] ?? null)]);
}
function commons_query(array $q): array {
    $data = image_json(COMMONS . '?' . http_build_query($q + ['action' => 'query', 'format' => 'json', 'formatversion' => 2,
        'prop' => 'imageinfo', 'iiprop' => 'url|extmetadata', 'iiurlwidth' => 400, 'iiextmetadatafilter' => 'License|LicenseShortName|Artist|ObjectName']));
    if (!is_array($data) || isset($data['error'])) throw new ImageSourceDown('Commons answered an error');
    $pages = (array)($data['query']['pages'] ?? []);
    usort($pages, fn($a, $b) => ($a['index'] ?? 0) <=> ($b['index'] ?? 0));   // the search's own order
    return array_values(array_filter(array_map(fn($p) => is_array($p) ? commons_item($p) : null, $pages)));
}
function commons_search(string $q): array {
    return commons_query(['generator' => 'search', 'gsrsearch' => "$q filetype:bitmap", 'gsrnamespace' => 6, 'gsrlimit' => IMAGE_RESULTS]);
}
function commons_lookup(string $id): ?array {
    if (!preg_match('/^\d{1,12}$/', $id)) return null;
    $item = commons_query(['pageids' => $id])[0] ?? null;
    if (!$item) return null;
    // The picture to copy: Commons' own 1,600 pixel copy rather than the original, which can be huge.
    $big = image_json(COMMONS . '?' . http_build_query(['action' => 'query', 'format' => 'json', 'formatversion' => 2, 'pageids' => $id,
        'prop' => 'imageinfo', 'iiprop' => 'url', 'iiurlwidth' => 1600]));
    $item['full'] = image_url($big['query']['pages'][0]['imageinfo'][0]['thumburl'] ?? null) ?? $item['full'];
    return $item;
}

// --- Pixabay ---------------------------------------------------------------------------------------------------
// Free under the Pixabay Content License (not an open licence, but use, change and commercial use are allowed, no
// credit needed). Its API asks for a key, a day's caching of each search, the pictures downloaded rather than
// hotlinked once used, and the results to say they came from Pixabay.
const PIXABAY = 'https://pixabay.com/api/';
const PIXABAY_LICENSE = ['Pixabay Content License', 'https://pixabay.com/service/license-summary/', true];
function pixabay_key(): string { return trim((string)(image_cfg()['pixabay']['api_key'] ?? '')); }
function pixabay_item(array $h): ?array {
    $id = (int)($h['id'] ?? 0);
    if (!$id) return null;
    $user = (string)($h['user'] ?? '');
    $web = (string)($h['webformatURL'] ?? '');
    return image_item('pixabay', (string)$id, ['title' => ucfirst(str_replace(',', ', ', preg_replace('/\s*,\s*/', ',', (string)($h['tags'] ?? '')))),
        'author' => $user, 'author_url' => $user !== '' && !empty($h['user_id']) ? 'https://pixabay.com/users/' . rawurlencode($user) . '-' . (int)$h['user_id'] . '/' : null,
        'license' => PIXABAY_LICENSE, 'via' => 'Pixabay', 'landing_url' => $h['pageURL'] ?? null,
        'thumb' => $web !== '' ? preg_replace('/_640(\.\w+)$/', '_340$1', $web) : ($h['previewURL'] ?? null), 'full' => $h['largeImageURL'] ?? ($web ?: null)]);
}
/** Pixabay's answer to one query, kept for a day as its API asks. */
function pixabay_get(array $q): array {
    $key = pixabay_key();
    return image_cached('pixabay:' . http_build_query($q), 86400, function () use ($q, $key) {
        $data = image_json(PIXABAY . '?' . http_build_query(['key' => $key] + $q));
        if (!isset($data['hits']) || !is_array($data['hits'])) throw new ImageSourceDown('no results list');
        return $data['hits'];
    });
}
function pixabay_search(string $q): array {
    return array_values(array_filter(array_map(fn($h) => is_array($h) ? pixabay_item($h) : null,
        pixabay_get(['q' => mb_substr($q, 0, 100), 'image_type' => 'all', 'safesearch' => 'true', 'per_page' => IMAGE_RESULTS]))));
}
function pixabay_lookup(string $id): ?array {
    if (!preg_match('/^\d{1,12}$/', $id)) return null;
    $h = pixabay_get(['id' => $id])[0] ?? null;
    return is_array($h) ? pixabay_item($h) : null;
}

// --- Pexels ----------------------------------------------------------------------------------------------------
// Photographs, mostly of today's world, under the Pexels License (free to use and change, credit not needed; not an
// open licence). A key goes in the Authorization header, and results link to Pexels and credit the photographer.
const PEXELS = 'https://api.pexels.com/v1';
const PEXELS_LICENSE = ['Pexels License', 'https://www.pexels.com/license/', true];
function pexels_key(): string { return trim((string)(image_cfg()['pexels']['api_key'] ?? '')); }
function pexels_item(array $p): ?array {
    $id = (int)($p['id'] ?? 0);
    $src = (array)($p['src'] ?? []);
    if (!$id) return null;
    return image_item('pexels', (string)$id, ['title' => ($p['alt'] ?? '') ?: 'Photo', 'author' => $p['photographer'] ?? '', 'author_url' => $p['photographer_url'] ?? null,
        'license' => PEXELS_LICENSE, 'via' => 'Pexels', 'landing_url' => $p['url'] ?? null, 'thumb' => $src['medium'] ?? ($src['small'] ?? null),
        'full' => $src['large2x'] ?? ($src['large'] ?? ($src['original'] ?? null))]);
}
function pexels_search(string $q): array {
    $data = image_json(PEXELS . '/search?' . http_build_query(['query' => $q, 'per_page' => IMAGE_RESULTS]), ['headers' => ['Authorization: ' . pexels_key()]]);
    if (!isset($data['photos']) || !is_array($data['photos'])) throw new ImageSourceDown('no results list');
    return array_values(array_filter(array_map(fn($p) => is_array($p) ? pexels_item($p) : null, $data['photos'])));
}
function pexels_lookup(string $id): ?array {
    if (!preg_match('/^\d{1,12}$/', $id)) return null;
    $p = image_json(PEXELS . "/photos/$id", ['headers' => ['Authorization: ' . pexels_key()]]);
    return $p ? pexels_item($p) : null;
}

// --- DeviantArt ------------------------------------------------------------------------------------------------
const DEVIANTART = 'https://www.deviantart.com';
const DEVIANTART_OEMBED = 'https://backend.deviantart.com/oembed';
function deviantart_ready(): bool {
    $k = (array)(image_cfg()['deviantart'] ?? []);
    return trim((string)($k['client_id'] ?? '')) !== '' && trim((string)($k['client_secret'] ?? '')) !== '';
}
function deviantart_get(string $path, array $query): ?array {
    $token = image_token('deviantart', DEVIANTART . '/oauth2/token');
    return image_json(DEVIANTART . "/api/v1/oauth2/$path?" . preg_replace('/%5B\d+%5D=/', '%5B%5D=', http_build_query($query)), ['headers' => ["Authorization: Bearer $token"]]);
}
/** DeviantArt's tags are single words: "Ruined keep" is searched as ruinedkeep. */
function deviantart_tag(string $q): string { return mb_substr(preg_replace('/[^\p{L}\p{N}_]+/u', '', mb_strtolower($q)) ?? '', 0, 50); }
/** Licences of deviations by id, from deviation/metadata (which the browse lists leave out). */
function deviantart_licenses(array $ids): array {
    if (!$ids) return [];
    $data = deviantart_get('deviation/metadata', ['deviationids' => array_values($ids)]);
    $out = [];
    foreach ((array)($data['metadata'] ?? []) as $m) if (is_array($m)) $out[(string)($m['deviationid'] ?? '')] = (string)($m['license'] ?? '');
    return $out;
}
function deviantart_item(array $d, string $license): array {
    $thumb = null;
    foreach ((array)($d['thumbs'] ?? []) as $t) if (is_array($t) && image_url($t['src'] ?? null)) { $thumb = $t['src']; if ((int)($t['width'] ?? 0) >= 300) break; }
    $user = (string)($d['author']['username'] ?? '');
    [$code, $ver] = deviantart_license($license);
    $lic = $code !== '' ? image_license($code, $ver) : [preg_match('/^no license$/i', trim($license)) || trim($license) === '' ? 'All rights reserved' : image_text($license, 60), null, false];
    return image_item('deviantart', (string)($d['deviationid'] ?? ''), ['title' => $d['title'] ?? '', 'author' => $user,
        'author_url' => $user !== '' ? DEVIANTART . '/' . rawurlencode($user) : null, 'license' => $lic, 'via' => 'DeviantArt',
        'landing_url' => $d['url'] ?? null, 'thumb' => $thumb ?? ($d['preview']['src'] ?? null), 'full' => $d['content']['src'] ?? null,
        'mature' => !empty($d['is_mature'])]);
}
function deviantart_search(string $q): array {
    $tag = deviantart_tag($q);
    if ($tag === '') return [];
    $data = deviantart_get('browse/tags', ['tag' => $tag, 'limit' => IMAGE_RESULTS, 'mature_content' => 'false']);
    if (!isset($data['results']) || !is_array($data['results'])) throw new ImageSourceDown('no results list');
    $list = array_values(array_filter($data['results'], fn($d) => is_array($d) && empty($d['is_mature']) && !empty($d['deviationid']) && (isset($d['content']) || isset($d['thumbs']))));
    $lic = deviantart_licenses(array_map(fn($d) => (string)$d['deviationid'], $list));
    return array_map(fn($d) => deviantart_item($d, $lic[(string)$d['deviationid']] ?? ''), $list);
}
function deviantart_lookup(string $id): ?array {
    if (!preg_match('/^[0-9A-F-]{36}$/i', $id)) return null;
    $d = deviantart_get("deviation/$id", []);
    return $d ? deviantart_item($d, deviantart_licenses([$id])[$id] ?? '') : null;
}
/** oEmbed's picture for a deviation's page: ['src', 'width', 'height', 'title', 'author', 'author_url'], or null when
 * DeviantArt says the work is gone, is for adults, or gives a picture somewhere other than its own image hosts. */
function deviantart_oembed(string $page): ?array {
    if (!preg_match('~^https://www\.deviantart\.com/[^/?#]+/art/[^?#]+$~', $page)) return null;
    $o = image_json(DEVIANTART_OEMBED . '?' . http_build_query(['url' => $page, 'format' => 'json']));
    if (!$o || strtolower((string)($o['safety'] ?? 'nonadult')) === 'adult') return null;
    $src = embed_src_ok($o['url'] ?? null) ?? embed_src_ok($o['thumbnail_url'] ?? null);
    if (!$src) return null;
    return ['src' => $src, 'width' => (int)($o['width'] ?? 0) ?: null, 'height' => (int)($o['height'] ?? 0) ?: null,
        'title' => image_text($o['title'] ?? '', 200), 'author' => image_text($o['author_name'] ?? '', 200), 'author_url' => image_url($o['author_url'] ?? null)];
}
/** $u when it is an https address on DeviantArt's image hosts, the only places an embed is ever sent to. */
function embed_src_ok($u): ?string {
    $u = is_string($u) ? $u : '';
    $host = strtolower((string)parse_url($u, PHP_URL_HOST));
    return strlen($u) <= 1000 && str_starts_with($u, 'https://') && preg_match('/(^|\.)(wixmp\.com|deviantart\.net)$/', $host) ? $u : null;
}

/** Stops the request (409 source_not_set_up) when $source needs keys the config doesn't have, telling an admin where
 * to get them. */
function image_source_ready(string $source): void {
    $need = ['deviantart' => [deviantart_ready(), "register an app at deviantart.com/developers and put its client_id and client_secret under 'image_search' => ['deviantart' => …]"],
        'pixabay' => [pixabay_key() !== '', "get a free key at pixabay.com/api/docs (signed in) and put it under 'image_search' => ['pixabay' => ['api_key' => …]]"],
        'pexels' => [pexels_key() !== '', "get a free key at pexels.com/api and put it under 'image_search' => ['pexels' => ['api_key' => …]]"]][$source] ?? [true, ''];
    if ($need[0]) return;
    $name = IMAGE_SOURCE_NAMES[$source];
    fail(me()['is_admin'] ? "$name isn't set up on this server: {$need[1]} in the config." : "$name isn't available on this server.", 409, 'source_not_set_up');
}

// --- one entry point per action --------------------------------------------------------------------------------
function image_search(string $source, string $q): array {
    $items = match ($source) { 'openverse' => openverse_search($q), 'commons' => commons_search($q), 'pixabay' => pixabay_search($q),
        'museums' => museums_search($q), 'pexels' => pexels_search($q), 'deviantart' => deviantart_search($q) };
    return array_values(array_map('image_public', array_filter($items, fn($i) => $i['id'] !== '' && $i['thumb'] && !$i['mature'])));
}
/** One work, looked up again by source and id (never taken from the browser), with its full picture; null if gone. */
function image_lookup(string $source, string $id): ?array {
    $i = match ($source) { 'openverse' => openverse_lookup($id), 'commons' => commons_lookup($id), 'pixabay' => pixabay_lookup($id),
        'museums' => museums_lookup($id), 'pexels' => pexels_lookup($id), 'deviantart' => deviantart_lookup($id), default => null };
    return $i && !$i['mature'] ? $i : null;
}

/** Download a found picture to a temporary file, refusing anything past $max bytes: https only, to public addresses
 * only (so a source can't point the server at itself or the local network), following at most 3 redirects. Returns the
 * path; throws ImageSourceDown, or LengthException when it is too big. */
function image_download(string $url, int $max): string {
    $tmp = tempnam(sys_get_temp_dir(), 'ccimg');
    if (($file = (string)(image_cfg()['stub'] ?? '')) !== '') {
        $r = image_http('GET', $url, ['binary' => true]);
        if ($r['status'] !== 200) { @unlink($tmp); throw new ImageSourceDown('download failed'); }
        if (strlen($r['body']) > $max) { @unlink($tmp); throw new LengthException('too big'); }
        file_put_contents($tmp, $r['body']);
        return $tmp;
    }
    for ($hop = 0; $hop <= 3; $hop++) {
        $p = parse_url($url);
        $host = strtolower((string)($p['host'] ?? ''));
        if (($p['scheme'] ?? '') !== 'https' || $host === '' || isset($p['user']) || isset($p['port'])) break;
        $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : (gethostbynamel($host) ?: []);
        $ips = array_filter($ips, fn($ip) => filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE));
        if (!$ips) break;
        $fh = fopen($tmp, 'wb');
        $got = 0;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RESOLVE => ["$host:443:" . reset($ips)], CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 20,
            CURLOPT_HTTPHEADER => ['User-Agent: CampaignChronicle/1.0', 'Accept: image/*'], CURLOPT_HEADER => false,
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use ($fh, &$got, $max) { $got += strlen($chunk); return $got > $max ? -1 : fwrite($fh, $chunk); },
        ]);
        curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $next = (string)curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        unset($ch);                                       // frees the handle (curl_close() is deprecated in PHP 8.5)
        fclose($fh);
        if ($got > $max) { @unlink($tmp); throw new LengthException('too big'); }
        if ($status === 200 && $got > 0) return $tmp;
        if (!in_array($status, [301, 302, 303, 307, 308], true) || $next === '') break;
        $url = $next;
    }
    @unlink($tmp);
    throw new ImageSourceDown('download failed');
}
