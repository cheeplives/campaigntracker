-- 018_encyclopedia_categories.sql — every Encyclopedia entry can have one Category (Location, Person, Item, Group or
-- Vehicle), so the list is grouped by Category and the tags are left to tell entries of one Category apart.
--
-- Entries already tagged Location, Person, Item, Group or Vehicle take that as their Category and lose the tag, since
-- the Category now says it. An entry with more than one of them takes the first of Person, Location, Group, Item,
-- Vehicle, and keeps the others as tags. Any of those five tags left on no entry is removed.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/018_encyclopedia_categories.sql
-- (install.php runs it for you when encyclopedia_entries has no category column.)
-- Fresh installs already get the column from db/schema.sql.
ALTER TABLE encyclopedia_entries ADD COLUMN category VARCHAR(20) NULL AFTER name;

UPDATE encyclopedia_entries e JOIN encyclopedia_tags et ON et.entry_id=e.id JOIN encyclopedia_tag_names t ON t.id=et.tag_id
  SET e.category='person' WHERE e.category IS NULL AND t.name='Person';
UPDATE encyclopedia_entries e JOIN encyclopedia_tags et ON et.entry_id=e.id JOIN encyclopedia_tag_names t ON t.id=et.tag_id
  SET e.category='location' WHERE e.category IS NULL AND t.name='Location';
UPDATE encyclopedia_entries e JOIN encyclopedia_tags et ON et.entry_id=e.id JOIN encyclopedia_tag_names t ON t.id=et.tag_id
  SET e.category='group' WHERE e.category IS NULL AND t.name='Group';
UPDATE encyclopedia_entries e JOIN encyclopedia_tags et ON et.entry_id=e.id JOIN encyclopedia_tag_names t ON t.id=et.tag_id
  SET e.category='item' WHERE e.category IS NULL AND t.name='Item';
UPDATE encyclopedia_entries e JOIN encyclopedia_tags et ON et.entry_id=e.id JOIN encyclopedia_tag_names t ON t.id=et.tag_id
  SET e.category='vehicle' WHERE e.category IS NULL AND t.name='Vehicle';

-- the tag that became the Category (names compare without regard to case)
DELETE et FROM encyclopedia_tags et JOIN encyclopedia_entries e ON e.id=et.entry_id JOIN encyclopedia_tag_names t ON t.id=et.tag_id
  WHERE t.name=e.category;
DELETE t FROM encyclopedia_tag_names t LEFT JOIN encyclopedia_tags et ON et.tag_id=t.id
  WHERE et.tag_id IS NULL AND t.name IN ('Location', 'Person', 'Item', 'Group', 'Vehicle');
