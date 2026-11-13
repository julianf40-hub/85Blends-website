-- Recommended Gear admin backend: LOCAL DEVELOPMENT ONLY (fictional data).
-- This is a standalone local Supabase project (`gear-admin-local`). It is NOT part of the live
-- project's migration history, which lives in E85-Blends-App/supabase/migrations; a reviewed copy
-- of this schema would be proposed there separately (plan §2, §12).
--
-- Enforcement summary
--   * Reads and draft saves: RLS / security-definer RPC, require a gear_admins row AND aal2.
--   * Publications: written only through service-role RPCs called by the gear-publish function,
--     under a lease with a fencing token; a trigger independently requires the single publisher,
--     aal2, a digest matching the exact bytes, and a strictly increasing publishedAt.
--   * History, status, drift acknowledgements and audit are append-only (UPDATE/DELETE refused).

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------- administrators
create table public.gear_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('editor', 'publisher')),
  added_by uuid references auth.users (id),
  added_at timestamptz not null default now()
);
-- Operating model: exactly one publisher can exist.
create unique index gear_admins_single_publisher on public.gear_admins (role) where role = 'publisher';

-- The caller's role, only when the session is MFA-verified (aal2). Null otherwise.
create function private.gear_role() returns text
  language sql stable security definer set search_path = '' as $$
  select a.role from public.gear_admins a
  where a.user_id = auth.uid() and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;
grant usage on schema private to authenticated;
revoke all on function private.gear_role() from public;
grant execute on function private.gear_role() to authenticated;

-- ---------------------------------------------------------------- drafts
create table public.gear_catalog_drafts (
  id text primary key default 'main' check (id = 'main'),
  catalog jsonb not null,
  meta jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version >= 1),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- publications
create table public.gear_publication_head (
  target text primary key check (target in ('staging', 'production')),
  revision uuid,
  published_at bigint,
  digest text,
  lease_token uuid,
  lease_expires_at timestamptz
);
insert into public.gear_publication_head (target) values ('staging'), ('production');

create table public.gear_catalog_publications (
  id uuid primary key default gen_random_uuid(),
  target text not null check (target in ('staging', 'production')),
  revision uuid not null unique,
  published_at bigint not null check (published_at > 0),
  document text not null,
  digest text not null,
  summary text not null,
  draft_version integer,
  rollback_of uuid references public.gear_catalog_publications (id),
  validator_version text not null,
  published_by uuid not null references auth.users (id),
  auth_aal text not null,
  auth_amr jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (target, published_at)
);

create table public.gear_publication_status (
  id bigserial primary key,
  publication_id uuid not null references public.gear_catalog_publications (id),
  status text not null check (status in ('recorded', 'verified', 'uncertain', 'conflict')),
  note text,
  at timestamptz not null default clock_timestamp()
);

create table public.gear_storage_drift_acks (
  id bigserial primary key,
  target text not null check (target in ('staging', 'production')),
  digest text not null,
  foreign_revision text,
  foreign_published_at bigint,
  passes_validation boolean not null,
  validation_error text,
  acknowledged_by uuid not null references auth.users (id),
  at timestamptz not null default now()
);

create table public.gear_audit_log (
  id bigserial primary key,
  at timestamptz not null default clock_timestamp(),
  actor uuid,
  event text not null,
  detail jsonb not null default '{}'::jsonb
);

-- Independent checks on every publication row, whoever inserts it.
create function private.gear_publication_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  latest bigint;
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
  select max(p.published_at) into latest from public.gear_catalog_publications p where p.target = new.target;
  if latest is not null and new.published_at <= latest then
    raise exception 'publishedAt must strictly increase (latest %, got %)', latest, new.published_at using errcode = 'PT409';
  end if;
  return new;
end $$;
create trigger gear_publications_guard before insert on public.gear_catalog_publications
  for each row execute function private.gear_publication_guard();

create function private.gear_append_only() returns trigger
  language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'PT403';
end $$;
create trigger gear_publications_append_only before update or delete on public.gear_catalog_publications
  for each row execute function private.gear_append_only();
create trigger gear_status_append_only before update or delete on public.gear_publication_status
  for each row execute function private.gear_append_only();
create trigger gear_acks_append_only before update or delete on public.gear_storage_drift_acks
  for each row execute function private.gear_append_only();
create trigger gear_audit_append_only before update or delete on public.gear_audit_log
  for each row execute function private.gear_append_only();

