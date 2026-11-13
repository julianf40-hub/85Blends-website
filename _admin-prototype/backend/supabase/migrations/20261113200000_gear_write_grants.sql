-- Recommended Gear admin backend: bypass hardening (LOCAL, fictional data).
--
-- Review findings at f7d2a3c (tests/bypass.test.mjs):
--   * lease_token and expected_object_version were readable by aal2 admins over REST, so the
--     publisher could take a live lease token (e.g. after a crash) and upload arbitrary bytes
--     directly to Storage, skipping gear-publish.
--   * Storage API v1.72.1 evaluates RLS in canUpload() as a rolled-back dry run BEFORE the bytes
--     are uploaded, with only client-declared metadata ({mimetype, contentLength}); completeUpload()
--     then writes the row as superuser without RLS. RLS therefore cannot bind a write to the
--     uploaded bytes, and the CAS/fencing checks hold when an upload STARTS, not when it commits.
--
-- Changes:
--   1. Lease internals are no longer readable by clients (column privileges).
--   2. Writes need a single-use write grant: a nonce bound to the target environment, the exact
--      object path, the specific recorded publication and its byte size (compared with the
--      declared size), and the publisher account it was issued for. The nonce is rotated/consumed after each write and never stored in a
--      client-readable place except the object's own user_metadata after the write, when it is spent.
--   3. The publication guard also checks that the stored JSON matches the row (schemaVersion 1,
--      revision, publishedAt, brands array). Full v1 validation still happens in gear-publish.

-- 1. hide lease internals ---------------------------------------------------------------------
revoke select on public.gear_publication_head from authenticated;
grant select (target, revision, published_at, digest) on public.gear_publication_head to authenticated;

-- 2. single-use write grants -------------------------------------------------------------------
create table private.gear_write_grants (
  target text primary key check (target in ('staging', 'production')),
  object_name text not null,
  lease_token uuid not null,
  nonce uuid not null,
  publication_id uuid not null references public.gear_catalog_publications (id),
  user_id uuid not null references auth.users (id),
  declared_size bigint not null,
  expires_at timestamptz not null
);
revoke all on private.gear_write_grants from public, anon, authenticated;

create function public.gear_authorize_write(p_token uuid, p_target text, p_publication_id uuid, p_user_id uuid) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare
  head public.gear_publication_head := private.gear_require_lease(p_target, p_token);
  doc text;
  result uuid;
begin
  if not head.expected_object_known then
    raise exception 'prepare_required: capture the object version before authorizing a write' using errcode = 'PT409';
  end if;
  if not exists (select 1 from public.gear_admins a where a.user_id = p_user_id and a.role = 'publisher') then
    raise exception 'publisher_required: write grants are issued only for the current publisher' using errcode = 'PT403';
  end if;
  select p.document into doc from public.gear_catalog_publications p where p.id = p_publication_id and p.target = p_target;
  if doc is null then raise exception 'unknown publication for %', p_target using errcode = 'PT404'; end if;
  insert into private.gear_write_grants as g (target, object_name, lease_token, nonce, publication_id, user_id, declared_size, expires_at)
  values (p_target, case p_target when 'production' then 'catalog-v1.json' else 'staging/catalog-v1.json' end,
          p_token, gen_random_uuid(), p_publication_id, p_user_id, octet_length(convert_to(doc, 'UTF8')), head.lease_expires_at)
  on conflict (target) do update set object_name = excluded.object_name, lease_token = excluded.lease_token, nonce = excluded.nonce,
    publication_id = excluded.publication_id, user_id = excluded.user_id, declared_size = excluded.declared_size, expires_at = excluded.expires_at
  returning g.nonce into result;
  return result;
end $$;

create function public.gear_consume_write(p_token uuid, p_target text) returns void
  language sql security definer set search_path = '' as $$
  delete from private.gear_write_grants where target = p_target and lease_token = p_token
$$;

