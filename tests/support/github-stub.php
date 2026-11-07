<?php
// Stands in for GitHub's REST API in the browser tests (config.test.php's github_reports.stub): opening an issue answers
// 201 with a made-up address, numbered from the title's length so a test can tell its issues apart. A title holding
// "GITHUB DOWN" answers 503, for the error path. Each request is added to a log in the temp folder (one JSON line each) for the test to read back.
return function (string $method, string $url, array $opts): array {
    $data = json_decode((string)($opts['post_fields'] ?? ''), true) ?: [];
    file_put_contents(sys_get_temp_dir() . '/chronicle-github-stub.log', json_encode(['method' => $method, 'url' => $url, 'data' => $data]) . "\n", FILE_APPEND | LOCK_EX);
    if (str_contains((string)($data['title'] ?? ''), 'GITHUB DOWN')) return ['status' => 503, 'body' => '{}', 'error' => ''];
    if ($method !== 'POST' || !preg_match('~^https://api\.github\.com/repos/([^/]+/[^/]+)/issues$~', $url, $m)) return ['status' => 404, 'body' => '{}', 'error' => ''];
    $n = 100 + strlen((string)($data['title'] ?? ''));
    return ['status' => 201, 'body' => json_encode(['number' => $n, 'html_url' => "https://github.com/{$m[1]}/issues/$n"]), 'error' => ''];
};
