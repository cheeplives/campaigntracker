-- 046_picture_framing.sql — how a picture sits in its round disc: a character's portrait, an Encyclopedia entry's disc,
-- a token and the pin or party marker that wears it on a map. attachments.frame_x and frame_y are the point of the
-- picture (as a percentage across and down, 0 to 100) kept in the middle of the circle as far as the picture allows, and
-- frame_zoom how far it is enlarged around that point (100 = just filling the circle, up to 400). NULL in all three: as
-- before, the middle of the picture, filling the circle. Set from the Fit in the circle box (static/kit.js, KIT.framer).
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/046_picture_framing.sql
-- (deploy.sh and install.php run it for you when attachments has no frame_x column.)
-- Fresh installs already get the columns from db/schema.sql.
ALTER TABLE attachments ADD COLUMN frame_x TINYINT UNSIGNED NULL AFTER caption,
  ADD COLUMN frame_y TINYINT UNSIGNED NULL AFTER frame_x, ADD COLUMN frame_zoom SMALLINT UNSIGNED NULL AFTER frame_y;
