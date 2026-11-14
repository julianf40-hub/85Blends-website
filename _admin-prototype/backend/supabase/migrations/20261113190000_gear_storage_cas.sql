-- Recommended Gear admin backend: Storage-level fencing and compare-and-swap (LOCAL, fictional).
--
-- A lease token in the database does not by itself stop a stale process from overwriting Storage.
-- Here the catalog objects can only be written by an authenticated (non-service) request whose
-- storage.objects row change passes RLS, evaluated by Postgres when Storage commits the object row:
--   * the caller is the publisher with aal2, from the JWT the Storage API verified;
--   * the upload carries the live, unexpired lease token in its user metadata;
--   * an UPDATE replaces exactly the object version captured before the function read it (CAS);
--   * Production writes also need a TOTP verification within the step-up window (amr claim).
-- The served object is whatever version the objects row points to, so a rejected upload changes
-- nothing that clients read. Service/secret keys bypass RLS: those writers remain detectable drift.

create table public.gear_settings (
  id boolean primary key default true check (id),
  production_step_up_seconds integer not null default 900 check (production_step_up_seconds between 30 and 3600)
);
insert into public.gear_settings default values;
alter table public.gear_settings enable row level security;
revoke all on public.gear_settings from anon, authenticated;

alter table public.gear_publication_head
  add column expected_object_version text,
  add column expected_object_known boolean not null default false;

create function private.gear_object_target(p_name text) returns text
  language sql immutable set search_path = '' as $$
  select case p_name when 'catalog-v1.json' then 'production' when 'staging/catalog-v1.json' then 'staging' end
$$;

-- Service role only: under the lease, capture the version currently stored for the target's object.
-- Every later write in this lease must replace exactly this version (or create the object if absent).
create function public.gear_prepare_write(p_token uuid, p_target text) returns text
  language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  perform private.gear_require_lease(p_target, p_token);
  select o.version into v from storage.objects o
   where o.bucket_id = 'recommended-gear' and o.name = case p_target when 'production' then 'catalog-v1.json' else 'staging/catalog-v1.json' end;
  update public.gear_publication_head set expected_object_version = v, expected_object_known = true where target = p_target;
  return v;
end $$;
revoke all on function public.gear_prepare_write(uuid, text) from public, anon, authenticated;
grant execute on function public.gear_prepare_write(uuid, text) to service_role;

-- New-row check (INSERT and UPDATE): publisher + aal2 from the verified JWT, live lease token,
-- a prepared expectation, and for Production a recent TOTP verification.
create function private.gear_catalog_write_allowed(p_name text, p_user_metadata jsonb) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
declare
  t text := private.gear_object_target(p_name);
  head public.gear_publication_head;
  window_seconds integer;
begin
  if t is null or private.gear_role() is distinct from 'publisher' then return false; end if;
  select * into head from public.gear_publication_head h where h.target = t;
  if head.lease_token is null or head.lease_expires_at < clock_timestamp()
     or coalesce(p_user_metadata ->> 'gear_lease', '') <> head.lease_token::text
     or not head.expected_object_known then
    return false;
  end if;
  if t = 'production' then
    select production_step_up_seconds into window_seconds from public.gear_settings;
    if not exists (
      select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) e
      where e ->> 'method' = 'totp' and (e ->> 'timestamp')::bigint >= extract(epoch from clock_timestamp())::bigint - window_seconds
    ) then
      return false;
    end if;
  end if;
  return true;
end $$;

-- Existing-row check (UPDATE USING): the object being replaced is exactly the prepared version.
create function private.gear_catalog_version_matches(p_name text, p_version text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((select h.expected_object_known and h.expected_object_version is not distinct from p_version
                     and h.lease_expires_at >= clock_timestamp()
                   from public.gear_publication_head h where h.target = private.gear_object_target(p_name)), false)
$$;

revoke all on function private.gear_object_target(text), private.gear_catalog_write_allowed(text, jsonb),
  private.gear_catalog_version_matches(text, text) from public, anon;
grant execute on function private.gear_object_target(text), private.gear_catalog_write_allowed(text, jsonb),
  private.gear_catalog_version_matches(text, text) to authenticated;

create policy "gear catalog insert: publisher, aal2, live lease" on storage.objects for insert to authenticated
  with check (bucket_id = 'recommended-gear' and private.gear_catalog_write_allowed(name, user_metadata));
create policy "gear catalog update: CAS on prepared version" on storage.objects for update to authenticated
  using (bucket_id = 'recommended-gear' and private.gear_catalog_version_matches(name, version))
  with check (bucket_id = 'recommended-gear' and private.gear_catalog_write_allowed(name, user_metadata));
create policy "gear catalog origin read: publisher aal2" on storage.objects for select to authenticated
  using (bucket_id = 'recommended-gear' and private.gear_role() = 'publisher');
