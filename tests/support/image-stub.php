<?php
// Find Image's sources, for the browser tests only: support/config.test.php names this file as image_search.stub, so
// api/images.php asks this function instead of Openverse, the museums (the Smithsonian's key is "stub") and DeviantArt, and nothing leaves the machine.
// Commons, Pixabay, Pexels, Cleveland and Europeana are answered too (Pixabay notes each search it is asked in
// chronicle-test-pixabay.log in the temp folder, so a test can see the day's cache at work).
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
    $words = strtolower((string)($q['q'] ?? $q['tag'] ?? $q['gsrsearch'] ?? $q['query'] ?? ''));
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
    if ($host === 'commons.wikimedia.org' && $path === '/w/api.php') {
        $files = [
            9001 => ['title' => 'File:Ruined keep in winter.jpg', 'License' => 'cc-by-sa-4.0', 'LicenseShortName' => 'CC BY-SA 4.0',
                'Artist' => '<a href="//commons.wikimedia.org/wiki/User:Ann" title="User:Ann">Ann Walker</a>', 'ObjectName' => 'Ruined keep in winter'],
            9002 => ['title' => 'File:Keep under the GFDL.png', 'License' => 'gfdl', 'LicenseShortName' => 'GFDL', 'Artist' => 'Gus', 'ObjectName' => ''],
            9003 => ['title' => 'File:Old engraving of a keep.jpg', 'License' => 'pd', 'LicenseShortName' => 'Public domain', 'Artist' => 'Unknown engraver', 'ObjectName' => 'Old engraving of a keep'],
        ];
        $page = fn(int $id, int $i) => ['pageid' => $id, 'ns' => 6, 'title' => $files[$id]['title'], 'index' => $i, 'imageinfo' => [[
            'url' => "https://img.test/commons-$id-original.png", 'descriptionurl' => 'https://commons.wikimedia.org/wiki/' . str_replace(' ', '_', $files[$id]['title']),
            'thumburl' => (($q['iiurlwidth'] ?? '') === '1600' ? "https://img.test/commons-$id-1600.png" : $thumb),
            'extmetadata' => array_map(fn($v) => ['value' => $v, 'source' => 'commons-desc-page'], array_diff_key($files[$id], ['title' => 1]))]]];
        if (isset($q['pageids'])) return $json(['batchcomplete' => true, 'query' => ['pages' => isset($files[(int)$q['pageids']]) ? [$page((int)$q['pageids'], 1)] : [['pageid' => (int)$q['pageids'], 'missing' => true]]]]);
        // the search's pages come in no particular order; "index" is their place in it
        return $json(['batchcomplete' => true] + ($none ? [] : ['query' => ['pages' => [$page(9003, 3), $page(9001, 1), $page(9002, 2)]]]));
    }
    if ($host === 'pixabay.com' && $path === '/api/') {
        if (($q['key'] ?? '') !== 'stub') return $json(['error' => '[ERROR 400] "key" is wrong'], 400);
        @file_put_contents(sys_get_temp_dir() . '/chronicle-test-pixabay.log', ($q['q'] ?? 'id=' . ($q['id'] ?? '')) . "\n", FILE_APPEND);
        $hit = fn(int $id, string $tags, string $user) => ['id' => $id, 'pageURL' => "https://pixabay.com/illustrations/castle-$id/", 'type' => 'illustration', 'tags' => $tags,
            'previewURL' => $thumb, 'webformatURL' => $thumb, 'largeImageURL' => "https://img.test/pixabay-$id.png", 'user_id' => 77, 'user' => $user];
        $hits = [5001 => $hit(5001, 'castle, fantasy, dragon', 'DragonPainter'), 5002 => $hit(5002, 'wizard,tower', 'Mage')];
        if (isset($q['id'])) return $json(['total' => isset($hits[(int)$q['id']]) ? 1 : 0, 'totalHits' => 0, 'hits' => isset($hits[(int)$q['id']]) ? [$hits[(int)$q['id']]] : []]);
        return $json(['total' => $none ? 0 : 2, 'totalHits' => $none ? 0 : 2, 'hits' => $none ? [] : array_values($hits)]);
    }
    if ($host === 'api.pexels.com') {
        if (!in_array('Authorization: stub', $opts['headers'] ?? [], true)) return $json(['error' => 'Unauthorized'], 401);
        $photo = fn(int $id) => ['id' => $id, 'width' => 2, 'height' => 1, 'url' => "https://www.pexels.com/photo/old-tower-$id/", 'photographer' => 'Pat Lens',
            'photographer_url' => 'https://www.pexels.com/@pat', 'alt' => 'An old stone tower by a river', 'src' => ['original' => "https://img.test/pexels-$id.png",
            'large2x' => "https://img.test/pexels-$id-large2x.png", 'large' => "https://img.test/pexels-$id-large.png", 'medium' => $thumb, 'small' => $thumb, 'tiny' => $thumb]];
        if ($path === '/v1/search') return $json(['page' => 1, 'per_page' => 20, 'total_results' => $none ? 0 : 1, 'photos' => $none ? [] : [$photo(3003)]]);
        if ($path === '/v1/photos/3003') return $json($photo(3003));
        return $json(['error' => 'Not found'], 404);
    }
    if ($host === 'openaccess-api.clevelandart.org') {
        $art = fn(int $id, string $status) => ['id' => $id, 'accession_number' => "1916.$id", 'share_license_status' => $status, 'title' => $status === 'CC0' ? 'Helmet for the joust' : 'A modern print',
            'creators' => $status === 'CC0' ? [['description' => 'Kolman Helmschmid (German, 1471-1532)', 'role' => 'artist']] : [],
            'url' => "https://clevelandart.org/art/1916.$id", 'images' => ['web' => ['url' => $thumb], 'print' => ['url' => "https://img.test/cma-$id.png"]]];
        if ($path === '/api/artworks/') return str_contains($u['query'] ?? '', '&cc0') ? $json(['info' => ['total' => $none ? 0 : 2], 'data' => $none ? [] : [$art(1517, 'CC0'), $art(2000, 'Copyrighted')]])
            : $json(['detail' => 'the stub expects the cc0 flag'], 400);
        if ($path === '/api/artworks/1517') return $json(['data' => $art(1517, 'CC0')]);
        return $json(['detail' => 'Not found'], 404);
    }
    if ($host === 'api.europeana.eu' && $path === '/record/v2/search.json') {
        if (($q['wskey'] ?? '') !== 'stub') return $json(['success' => false, 'error' => 'Invalid API key'], 401);
        if (($q['reusability'] ?? '') !== 'open') return $json(['success' => false, 'error' => 'the stub expects reusability=open'], 400);
        $items = [
            '/90402/SK_A_1505' => ['title' => ['Portrait of a Knight'], 'dcCreator' => ['Frans Hals'], 'rights' => ['http://creativecommons.org/publicdomain/mark/1.0/'], 'dataProvider' => ['Rijksmuseum']],
            '/2048/item_77' => ['title' => ['Sketch of a tower'], 'dcCreator' => ['A. Student'], 'rights' => ['http://creativecommons.org/licenses/by-sa/4.0/'], 'dataProvider' => ['SMK - Statens Museum for Kunst']],
        ];
        $item = fn($id) => ['id' => $id, 'guid' => "https://www.europeana.eu/item$id", 'edmPreview' => [$thumb], 'edmIsShownBy' => ['https://img.test/eu' . str_replace('/', '-', $id) . '.png'], 'type' => 'IMAGE'] + $items[$id];
        if (preg_match('~^europeana_id:"([^"]+)"$~', (string)$q['query'], $m)) return $json(['success' => true, 'itemsCount' => isset($items[$m[1]]) ? 1 : 0, 'items' => isset($items[$m[1]]) ? [$item($m[1])] : []]);
        return $json(['success' => true, 'itemsCount' => $none ? 0 : 2, 'items' => $none ? [] : array_map($item, array_keys($items))]);
    }
    return ['status' => 0, 'body' => '', 'error' => "image stub: nothing at $url"];
};
