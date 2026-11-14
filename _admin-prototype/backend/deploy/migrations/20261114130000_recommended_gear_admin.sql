-- Recommended Gear admin: DEPLOYMENT migration (squashed; current design only, decision D10 option 2).
--
-- Source of truth for what a hosted project receives. It contains ONLY the database-pointer design:
--   * administrators (single publisher) and the aal2 role check;
--   * the shared draft with an optimistic version lock;
--   * publications (exact bytes + SHA-256), the per-target current-publication pointer, status and
--     audit logs (append-only), and a publication guard trigger;
--   * private publish intents, the commit RPC (called with the publisher's JWT), operation lookup,
--     replay and cleanup (service role);
--   * the anon-readable current-catalog read RPC used by the gear-catalog endpoint;
--   * immutable, content-addressed image uploads (insert-only Storage policies, single-use grants).
-- Works the same on a fresh project and on the existing live project: it creates only new objects
-- and never alters the existing recommended-gear bucket (see deploy/ROLLOUT.md).
-- It deliberately contains NONE of the superseded Storage publication path: no leases, no write
-- grants for catalog objects, no catalog Storage policies, no drift acknowledgements, no commit-guard
-- trigger. Checked by tests/deploy_package.test.mjs.
--

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

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
revoke all on function private.gear_role() from public;
grant execute on function private.gear_role() to authenticated;

create table public.gear_settings (
  id boolean primary key default true check (id),
  production_step_up_seconds integer not null default 900 check (production_step_up_seconds between 30 and 3600)
);
insert into public.gear_settings default values;

-- ---------------------------------------------------------------- drafts
create table public.gear_catalog_drafts (
  id text primary key default 'main' check (id = 'main'),
  catalog jsonb not null,
  meta jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version >= 1),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);
insert into public.gear_catalog_drafts (id, catalog) values ('main', '{"schemaVersion": 1, "brands": []}'::jsonb);

-- ---------------------------------------------------------------- publications
create table public.gear_catalog_publications (
  id uuid primary key default gen_random_uuid(),
  target text not null check (target in ('staging', 'production')),
  revision uuid not null unique,
  published_at bigint not null check (published_at > 0),
  document text not null,                -- the exact bytes served
  digest text not null,                  -- SHA-256 of those bytes
  summary text not null,
  draft_version integer,
  rollback_of uuid references public.gear_catalog_publications (id),
  validator_version text not null,
  published_by uuid not null references auth.users (id),
  auth_aal text not null,
  auth_amr jsonb not null default '[]'::jsonb,
  operation_id uuid,
  request_digest text,
  created_at timestamptz not null default now(),
  unique (target, published_at)
);
create unique index gear_catalog_publications_operation_id on public.gear_catalog_publications (operation_id) where operation_id is not null;

create table public.gear_publication_head (
  target text primary key check (target in ('staging', 'production')),
  current_publication_id uuid references public.gear_catalog_publications (id),
  revision uuid,
  published_at bigint,
  digest text
);
insert into public.gear_publication_head (target) values ('staging'), ('production');

