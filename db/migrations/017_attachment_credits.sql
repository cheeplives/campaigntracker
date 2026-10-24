-- 017_attachment_credits.sql — where a picture found with Find Image came from, and pictures embedded from DeviantArt.
-- The credit_ columns hold a found picture's title, artist, licence and source, each with its link, so the picture is
-- credited wherever it shows (open licences such as CC BY ask for that). A row with kind 'embed' has no file: the
-- picture loads from DeviantArt through its oEmbed API each time it is shown. embed_url is the work's page on
-- DeviantArt, embed_src the picture's address oEmbed last gave and embed_checked_at when it gave it, as those addresses
-- can expire. All are empty for a file uploaded by hand.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/017_attachment_credits.sql
-- (install.php runs it for you when attachments has no credit_license column.)
-- Fresh installs already get it from db/schema.sql.
ALTER TABLE attachments
  ADD COLUMN credit_title VARCHAR(200) NULL AFTER caption,
  ADD COLUMN credit_author VARCHAR(200) NULL AFTER credit_title,
  ADD COLUMN credit_author_url VARCHAR(500) NULL AFTER credit_author,
  ADD COLUMN credit_license VARCHAR(60) NULL AFTER credit_author_url,
  ADD COLUMN credit_license_url VARCHAR(300) NULL AFTER credit_license,
  ADD COLUMN credit_source VARCHAR(60) NULL AFTER credit_license_url,
  ADD COLUMN credit_source_url VARCHAR(500) NULL AFTER credit_source,
  ADD COLUMN embed_url VARCHAR(500) NULL AFTER credit_source_url,
  ADD COLUMN embed_src VARCHAR(1000) NULL AFTER embed_url,
  ADD COLUMN embed_checked_at DATETIME NULL AFTER embed_src;
