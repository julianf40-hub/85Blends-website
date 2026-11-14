-- Independent-review fixes for the operation lifecycle (current design).
--   1. Cleanup kept no record of an expired pending operation, so its operation ID could later be bound
--      to a different publisher, environment or content. It now leaves a small tombstone
--      (operation_id, user_id, target, request_digest); the bulky document is still deleted.
--   2. gear_prepare_intent refuses an operation ID that is retired or already published (defense in depth;
--      gear-publish checks first).
--   3. The read RPC also checks that the pointed-to publication belongs to the requested target.

create table private.gear_retired_operations (
  operation_id uuid primary key,
  user_id uuid not null references auth.users (id),
  target text not null check (target in ('staging', 'production')),
  request_digest text not null,
  retired_at timestamptz not null default clock_timestamp()
);
revoke all on private.gear_retired_operations from public, anon, authenticated;

create or replace function public.gear_find_operation(p_operation_id uuid) returns jsonb
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

create or replace function public.gear_cleanup_operations(p_pending_grace interval default '1 hour', p_committed_retention interval default '7 days')
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

create or replace function public.gear_prepare_intent(p jsonb) returns jsonb
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

create or replace function public.gear_current_catalog(p_target text) returns table (document text, digest text, revision uuid, published_at bigint)
  language sql stable security definer set search_path = '' as $$
  select p.document, p.digest, p.revision, p.published_at
  from public.gear_publication_head h join public.gear_catalog_publications p on p.id = h.current_publication_id and p.target = h.target
  where h.target = p_target
$$;
