-- Gear images move to their own bucket, recommended-gear-images (decision after D10 review).
-- The existing recommended-gear bucket is NOT changed in any way: its settings, policies and
-- objects stay exactly as they are, because installed app builds and the current publisher
-- (publish_catalog.py) still use it. The current design never writes it.
-- Image object names are unchanged: images/<brandId>/<sha256>.<png|jpg>, insert-only, single-use grants.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recommended-gear-images', 'recommended-gear-images', true, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

drop policy "gear images insert: aal2 admin with a single-use image grant" on storage.objects;
drop policy "gear images read: aal2 admins" on storage.objects;
create policy "gear images insert: aal2 admin with a single-use image grant" on storage.objects for insert to authenticated
  with check (bucket_id = 'recommended-gear-images' and name ~ '^images/[a-z0-9-]{1,64}/[a-f0-9]{64}\.(png|jpg)$'
              and private.gear_image_write_allowed(name, metadata, user_metadata));
create policy "gear images read: aal2 admins" on storage.objects for select to authenticated
  using (bucket_id = 'recommended-gear-images' and name like 'images/%' and private.gear_role() is not null);

create or replace function public.gear_image_objects(p_names text[]) returns table (name text, size bigint, mimetype text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
    from storage.objects o where o.bucket_id = 'recommended-gear-images' and o.name = any (p_names)
$$;
create or replace function public.gear_list_images() returns table (name text, size bigint, mimetype text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
    from storage.objects o where o.bucket_id = 'recommended-gear-images' and o.name like 'images/%' order by o.created_at
$$;
