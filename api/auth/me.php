<?php
/**
 * me.php — the client's auth probe (same contract as Sinless).
 *   200 {user fields + csrf}   when signed in (any status: the client shows the
 *                              waiting screen for pending/revoked accounts)
 *   401 {error, providers[]}   when signed out (providers = which buttons to show)
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_method('GET');

$u = current_user();
if (!$u) {
  json_out(['error' => 'not_authenticated', 'providers' => configured_providers()], 401);
}

/** Per-user display preferences (units, colour theme). */
$st = db()->prepare('SELECT prefs_json FROM user_prefs WHERE user_id = ?');
$st->execute([$u['id']]);
$prefs = json_decode((string) ($st->fetchColumn() ?: ''), true);

json_out([
  'id'       => (int) $u['id'],
  'email'    => $u['email'],
  'name'     => $u['display_name'],
  'avatar'   => $u['avatar_url'],
  'status'   => $u['status'],       // pending | approved | revoked
  'is_admin' => (bool) (int) $u['is_admin'],
  'prefs'    => (object) (is_array($prefs) ? $prefs : []),
  'csrf'     => csrf_token(),
]);
