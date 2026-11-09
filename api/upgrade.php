<?php
/**
 * upgrade.php — brings the database up to date: creates the tables on a fresh database, or runs the files in
 * db/migrations/ an older install still needs. Shared by tools/migrate.php (which deploy.sh runs after every pull)
 * and install.php. Defines functions only; api/.htaccess refuses it from the web.
 *
 * Each step looks at the database itself (a missing table or column) to decide whether its migration is needed, so
 * running it again is harmless, and an install that ran a migration by hand with mysql is not run twice.
 *
 * A new migration: add db/migrations/NNN_name.sql, make db/schema.sql create the same tables for fresh installs, and
 * add a step to upgrade_steps() below that says how to tell it hasn't run yet.
 */
declare(strict_types=1);

/** Run a .sql file statement by statement, skipping comment-only chunks. */
function run_sql_file(PDO $pdo, string $file): void {
    $sql = file_get_contents($file);
    if ($sql === false) throw new RuntimeException("Can't read $file");
    foreach (array_filter(array_map('trim', preg_split('/;\s*\n/', $sql))) as $stmt) {
        if (preg_match('/^\s*(--.*\n\s*)*(--.*)?$/', $stmt)) continue;
        $pdo->exec($stmt);
    }
    db_tables($pdo, true);   // it may have made a table
}

/** The database's tables, from one SHOW TABLES per connection per request: schema_current() runs on every API request,
 * and lib.php's has_table() asks the same question, so the list is read once and shared. run_sql_file() refreshes it,
 * since a migration or schema.sql may have just made a table. */
function db_tables(PDO $pdo, bool $fresh = false): array {
    static $cache = [];
    $k = spl_object_id($pdo);
    if ($fresh || !isset($cache[$k])) $cache[$k] = array_flip($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN));
    return $cache[$k];
}

function db_has_table(PDO $pdo, string $table): bool {
    return isset(db_tables($pdo)[$table]);
}

function db_has_column(PDO $pdo, string $table, string $column): bool {
    return db_has_table($pdo, $table)
        && (bool)$pdo->query("SHOW COLUMNS FROM `$table` LIKE " . $pdo->quote($column))->fetchColumn();
}