create table public.gear_publication_status (
  id bigserial primary key,
  publication_id uuid not null references public.gear_catalog_publications (id),
  status text not null check (status in ('committed')),
  note text,
  at timestamptz not null default clock_timestamp()
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
create trigger gear_audit_append_only before update or delete on public.gear_audit_log
  for each row execute function private.gear_append_only();
revoke all on function private.gear_publication_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- RLS
alter table public.gear_admins enable row level security;
alter table public.gear_settings enable row level security;
alter table public.gear_catalog_drafts enable row level security;
alter table public.gear_publication_head enable row level security;
alter table public.gear_catalog_publications enable row level security;
alter table public.gear_publication_status enable row level security;
alter table public.gear_audit_log enable row level security;

create policy "admins read own row" on public.gear_admins for select to authenticated using (user_id = (select auth.uid()));
create policy "aal2 admins read drafts" on public.gear_catalog_drafts for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read heads" on public.gear_publication_head for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read publications" on public.gear_catalog_publications for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read status" on public.gear_publication_status for select to authenticated using ((select private.gear_role()) is not null);
create policy "aal2 admins read audit" on public.gear_audit_log for select to authenticated using ((select private.gear_role()) is not null);

-- No write policies anywhere; also remove the default table grants for client roles.
revoke insert, update, delete, truncate, references, trigger on
  public.gear_admins, public.gear_settings, public.gear_catalog_drafts, public.gear_publication_head,
  public.gear_catalog_publications, public.gear_publication_status, public.gear_audit_log
  from anon, authenticated;
revoke select on
  public.gear_admins, public.gear_settings, public.gear_catalog_drafts, public.gear_publication_head,
  public.gear_catalog_publications, public.gear_publication_status, public.gear_audit_log
  from anon;
revoke select on public.gear_settings from authenticated;

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

create function public.gear_audit(p_actor uuid, p_event text, p_detail jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.gear_audit_log (actor, event, detail) values (p_actor, p_event, coalesce(p_detail, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------- publish intents (service-written)
create table private.gear_publish_intents (
  operation_id uuid primary key,
  target text not null check (target in ('staging', 'production')),
  user_id uuid not null references auth.users (id),
  request_digest text not null,            -- fingerprint of the request: target, action, review, draft, head, rollback source
  revision uuid not null unique,
  published_at bigint not null check (published_at > 0),
  document text not null,
  digest text not null,
  summary text not null,
  expected_publication_id uuid references public.gear_catalog_publications (id),
  draft_version integer,
  rollback_of uuid references public.gear_catalog_publications (id),
  validator_version text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  publication_id uuid unique references public.gear_catalog_publications (id),
  check ((draft_version is null) = (rollback_of is not null)),
  check (digest = encode(pg_catalog.sha256(convert_to(document, 'UTF8')), 'hex'))
);
revoke all on private.gear_publish_intents from public, anon, authenticated;

create function public.gear_prepare_intent(p jsonb) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare i private.gear_publish_intents;
begin
  if exists (select 1 from private.gear_retired_operations r where r.operation_id = (p ->> 'operation_id')::uuid)
     or exists (select 1 from public.gear_catalog_publications c where c.operation_id = (p ->> 'operation_id')::uuid) then
    raise exception 'operation_conflict: this operation ID was already used' using errcode = 'PT409';
  end if;
  insert into private.gear_publish_intents (operation_id, target, user_id, request_digest, revision, published_at, document, digest,
    summary, expected_publication_id, draft_version, rollback_of, validator_version, expires_at)
  values ((p ->> 'operation_id')::uuid, p ->> 'target', (p ->> 'user_id')::uuid, p ->> 'request_digest', (p ->> 'revision')::uuid,
    (p ->> 'published_at')::bigint, p ->> 'document', p ->> 'digest', p ->> 'summary', (p ->> 'expected_publication_id')::uuid,
    (p ->> 'draft_version')::integer, (p ->> 'rollback_of')::uuid, p ->> 'validator_version', clock_timestamp() + interval '10 minutes')
  on conflict (operation_id) do nothing;
  select * into i from private.gear_publish_intents w where w.operation_id = (p ->> 'operation_id')::uuid;
  return jsonb_build_object('operation_id', i.operation_id, 'target', i.target, 'user_id', i.user_id, 'request_digest', i.request_digest,
    'revision', i.revision, 'publication_id', i.publication_id, 'created', i.revision = (p ->> 'revision')::uuid);
end $$;

create function private.gear_publication_result(p_publication_id uuid, p_replayed boolean) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('publicationId', p.id, 'target', p.target, 'revision', p.revision, 'publishedAt', p.published_at,
    'digest', p.digest, 'bytes', octet_length(convert_to(p.document, 'UTF8')), 'summary', p.summary, 'operationId', p.operation_id,
    'rollbackOf', p.rollback_of, 'replayed', p_replayed)
  from public.gear_catalog_publications p where p.id = p_publication_id
$$;

-- The commit: called WITH THE PUBLISHER'S JWT. One transaction, under a row lock on the target head.
create function public.gear_commit_publication(p_operation_id uuid) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  i private.gear_publish_intents;
  h public.gear_publication_head;
  v_draft integer;
  v_window integer;
  v_pub uuid;
  v_claims jsonb := auth.jwt();
begin
  if private.gear_role() is distinct from 'publisher' then
    raise exception 'publisher_required: only the publisher, with aal2, can commit a publication' using errcode = 'PT403';
  end if;
  select * into i from private.gear_publish_intents w where w.operation_id = p_operation_id for update;
  if i.operation_id is null then
    raise exception 'unknown_operation: no prepared publication with this operation ID' using errcode = 'PT404';
  end if;
  if i.user_id is distinct from auth.uid() then
    raise exception 'not_your_operation: prepared for another account' using errcode = 'PT403';
  end if;
  if i.publication_id is not null then
    return private.gear_publication_result(i.publication_id, true); -- a retry of a committed operation
  end if;
  if i.expires_at < clock_timestamp() then
    raise exception 'operation_expired: prepared more than 10 minutes ago; review again' using errcode = 'PT409';
  end if;
  if i.target = 'production' then
    select production_step_up_seconds into v_window from public.gear_settings;
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_claims -> 'amr', '[]'::jsonb)) e
      where e ->> 'method' = 'totp' and (e ->> 'timestamp')::bigint >= extract(epoch from clock_timestamp())::bigint - v_window
    ) then
      raise exception 'mfa_step_up_required: Production needs a TOTP verification within the last % s', v_window using errcode = 'PT403';
    end if;
  end if;

  -- Serializes commits per target. The pointer must still be the one the review saw.
  select * into h from public.gear_publication_head x where x.target = i.target for update;
  if h.current_publication_id is distinct from i.expected_publication_id then
    raise exception 'head_changed: % changed since it was reviewed', i.target using errcode = 'PT409';
  end if;
  if i.rollback_of is null then
    select d.version into v_draft from public.gear_catalog_drafts d where d.id = 'main' for share;
    if v_draft is distinct from i.draft_version then
      raise exception 'draft_changed: the draft is now version %; the reviewed version was %', v_draft, i.draft_version using errcode = 'PT409';
    end if;
  end if;
  if h.published_at is not null and i.published_at <= h.published_at then
    raise exception 'not_newer: publishedAt % is not after the current %', i.published_at, h.published_at using errcode = 'PT409';
  end if;

  insert into public.gear_catalog_publications (target, revision, published_at, document, digest, summary, draft_version, rollback_of,
    validator_version, published_by, auth_aal, auth_amr, operation_id, request_digest)
  values (i.target, i.revision, i.published_at, i.document, i.digest, i.summary, i.draft_version, i.rollback_of,
    i.validator_version, auth.uid(), v_claims ->> 'aal', coalesce(v_claims -> 'amr', '[]'::jsonb), i.operation_id, i.request_digest)
  returning id into v_pub;
  update public.gear_publication_head set current_publication_id = v_pub, revision = i.revision, published_at = i.published_at, digest = i.digest
    where target = i.target;
  update private.gear_publish_intents set publication_id = v_pub where operation_id = i.operation_id;
  insert into public.gear_publication_status (publication_id, status, note) values (v_pub, 'committed', 'database pointer advanced');
  insert into public.gear_audit_log (actor, event, detail) values (auth.uid(), 'publication_committed',
    jsonb_build_object('target', i.target, 'revision', i.revision, 'operation_id', i.operation_id, 'rollback_of', i.rollback_of));
  return private.gear_publication_result(v_pub, false);
end $$;

-- Retired operations: the binding of a pending operation that expired and was cleaned up.
create table private.gear_retired_operations (
  operation_id uuid primary key,
  user_id uuid not null references auth.users (id),
  target text not null check (target in ('staging', 'production')),
  request_digest text not null,
  retired_at timestamptz not null default clock_timestamp()
);
revoke all on private.gear_retired_operations from public, anon, authenticated;

-- Operations: pending (intent) or committed (publication, append-only). Replays and cleanup.
create function public.gear_find_operation(p_operation_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('operation_id', i.operation_id, 'target', i.target, 'user_id', i.user_id, 'request_digest', i.request_digest,
       'publication_id', i.publication_id, 'state', case when i.publication_id is null then 'pending' else 'committed' end)
     from private.gear_publish_intents i where i.operation_id = p_operation_id),
    (select jsonb_build_object('operation_id', p.operation_id, 'target', p.target, 'user_id', p.published_by, 'request_digest', p.request_digest,
       'publication_id', p.id, 'state', 'committed')
     from public.gear_catalog_publications p where p.operation_id = p_operation_id),
    (select jsonb_build_object('operation_id', r.operation_id, 'target', r.target, 'user_id', r.user_id, 'request_digest', r.request_digest,
       'publication_id', null, 'state', 'retired')
     from private.gear_retired_operations r where r.operation_id = p_operation_id))
