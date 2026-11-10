<?php
// Router for the test server (`php -S ... tests/support/router.php`, started by playwright.config.js).
//
// php -S never reads .htaccess, so on its own it would serve the pages with no Content-Security-Policy at all. The
// pages carry no CSP meta tag (a meta CSP stops Chrome's preload scanner, so the 40-odd scripts would load one after
// another instead of together), which leaves the header as the only policy, here as on the live site. So this sends
// the page the same header .htaccess does, read from .htaccess itself so the two can never drift apart, and the suite
// still fails on anything the live policy would block. Everything else is left to php -S as before.
$root = dirname(__DIR__, 2);
$path = rawurldecode((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH));
if (str_ends_with($path, '/')) $path .= 'index.html';
// Only the app's two pages: offline.html stays as php -S serves it, since tests use it as "another site" to frame the
// panel from.
if (!in_array($path, ['/index.html', '/panel.html'], true)) return false;
$file = $root . $path;

$ht = (string) file_get_contents("$root/.htaccess");
// the site-wide policy, and panel.html's own (inside its <Files> block), as .htaccess sets them
preg_match_all('/Header always set Content-Security-Policy "([^"]+)"/', $ht, $m);
$csp = basename($file) === 'panel.html' ? ($m[1][1] ?? null) : ($m[1][0] ?? null);
if ($csp === null) { http_response_code(500); exit('router.php: no Content-Security-Policy found in .htaccess'); }
header("Content-Security-Policy: $csp");
header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: no-cache');
readfile($file);
return true;
