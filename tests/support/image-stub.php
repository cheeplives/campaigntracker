<?php
// Find Image's sources, for the browser tests only: support/config.test.php names this file as image_search.stub, so
// api/images.php asks this function instead of Openverse, the museums (the Smithsonian's key is "stub") and DeviantArt, and nothing leaves the machine.
// Searching for "broken" makes a source answer an error; "nothing" finds nothing. Thumbnails are data: pictures; the
// full-size pictures are at https://img.test/, which only this stub serves. A DeviantArt page with "/art/Gone-" in it
// is one oEmbed no longer knows, and oEmbed is down for /offline/.
const STUB_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAD0lEQVQImWNgYGBgYGAAAAAHAAHV3tbYAAAAAElFTkSuQmCC';

return function (string $method, string $url, array $opts): array {
    $png = base64_decode(STUB_PNG);
    $thumb = 'data:image/png;base64,' . STUB_PNG;
    $json = fn($data, int $status = 200) => ['status' => $status, 'body' => json_encode($data), 'error' => ''];
    $u = parse_url($url);
    $host = $u['host'] ?? '';
    $path = $u['path'] ?? '';
    parse_str($u['query'] ?? '', $q);
    $words = strtolower((string)($q['q'] ?? $q['tag'] ?? ''));
    if (str_contains($words, 'broken')) return $json(['detail' => 'down'], 500);
    $none = str_contains($words, 'nothing');

    if (str_starts_with($url, 'data:image/png;base64,')) return ['status' => 200, 'body' => base64_decode(substr($url, 22)), 'error' => ''];
    // Import from Scabard copies pictures from scabard.com: every path there is a picture, except /gone/ ones.
    if ($host === 'www.scabard.com') return str_contains($path, '/gone/') ? ['status' => 404, 'body' => '', 'error' => ''] : ['status' => 200, 'body' => $png, 'error' => ''];
    if ($host === 'img.test') {
        // big.png is past the tests' 2 MB limit, so the thumbnail is kept instead.
        if ($path === '/big.png') return ['status' => 200, 'body' => $png . str_repeat("\0", 3 << 20), 'error' => ''];
        return ['status' => 200, 'body' => $png, 'error' => ''];
    }

    $ov = [
        '11111111-1111-1111-1111-111111111111' => ['title' => 'Ruined keep at dusk', 'creator' => 'Ann Photo', 'creator_url' => 'https://www.flickr.com/photos/ann',
            'license' => 'by-sa', 'license_version' => '4.0', 'provider' => 'flickr', 'foreign_landing_url' => 'https://www.flickr.com/photos/ann/1', 'url' => 'https://img.test/keep.png'],
        '22222222-2222-2222-2222-222222222222' => ['title' => 'Keep, not for sale', 'creator' => 'Bo', 'creator_url' => null,
            'license' => 'by-nc', 'license_version' => '2.0', 'provider' => 'flickr', 'foreign_landing_url' => 'https://www.flickr.com/photos/bo/2', 'url' => 'https://img.test/nc.png'],
        '33333333-3333-3333-3333-333333333333' => ['title' => 'Huge castle map', 'creator' => 'Cy', 'creator_url' => 'https://commons.wikimedia.org/wiki/User:Cy',
            'license' => 'cc0', 'license_version' => '1.0', 'provider' => 'wikimedia', 'foreign_landing_url' => 'https://commons.wikimedia.org/wiki/File:Map.png', 'url' => 'https://img.test/big.png'],
    ];
    if ($host === 'api.openverse.org') {
        if (preg_match('~^/v1/images/([0-9a-f-]{36})/$~', $path, $m))
            return isset($ov[$m[1]]) ? $json(['id' => $m[1], 'thumbnail' => $thumb] + $ov[$m[1]]) : $json(['detail' => 'Not found'], 404);
        if ($path === '/v1/images/')
            return $json(['result_count' => $none ? 0 : 3, 'results' => $none ? [] : array_map(fn($id) => ['id' => $id, 'thumbnail' => $thumb] + $ov[$id], array_keys($ov))]);
    }

    if ($host === 'api.artic.edu') {
        $art = ['id' => 27992, 'title' => 'A Sunday on La Grande Jatte', 'artist_title' => 'Georges Seurat', 'artist_id' => 35, 'image_id' => '2d484387-2509-5e8e-2c43-22f9981972eb', 'is_public_domain' => true];
        $config = ['iiif_url' => 'https://www.artic.edu/iiif/2'];
        if ($path === '/api/v1/artworks/27992') return $json(['data' => $art, 'config' => $config]);
        if ($path === '/api/v1/artworks/search') return $json(['data' => $none ? [] : [$art], 'config' => $config]);
    }
    if ($host === 'collectionapi.metmuseum.org') {
        $objs = [
            436535 => ['objectID' => 436535, 'isPublicDomain' => true, 'title' => 'Armor of George Clifford', 'artistDisplayName' => 'Jacob Halder',
                'artistWikidata_URL' => 'https://www.wikidata.org/wiki/Q1', 'objectURL' => 'https://www.metmuseum.org/art/collection/search/436535',
                'primaryImage' => 'https://img.test/armor.png', 'primaryImageSmall' => $thumb],
            1 => ['objectID' => 1, 'isPublicDomain' => false, 'title' => 'Not public domain', 'primaryImageSmall' => $thumb],
        ];
        if ($path === '/public/collection/v1/search') return $json(['total' => $none ? 0 : 2, 'objectIDs' => $none ? null : [436535, 1]]);
        if (preg_match('~^/public/collection/v1/objects/(\d+)$~', $path, $m)) return isset($objs[(int)$m[1]]) ? $json($objs[(int)$m[1]]) : $json(['message' => 'Not a valid object'], 404);
    }

    if ($host === 'api.si.edu') {
        if (($q['api_key'] ?? '') !== 'stub') return $json(['error' => ['code' => 'API_KEY_MISSING']], 403);
        $rec = fn(string $id, string $access) => ['id' => $id, 'title' => $id === 'edanmdm-nmah_1' ? 'Suit of armor' : 'Locked photograph', 'unitCode' => 'NMAH',
            'content' => ['descriptiveNonRepeating' => ['record_link' => "https://americanhistory.si.edu/collections/object/$id",
                'online_media' => ['mediaCount' => 1, 'media' => [['idsId' => "NMAH-$id", 'thumbnail' => "https://ids.si.edu/ids/deliveryService?id=NMAH-$id", 'usage' => ['access' => $access]]]]],
                'freetext' => ['name' => [['label' => 'Maker', 'content' => 'Unknown armorer']]]]];
        if ($path === '/openaccess/api/v1.0/search')
            return $json(['status' => 200, 'response' => ['rowCount' => $none ? 0 : 2, 'rows' => $none ? [] : [$rec('edanmdm-nmah_1', 'CC0'), $rec('edanmdm-nmah_2', 'Usage conditions apply')]]]);
        if ($path === '/openaccess/api/v1.0/content/edanmdm-nmah_1') return $json(['status' => 200, 'response' => $rec('edanmdm-nmah_1', 'CC0')]);
    }
    if ($host === 'ids.si.edu') return ['status' => 200, 'body' => $png, 'error' => ''];

    $da = [
        'A1B2C3D4-0000-0000-0000-000000000001' => ['title' => 'Keep in the mist', 'user' => 'mistpainter', 'slug' => 'Keep-in-the-mist-1', 'license' => 'Creative Commons Attribution 3.0 License'],
        'A1B2C3D4-0000-0000-0000-000000000002' => ['title' => 'The Grey Keep', 'user' => 'greyartist', 'slug' => 'The-Grey-Keep-2', 'license' => 'No License'],
        'A1B2C3D4-0000-0000-0000-000000000003' => ['title' => 'Grown-up keep', 'user' => 'someone', 'slug' => 'Grown-up-keep-3', 'license' => 'No License', 'mature' => true],
        'A1B2C3D4-0000-0000-0000-000000000004' => ['title' => 'Keep elsewhere', 'user' => 'elsewhere', 'slug' => 'Keep-elsewhere-4', 'license' => 'No License'],
        // Not in any search: oEmbed is down for it, and the API's own picture is on DeviantArt's hosts.
        'A1B2C3D4-0000-0000-0000-000000000005' => ['title' => 'Keep offline', 'user' => 'offline', 'slug' => 'Keep-offline-5', 'license' => 'No License', 'hidden' => true,
            'src' => 'https://images-wixmp-stub.wixmp.com/f/offline.png?token=api'],
    ];
    $dev = fn($id) => ['deviationid' => $id, 'url' => "https://www.deviantart.com/{$da[$id]['user']}/art/{$da[$id]['slug']}", 'title' => $da[$id]['title'],
        'author' => ['username' => $da[$id]['user']], 'is_mature' => !empty($da[$id]['mature']),
        'thumbs' => [['src' => $thumb, 'width' => 150, 'height' => 75], ['src' => $thumb, 'width' => 300, 'height' => 150]],
        'content' => ['src' => $da[$id]['src'] ?? 'https://img.test/da-' . substr($id, -1) . '.png', 'width' => 2, 'height' => 1]];
    if ($host === 'www.deviantart.com') {
        if ($path === '/oauth2/token') return $json(['access_token' => 'stub-token', 'expires_in' => 3600, 'status' => 'success']);
        if ($path === '/api/v1/oauth2/browse/tags') return $json(['has_more' => false, 'next_offset' => null, 'results' => $none ? [] : array_map($dev, array_keys(array_filter($da, fn($d) => empty($d['hidden']))))]);
        if ($path === '/api/v1/oauth2/deviation/metadata')
            return $json(['metadata' => array_map(fn($id) => ['deviationid' => $id, 'license' => $da[$id]['license'] ?? 'No License'], array_filter((array)($q['deviationids'] ?? []), fn($id) => isset($da[$id])))]);
        if (preg_match('~^/api/v1/oauth2/deviation/([0-9A-F-]{36})$~', $path, $m)) return isset($da[$m[1]]) ? $json($dev($m[1])) : $json(['error' => 'invalid_request'], 404);
    }
    if ($host === 'backend.deviantart.com' && $path === '/oembed') {
        $page = (string)($q['url'] ?? '');
        if (str_contains($page, '/art/Gone-')) return $json(['error' => 'not found'], 404);
        if (str_contains($page, '/offline/')) return $json(['error' => 'unavailable'], 503);
        $src = str_contains($page, '/elsewhere/') ? 'https://evil.test/keep.jpg' : 'https://images-wixmp-stub.wixmp.com/f/keep.png?token=' . bin2hex(random_bytes(4));
        return $json(['version' => '1.0', 'type' => 'photo', 'url' => $src, 'width' => 2, 'height' => 1, 'title' => 'The Grey Keep',
            'author_name' => 'greyartist', 'author_url' => 'https://www.deviantart.com/greyartist', 'provider_name' => 'DeviantArt', 'safety' => 'nonadult']);
    }
    return ['status' => 0, 'body' => '', 'error' => "image stub: nothing at $url"];
};
