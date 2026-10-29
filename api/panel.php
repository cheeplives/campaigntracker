<?php
/**
 * panel.php — panel links: how the At the Table panel (panel.html) signs in where Chronicle's own sign-in can't reach.
 *
 * Shown inside a virtual tabletop (an Owlbear Rodeo extension, a Foundry window) or a stream overlay, the panel is in
 * another site's frame: the browser doesn't send Chronicle's SameSite=Lax session cookie there, and Google and GitHub
 * won't sign in inside a frame. So a signed-in member makes a panel link in Chronicle, and the panel sends the link's
 * code in the X-Chronicle-Panel header on every request instead of a cookie:
 *  - scope 'panel': the link acts as the member who made it, seeing what they see (and GM or not as they are now);
 *  - scope 'public_panel': made by a GM, for a stream or a shared screen; it acts as a player with no account,
 *    read-only, so it gets only what every player may see.
 * A link only reaches its own campaign, and only the actions in PANEL_READ (and PANEL_WRITE for a member's own link).
 * The code is shown once; only its SHA-256 is stored. A header, unlike a cookie, is never sent by another site's form
 * or script (no CORS here), so panel requests need no CSRF token.
 */
declare(strict_types=1);

const PANEL_SCOPES = ['panel', 'public_panel'];
/** What any panel link may read. */
const PANEL_READ = ['panel_whoami', 'campaign', 'changed', 'days', 'reminders', 'encyclopedia', 'groups', 'maps', 'map'];
/** What a member's own link may also change; each action still checks GM or player as usual. */
const PANEL_WRITE = ['set_time', 'days_save', 'shift_note_add', 'entry_note_add'];