$$;

create function public.gear_operation_result(p_operation_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select private.gear_publication_result(p.id, true) from public.gear_catalog_publications p where p.operation_id = p_operation_id
$$;

create function public.gear_cleanup_operations(p_pending_grace interval default '1 hour', p_committed_retention interval default '7 days')
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pending integer; v_committed integer;
begin
  -- Expired pending operations: keep the binding as a tombstone, drop the document.
  with gone as (
    delete from private.gear_publish_intents i where i.publication_id is null and i.expires_at < clock_timestamp() - p_pending_grace
    returning i.operation_id, i.user_id, i.target, i.request_digest)
  insert into private.gear_retired_operations (operation_id, user_id, target, request_digest)
  select operation_id, user_id, target, request_digest from gone
  on conflict (operation_id) do nothing;
  get diagnostics v_pending = row_count;
  -- Committed operations: the append-only publication keeps operation_id + request_digest.
  delete from private.gear_publish_intents i where i.publication_id is not null and i.created_at < clock_timestamp() - p_committed_retention
    and exists (select 1 from public.gear_catalog_publications p where p.id = i.publication_id and p.operation_id = i.operation_id and p.request_digest is not null);
  get diagnostics v_committed = row_count;
  insert into public.gear_audit_log (actor, event, detail) values (null, 'operations_cleanup',
    jsonb_build_object('pending_retired', v_pending, 'committed_deleted', v_committed));
  return jsonb_build_object('pendingDeleted', v_pending, 'committedDeleted', v_committed);
end $$;

create function public.gear_intent_overview() returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'uncommitted', count(*) filter (where i.publication_id is null),
    'expired_uncommitted', count(*) filter (where i.publication_id is null and i.expires_at < clock_timestamp()))
  from private.gear_publish_intents i