-- ---------------------------------------------------------------- RLS
alter table public.gear_admins enable row level security;
alter table public.gear_catalog_drafts enable row level security;
alter table public.gear_publication_head enable row level security;
alter table public.gear_catalog_publications enable row level security;
alter table public.gear_publication_status enable row level security;
alter table public.gear_storage_drift_acks enable row level security;
alter table public.gear_audit_log enable row level security;

create policy "admins read own row" on public.gear_admins for select to authenticated using (user_id = (select auth.uid()));
create policy "aal2 admins read drafts" on public.gear_catalog_drafts for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read heads" on public.gear_publication_head for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read publications" on public.gear_catalog_publications for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read status" on public.gear_publication_status for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read drift acks" on public.gear_storage_drift_acks for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read audit" on public.gear_audit_log for select to authenticated using ((select private.gear_role()) is not null);

-- No write policies anywhere; also remove the default table grants for client roles.
revoke insert, update, delete, truncate, references, trigger on
  public.gear_admins, public.gear_catalog_drafts, public.gear_publication_head, public.gear_catalog_publications,
  public.gear_publication_status, public.gear_storage_drift_acks, public.gear_audit_log
  from anon, authenticated;
revoke select on
  public.gear_admins, public.gear_catalog_drafts, public.gear_publication_head, public.gear_catalog_publications,
  public.gear_publication_status, public.gear_storage_drift_acks, public.gear_audit_log
  from anon;

-- ---------------------------------------------------------------- draft save (user JWT)
create function public.save_gear_draft(expected_version integer, new_catalog jsonb, new_meta jsonb)
returns public.gear_catalog_drafts
language plpgsql security definer set search_path = '' as $$
declare
  result public.gear_catalog_drafts;
  caller_role text := private.gear_role();
begin
  if caller_role is null then
    raise exception 'an MFA-verified (aal2) gear administrator is required' using errcode = 'PT403';
  end if;
  if jsonb_typeof(new_catalog -> 'brands') is distinct from 'array' then
    raise exception 'catalog.brands must be an array' using errcode = 'PT400';
  end if;
  if jsonb_typeof(coalesce(new_meta, '{}'::jsonb)) is distinct from 'object' then
    raise exception 'meta must be an object' using errcode = 'PT400';
  end if;
  if octet_length(new_catalog::text) + octet_length(coalesce(new_meta, '{}'::jsonb)::text) > 2000000 then
    raise exception 'draft too large' using errcode = 'PT413';
  end if;
  update public.gear_catalog_drafts d
     set catalog = jsonb_build_object('schemaVersion', 1, 'brands', new_catalog -> 'brands'), -- server-stamped fields never accepted
         meta = jsonb_build_object('approvals', coalesce(new_meta -> 'approvals', '{}'::jsonb), 'notes', coalesce(new_meta -> 'notes', '{}'::jsonb)),
         version = d.version + 1, updated_by = auth.uid(), updated_at = now()
   where d.id = 'main' and d.version = expected_version
  returning * into result;
  if not found then
    raise exception 'draft_conflict: the draft is no longer version %', expected_version using errcode = 'PT409';
  end if;
  insert into public.gear_audit_log (actor, event, detail)
    values (auth.uid(), 'draft_save', jsonb_build_object('version', result.version, 'role', caller_role));
  return result;
