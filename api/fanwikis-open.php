<?php
/**
 * fanwikis-open.php — the fan wikis whose text is openly licensed (CC BY-SA or the GNU FDL), for api/fanwikis.php.
 *
 * Each wiki: name, the settings it covers, its host, its address (site), its MediaWiki api.php (found again from the
 * site's own page if this one stops answering) and the licence its licence page gave on 25 October 2026. The licence
 * the wiki reports itself is asked again when it is used, so a wiki that changes licence is caught.
 *
 * Fandom's text is CC BY-SA 3.0 unless a wiki's footer says otherwise; its pictures are each under their own terms,
 * mostly fair-use screenshots and official art, which only api/fanwikis-nonopen.php allows to be copied.
 * Research and sources: /mnt/project-files/fan-wiki-licenses/report.md in the project files.
 */

$fandom = fn(string $sub, string $name, array $settings) => [$sub, ['name' => $name, 'settings' => $settings, 'host' => 'Fandom',
    'site' => "https://$sub.fandom.com/", 'api' => "https://$sub.fandom.com/api.php", 'images' => ['static.wikia.nocookie.net'],
    'license' => ['CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/']]];

return array_merge(array_column([
    $fandom('lotr', 'The One Wiki to Rule Them All', ['The One Ring', 'Middle-earth']),
    $fandom('starwars', 'Wookieepedia', ['Star Wars']),
    $fandom('robotech', 'Robotech Wiki', ['Robotech']),
    $fandom('twilight2000', 'Twilight 2000 Wiki', ['Twilight: 2000']),
    $fandom('expanse', 'The Expanse Wiki', ['The Expanse']),
    $fandom('warhammerfantasy', 'Warhammer Fantasy Wiki', ['Warhammer Fantasy']),
    $fandom('rifts', 'Rifts Wiki', ['Rifts']),
    $fandom('fadingsuns', 'Fading Suns Wiki', ['Fading Suns']),
    $fandom('whitewolf', 'White Wolf Wiki', ['World of Darkness']),
    $fandom('shadowrun', 'Shadowrun Wiki', ['Shadowrun']),
    $fandom('cyberpunk', 'Cyberpunk Wiki', ['Cyberpunk']),
    $fandom('firefly', 'Firefly Wiki', ['Firefly', 'Serenity']),
    $fandom('bladerunner', 'Blade Runner Wiki', ['Blade Runner']),
    $fandom('fallout', 'Nukapedia (Fallout Wiki)', ['Fallout']),
    $fandom('cowboybebop', 'Cowboy Bebop Wiki', ['Cowboy Bebop']),
    $fandom('myheroacademia', 'My Hero Academia Wiki', ['My Hero Academia']),
    $fandom('conan', 'Conan Wiki', ['Conan']),
    $fandom('runequest-glorantha', 'RuneQuest Glorantha Wiki', ['Glorantha']),
    $fandom('forgottenrealms', 'Forgotten Realms Wiki', ['Forgotten Realms', 'Spelljammer', 'Greyhawk', 'Dark Sun']),
    $fandom('darksun', 'Dark Sun Wiki', ['Dark Sun']),
    $fandom('lovecraft', 'H.P. Lovecraft Wiki', ['Call of Cthulhu']),
    $fandom('spelljammer', 'Spelljammer Wiki', ['Spelljammer']),
    $fandom('blades-in-the-dark', 'Blades In The Dark Wiki', ['Blades in the Dark']),
    $fandom('deadlands', 'Deadlands Wiki', ['Deadlands']),
    $fandom('avp', 'Alien vs. Predator Wiki (Xenopedia)', ['Alien']),
    $fandom('alienanthology', 'Alien Anthology Wiki', ['Alien']),
    $fandom('l5r', 'Legend of the Five Rings Wiki', ['Legend of the Five Rings']),
    $fandom('ironkingdoms', 'Iron Kingdoms Wiki', ['Iron Kingdoms']),
    $fandom('ravenloft', 'Ravenloft Wiki', ['Ravenloft']),
    $fandom('dune', 'Dune Wiki', ['Dune']),
    $fandom('witcher', 'Witcher Wiki', ['The Witcher']),
], 1, 0), [
    'tolkiengateway' => ['name' => 'Tolkien Gateway', 'settings' => ['The One Ring', 'Middle-earth'], 'host' => 'Independent',
        'site' => 'https://tolkiengateway.net/', 'api' => 'https://tolkiengateway.net/w/api.php', 'images' => ['tolkiengateway.net'],
        'license' => ['CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/']],
    'sarna' => ['name' => 'BattleTechWiki (Sarna.net)', 'settings' => ['BattleTech'], 'host' => 'Independent',
        'site' => 'https://www.sarna.net/wiki/Main_Page', 'api' => 'https://www.sarna.net/wiki/api.php', 'images' => ['www.sarna.net', 'cfw.sarna.net'],
        'license' => ['GNU FDL 1.2', 'https://www.gnu.org/licenses/old-licenses/fdl-1.2.html']],
]);