/** The migrations that run after the tables exist, in order: [file in db/migrations/, is it needed?, what it did]. */
function upgrade_steps(): array {
    return [
        // Event shift ranges and tags. schema.sql already made the new tables,
        // so on an older install this only adds the events.shift_end column.
        ['002_event_shifts_tags.sql', fn(PDO $p) => !db_has_column($p, 'events', 'shift_end'),
            'Events now have Shift Start/End and tags; existing events are unchanged.'],
        // schema.sql only creates missing tables, so columns added later come from their migration.
        ['003_shift_notes_characters.sql', fn(PDO $p) => !db_has_column($p, 'campaign_members', 'character_name'),
            'Added character names and shift notes.'],
        ['004_day_locations.sql', fn(PDO $p) => !db_has_column($p, 'days', 'locations'),
            'Days now have a Locations visited box.'],
        ['005_downtime.sql', fn(PDO $p) => !db_has_table($p, 'downtimes'), 'Added the Downtime tab.'],
        ['006_party_holdings.sql', fn(PDO $p) => !db_has_table($p, 'holdings'), 'Added the Party Holdings tab.'],
        ['007_reminders.sql', fn(PDO $p) => !db_has_table($p, 'reminder_dismissals'), 'Added calendar reminders.'],
        ['008_party_funds.sql', fn(PDO $p) => !db_has_table($p, 'party_funds'), 'Added Party Funds.'],
        ['009_party_funds_location.sql', fn(PDO $p) => !db_has_column($p, 'party_funds', 'location'),
            'Party Funds now have a Location.'],
        ['010_day_notes_rich_text.sql', fn(PDO $p) => !db_has_column($p, 'days', 'notes_format'),
            'Day notes can now be formatted (Public and Secret notes).'],
        ['011_encyclopedia.sql', fn(PDO $p) => !db_has_table($p, 'encyclopedia_ignored'),
            'Added the Encyclopedia tab and the Feature Highlighter.'],
        ['012_encyclopedia_relations.sql', fn(PDO $p) => !db_has_table($p, 'encyclopedia_relations'),
            'Encyclopedia entries can now be connected to each other.'],
        ['013_attachments.sql', fn(PDO $p) => !db_has_table($p, 'attachments'),
            'Encyclopedia entries can now have pictures and files.'],
        ['014_library.sql', fn(PDO $p) => !db_has_table($p, 'library_tomes'),
            'Added the Library tab for books, journals and notes.'],
        ['015_sessions.sql', fn(PDO $p) => !db_has_table($p, 'play_sessions'), 'Added the Sessions tab.'],
        ['016_session_rewards.sql', fn(PDO $p) => db_has_table($p, 'play_sessions') && !db_has_column($p, 'play_sessions', 'rewards'),
            'Sessions can now record Session Rewards and Loot Found.'],
        ['017_attachment_credits.sql', fn(PDO $p) => db_has_table($p, 'attachments') && !db_has_column($p, 'attachments', 'credit_license'),
            'Encyclopedia entries can now find pictures with Find Image, credited, or embedded from DeviantArt.'],
        ['018_encyclopedia_categories.sql', fn(PDO $p) => db_has_table($p, 'encyclopedia_entries') && !db_has_column($p, 'encyclopedia_entries', 'category'),
            'Encyclopedia entries now have a Category; entries tagged Location, Person, Item, Group or Vehicle were given it.'],
        // Maps: party_groups is its last table, so a run that stopped part way is made good (every statement is IF NOT EXISTS).
        ['019_maps.sql', fn(PDO $p) => !db_has_table($p, 'party_groups'), 'Maps are ready.'],
        ['021_map_grid.sql', fn(PDO $p) => db_has_table($p, 'maps') && !db_has_column($p, 'maps', 'grid_type'),
            'Maps can now show a square or hex grid.'],
        ['022_panel_links.sql', fn(PDO $p) => !db_has_table($p, 'connection_keys'),
            'Added panel links, for showing At the Table inside a virtual tabletop or on a stream.'],
        ['023_character_sheets.sql', fn(PDO $p) => !db_has_column($p, 'campaign_members', 'active_character_id'),
            'Added character sheets and the template library.'],
        ['024_map_styles.sql', fn(PDO $p) => db_has_table($p, 'map_pins') && !db_has_column($p, 'map_pins', 'icon'),
            'Map pins can now have their own icon and colour and be locked, and routes their own colour and line.'],
        ['025_versions_invites.sql', fn(PDO $p) => db_has_table($p, 'encyclopedia_entries') && !db_has_column($p, 'encyclopedia_entries', 'version'),
            'Encyclopedia entries and day notes now refuse a save from an older copy, and GMs can invite people by email before they have an account.'],
        ['026_session_notes_text.sql', fn(PDO $p) => db_has_table($p, 'play_sessions') && !db_has_column($p, 'play_sessions', 'notes_text'),
            'A session\'s notes are now one text box that saves as you type; each session\'s notes go into it when it is next opened.'],
        ['027_session_shifts_party_trail.sql', fn(PDO $p) => db_has_table($p, 'play_sessions') && !db_has_column($p, 'play_sessions', 'first_shift'),
            'Sessions now remember the shift they started and ended on, and the party leaves a trail on the maps as you move it.'],
        ['028_session_extra_shifts.sql', fn(PDO $p) => db_has_table($p, 'play_sessions') && !db_has_table($p, 'session_shifts'),
            'A session can now take in shifts outside its one run, such as a flashback or a split party played another night.'],
        ['029_session_undated.sql', fn(PDO $p) => db_has_table($p, 'play_sessions') && !db_has_column($p, 'play_sessions', 'undated'),
            'Sessions imported from Scabard no longer sit on the day of the import: they have no in-game dates, so the shifts of that day stop showing them all.'],
        ['030_clocks.sql', fn(PDO $p) => !db_has_table($p, 'clock_ticks'), 'Added Clocks, for the GM and players to track what is coming.'],
        ['031_map_nesting.sql', fn(PDO $p) => db_has_table($p, 'map_pins') && !db_has_column($p, 'map_pins', 'child_map_id'),
            'A map pin can now open another map, so a town on the region map opens the town\'s own map.'],
        ['032_shift_actions.sql', fn(PDO $p) => !db_has_table($p, 'shift_actions'),
            'At the Table now has an action for each player and one for the party on every shift, listed on the session\'s page.'],
        ['033_party_characters.sql', fn(PDO $p) => db_has_table($p, 'sheet_characters') && !db_has_column($p, 'sheet_characters', 'party_group_id'),
            'A character with no player can now travel with the party, and every character\'s Encyclopedia entry is tagged PC or NPC.'],
        ['034_party_out.sql', fn(PDO $p) => db_has_table($p, 'sheet_characters') && !db_has_column($p, 'sheet_characters', 'party_out'),
            'A GM can now take a player\'s character out of the party, and put it back, with Travels with the party on its sheet.'],
        ['035_route_terrain.sql', fn(PDO $p) => db_has_table($p, 'map_routes') && !db_has_column($p, 'map_routes', 'terrain_json'),
            'A saved route can now have a terrain for each leg, which Plan this trip takes into the travel time.'],
        ['036_user_profiles.sql', fn(PDO $p) => !db_has_table($p, 'user_profiles'),
            'Everyone can now set the name and pronouns Chronicle calls them by on their Account page.'],
        ['037_game_requests.sql', fn(PDO $p) => !db_has_table($p, 'game_requests'),
            'Sheet templates now has Request a game, and Site Admin a Sheets tab listing what people asked for, with a switch to turn requests off.'],
        ['038_dice_rolls.sql', fn(PDO $p) => !db_has_table($p, 'dice_rolls'),
            'Added the die roller: the 🎲 button on every campaign page, with a roll log the table shares.'],
        ['039_content_versions.sql', fn(PDO $p) => !db_has_table($p, 'content_versions'),
            'Entries, tomes, session notes and day notes now keep their earlier versions, for a GM to read, compare and restore.'],
        ['040_site_reports.sql', fn(PDO $p) => !db_has_table($p, 'site_reports'),
            'Added the Report (!) button to the top bar, and a Reports tab on Site Admin to read, resolve, send to GitHub or delete what people report.'],
        ['041_shift_action_characters.sql', fn(PDO $p) => db_has_table($p, 'shift_actions') && !db_has_column($p, 'shift_actions', 'character_id'),
            'Characters with no player who travel with the party now get their own action on every shift At the Table.'],
        ['042_pip_caps.sql', fn(PDO $p) => db_has_table($p, 'sheet_characters') && !db_has_column($p, 'sheet_characters', 'pip_caps'),
            'A character sheet\'s dot and box tracks can now have the character\'s own maximum: the dots past it are greyed out and can\'t be ticked.'],
        ['043_character_portraits.sql', fn(PDO $p) => db_has_table($p, 'sheet_characters') && !db_has_column($p, 'sheet_characters', 'portrait_id'),
            'A character can now have a portrait, picked or uploaded on its sheet and shown on its card, its sheet and its Play view.'],
    ];
}

