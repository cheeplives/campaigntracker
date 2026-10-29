<?php
/**
 * images.php — Find Image: the server side of searching for a picture for an Encyclopedia entry.
 *
 * Three sources, each searched only when its tab is opened: Openverse (openly licensed pictures from Flickr, Wikimedia
 * Commons, museums and more), museums' open access collections (the Art Institute of Chicago, The Met and, with a key,
 * the Smithsonian; public domain works only) and DeviantArt (by tag). The server asks them, so the keys in the config's image_search block never
 * reach the browser, and every result comes back in one shape (image_item()). Only pictures under an open licence
 * (image_license()) can be copied into the app; a DeviantArt work that isn't can be embedded instead, which keeps only
 * its link and loads the picture from DeviantArt through its oEmbed API each time.
 *
 * Every outbound call goes through image_http(). When the config names an image_search.stub file (the tests do), that
 * file's function answers instead and nothing leaves the machine.
 */

const IMAGE_SOURCES = ['openverse', 'museums', 'deviantart'];
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

// --- tokens ----------------------------------------------------------------------------------------------------
/** A client-credentials access token for $name ('openverse' or 'deviantart'), kept until it expires in a file in the
 * uploads folder (outside the web root); null when the config has no keys for it. */
function image_token(string $name, string $tokenUrl): ?string {
    $keys = (array)(image_cfg()[$name] ?? []);
    $id = trim((string)($keys['client_id'] ?? '')); $secret = trim((string)($keys['client_secret'] ?? ''));
    if ($id === '' || $secret === '') return null;
    $dir = upload_dir()['dir'];
    $file = $dir ? "$dir/.image-search-tokens.json" : null;
    $cache = $file && is_file($file) ? (json_decode((string)@file_get_contents($file), true) ?: []) : [];
    $key = $name . ':' . hash('sha256', $id);
    if (($cache[$key]['until'] ?? 0) > time() + 60) return $cache[$key]['token'];
    $data = image_json($tokenUrl, ['post_fields' => http_build_query(['grant_type' => 'client_credentials', 'client_id' => $id, 'client_secret' => $secret]),
        'headers' => ['Content-Type: application/x-www-form-urlencoded']], 'POST');
    $token = (string)($data['access_token'] ?? '');
    if ($token === '') throw new ImageSourceDown('no token');
    $cache[$key] = ['token' => $token, 'until' => time() + max(60, (int)($data['expires_in'] ?? 3600))];
    if ($file && @file_put_contents($file, json_encode($cache), LOCK_EX) !== false) @chmod($file, 0600);
    return $token;
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
/** The museums, taken in turn so none crowds the others out: the Art Institute of Chicago and The Met, and the
 * Smithsonian when the config has its key. One that is down is skipped while another answers. */
function museums_search(string $q): array {
    $lists = [];
    $tried = $down = 0;
    $tried++;
    try {
        $data = image_json(ARTIC . '/api/v1/artworks/search?' . http_build_query(['q' => $q, 'limit' => IMAGE_RESULTS, 'fields' => ARTIC_FIELDS,
            'query' => ['term' => ['is_public_domain' => 'true']]]), ['headers' => artic_headers()]);
        $lists[] = array_values(array_filter(array_map(fn($r) => is_array($r) ? artic_item($r, (string)($data['config']['iiif_url'] ?? '')) : null, (array)($data['data'] ?? []))));
    } catch (ImageSourceDown) { $down++; }
    $tried++;
    try {
        $data = image_json(MET . '/public/collection/v1/search?' . http_build_query(['hasImages' => 'true', 'q' => $q]));
        $met = [];
        foreach (array_slice(array_filter(array_map('intval', (array)($data['objectIDs'] ?? []))), 0, 10) as $id) {
            try { $r = image_json(MET . "/public/collection/v1/objects/$id"); } catch (ImageSourceDown) { continue; }
            if ($r && ($i = met_item($r))) $met[] = $i;
        }
        $lists[] = $met;
    } catch (ImageSourceDown) { $down++; }
    if (($key = smithsonian_key()) !== '') {
        $tried++;
        try {
            $data = image_json(SMITHSONIAN . '/search?' . http_build_query(['q' => "$q AND online_media_type:\"Images\"", 'rows' => IMAGE_RESULTS, 'api_key' => $key]));
            $lists[] = array_values(array_filter(array_map(fn($r) => is_array($r) ? smithsonian_item($r) : null, (array)($data['response']['rows'] ?? []))));
        } catch (ImageSourceDown) { $down++; }
    }
    if ($down === $tried) throw new ImageSourceDown('every museum down');
    $out = [];
    for ($i = 0; count($out) < IMAGE_RESULTS && array_filter($lists, fn($l) => isset($l[$i])); $i++)
        foreach ($lists as $l) if (isset($l[$i]) && count($out) < IMAGE_RESULTS) $out[] = $l[$i];
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
    return null;
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

// --- one entry point per action --------------------------------------------------------------------------------
function image_search(string $source, string $q): array {
    $items = match ($source) { 'openverse' => openverse_search($q), 'museums' => museums_search($q), 'deviantart' => deviantart_search($q) };
    return array_values(array_map('image_public', array_filter($items, fn($i) => $i['id'] !== '' && $i['thumb'] && !$i['mature'])));
}
/** One work, looked up again by source and id (never taken from the browser), with its full picture; null if gone. */
function image_lookup(string $source, string $id): ?array {
    $i = match ($source) { 'openverse' => openverse_lookup($id), 'museums' => museums_lookup($id), 'deviantart' => deviantart_lookup($id), default => null };
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