/** Whether migration 022 has been run. */
function has_panel_links(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW TABLES LIKE 'connection_keys'")->fetchColumn();
}
function need_panel_links(): void {
    if (!has_panel_links()) fail('Panel links need a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}

/** Whether this request came from the panel, with a link code instead of the session. */
function panel_request(): bool {
    return ($_SERVER['HTTP_X_CHRONICLE_PANEL'] ?? '') !== '';
}
/** The link this request signed in with (set by panel_gate()), or null. */
function panel_link(): ?array {
    return $GLOBALS['panel_link'] ?? null;
}
/** Whether this request is a public panel: a player with no account. */
function panel_public(): bool {
    return (panel_link()['scope'] ?? '') === 'public_panel';
}

/**
 * Sign in a panel request by its code, or stop it: an unknown or revoked code, or an action the link may not use, is a
 * 401. Pins the request to the link's campaign, and sets who it acts as for current_user() (api/lib.php).
 */
function panel_gate(string $action): void {
    if (!has_panel_links()) json_error(401, 'bad_panel_link', 'This Chronicle hasn\'t been upgraded for panel links yet.');
    $code = (string)$_SERVER['HTTP_X_CHRONICLE_PANEL'];
    if (!preg_match('/^[0-9a-f]{64}$/', $code)) json_error(401, 'bad_panel_link', 'That panel link isn\'t right. Make a new one in Chronicle.');
    $st = db()->prepare('SELECT * FROM connection_keys WHERE token_hash=? AND revoked_at IS NULL');
    $st->execute([hash('sha256', $code)]);
    $link = $st->fetch();
    if (!$link || !in_array($link['scope'], PANEL_SCOPES, true)) json_error(401, 'bad_panel_link', 'That panel link was revoked, or never existed. Make a new one in Chronicle.');
    $allowed = $link['scope'] === 'panel' ? [...PANEL_READ, ...PANEL_WRITE] : PANEL_READ;
    if (!in_array($action, $allowed, true)) json_error(401, 'panel_not_allowed', 'A panel link can\'t do that. Open Chronicle itself.');
    rate_limit('panel', 'k' . $link['id'], (int)(cfg('limits', [])['panel_per_minute'] ?? 240), 60);
    $GLOBALS['panel_link'] = $link;
    if ($link['scope'] === 'public_panel') {
        // It stops with the GM who made it: once they are no longer a GM here (or an admin), nobody vouches for it.
        $st = db()->prepare("SELECT 1 FROM users u WHERE u.id=? AND (u.is_admin=1 OR EXISTS (SELECT 1 FROM campaign_members m WHERE m.user_id=u.id AND m.campaign_id=? AND m.role='gm'))");
        $st->execute([(int)$link['created_by'], (int)$link['campaign_id']]);
        if (!$st->fetchColumn()) json_error(401, 'bad_panel_link', 'The GM who made this panel link no longer runs the campaign. Make a new one in Chronicle.');
        $GLOBALS['panel_user'] = ['id' => 0, 'is_admin' => 0, 'status' => 'approved', 'display_name' => 'Public panel', 'email' => '', 'provider' => 'panel'];
    } else {
        $st = db()->prepare('SELECT * FROM users WHERE id=?');
        $st->execute([(int)$link['user_id']]);
        $u = $st->fetch();
        if (!$u) json_error(401, 'bad_panel_link', 'That panel link\'s account is gone.');
        $st = db()->prepare('SELECT 1 FROM campaign_members WHERE campaign_id=? AND user_id=?');
        $st->execute([(int)$link['campaign_id'], (int)$u['id']]);
        if (!(int)$u['is_admin'] && !$st->fetchColumn()) json_error(401, 'bad_panel_link', 'You are no longer in this campaign, so its panel link stopped working.');
        $u['status'] = chronicle_status($u);
        $GLOBALS['panel_user'] = $u;
    }
    // The campaign comes from the link, so a code can never reach another campaign whatever the request says.
    $_GET['cid'] = (string)$link['campaign_id'];
    db()->prepare('UPDATE connection_keys SET last_used_at=CURRENT_TIMESTAMP WHERE id=? AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP - INTERVAL 1 MINUTE)')
        ->execute([$link['id']]);
}

/** A link as its list shows it. */
function panel_link_out(array $k): array {
    $o = dec($k['options_json'] ?? null) ?: [];
    return ['id' => (int)$k['id'], 'scope' => $k['scope'], 'label' => $k['label'], 'overlay' => !empty($o['overlay']),
        'user_id' => $k['user_id'] !== null ? (int)$k['user_id'] : null, 'maker' => $k['maker'] ?? null,
        'created_at' => $k['created_at'], 'last_used_at' => $k['last_used_at']];
}
/** Campaign $cid's links that this member manages: their own, and every one for a GM. */
function panel_links_list(int $cid, bool $isGm): array {
    $st = db()->prepare('SELECT k.*, ' . AUTHOR_SQL . ' AS maker FROM connection_keys k LEFT JOIN users u ON u.id=k.created_by
        LEFT JOIN campaign_members m ON m.campaign_id=k.campaign_id AND m.user_id=k.created_by
        WHERE k.campaign_id=? AND k.revoked_at IS NULL' . ($isGm ? '' : ' AND k.created_by=?') . ' ORDER BY k.id');
    $st->execute($isGm ? [$cid] : [$cid, me()['id']]);
    return array_map('panel_link_out', $st->fetchAll());
}
/** Make a link; returns it with its code, the only time the code is seen. */
function panel_link_create(int $cid, bool $isGm): array {
    $scope = (string)p('scope', 'panel');
    if (!in_array($scope, PANEL_SCOPES, true)) fail('Pick the kind of link');
    if ($scope === 'public_panel' && !$isGm) fail('Only a GM can make a public panel link', 403);
    $label = trim((string)str_in(p('label'), 80, false));
    if ($label === '') $label = $scope === 'public_panel' ? 'Public panel' : 'My panel';
    $st = db()->prepare('SELECT COUNT(*) FROM connection_keys WHERE campaign_id=? AND created_by=? AND revoked_at IS NULL');
    $st->execute([$cid, me()['id']]);
    if ((int)$st->fetchColumn() >= 20) fail('You have 20 panel links in this campaign already. Revoke some first');
    $code = bin2hex(random_bytes(32));
    $overlay = $scope === 'public_panel' && p('overlay') ? json_encode(['overlay' => true]) : null;
    db()->prepare('INSERT INTO connection_keys (campaign_id, user_id, scope, label, token_hash, options_json, created_by) VALUES (?,?,?,?,?,?,?)')
        ->execute([$cid, $scope === 'panel' ? me()['id'] : null, $scope, $label, hash('sha256', $code), $overlay, me()['id']]);
    $id = (int)db()->lastInsertId();
    $st = db()->prepare('SELECT * FROM connection_keys WHERE id=?');
    $st->execute([$id]);
    return panel_link_out($st->fetch()) + ['code' => $code];
}
/** Revoke a link: your own, or any in the campaign for a GM. */
function panel_link_revoke(int $cid, bool $isGm): void {
    $st = db()->prepare('SELECT created_by FROM connection_keys WHERE id=? AND campaign_id=? AND revoked_at IS NULL');
    $st->execute([int_in(p('id'), 1), $cid]);
    $by = $st->fetchColumn();
    if ($by === false) fail('Link not found', 404);
    if (!$isGm && (int)$by !== me()['id']) fail('You can only revoke your own links', 403);
    db()->prepare('UPDATE connection_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id=?')->execute([int_in(p('id'), 1)]);
}

/**
 * The Owlbear Rodeo extension: its manifest, added in Owlbear under Extensions → Add custom extension. The panel opens
 * as the extension's popover. Owlbear reads the manifest from its own page, so it is open to any origin; it holds
 * nothing private. The addresses are whole URLs from base_url, as Owlbear doesn't say how it resolves a relative one.
 * The icon travels inside the manifest as a data: URL: Owlbear draws the toolbar button with the icon as a CSS mask,
 * which the browser fetches in CORS mode, and a base_url that redirects (example.com to www.example.com, say) loses
 * the CORS header on the way, leaving the button blank.
 */
function owlbear_manifest(): void {
    $base = rtrim((string)cfg('base_url', ''), '/');
    if ($base === '') {
        $https = ($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off';
        $base = ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . rtrim(dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/api/index.php')), '/');
    }
    $icon = 'data:image/svg+xml;base64,' . base64_encode((string)file_get_contents(__DIR__ . '/../static/icons/owlbear.svg'));
    header('Access-Control-Allow-Origin: *');
    out(['name' => 'Campaign Chronicle', 'version' => '1.0.0', 'manifest_version' => 1,
        'description' => 'The campaign right now: date, weather, moons, where the party is, notes and lore.',
        'author' => 'Campaign Chronicle', 'homepage_url' => "$base/", 'icon' => $icon,
        'action' => ['title' => 'Campaign Chronicle', 'icon' => $icon, 'popover' => "$base/panel.html", 'width' => 420, 'height' => 720]]);
}