/** Tables db/schema.sql creates, so a fresh or partly made database can be spotted without running it. */
function schema_tables(string $root): array {
    static $cache = [];
    if (!isset($cache[$root])) {
        preg_match_all('/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/i', (string)file_get_contents("$root/db/schema.sql"), $m);
        $cache[$root] = $m[1];
    }
    return $cache[$root];
}

/**
 * Whether the database is at the latest migration, cheaply enough to ask on every API request (api/index.php refuses
 * to run anything on a database that is behind): every table db/schema.sql makes is there, from the one SHOW TABLES
 * the request shares (db_tables), and the newest step above has nothing left to do. The steps run in order, so the
 * newest stands for them all.
 */
function schema_current(PDO $pdo, string $root): bool {
    $have = db_tables($pdo);
    foreach (schema_tables($root) as $t) if (!isset($have[$t])) return false;
    $steps = upgrade_steps();
    return !end($steps)[1]($pdo);
}

/**
 * What upgrade_database() would run, without changing anything: a list of file names ('schema.sql' or a migration).
 * On a database with tables missing it stops after schema.sql, as the later checks need those tables to exist.
 */
function pending_upgrades(PDO $pdo, string $root): array {
    $hasUsers = db_has_table($pdo, 'users');
    if ($hasUsers && db_has_column($pdo, 'users', 'password_hash')) return ['001_oauth_signin.sql', '…and whatever follows it'];
    $missing = array_filter(schema_tables($root), fn($t) => !db_has_table($pdo, $t));
    $access = $hasUsers && !db_has_table($pdo, 'chronicle_access') ? ['020_chronicle_access.sql'] : [];
    if ($missing) return array_merge(['schema.sql'], $access);
    $out = [];
    foreach (upgrade_steps() as [$file, $needed]) {
        if (is_file("$root/db/migrations/$file") && $needed($pdo)) $out[] = $file;
    }
    return array_merge($out, $access);
}