$$;

-- ---------------------------------------------------------------- read path (anyone, guests included)
create function public.gear_current_catalog(p_target text) returns table (document text, digest text, revision uuid, published_at bigint)
  language sql stable security definer set search_path = '' as $$
  select p.document, p.digest, p.revision, p.published_at
  from public.gear_publication_head h join public.gear_catalog_publications p on p.id = h.current_publication_id and p.target = h.target
  where h.target = p_target
$$;

-- ---------------------------------------------------------------- images (immutable Storage objects)
-- Gear images get their OWN bucket. The existing recommended-gear bucket (old catalog objects, read
-- by installed app builds and written by the current publisher) is never touched by this migration:
-- not its settings, not its policies, not its objects. On a fresh project it simply does not exist.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recommended-gear-images', 'recommended-gear-images', true, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

create table private.gear_image_grants (
  name text primary key check (name ~ '^images/[a-z0-9-]{1,64}/[a-f0-9]{64}\.(png|jpg)$'),
  nonce uuid not null,
  user_id uuid not null references auth.users (id),
  declared_size bigint not null check (declared_size between 1 and 5000000),
  content_type text not null check (content_type in ('image/png', 'image/jpeg')),
  expires_at timestamptz not null
);
revoke all on private.gear_image_grants from public, anon, authenticated;

