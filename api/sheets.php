<?php
/**
 * Character sheets (see docs/superpowers/specs/2026-10-29-character-sheets-design.md).
 *
 * Sheet templates are site-wide: anyone can use or fork one, only its author or a site admin changes it. A character
 * is one filled-in copy of a template in a campaign, with its own Encyclopedia entry (which holds its name), marked PC
 * or NPC. Values save one field at a time (character_field); the sheet's settings save with a version check. Fields
 * and sections the owner hides, and an NPC sheet not shown to players, never leave the server for other members.
 */
declare(strict_types=1);

function has_sheets(): bool {
    static $has = null;
    return $has ??= (bool)db()->query("SHOW COLUMNS FROM campaign_members LIKE 'active_character_id'")->fetchColumn();
}
function need_sheets(): void {
    if (!has_sheets()) fail('Character sheets need a database upgrade: open install.php and press Install or upgrade', 409, 'needs_upgrade');
}
