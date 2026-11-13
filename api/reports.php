<?php
/**
 * reports.php — the Report (!) button in the top bar, and Site Admin's Reports tab.
 *
 * Anyone signed in can report a problem with the site: what they wrote, the page they were on, what the page gathered
 * by itself (build, browser, screen, the campaign open, its recent errors and failed requests) and, if they kept it, a
 * screenshot of the page. Only site admins read them. Each one can be resolved without a fix ("Resolve unfixed"), sent
 * to GitHub as an issue, reopened or deleted.
 *
 * Send to GitHub: with github_reports.token in the config the server opens the issue itself, through GitHub's REST API,
 * and keeps its address. Without one it hands back a github.com "new issue" address with the title and text filled in,
 * which the admin's browser opens for them to check and submit. Either way the issue leaves out who sent the report
 * and the screenshot (a public repository's issues are public): it names the report's number on Site Admin instead.
 */

const REPORT_SHOT_MAX = 1_500_000;          // bytes of picture, after decoding
const REPORT_TYPES = ['image/jpeg' => "\xFF\xD8\xFF", 'image/png' => "\x89PNG\r\n\x1A\n"];
const REPORT_STATUSES = ['open', 'resolved', 'github'];

function github_reports_cfg(): array {
    $c = (array)cfg('github_reports', []);
    $repo = trim((string)($c['repo'] ?? 'cheeplives/campaigntracker'));
    return ['repo' => preg_match('~^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$~', $repo) ? $repo : '',
        'token' => trim((string)($c['token'] ?? '')), 'labels' => array_values(array_filter((array)($c['labels'] ?? ['bug']), 'is_string')),
        'stub' => (string)($c['stub'] ?? '')];
}

/** The page's own details, kept to plain values and a sane size: nothing it sends is trusted further than that. */
function report_context($v): string {
    if (!is_array($v)) return '{}';
    $s = json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    if ($s === false || strlen($s) > 60_000) fail('Too much detail sent with the report');
    return $s;
}
/** A data: URL screenshot as [bytes, mime], or [null, null] when none was kept. */
function report_shot($v): array {
    if ($v === null || $v === '') return [null, null];
    if (!is_string($v) || !preg_match('~^data:(image/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$~', $v, $m)) fail('That screenshot is not a picture');
    $bytes = base64_decode($m[2], true);
    if ($bytes === false || $bytes === '') fail('That screenshot is not a picture');
    if (strlen($bytes) > REPORT_SHOT_MAX) fail('That screenshot is too large. Send the report without it', 413);
    if (!str_starts_with($bytes, REPORT_TYPES[$m[1]])) fail('That screenshot is not a picture');
    return [$bytes, $m[1]];
}

