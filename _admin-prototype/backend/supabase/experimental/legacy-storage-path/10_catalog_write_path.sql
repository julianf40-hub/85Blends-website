-- LEGACY STORAGE PATH (experimental evidence only; NOT part of the migration/deployment path).
-- Applied by tests/legacy-storage/* after a local reset, as the local superuser, to restore the
-- superseded design: catalog objects written to Storage under a lease with single-use write grants.
-- Kept so the failing old-design demonstrations (PS1b-unguarded, PS2-unguarded) stay reproducible.
create policy "gear catalog insert: publisher, aal2, single-use write grant" on storage.objects for insert to authenticated
  with check (bucket_id = 'recommended-gear' and private.gear_catalog_write_allowed(name, metadata, user_metadata));
create policy "gear catalog update: grant + CAS on prepared version" on storage.objects for update to authenticated
  using (bucket_id = 'recommended-gear' and private.gear_catalog_version_matches(name, version))
  with check (bucket_id = 'recommended-gear' and private.gear_catalog_write_allowed(name, metadata, user_metadata));
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('gear_acquire_lease', 'gear_release_lease', 'gear_record_publication',
             'gear_record_status', 'gear_record_drift_ack', 'gear_prepare_write', 'gear_authorize_write', 'gear_consume_write',
             'gear_lease_overview') loop
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
-- The superseded path also kept gear images in the recommended-gear bucket.
drop policy "gear images insert: aal2 admin with a single-use image grant" on storage.objects;
drop policy "gear images read: aal2 admins" on storage.objects;
create policy "gear images insert: aal2 admin with a single-use image grant" on storage.objects for insert to authenticated
  with check (bucket_id = 'recommended-gear' and name ~ '^images/[a-z0-9-]{1,64}/[a-f0-9]{64}\.(png|jpg)$'
              and private.gear_image_write_allowed(name, metadata, user_metadata));
create policy "gear images read: aal2 admins" on storage.objects for select to authenticated
  using (bucket_id = 'recommended-gear' and name like 'images/%' and private.gear_role() is not null);
create or replace function public.gear_image_objects(p_names text[]) returns table (name text, size bigint, mimetype text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
    from storage.objects o where o.bucket_id = 'recommended-gear' and o.name = any (p_names)
$$;
create or replace function public.gear_list_images() returns table (name text, size bigint, mimetype text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
    from storage.objects o where o.bucket_id = 'recommended-gear' and o.name like 'images/%' order by o.created_at
$$;