create function public.gear_authorize_image(p_name text, p_user_id uuid, p_size bigint, p_content_type text) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if not exists (select 1 from public.gear_admins a where a.user_id = p_user_id) then
    raise exception 'not_admin: image grants are issued only to gear administrators' using errcode = 'PT403';
  end if;
  delete from private.gear_image_grants where expires_at < clock_timestamp();
  insert into private.gear_image_grants as g (name, nonce, user_id, declared_size, content_type, expires_at)
  values (p_name, gen_random_uuid(), p_user_id, p_size, p_content_type, clock_timestamp() + interval '60 seconds')
  on conflict (name) do update set nonce = excluded.nonce, user_id = excluded.user_id, declared_size = excluded.declared_size,
    content_type = excluded.content_type, expires_at = excluded.expires_at
  returning g.nonce into result;
  return result;
end $$;

create function public.gear_consume_image(p_name text) returns void
  language sql security definer set search_path = '' as $$
  delete from private.gear_image_grants where name = p_name
$$;

create function private.gear_image_write_allowed(p_name text, p_metadata jsonb, p_user_metadata jsonb) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
declare g private.gear_image_grants;
begin
  if private.gear_role() is null then return false; end if; -- an aal2 admin (editor or publisher)
  select * into g from private.gear_image_grants w where w.name = p_name;
  return g.nonce is not null
     and g.expires_at >= clock_timestamp()
     and g.user_id = auth.uid()
     and coalesce(p_user_metadata ->> 'gear_image', '') = g.nonce::text
     and coalesce((p_metadata ->> 'contentLength')::bigint, -1) = g.declared_size
     and coalesce(p_metadata ->> 'mimetype', '') = g.content_type;
end $$;
revoke all on function private.gear_image_write_allowed(text, jsonb, jsonb) from public, anon;
grant execute on function private.gear_image_write_allowed(text, jsonb, jsonb) to authenticated;

create policy "gear images insert: aal2 admin with a single-use image grant" on storage.objects for insert to authenticated
  with check (bucket_id = 'recommended-gear-images' and name ~ '^images/[a-z0-9-]{1,64}/[a-f0-9]{64}\.(png|jpg)$'
              and private.gear_image_write_allowed(name, metadata, user_metadata));
create policy "gear images read: aal2 admins" on storage.objects for select to authenticated
  using (bucket_id = 'recommended-gear-images' and name like 'images/%' and private.gear_role() is not null);

create function public.gear_image_objects(p_names text[]) returns table (name text, size bigint, mimetype text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
    from storage.objects o where o.bucket_id = 'recommended-gear-images' and o.name = any (p_names)
$$;
create function public.gear_list_images() returns table (name text, size bigint, mimetype text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
    from storage.objects o where o.bucket_id = 'recommended-gear-images' and o.name like 'images/%' order by o.created_at
$$;

-- ---------------------------------------------------------------- grants
revoke all on function private.gear_publication_result(uuid, boolean) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public.gear_audit(uuid, text, jsonb)', 'public.gear_prepare_intent(jsonb)', 'public.gear_find_operation(uuid)',
    'public.gear_operation_result(uuid)', 'public.gear_cleanup_operations(interval, interval)', 'public.gear_intent_overview()',
    'public.gear_authorize_image(text, uuid, bigint, text)', 'public.gear_consume_image(text)',
    'public.gear_image_objects(text[])', 'public.gear_list_images()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function public.gear_commit_publication(uuid) from public, anon, authenticated;
grant execute on function public.gear_commit_publication(uuid) to authenticated;
revoke all on function public.gear_current_catalog(text) from public, anon, authenticated;
grant execute on function public.gear_current_catalog(text) to anon, authenticated, service_role;
