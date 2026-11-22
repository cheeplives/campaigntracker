-- 058_key_expiry.sql — an API key can run out.
-- connection_keys.expires_at: when a key stops working. A new API key lasts a year unless its maker picks 30 or 90
-- days, or no end. NULL is "until revoked": every panel link, and every key made before this change, which is left
-- as it was so nothing already set up stops working.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/058_key_expiry.sql
-- (deploy.sh and install.php run it for you when connection_keys has no expires_at column.)
-- Fresh installs already get the column from db/schema.sql.
ALTER TABLE connection_keys ADD COLUMN expires_at DATETIME NULL AFTER last_used_at;