-- Releasing or (re)acquiring a lease, or capturing a new expected version, drops any grant.
create or replace function public.gear_release_lease(p_target text, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from private.gear_write_grants where target = p_target and lease_token = p_token;
  update public.gear_publication_head set lease_token = null, lease_expires_at = null, expected_object_known = false, expected_object_version = null
   where target = p_target and lease_token = p_token;
  return found;
end $$;

create or replace function public.gear_prepare_write(p_token uuid, p_target text) returns text
  language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  perform private.gear_require_lease(p_target, p_token);
  delete from private.gear_write_grants where target = p_target;
  select o.version into v from storage.objects o
   where o.bucket_id = 'recommended-gear' and o.name = case p_target when 'production' then 'catalog-v1.json' else 'staging/catalog-v1.json' end;
  update public.gear_publication_head set expected_object_version = v, expected_object_known = true where target = p_target;
  return v;
end $$;

create or replace function public.gear_acquire_lease(p_target text, p_ttl_seconds integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare token uuid;
begin
  update public.gear_publication_head h
     set lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + make_interval(secs => greatest(1, least(p_ttl_seconds, 300))),
         expected_object_known = false, expected_object_version = null
   where h.target = p_target and (h.lease_token is null or h.lease_expires_at < clock_timestamp())
  returning h.lease_token into token;
  if token is null then
    if not exists (select 1 from public.gear_publication_head h where h.target = p_target) then
      raise exception 'unknown target' using errcode = 'PT400';
    end if;
    raise exception 'lease_held: another publish or reconcile is in progress for %', p_target using errcode = 'PT423';
  end if;
  delete from private.gear_write_grants where target = p_target;
  return token;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.gear_authorize_write(uuid, text, uuid, uuid)', 'public.gear_consume_write(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Storage policy check: the write grant replaces the reusable lease token.
drop policy "gear catalog insert: publisher, aal2, live lease" on storage.objects;
drop policy "gear catalog update: CAS on prepared version" on storage.objects;
drop function private.gear_catalog_write_allowed(text, jsonb);

create function private.gear_catalog_write_allowed(p_name text, p_metadata jsonb, p_user_metadata jsonb) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
declare
  t text := private.gear_object_target(p_name);
  head public.gear_publication_head;
  g private.gear_write_grants;
  window_seconds integer;
begin
  if t is null or private.gear_role() is distinct from 'publisher' then return false; end if;
  select * into head from public.gear_publication_head h where h.target = t;
  select * into g from private.gear_write_grants w where w.target = t;
  if head.lease_token is null or head.lease_expires_at < clock_timestamp() or not head.expected_object_known
     or g.nonce is null or g.lease_token <> head.lease_token or g.expires_at < clock_timestamp()
     or g.object_name <> p_name
     or g.user_id is distinct from auth.uid()
     or coalesce(p_user_metadata ->> 'gear_write', '') <> g.nonce::text
     -- Declared by the client (Storage checks RLS before the bytes arrive): hygiene, not proof of content.
     or coalesce((p_metadata ->> 'contentLength')::bigint, -1) <> g.declared_size then
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
revoke all on function private.gear_catalog_write_allowed(text, jsonb, jsonb) from public, anon;
grant execute on function private.gear_catalog_write_allowed(text, jsonb, jsonb) to authenticated;

create policy "gear catalog insert: publisher, aal2, single-use write grant" on storage.objects for insert to authenticated
  with check (bucket_id = 'recommended-gear' and private.gear_catalog_write_allowed(name, metadata, user_metadata));
create policy "gear catalog update: grant + CAS on prepared version" on storage.objects for update to authenticated
  using (bucket_id = 'recommended-gear' and private.gear_catalog_version_matches(name, version))
  with check (bucket_id = 'recommended-gear' and private.gear_catalog_write_allowed(name, metadata, user_metadata));

-- 3. publication JSON must match its row --------------------------------------------------------
create or replace function private.gear_publication_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  latest bigint;
  doc jsonb;
begin
  if not exists (select 1 from public.gear_admins a where a.user_id = new.published_by and a.role = 'publisher') then
    raise exception 'publications must be authored by the publisher' using errcode = 'PT403';
  end if;
  if new.auth_aal is distinct from 'aal2' then
    raise exception 'publications require an MFA-verified (aal2) session' using errcode = 'PT403';
  end if;
  if new.digest is distinct from encode(pg_catalog.sha256(convert_to(new.document, 'UTF8')), 'hex') then
    raise exception 'digest does not match the recorded bytes' using errcode = 'PT422';
  end if;
  begin
    doc := new.document::jsonb;
  exception when others then
    raise exception 'document is not JSON' using errcode = 'PT422';
  end;
  if (doc ->> 'schemaVersion') is distinct from '1' or (doc ->> 'revision') is distinct from new.revision::text
     or (doc ->> 'publishedAt') is distinct from new.published_at::text or jsonb_typeof(doc -> 'brands') is distinct from 'array' then
    raise exception 'document does not match the publication row (schemaVersion, revision, publishedAt, brands)' using errcode = 'PT422';
  end if;
  select max(p.published_at) into latest from public.gear_catalog_publications p where p.target = new.target;
  if latest is not null and new.published_at <= latest then
    raise exception 'publishedAt must strictly increase (latest %, got %)', latest, new.published_at using errcode = 'PT409';
  end if;
  return new;
end $$;

-- 4. a write Storage refused before the upload is 'refused' (certainly not stored), distinct from
--    'conflict' (read-back found different bytes). Reconcile treats 'refused' like 'recorded'.
alter table public.gear_publication_status drop constraint gear_publication_status_status_check;
alter table public.gear_publication_status add constraint gear_publication_status_status_check
  check (status in ('recorded', 'verified', 'uncertain', 'conflict', 'refused'));
