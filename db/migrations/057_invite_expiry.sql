-- 057_invite_expiry.sql — an invitation to a campaign runs out.
-- campaign_invites.expires_at: when the invitation, and its link, can no longer be taken up. A new invitation lasts
-- 14 days, and inviting the address again (or asking for its link) starts that over. Invitations waiting when this
-- runs get 14 days from now.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/057_invite_expiry.sql
-- (deploy.sh and install.php run it for you when campaign_invites has no expires_at column.)
-- Fresh installs already get the column from db/schema.sql.
ALTER TABLE campaign_invites ADD COLUMN expires_at DATETIME NULL AFTER created_at;
UPDATE campaign_invites SET expires_at = NOW() + INTERVAL 14 DAY WHERE expires_at IS NULL;
