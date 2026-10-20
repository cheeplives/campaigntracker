-- 009_party_funds_location.sql — where each line of Party Funds is kept.
--
-- Run ONCE on an install that already has the party_funds table (008):
--   mysql -u <user> -p <database> < db/migrations/009_party_funds_location.sql
-- (install.php runs it for you when party_funds has no location column.)
-- Fresh installs already get it from db/schema.sql.

ALTER TABLE party_funds ADD COLUMN location VARCHAR(200) NOT NULL DEFAULT '' AFTER currency;