/**
 * Create or upgrade the tables. Returns what was done, one sentence per step (empty when it was already up to date).
 * Takes a MySQL lock first, so a deploy and someone on install.php can't run the same migration twice at once.
 * Throws on any failure; the steps that already ran stay done, and the next run carries on from there.
 */
function upgrade_database(PDO $pdo, string $root): array {
    if ((int)$pdo->query("SELECT GET_LOCK('chronicle_upgrade', 0)")->fetchColumn() !== 1)
        throw new RuntimeException('Another upgrade is running right now. Try again in a minute.');
    try {
        $done = [];
        $hasUsers = db_has_table($pdo, 'users');
        $oldUsers = $hasUsers && db_has_column($pdo, 'users', 'password_hash');
        // Asked before schema.sql runs, since it creates chronicle_access empty: an install with accounts already needs 020
        // to carry their access over.
        $needAccess = $hasUsers && !db_has_table($pdo, 'chronicle_access');
        if ($oldUsers) {
            run_sql_file($pdo, "$root/db/migrations/001_oauth_signin.sql");
            $done[] = 'Upgraded to Google/GitHub sign-in. Existing accounts kept their campaigns. '
                    . 'Sign in, then enter each player\'s email under Site Admin so their first sign-in takes over their old account.';
        } elseif (array_filter(schema_tables($root), fn($t) => !db_has_table($pdo, $t))) {
            run_sql_file($pdo, "$root/db/schema.sql");
            $done[] = $hasUsers ? 'Added the new tables.' : 'Tables are ready.';
        }
        foreach (upgrade_steps() as [$file, $needed, $what]) {
            // A step whose file isn't in this copy of the code yet (one being written on another branch) is left for later.
            if (!is_file("$root/db/migrations/$file") || !$needed($pdo)) continue;
            run_sql_file($pdo, "$root/db/migrations/$file");
            $done[] = $what;
        }
        if ($needAccess) {
            run_sql_file($pdo, "$root/db/migrations/020_chronicle_access.sql");
            $done[] = 'Campaign Chronicle now approves its own users, apart from Sinless; everyone kept the access they had.';
        }
        return $done;
    } finally {
        $pdo->query("SELECT RELEASE_LOCK('chronicle_upgrade')");
    }
}
