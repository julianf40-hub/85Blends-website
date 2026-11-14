-- The recommended-gear bucket holds images only (D10 option 2: catalogs are served from the database).
-- Removes application/json from the allowed types so the superseded catalog-v1.json path cannot be
-- written by ordinary uploads. The legacy demonstrations re-allow it in their local fixture.
update storage.buckets set allowed_mime_types = array['image/png', 'image/jpeg'] where id = 'recommended-gear';
