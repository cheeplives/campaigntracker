<?php
/**
 * webhooks.php — a campaign's Discord channels: a GM pastes a channel's webhook address (Discord: Edit Channel →
 * Integrations → Webhooks), and the campaign posts a line there when time passes, an event is added, a clock everyone
 * sees fills, or a session ends. Only what every player may see is ever posted: no secret events, no vague or secret
 * clocks, no GM notes.
 *
 * The address is the channel's password (whoever has it can post there), so it is only ever shown to GMs with its
 * token cut off, and it is left out of campaign copies and exports (it isn't in CAMPAIGN_COPY).
 *
 * Only Discord's own webhook addresses are taken, so the server can't be made to call anywhere else. Lines are queued
 * while the action runs and sent once the answer has gone (webhooks_flush(), at shutdown), so a slow Discord never
 * slows a save; a channel that fails 10 times in a row is switched off until a GM tests it again.
 */
declare(strict_types=1);

/** What a channel can hear about. */
const WEBHOOK_EVENTS = ['time', 'event', 'clock', 'session'];
const WEBHOOKS_PER_CAMPAIGN = 5;
const WEBHOOK_MAX_FAILS = 10;
const WEBHOOK_URL_RE = '~^https://(?:(?:ptb|canary)\.)?discord(?:app)?\.com/api/(?:v\d+/)?webhooks/\d{5,25}/[A-Za-z0-9_-]{20,200}$~';

function webhooks_ready(): bool { return has_table('campaign_webhooks'); }

/** A channel as its list shows it: never the whole address. */
function webhook_out(array $w): array {
    $ev = array_values(array_intersect(WEBHOOK_EVENTS, dec($w['events_json']) ?: []));
    return ['id' => (int)$w['id'], 'label' => $w['label'], 'events' => $ev,
        'address' => preg_replace('~/[^/]+$~', '/…', (string)$w['url']),
        'last_sent_at' => $w['last_sent_at'], 'last_error' => $w['last_error'], 'off' => (int)$w['fails'] >= WEBHOOK_MAX_FAILS];
}

/** Discord reads Markdown and @mentions: neither may come from a campaign's own words. */
function webhook_plain(string $s, int $max = 300): string {
    $s = trim(preg_replace('/\s+/u', ' ', $s));
    if (mb_strlen($s) > $max) $s = mb_substr($s, 0, $max - 1) . '…';
    return preg_replace('/([\\\\*_~`|>#\[\]()@:])/u', '\\\\$1', $s);
}

/** Queue a line for the campaign's channels that listen for $kind. Never throws: a save must not fail over this. */
function webhook_say(int $cid, string $kind, string $line): void {
    try {
        if (!webhooks_ready()) return;
        $GLOBALS['webhook_queue'][] = [$cid, $kind, $line];
        if (count($GLOBALS['webhook_queue']) === 1) register_shutdown_function('webhooks_flush');
    } catch (Throwable $e) {
        error_log('webhook_say failed: ' . $e->getMessage());
    }
}

