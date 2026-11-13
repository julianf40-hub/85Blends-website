-- Recommended Gear: the database is the publication channel (decision D10, option 2). LOCAL, fictional.
--
-- A publication is committed by ONE database transaction that records the exact catalog bytes and
-- their digest and advances the target's current-publication pointer, guarded by a compare-and-swap
-- on that pointer. Apps read the current publication through the read-only gear-catalog endpoint.
-- Storage keeps only immutable, content-addressed images. The mutable catalog-v1.json objects are no
-- longer written by anything in this path (their write policies are dropped below) and are not
-- authoritative.
--
-- Commit flow:
--   1. gear-publish (service role) validates, stamps and stores the exact bytes as a private INTENT,
--      keyed by the client's operation ID, bound to the reviewed draft version (or rollback source)
--      and to the pointer the review saw.
--   2. gear-publish calls gear_commit_publication(operation_id) WITH THE PUBLISHER'S OWN JWT. The
--      database itself checks publisher, aal2 and the Production step-up, then, under a row lock on
--      the pointer: the pointer is still the reviewed one (CAS), the draft is still the reviewed
--      version, and it inserts the publication and advances the pointer, in one transaction.
--   3. A repeated commit of the same operation returns the original publication (idempotent).

-- 1. pointer and idempotency ----------------------------------------------------------------------
alter table public.gear_publication_head add column current_publication_id uuid references public.gear_catalog_publications (id);
update public.gear_publication_head h set current_publication_id = p.id
  from public.gear_catalog_publications p where p.revision = h.revision and p.target = h.target;

alter table public.gear_catalog_publications add column operation_id uuid;
create unique index gear_catalog_publications_operation_id on public.gear_catalog_publications (operation_id) where operation_id is not null;

alter table public.gear_publication_status drop constraint gear_publication_status_status_check;
alter table public.gear_publication_status add constraint gear_publication_status_status_check
  check (status in ('recorded', 'verified', 'uncertain', 'conflict', 'refused', 'committed'));

-- 2. intents (service-written, never readable by clients) ------------------------------------------
create table private.gear_publish_intents (
  operation_id uuid primary key,
  target text not null check (target in ('staging', 'production')),
  user_id uuid not null references auth.users (id),
  request_digest text not null,            -- what the client asked for: the review digest it sent
  revision uuid not null unique,
  published_at bigint not null check (published_at > 0),
  document text not null,                  -- the exact bytes that will be served
  digest text not null,
  summary text not null,
  expected_publication_id uuid references public.gear_catalog_publications (id), -- the reviewed baseline
  draft_version integer,                   -- the reviewed draft version (null for a rollback)
  rollback_of uuid references public.gear_catalog_publications (id),
  validator_version text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  publication_id uuid unique references public.gear_catalog_publications (id), -- set by the commit
  check ((draft_version is null) = (rollback_of is not null)),
  check (digest = encode(pg_catalog.sha256(convert_to(document, 'UTF8')), 'hex'))
);
revoke all on private.gear_publish_intents from public, anon, authenticated;

-- Insert-or-return. Concurrent duplicates with the same operation ID resolve to one row.
create function public.gear_prepare_intent(p jsonb) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare i private.gear_publish_intents;
begin
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

create function public.gear_find_intent(p_operation_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('operation_id', i.operation_id, 'target', i.target, 'user_id', i.user_id, 'request_digest', i.request_digest,
    'revision', i.revision, 'publication_id', i.publication_id)
  from private.gear_publish_intents i where i.operation_id = p_operation_id
$$;

create function private.gear_publication_result(p_publication_id uuid, p_replayed boolean) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('publicationId', p.id, 'target', p.target, 'revision', p.revision, 'publishedAt', p.published_at,
    'digest', p.digest, 'bytes', octet_length(convert_to(p.document, 'UTF8')), 'summary', p.summary, 'operationId', p.operation_id,
    'rollbackOf', p.rollback_of, 'replayed', p_replayed)
  from public.gear_catalog_publications p where p.id = p_publication_id
$$;

-- 3. the commit: called with the publisher's JWT ---------------------------------------------------
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
    validator_version, published_by, auth_aal, auth_amr, operation_id)
  values (i.target, i.revision, i.published_at, i.document, i.digest, i.summary, i.draft_version, i.rollback_of,
    i.validator_version, auth.uid(), v_claims ->> 'aal', coalesce(v_claims -> 'amr', '[]'::jsonb), i.operation_id)
  returning id into v_pub;
  update public.gear_publication_head set current_publication_id = v_pub, revision = i.revision, published_at = i.published_at, digest = i.digest
    where target = i.target;
  update private.gear_publish_intents set publication_id = v_pub where operation_id = i.operation_id;
  insert into public.gear_publication_status (publication_id, status, note) values (v_pub, 'committed', 'database pointer advanced');
  insert into public.gear_audit_log (actor, event, detail) values (auth.uid(), 'publication_committed',
    jsonb_build_object('target', i.target, 'revision', i.revision, 'operation_id', i.operation_id, 'rollback_of', i.rollback_of));
  return private.gear_publication_result(v_pub, false);
end $$;

-- 4. the read path: anyone (guests included) ------------------------------------------------------
-- One statement, so the bytes, digest, revision and publishedAt always come from the same row.
create function public.gear_current_catalog(p_target text) returns table (document text, digest text, revision uuid, published_at bigint)
  language sql stable security definer set search_path = '' as $$
  select p.document, p.digest, p.revision, p.published_at
  from public.gear_publication_head h join public.gear_catalog_publications p on p.id = h.current_publication_id
  where h.target = p_target
$$;

-- For the verifier: prepared publications that were never committed (stale or abandoned reviews).
create function public.gear_intent_overview() returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'uncommitted', count(*) filter (where i.publication_id is null),
    'expired_uncommitted', count(*) filter (where i.publication_id is null and i.expires_at < clock_timestamp()))
  from private.gear_publish_intents i
$$;
revoke all on function public.gear_intent_overview() from public, anon, authenticated;
grant execute on function public.gear_intent_overview() to service_role;

-- 5. grants ---------------------------------------------------------------------------------------
revoke all on function public.gear_prepare_intent(jsonb), public.gear_find_intent(uuid), private.gear_publication_result(uuid, boolean),
  public.gear_commit_publication(uuid), public.gear_current_catalog(text) from public, anon, authenticated;
grant execute on function public.gear_prepare_intent(jsonb), public.gear_find_intent(uuid) to service_role;
grant execute on function public.gear_commit_publication(uuid) to authenticated;
grant execute on function public.gear_current_catalog(text) to anon, authenticated, service_role;

-- 6. no second publication channel ----------------------------------------------------------------
-- The mutable catalog objects are no longer written by any client path.
drop policy "gear catalog insert: publisher, aal2, single-use write grant" on storage.objects;
drop policy "gear catalog update: grant + CAS on prepared version" on storage.objects;
-- The Storage-path RPCs (lease, record, status, drift acknowledgement, write grants) can no longer be
-- called by anyone but the database owner. The legacy demonstrations re-grant them in a local fixture
-- (supabase/experimental/legacy-storage-path/), which is not part of this migration path.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('gear_acquire_lease', 'gear_release_lease', 'gear_record_publication',
             'gear_record_status', 'gear_record_drift_ack', 'gear_prepare_write', 'gear_authorize_write', 'gear_consume_write',
             'gear_lease_overview') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;