/** One report for the Reports tab: everything but the picture itself, which report_shot serves. */
function report_row(array $r): array {
    return ['id' => (int)$r['id'], 'message' => $r['message'], 'page' => $r['page'], 'context' => dec($r['context_json']) ?: new stdClass(),
        'has_shot' => (bool)(int)$r['has_shot'], 'status' => $r['status'], 'github_url' => $r['github_url'],
        'user_id' => $r['user_id'] === null ? null : (int)$r['user_id'], 'who' => $r['who'], 'email' => $r['email'],
        'closed_by' => $r['closer'], 'closed_at' => $r['closed_at'], 'created_at' => $r['created_at']];
}
function report_get(int $id): array {
    $st = db()->prepare('SELECT r.id, r.user_id, r.message, r.page, r.context_json, r.shot IS NOT NULL AS has_shot, r.status, r.github_url,
        r.closed_at, r.created_at, ' . user_name_sql('u') . ' AS who, u.email, ' . user_name_sql('c') . ' AS closer
        FROM site_reports r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users c ON c.id = r.closed_by WHERE r.id = ?');
    $st->execute([$id]);
    $r = $st->fetch();
    if (!$r) fail('That report is gone', 404);
    return report_row($r);
}

/** The issue GitHub gets: a title from the first line of the report, and the details that help fix it, not who sent it. */
function report_issue(array $r): array {
    $first = trim((string)strtok(str_replace("\r", '', $r['message']), "\n"));
    $title = 'Report: ' . (mb_strlen($first) > 80 ? rtrim(mb_substr($first, 0, 79)) . '…' : $first);
    $c = (array)$r['context'];
    $line = fn(string $k, $v) => $v === null || $v === '' || $v === [] ? null : "- **$k:** " . (is_scalar($v) ? (string)$v : json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    $page = preg_replace('~^https?://[^/#]+~i', '', (string)$r['page']);   // the address on this site, not the site's host
    $details = array_filter([
        $line('Page', $page), $line('Build', $c['build'] ?? null), $line('Browser', $c['browser'] ?? null),
        $line('Screen', $c['screen'] ?? null), $line('Theme', $c['theme'] ?? null),
        $line('Campaign role', is_array($c['campaign'] ?? null) ? ($c['campaign']['role'] ?? null) : null), $line('Online', isset($c['online']) ? ($c['online'] ? 'yes' : 'no') : null),
        $line('Reported', $r['created_at'] . ' (server time)'),
    ]);
    $quote = implode("\n", array_map(fn($l) => '> ' . $l, explode("\n", str_replace("\r", '', $r['message']))));
    $body = "Reported with the Report button in GM's Almanac (Site Admin, Reports, #{$r['id']}"
        . ($r['has_shot'] ? ', with a screenshot there' : '') . ").\n\n$quote\n\n### Details\n" . implode("\n", $details);
    $list = function (string $k, string $head) use ($c): string {
        $items = array_slice(array_values(array_filter((array)($c[$k] ?? []), 'is_array')), -10);
        if (!$items) return '';
        return "\n\n### $head\n```\n" . implode("\n", array_map(fn($e) => mb_substr(implode(' · ', array_map(
            fn($x) => is_scalar($x) ? (string)$x : json_encode($x, JSON_UNESCAPED_UNICODE), array_values($e))), 0, 400), $items)) . "\n```";
    };
    $body .= $list('errors', 'Recent errors in the page') . $list('requests', 'Recent failed requests');
    return ['title' => $title, 'body' => mb_substr($body, 0, 6000)];
}

function reports_action(string $action): void {
    $me = me();
    switch ($action) {
        case 'report_send': // anyone signed in: message, page, context {…}, shot (data: URL, optional)
            $message = trim((string)str_in(p('message'), 5000, false));
            if (mb_strlen($message) < 3) fail('Say what went wrong');
            $page = (string)str_in(p('page'), 500);
            [$shot, $mime] = report_shot(p('shot'));
            $context = report_context(p('context', []));
            rate_limit('report', (string)$me['id'], 20, 86400, 1, 'That is a lot of reports for one day. Thank you! Try again tomorrow');
            db()->prepare('INSERT INTO site_reports (user_id, message, page, context_json, shot, shot_mime) VALUES (?,?,?,?,?,?)')
                ->execute([$me['id'], $message, $page, $context, $shot, $mime]);
            out(['ok' => true, 'id' => (int)db()->lastInsertId()]);

        case 'reports': // site admins: status (open | resolved | github | all), newest first
            $status = (string)($_GET['status'] ?? 'open');
            $where = in_array($status, REPORT_STATUSES, true) ? 'WHERE r.status = ?' : '';
            $st = db()->prepare('SELECT r.id, r.user_id, r.message, r.page, r.context_json, r.shot IS NOT NULL AS has_shot, r.status, r.github_url,
                r.closed_at, r.created_at, ' . user_name_sql('u') . ' AS who, u.email, ' . user_name_sql('c') . ' AS closer
                FROM site_reports r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users c ON c.id = r.closed_by ' . $where . '
                ORDER BY r.created_at DESC, r.id DESC LIMIT 200');
            $st->execute($where ? [$status] : []);
            $counts = db()->query('SELECT status, COUNT(*) FROM site_reports GROUP BY status')->fetchAll(PDO::FETCH_KEY_PAIR);
            $gh = github_reports_cfg();
            out(['reports' => array_map('report_row', $st->fetchAll()),
                'counts' => array_map('intval', array_merge(array_fill_keys(REPORT_STATUSES, 0), $counts)),
                'github' => ['repo' => $gh['repo'], 'direct' => $gh['repo'] !== '' && $gh['token'] !== '']]);

        case 'report_shot': // site admins: id; the screenshot itself
            $st = db()->prepare('SELECT shot, shot_mime FROM site_reports WHERE id = ?');
            $st->execute([int_in($_GET['id'] ?? 0, 1)]);
            $r = $st->fetch();
            if (!$r || $r['shot'] === null || !isset(REPORT_TYPES[$r['shot_mime']])) fail('No screenshot', 404);
            header('Content-Type: ' . $r['shot_mime']);
            header('Content-Length: ' . strlen($r['shot']));
            header('Cache-Control: private, max-age=3600');
            header('Content-Disposition: inline; filename="report-' . (int)$_GET['id'] . ($r['shot_mime'] === 'image/png' ? '.png' : '.jpg') . '"');
            header("Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
            header('Cross-Origin-Resource-Policy: same-origin');
            header('X-Content-Type-Options: nosniff');
            echo $r['shot'];
            exit;

        case 'report_status': // site admins: id, status (open | resolved)
            $id = int_in(p('id'), 1);
            $status = (string)p('status');
            if (!in_array($status, ['open', 'resolved'], true)) fail('A report can be reopened or resolved here');
            report_get($id);
            db()->prepare('UPDATE site_reports SET status = ?, closed_by = ?, closed_at = ' . ($status === 'open' ? 'NULL' : 'NOW()') . ' WHERE id = ?')
                ->execute([$status, $status === 'open' ? null : $me['id'], $id]);
            out(['ok' => true, 'report' => report_get($id)]);

        case 'report_github': // site admins: id. Opens the issue (with a token) or hands back the address to open it at.
            $id = int_in(p('id'), 1);
            $r = report_get($id);
            $gh = github_reports_cfg();
            if ($gh['repo'] === '') fail('Set github_reports.repo in the server config to the repository issues go to (owner/name)');
            $issue = report_issue($r);
            if ($gh['token'] === '') {
                // No token: the admin's browser opens GitHub's new issue page filled in, and they press Submit there.
                $url = "https://github.com/{$gh['repo']}/issues/new?" . http_build_query(array_filter([
                    'title' => $issue['title'], 'body' => $issue['body'], 'labels' => implode(',', $gh['labels'])]), '', '&', PHP_QUERY_RFC3986);
                db()->prepare("UPDATE site_reports SET status = 'github', closed_by = ?, closed_at = NOW() WHERE id = ?")->execute([$me['id'], $id]);
                out(['ok' => true, 'open' => $url, 'report' => report_get($id)]);
            }
            $payload = json_encode(['title' => $issue['title'], 'body' => $issue['body'], 'labels' => $gh['labels']], JSON_UNESCAPED_UNICODE);
            $opts = ['post_fields' => $payload, 'timeout' => 15, 'headers' => ['Accept: application/vnd.github+json', 'Content-Type: application/json',
                'Authorization: Bearer ' . $gh['token'], 'X-GitHub-Api-Version: 2022-11-28', 'User-Agent: GMsAlmanac/1.0']];
            $url = "https://api.github.com/repos/{$gh['repo']}/issues";
            $res = $gh['stub'] !== '' ? (require $gh['stub'])('POST', $url, $opts) : http_request('POST', $url, $opts);
            $made = json_decode($res['body'], true);
            $link = is_array($made) ? (string)($made['html_url'] ?? '') : '';
            if ($res['status'] !== 201 || !preg_match('~^https://github\.com/~', $link)) {
                error_log("report_github: GitHub answered {$res['status']} {$res['error']}");
                fail('GitHub did not take the issue (' . ($res['error'] !== '' ? $res['error'] : "HTTP {$res['status']}") . '). Check github_reports.token can write issues on ' . $gh['repo'], 502);
            }
            db()->prepare("UPDATE site_reports SET status = 'github', github_url = ?, closed_by = ?, closed_at = NOW() WHERE id = ?")
                ->execute([mb_substr($link, 0, 300), $me['id'], $id]);
            out(['ok' => true, 'report' => report_get($id)]);

        case 'report_github_link': // site admins: id, url. The issue's address, pasted after submitting it on GitHub.
            $id = int_in(p('id'), 1);
            report_get($id);
            $link = trim((string)str_in(p('url'), 300));
            if ($link !== '' && !preg_match('~^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\d+$~', $link)) fail('Paste the issue\'s address, like https://github.com/owner/repo/issues/12');
            db()->prepare('UPDATE site_reports SET github_url = ? WHERE id = ?')->execute([$link === '' ? null : $link, $id]);
            out(['ok' => true, 'report' => report_get($id)]);

        case 'report_delete': // site admins: id
            $st = db()->prepare('DELETE FROM site_reports WHERE id = ?');
            $st->execute([int_in(p('id'), 1)]);
            out(['ok' => true, 'deleted' => $st->rowCount()]);
    }
}
