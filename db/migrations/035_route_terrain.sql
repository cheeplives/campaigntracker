-- Terrain per leg of a saved route: a travel-time multiplier (1 to 4) for each leg, as a JSON list. Null: every leg is x1.
ALTER TABLE map_routes ADD COLUMN terrain_json VARCHAR(2000) NULL AFTER dash;
