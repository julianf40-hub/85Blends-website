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
-- The superseded path wrote JSON catalogs into the bucket.
update storage.buckets set allowed_mime_types = array['application/json', 'image/png', 'image/jpeg'] where id = 'recommended-gear';
