<?php
// The fan wikis, for the browser tests only: support/config.test.php names this file as fan_wikis.stub, so
// api/fanwikis.php asks this function instead of Wookieepedia, Memory Alpha and the Greyhawk Online wiki, and nothing
// leaves the machine. Wookieepedia says it is CC BY-SA 3.0, Memory Alpha CC BY-NC 4.0, and Greyhawk Online states no
// licence; its api.php isn't where the list says, so it is found from the EditURI link on its main page. Pictures are at
// https://img.test/, which tests/support/image-stub.php serves. Searching for "broken" makes a wiki answer an error.

return function (string $method, string $url, array $opts): array {
    $json = fn($data, int $status = 200) => ['status' => $status, 'body' => json_encode($data), 'error' => ''];
    $u = parse_url($url);
    $host = $u['host'] ?? '';
    $path = $u['path'] ?? '';
    parse_str($u['query'] ?? '', $q);
    $words = strtolower((string)($q['srsearch'] ?? $q['gsrsearch'] ?? ''));
    if (str_contains($words, 'broken')) return $json(['error' => 'down'], 500);

    $wikis = [
        'starwars.fandom.com' => ['api' => '/api.php', 'name' => 'Wookieepedia', 'rights' => ['url' => 'https://www.fandom.com/licensing', 'text' => 'CC-BY-SA']],
        'memory-alpha.fandom.com' => ['api' => '/api.php', 'name' => 'Memory Alpha', 'rights' => ['url' => 'https://creativecommons.org/licenses/by-nc/4.0/', 'text' => 'Creative Commons Attribution-NonCommercial']],
        'greyhawkonline.com' => ['api' => '/w/api.php', 'name' => 'Greyhawk Online', 'rights' => ['url' => '', 'text' => '']],
    ];
    $w = $wikis[$host] ?? null;
    if (!$w) return ['status' => 0, 'body' => '', 'error' => "fan wiki stub: nothing at $url"];
    if ($host === 'greyhawkonline.com' && $path === '/greyhawkwiki/Main_Page')
        return ['status' => 200, 'body' => '<html><head><link rel="EditURI" type="application/rsd+xml" href="//greyhawkonline.com/w/api.php?action=rsd"></head><body>Main Page</body></html>', 'error' => ''];
    if ($path !== $w['api']) return ['status' => 404, 'body' => 'Not found', 'error' => ''];

    if (($q['meta'] ?? '') === 'siteinfo')
        return $json(['query' => ['general' => ['sitename' => $w['name'], 'server' => "https://$host", 'articlepath' => '/wiki/$1'], 'rightsinfo' => $w['rights']]]);

    $article = ['Luke Skywalker' => '<div class="mw-parser-output"><aside class="portable-infobox"><p>Homeworld: Tatooine, a desert world of twin suns.</p></aside>'
        . '<p><b>Luke Skywalker</b> was a Force-sensitive human male who served as a Jedi Master.<sup class="reference">[1]</sup> He grew up on Tatooine.</p>'
        . '<table><tr><td>Not a paragraph worth quoting at all, it is a table cell.</td></tr></table>'
        . '<p>He later rebuilt the Jedi Order, and trained a new generation of Jedi on the planet Yavin 4.</p></div>',
        'Stardate' => '<div class="mw-parser-output"><p>A <b>stardate</b> was a system of measuring time used by Starfleet in the 23rd and 24th centuries.</p></div>',
        'Castle Greyhawk' => '<div class="mw-parser-output"><p><b>Castle Greyhawk</b> is a ruined castle near the Free City of Greyhawk, famous for its dungeons.</p></div>'];
    if (($q['list'] ?? '') === 'search') {
        $hits = ['starwars.fandom.com' => [['title' => 'Luke Skywalker', 'snippet' => '<span class="searchmatch">Luke</span> Skywalker was a Jedi'], ['title' => 'Luke Skywalker (clone)', 'snippet' => 'A clone']],
            'memory-alpha.fandom.com' => [['title' => 'Stardate', 'snippet' => 'A system of measuring time']],
            'greyhawkonline.com' => [['title' => 'Castle Greyhawk', 'snippet' => 'A ruined castle']]][$host];
        return $json(['query' => ['search' => str_contains($words, 'nothing') ? [] : $hits]]);
    }
    if (($q['action'] ?? '') === 'parse') {
        $page = (string)($q['page'] ?? '');
        return isset($article[$page]) ? $json(['parse' => ['title' => $page, 'text' => $article[$page]]]) : $json(['error' => ['code' => 'missingtitle', 'info' => 'The page you specified doesn\'t exist.']]);
    }
    // Pictures: one under CC BY-SA, one in a fair-use category, and one that is a sound file.
    $file = fn(string $title, string $img, array $cats, string $mime = 'image/png', array $meta = []) => ['title' => $title, 'categories' => array_map(fn($c) => ['ns' => 14, 'title' => "Category:$c"], $cats),
        'imageinfo' => [['url' => "https://img.test/$img", 'thumburl' => 'https://img.test/fw-thumb.png', 'descriptionurl' => "https://$host/wiki/" . str_replace(' ', '_', $title), 'mime' => $mime, 'extmetadata' => $meta]]];
    $files = ['File:X-wing fan drawing.png' => $file('File:X-wing fan drawing.png', 'fw-open.png', ['CC-BY-SA files'], 'image/png', ['Artist' => ['value' => '<a href="/wiki/User:Ann">Ann</a>']]),
        'File:Luke promo.png' => $file('File:Luke promo.png', 'fw-fair.png', ['Fair use images', 'Images of Luke Skywalker']),
        'File:Luke theme.ogg' => $file('File:Luke theme.ogg', 'fw.ogg', ['Music'], 'audio/ogg')];
    if (($q['generator'] ?? '') === 'images') return $json(['query' => ['pages' => [$files['File:Luke promo.png'], $files['File:Luke theme.ogg']]]]);
    if (($q['generator'] ?? '') === 'search') return $json(['query' => ['pages' => [$files['File:X-wing fan drawing.png'], $files['File:Luke promo.png']]]]);
    if (isset($q['titles'], $files[$q['titles']])) return $json(['query' => ['pages' => [$files[$q['titles']]]]]);
    if (isset($q['titles'])) return $json(['query' => ['pages' => [['title' => $q['titles'], 'missing' => true]]]]);
    return $json(['error' => ['code' => 'badparams', 'info' => 'stub: unknown query']]);
};