end $$;
revoke all on function public.save_gear_draft(integer, jsonb, jsonb) from public, anon;
grant execute on function public.save_gear_draft(integer, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------- publish lease (service role only)
-- A lease with a fencing token instead of a transaction held open across an HTTP upload: a
-- crashed function's lease simply expires, and every write below must present the live token.
create function public.gear_acquire_lease(p_target text, p_ttl_seconds integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare token uuid;
begin
  update public.gear_publication_head h
     set lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + make_interval(secs => greatest(1, least(p_ttl_seconds, 300)))
   where h.target = p_target and (h.lease_token is null or h.lease_expires_at < clock_timestamp())
  returning h.lease_token into token;
  if token is null then
    if not exists (select 1 from public.gear_publication_head h where h.target = p_target) then
      raise exception 'unknown target' using errcode = 'PT400';
    end if;
    raise exception 'lease_held: another publish or reconcile is in progress for %', p_target using errcode = 'PT423';
  end if;
  return token;
end $$;

create function private.gear_require_lease(p_target text, p_token uuid) returns public.gear_publication_head
language plpgsql security definer set search_path = '' as $$
declare head public.gear_publication_head;
begin
  select * into head from public.gear_publication_head h where h.target = p_target for update;
  if head.lease_token is distinct from p_token or head.lease_expires_at < clock_timestamp() then
    raise exception 'lease_lost: the publish lease expired or was taken over' using errcode = 'PT409';
  end if;
  return head;
end $$;

create function public.gear_release_lease(p_target text, p_token uuid)
returns boolean language sql security definer set search_path = '' as $$
  update public.gear_publication_head set lease_token = null, lease_expires_at = null
   where target = p_target and lease_token = p_token
  returning true
$$;

create function public.gear_record_publication(
  p_token uuid, p_target text, p_expected_head_revision uuid, p_revision uuid, p_published_at bigint,
  p_document text, p_digest text, p_summary text, p_draft_version integer, p_rollback_of uuid,
  p_validator_version text, p_published_by uuid, p_auth_aal text, p_auth_amr jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  head public.gear_publication_head := private.gear_require_lease(p_target, p_token);
  new_id uuid;
begin
  if head.revision is distinct from p_expected_head_revision then
    raise exception 'live_changed: % is now %', p_target, head.revision using errcode = 'PT409';
  end if;
  insert into public.gear_catalog_publications (target, revision, published_at, document, digest, summary, draft_version,
      rollback_of, validator_version, published_by, auth_aal, auth_amr)
    values (p_target, p_revision, p_published_at, p_document, p_digest, p_summary, p_draft_version,
      p_rollback_of, p_validator_version, p_published_by, p_auth_aal, coalesce(p_auth_amr, '[]'::jsonb))
    returning id into new_id;
  insert into public.gear_publication_status (publication_id, status, note) values (new_id, 'recorded', 'committed; upload not yet attempted');
  update public.gear_publication_head set revision = p_revision, published_at = p_published_at, digest = p_digest where target = p_target;
  insert into public.gear_audit_log (actor, event, detail) values (p_published_by,
    case when p_rollback_of is null then 'publish' else 'rollback' end,
    jsonb_build_object('target', p_target, 'revision', p_revision, 'publishedAt', p_published_at, 'summary', p_summary));
  return new_id;
end $$;

create function public.gear_record_status(p_token uuid, p_publication_id uuid, p_status text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare t text;
begin
  select target into t from public.gear_catalog_publications where id = p_publication_id;
  perform private.gear_require_lease(t, p_token);
  insert into public.gear_publication_status (publication_id, status, note) values (p_publication_id, p_status, p_note);
end $$;

create function public.gear_record_drift_ack(p_token uuid, p_target text, p_digest text, p_foreign_revision text,
  p_foreign_published_at bigint, p_passes_validation boolean, p_validation_error text, p_acknowledged_by uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.gear_require_lease(p_target, p_token);
  if not exists (select 1 from public.gear_admins a where a.user_id = p_acknowledged_by and a.role = 'publisher') then
    raise exception 'only the publisher can acknowledge drift' using errcode = 'PT403';
  end if;
  insert into public.gear_storage_drift_acks (target, digest, foreign_revision, foreign_published_at, passes_validation, validation_error, acknowledged_by)
    values (p_target, p_digest, p_foreign_revision, p_foreign_published_at, p_passes_validation, p_validation_error, p_acknowledged_by);
  insert into public.gear_audit_log (actor, event, detail) values (p_acknowledged_by, 'drift_acknowledged',
    jsonb_build_object('target', p_target, 'digest', p_digest, 'passesValidation', p_passes_validation));
end $$;

create function public.gear_audit(p_actor uuid, p_event text, p_detail jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.gear_audit_log (actor, event, detail) values (p_actor, p_event, coalesce(p_detail, '{}'::jsonb))
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.gear_acquire_lease(text, integer)', 'public.gear_release_lease(text, uuid)',
    'public.gear_record_publication(uuid, text, uuid, uuid, bigint, text, text, text, integer, uuid, text, uuid, text, jsonb)',
    'public.gear_record_status(uuid, uuid, text, text)',
    'public.gear_record_drift_ack(uuid, text, text, text, bigint, boolean, text, uuid)',
    'public.gear_audit(uuid, text, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function private.gear_require_lease(text, uuid) from public, anon, authenticated;
revoke all on function private.gear_publication_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- Storage (LOCAL bucket only)
-- The live project's bucket already exists (STAGING_SETUP.md); this creates the local equivalent:
-- public read, PNG/JPEG/JSON only, and NO storage.objects policies, so anon and authenticated
-- clients cannot write. Only a secret/service key (used by gear-publish) can.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recommended-gear', 'recommended-gear', true, 5242880, array['application/json', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;
