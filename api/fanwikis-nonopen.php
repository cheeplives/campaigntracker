<?php
/**
 * fanwikis-nonopen.php — everything about fan wikis that is NOT openly licensed, kept in this one file so it can be
 * taken out of the app in one go (tools/fanwiki-kill-switch.sh --non-open deletes it, and the rest keeps working):
 *
 *   wikis     the wikis whose text is non-commercial only (CC BY-NC), or whose licence is unclear or closed. Their text
 *             is added with its licence named, or as "personal fair use" when there is none.
 *   fair_use  pictures on any fan wiki that aren't openly licensed (most of them: screenshots, covers and official art)
 *             may be copied to an entry for the campaign's own use, credited and marked "Personal fair use".
 *
 * Every one of these is listed in SOURCES-TO-LICENSE.md (gitignored; a copy is in the project files) and on the About
 * page under "No open source". For a commercial version, set 'fan_wikis' => ['open_only' => true] in the config, or
 * run the kill switch to remove this file.
 */

$fandom = fn(string $sub) => ['site' => "https://$sub.fandom.com/", 'api' => "https://$sub.fandom.com/api.php", 'images' => ['static.wikia.nocookie.net'], 'host' => 'Fandom'];

return [
    'fair_use' => true,
    'wikis' => [
        'memory-alpha' => $fandom('memory-alpha') + ['name' => 'Memory Alpha', 'settings' => ['Star Trek'],
            'license' => ['CC BY-NC 4.0', 'https://creativecommons.org/licenses/by-nc/4.0/']],
        'memory-beta' => $fandom('memory-beta') + ['name' => 'Memory Beta', 'settings' => ['Star Trek'],
            'license' => ['CC BY-NC 3.0', 'https://creativecommons.org/licenses/by-nc/3.0/']],   // unconfirmed: the wiki's own answer wins
        'lexicanum-whfb' => ['name' => 'Warhammer Fantasy Lexicanum', 'settings' => ['Warhammer Fantasy'], 'host' => 'Independent',
            'site' => 'https://whfb.lexicanum.com/wiki/Main_Page', 'api' => 'https://whfb.lexicanum.com/mediawiki/api.php', 'images' => ['whfb.lexicanum.com'],
            'license' => ['CC BY-NC', 'https://creativecommons.org/licenses/by-nc/3.0/']],
        // Fan contributions are CC BY-NC 3.0, but quotes from Mongoose's books may not be copied off the wiki: its
        // Copyright page, https://wiki.travellerrpg.com/Copyright.
        'traveller' => ['name' => 'Traveller Wiki', 'settings' => ['Traveller'], 'host' => 'Independent',
            'site' => 'https://wiki.travellerrpg.com/', 'api' => 'https://wiki.travellerrpg.com/api.php', 'images' => ['wiki.travellerrpg.com'],
            'license' => ['CC BY-NC 3.0', 'https://creativecommons.org/licenses/by-nc/3.0/'],
            'note' => 'Quotes from the published books (Library Data and the like) are Mongoose\'s and may not be copied outside the wiki without permission.'],
        'fallout-wiki' => ['name' => 'Independent Fallout Wiki', 'settings' => ['Fallout'], 'host' => 'Independent',
            'site' => 'https://fallout.wiki/', 'api' => 'https://fallout.wiki/api.php', 'images' => ['fallout.wiki', 'images.fallout.wiki'],
            'license' => null],                                                                     // not confirmed: asked of the wiki each time
        'greyhawkonline' => ['name' => 'Greyhawk Online wiki', 'settings' => ['Greyhawk'], 'host' => 'Independent',
            'site' => 'https://greyhawkonline.com/greyhawkwiki/Main_Page', 'api' => 'https://greyhawkonline.com/grwiki/api.php', 'images' => ['greyhawkonline.com'],
            'license' => null],
        'ysdc' => ['name' => 'YSDC Into the Deep', 'settings' => ['Call of Cthulhu'], 'host' => 'Independent',
            'site' => 'https://yogwiki.cthulhueternal.com/wiki/Main_Page', 'api' => 'https://yogwiki.cthulhueternal.com/w/api.php', 'images' => ['yogwiki.cthulhueternal.com'],
            'license' => null],
        'wellofdaliath' => ['name' => 'The Well of Daliath (Chaosium)', 'settings' => ['Glorantha'], 'host' => 'Chaosium', 'kind' => 'wordpress',
            'site' => 'https://wellofdaliath.chaosium.com/', 'api' => 'https://wellofdaliath.chaosium.com/wp-json/wp/v2', 'images' => ['wellofdaliath.chaosium.com'],
            'license' => ['© Chaosium', null]],
    ],
];
