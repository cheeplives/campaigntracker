<?php
/**
 * The Maps tab: maps (an uploaded image with pins, routes, a scale and a grid), tokens and party groups.
 * The actions are added to api/index.php's switch as the tab is built; this file starts with the upgrade guard.
 */

/** Whether migration 019 has been run, so the rest of the app still works on an install that hasn't. */
function has_maps(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW TABLES LIKE 'maps'")->fetchColumn();
}
function need_maps(): void {
    if (!has_maps()) fail('Maps need a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}
