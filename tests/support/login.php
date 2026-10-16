<?php
/**
 * Test-only sign-in. Runs the same sign_in_identity() as the OAuth callback,
 * with a made-up identity, so the browser tests can cover new, pending,
 * approved, admin and migrated accounts without a real Google or GitHub login.
 *
 *   POST tests/support/login.php  {provider, id, email, name}
 *
 * Refuses unless the config sets 'test_login' => true AND the request comes
 * from this machine. On a real site it is unreachable anyway: .htaccess 404s tests/.
 */
declare(strict_types=1);
require __DIR__ . '/../../api/lib.php';

if (!cfg('test_login', false) || !in_array(client_ip(), ['127.0.0.1', '::1'], true)) json_error(404, 'not_found');
require_method('POST');
$b = json_decode((string) file_get_contents('php://input'), true) ?: [];
$provider = in_array($b['provider'] ?? '', ['google', 'github'], true) ? $b['provider'] : 'google';
$uid = sign_in_identity($provider, [
  'provider_user_id' => (string) ($b['id'] ?? ''),
  'email'  => (string) ($b['email'] ?? ''),
  'name'   => (string) ($b['name'] ?? ''),
  'avatar' => '',
]);
session_login($uid);
json_out(['id' => $uid, 'csrf' => csrf_token()]);
