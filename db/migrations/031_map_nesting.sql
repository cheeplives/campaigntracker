-- Maps inside maps: a pin can open another map (a town pin opens the town's map).
ALTER TABLE map_pins
  ADD COLUMN child_map_id INT UNSIGNED NULL AFTER event_id,
  ADD KEY ix_pin_child_map (child_map_id),
  ADD CONSTRAINT fk_pin_child_map FOREIGN KEY (child_map_id) REFERENCES maps(id) ON DELETE SET NULL;
