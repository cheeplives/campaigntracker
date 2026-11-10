<?php
/**
 * Export the whole campaign: every row campaign_copy would carry over (api/index.php's CAMPAIGN_COPY, so a table added
 * there is exported too), as one JSON answer for GMs. static/campaign-export.js turns it into a zip in the browser:
 * campaign.json (this answer, for a program or a later import), Markdown pages to read, and the pictures and files,
 * which the browser fetches one by one through ?a=file.
 *
 * Left out: the members and their accounts (people are named, never identified: user ids become names in `people`),
 * where files are kept on disk, edit history, API keys, panel links and invitations.
 */
declare(strict_types=1);

const CAMPAIGN_EXPORT_FORMAT = 'campaign-chronicle';
const CAMPAIGN_EXPORT_VERSION = 1;
/** Columns that hold a user's id, in any table: their names go in `people`. */
const EXPORT_USER_COLUMNS = ['created_by', 'updated_by', 'user_id', 'owner_id', 'member_id'];

function campaign_export(int $cid): array {
    $pdo = db();
    $c = campaign_row($cid);
    $tables = [];
    $keys = [];        // CAMPAIGN_COPY key => the ids exported, for the tables that hang off them
    $users = [];
    foreach (CAMPAIGN_COPY as $spec) {
        $t = $spec[0];
        $cols = array_column($pdo->query("SHOW COLUMNS FROM `$t`")->fetchAll(), 'Field');
        if (isset($spec['via'])) {
            [$vc, $vm] = $spec['via'];
            if (empty($keys[$vm])) { $tables[$t] = []; continue; }
            $st = $pdo->query("SELECT * FROM `$t` WHERE `$vc` IN (" . implode(',', array_map('intval', $keys[$vm])) . ") ORDER BY `$vc`");
        } else {
            $st = $pdo->prepare("SELECT * FROM `$t` WHERE campaign_id=?" . (in_array('id', $cols, true) ? ' ORDER BY id' : ''));
            $st->execute([$cid]);
        }
        $rows = [];
        foreach ($st->fetchAll() as $r) {
            unset($r['campaign_id'], $r['stored_name']);
            foreach (EXPORT_USER_COLUMNS as $u) if (isset($r[$u])) $users[(int)$r[$u]] = true;
            if (isset($spec['key'], $r['id'])) $keys[$spec['key']][] = (int)$r['id'];
            $rows[] = $r;
        }
        $tables[$t] = $rows;
    }
    $people = [];
    if ($users) {
        $st = $pdo->query('SELECT u.id, ' . user_name_sql() . ' AS name FROM users u WHERE u.id IN (' . implode(',', array_keys($users)) . ')');
        foreach ($st->fetchAll() as $u) $people[(string)$u['id']] = (string)($u['name'] ?? '');
    }
    return [
        'format' => CAMPAIGN_EXPORT_FORMAT,
        'version' => CAMPAIGN_EXPORT_VERSION,
        'exported_at' => gmdate('Y-m-d\TH:i:s\Z'),
        'campaign' => [
            'name' => $c['name'],
            'description' => $c['description'],
            'calendar' => dec($c['calendar_json']),
            'settings' => dec($c['settings_json']),
            'entry_fields' => entry_fields(dec($c['settings_json'])),
            'current_shift' => (int)$c['current_shift'],
            'seed' => $c['seed'],
        ],
        'people' => (object)$people,
        'tables' => $tables,
    ];
}
