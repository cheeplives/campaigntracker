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
}

function db_has_table(PDO $pdo, string $table): bool {
    return (bool)$pdo->query("SHOW TABLES LIKE " . $pdo->quote($table))->fetchColumn();
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
            'Added the Encyclopedia tab and the Proper Noun Detector.'],
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
    ];
}

/** Tables db/schema.sql creates, so a fresh or partly made database can be spotted without running it. */
function schema_tables(string $root): array {
    preg_match_all('/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/i', (string)file_get_contents("$root/db/schema.sql"), $m);
    return $m[1];
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
                    . 'Sign in, then enter each player\'s email under Users so their first sign-in takes over their old account.';
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
