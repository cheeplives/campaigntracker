<?php
/**
 * callback.php — OAuth redirect target. Verifies `state`, exchanges the code for
 * a token over TLS-verified cURL, fetches the (verified) email + profile, upserts
 * the user, establishes the session, and redirects back into the app.
 *
 * See sign_in_identity() in lib.php for how the user row is found, claimed
 * from a pre-OAuth account, or created (pending unless in admin_identities).
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

/** How long a sign-in started in api/auth/login.php may take to come back, in seconds. */
const OAUTH_STATE_TTL = 600;

require_method('GET');
rate_limit('callback', client_ip(), 30, 300);   // 30 callbacks / 5 min / IP

function auth_fail(string $reason): void {
  // Part of the reason can come from the query string: keep it short and on one line, so nobody can forge log lines.
  $reason = substr((string) preg_replace('/[\x00-\x1F\x7F]+/', ' ', $reason), 0, 200);
  error_log('oauth callback failed: ' . $reason);
  // Return to the app (which reads ?auth_error and shows a retry message), using
  // the configured base_url so this works under a subpath (e.g. /chronicle/).
  header('Location: ' . rtrim((string) cfg('base_url'), '/') . '/?auth_error=1', true, 302);
  exit;
}

// The provider may bounce back an error (user declined, etc.).
if (isset($_GET['error'])) auth_fail('provider_error:' . (string) $_GET['error']);

// --- verify state (one-time, constant-time) --------------------------------
$sess = $_SESSION['oauth'] ?? null;
unset($_SESSION['oauth']);                 // single use, regardless of outcome
$state = (string) ($_GET['state'] ?? '');
$code  = (string) ($_GET['code'] ?? '');
if (!$sess || $code === '' || $state === '' || !hash_equals((string) $sess['state'], $state)) {
  auth_fail('bad_state');
}
// A sign-in is finished within minutes; an old state is one left in a session, not someone signing in now.
if (time() - (int) ($sess['ts'] ?? 0) > OAUTH_STATE_TTL) auth_fail('expired_state');
$provider = (string) $sess['provider'];
$oauth = cfg('oauth', []);
if (empty($oauth[$provider]['client_id'])) auth_fail('provider_unconfigured');

$redirectUri = rtrim((string) cfg('base_url'), '/') . '/api/auth/callback.php';
$clientId     = $oauth[$provider]['client_id'];
$clientSecret = $oauth[$provider]['client_secret'];

// --- exchange code -> access token (TLS verified) --------------------------
$identity = null;   // ['provider_user_id','email','name','avatar']

if ($provider === 'google') {
  $tok = http_request('POST', 'https://oauth2.googleapis.com/token', [
    'headers'     => ['Content-Type: application/x-www-form-urlencoded'],
    'post_fields' => http_build_query([
      'code' => $code, 'client_id' => $clientId, 'client_secret' => $clientSecret,
      'redirect_uri' => $redirectUri, 'grant_type' => 'authorization_code',
    ]),
  ]);
  if ($tok['status'] !== 200) auth_fail('google_token:' . $tok['status']);
  $access = json_decode($tok['body'], true)['access_token'] ?? '';
  if (!$access) auth_fail('google_no_token');

  $ui = http_request('GET', 'https://openidconnect.googleapis.com/v1/userinfo', [
    'headers' => ['Authorization: Bearer ' . $access],
  ]);
  if ($ui['status'] !== 200) auth_fail('google_userinfo:' . $ui['status']);
  $p = json_decode($ui['body'], true) ?: [];
  if (empty($p['sub'])) auth_fail('google_no_sub');
  if (empty($p['email']) || ($p['email_verified'] ?? false) !== true) auth_fail('google_email_unverified');
  $identity = [
    'provider_user_id' => (string) $p['sub'],
    'email'  => (string) $p['email'],
    'name'   => (string) ($p['name'] ?? ''),
    'avatar' => (string) ($p['picture'] ?? ''),
  ];

} else { // github
  $tok = http_request('POST', 'https://github.com/login/oauth/access_token', [
    'headers'     => ['Accept: application/json', 'Content-Type: application/x-www-form-urlencoded'],
    'post_fields' => http_build_query([
      'code' => $code, 'client_id' => $clientId, 'client_secret' => $clientSecret,
      'redirect_uri' => $redirectUri,
    ]),
  ]);
  if ($tok['status'] !== 200) auth_fail('github_token:' . $tok['status']);
  $access = json_decode($tok['body'], true)['access_token'] ?? '';
  if (!$access) auth_fail('github_no_token');

  $ghHeaders = [
    'Authorization: Bearer ' . $access,
    'Accept: application/vnd.github+json',
    'User-Agent: campaign-chronicle',                 // GitHub requires a UA
  ];
  $ui = http_request('GET', 'https://api.github.com/user', ['headers' => $ghHeaders]);
  if ($ui['status'] !== 200) auth_fail('github_user:' . $ui['status']);
  $p = json_decode($ui['body'], true) ?: [];
  if (empty($p['id'])) auth_fail('github_no_id');

  // Pick the primary, verified email (the /user email can be null/private).
  $em = http_request('GET', 'https://api.github.com/user/emails', ['headers' => $ghHeaders]);
  $email = '';
  if ($em['status'] === 200) {
    foreach ((json_decode($em['body'], true) ?: []) as $row) {
      if (!empty($row['primary']) && !empty($row['verified'])) { $email = (string) $row['email']; break; }
    }
  }
  if ($email === '') auth_fail('github_email_unverified');
  $identity = [
    'provider_user_id' => (string) $p['id'],
    'email'  => $email,
    'name'   => (string) ($p['name'] ?: ($p['login'] ?? '')),
    'avatar' => (string) ($p['avatar_url'] ?? ''),
  ];
}

// --- find, claim or create the user (shared with the test sign-in) --------
$userId = sign_in_identity($provider, $identity);

// --- establish session + return to the app ---------------------------------
session_login($userId);
header('Location: ' . safe_return_path($sess['return'] ?? ''), true, 302);
exit;