/** Post one message to one channel; returns '' or what went wrong. */
function webhook_post(string $url, string $content): string {
    $payload = ['username' => "GM's Almanac", 'content' => mb_substr($content, 0, 1900), 'allowed_mentions' => ['parse' => []]];
    $outbox = (string)(((array)cfg('webhooks', []))['test_outbox'] ?? '');
    if ($outbox !== '') {   // the tests read this file instead of Discord
        file_put_contents($outbox, json_encode(['url' => $url] + $payload, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);
        return str_contains($url, 'FAIL') ? 'Discord answered 404' : '';
    }
    $r = http_request('POST', $url, ['headers' => ['Content-Type: application/json'], 'post_fields' => json_encode($payload),
        'connect_timeout' => 2, 'timeout' => 4, 'max_bytes' => 65536]);
    if ($r['status'] >= 200 && $r['status'] < 300) return '';
    return $r['status'] ? "Discord answered {$r['status']}" : 'Discord could not be reached';
}

/** Note how a send went on the channel's row. */
function webhook_mark(int $id, string $error): void {
    if ($error === '') db()->prepare('UPDATE campaign_webhooks SET last_sent_at=CURRENT_TIMESTAMP, last_error=NULL, fails=0 WHERE id=?')->execute([$id]);
    else db()->prepare('UPDATE campaign_webhooks SET last_error=?, fails=fails+1 WHERE id=?')->execute([mb_substr($error, 0, 190), $id]);
}

/** Send what was queued, after the answer has gone out. */
function webhooks_flush(): void {
    $queue = $GLOBALS['webhook_queue'] ?? [];
    $GLOBALS['webhook_queue'] = [];
    if (!$queue) return;
    try {
        if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
        $byCampaign = [];
        foreach ($queue as [$cid, $kind, $line]) $byCampaign[$cid][] = [$kind, $line];
        foreach ($byCampaign as $cid => $lines) {
            $st = db()->prepare('SELECT w.*, c.name AS campaign FROM campaign_webhooks w JOIN campaigns c ON c.id=w.campaign_id WHERE w.campaign_id=? AND w.fails < ?');
            $st->execute([$cid, WEBHOOK_MAX_FAILS]);
            foreach ($st->fetchAll() as $w) {
                $want = dec($w['events_json']) ?: [];
                $mine = array_values(array_unique(array_map(fn($l) => $l[1], array_filter($lines, fn($l) => in_array($l[0], $want, true)))));
                if (!$mine) continue;
                webhook_mark((int)$w['id'], webhook_post((string)$w['url'], '**' . webhook_plain((string)$w['campaign'], 120) . "**\n" . implode("\n", array_slice($mine, 0, 10))));
            }
        }
    } catch (Throwable $e) {
        error_log('webhooks_flush failed: ' . $e->getMessage());
    }
}

/** Answer one of these actions (GMs only, api/actions.php). */
function webhooks_action(string $action): void {
    $cid = cid();
    need_gm($cid);
    if (!webhooks_ready()) {
        if ($action === 'webhooks') out(['ready' => false, 'webhooks' => []]);
        fail('Discord channels need a database update: run install.php (migration 054)', 409);
    }
    $row = function (int $id) use ($cid): array {
        $st = db()->prepare('SELECT * FROM campaign_webhooks WHERE id=? AND campaign_id=?');
        $st->execute([$id, $cid]);
        return $st->fetch() ?: fail('Channel not found', 404);
    };
    switch ($action) {
    case 'webhooks':
        $st = db()->prepare('SELECT * FROM campaign_webhooks WHERE campaign_id=? ORDER BY id');
        $st->execute([$cid]);
        out(['ready' => true, 'webhooks' => array_map('webhook_out', $st->fetchAll())]);

    case 'webhook_save':
        // A new channel (url needed), or a change to one's label and what it hears (its address stays unless one is sent).
        $id = p('id') ? int_in(p('id'), 1) : null;
        $old = $id ? $row($id) : null;
        $url = trim((string)str_in(p('url'), 400, false));
        if ($url === '' && !$old) fail('Paste the channel\'s webhook address');
        if ($url !== '' && !preg_match(WEBHOOK_URL_RE, $url)) fail('That isn\'t a Discord webhook address. In Discord: Edit Channel → Integrations → Webhooks → Copy Webhook URL');
        $label = trim((string)str_in(p('label'), 80, false)) ?: 'Discord';
        $events = array_values(array_intersect(WEBHOOK_EVENTS, is_array(p('events')) ? p('events') : WEBHOOK_EVENTS));
        if (!$events) fail('Pick at least one thing to post');
        if ($old) {
            db()->prepare('UPDATE campaign_webhooks SET label=?, events_json=?, url=?, fails=IF(?, 0, fails) WHERE id=?')
                ->execute([$label, json_encode($events), $url !== '' ? $url : $old['url'], $url !== '' ? 1 : 0, $id]);
        } else {
            $st = db()->prepare('SELECT COUNT(*) FROM campaign_webhooks WHERE campaign_id=?');
            $st->execute([$cid]);
            if ((int)$st->fetchColumn() >= WEBHOOKS_PER_CAMPAIGN) fail('A campaign can post to ' . WEBHOOKS_PER_CAMPAIGN . ' channels. Remove one first');
            db()->prepare('INSERT INTO campaign_webhooks (campaign_id, label, url, events_json, created_by) VALUES (?,?,?,?,?)')
                ->execute([$cid, $label, $url, json_encode($events), me()['id']]);
            $id = (int)db()->lastInsertId();
        }
        out(['ok' => true, 'webhook' => webhook_out($row($id))]);

    case 'webhook_test':
        // Post a line now and say how it went; a channel that was switched off comes back on when it works.
        $w = $row(int_in(p('id'), 1));
        rate_limit('webhook_test', 'c' . $cid, 10, 60);
        $err = webhook_post((string)$w['url'], '**' . webhook_plain((string)campaign_row($cid)['name'], 120) . "**\nThis channel now hears from GM's Almanac.");
        webhook_mark((int)$w['id'], $err);
        if ($err !== '') fail("$err. Check the address, or make a new webhook in Discord", 502);
        out(['ok' => true, 'webhook' => webhook_out($row((int)$w['id']))]);

    case 'webhook_delete':
        $w = $row(int_in(p('id'), 1));
        db()->prepare('DELETE FROM campaign_webhooks WHERE id=?')->execute([$w['id']]);
        out(['ok' => true]);
    }
}
