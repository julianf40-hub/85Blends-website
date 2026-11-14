-- Recommended Gear: operation IDs bound to publisher, environment and request content, and cleanup of
-- pending operations without losing replay protection for committed ones. LOCAL, fictional.
--
-- request_digest is the function's fingerprint of the request: target, action, review digest, draft
-- version, expected head and rollback source. It is stored on the pending intent AND, at commit, on the
-- append-only publication. A retry is recognized from either place and must match publisher, target
-- and fingerprint; anything else is operation_conflict. Because committed operations are recognized from
-- gear_catalog_publications (never deleted), intents can be cleaned up without enabling a second
-- publication on retry.

alter table public.gear_catalog_publications add column request_digest text;

create or replace function public.gear_commit_publication(p_operation_id uuid) returns jsonb
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


-- Finds an operation: pending (intent) or committed (publication). Service only.
create function public.gear_find_operation(p_operation_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('operation_id', i.operation_id, 'target', i.target, 'user_id', i.user_id, 'request_digest', i.request_digest,
       'publication_id', i.publication_id, 'state', case when i.publication_id is null then 'pending' else 'committed' end)
     from private.gear_publish_intents i where i.operation_id = p_operation_id),
    (select jsonb_build_object('operation_id', p.operation_id, 'target', p.target, 'user_id', p.published_by, 'request_digest', p.request_digest,
       'publication_id', p.id, 'state', 'committed')
     from public.gear_catalog_publications p where p.operation_id = p_operation_id))
$$;

-- The original result of a committed operation (for replays answered by the function). Service only.
create function public.gear_operation_result(p_operation_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select private.gear_publication_result(p.id, true) from public.gear_catalog_publications p where p.operation_id = p_operation_id
$$;

-- Cleanup (service only; scheduled hourly on a hosted project, on demand locally):
--   - pending intents that expired more than p_pending_grace ago: never committed, so a retry simply
--     prepares again against the current review (it cannot produce a second publication: there was no first);
--   - committed intents older than p_committed_retention: their replay protection lives on in
--     gear_catalog_publications.operation_id + request_digest, which are append-only.
create function public.gear_cleanup_operations(p_pending_grace interval default '1 hour', p_committed_retention interval default '7 days')
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pending integer; v_committed integer;
begin
  delete from private.gear_publish_intents i where i.publication_id is null and i.expires_at < clock_timestamp() - p_pending_grace;
  get diagnostics v_pending = row_count;
  delete from private.gear_publish_intents i where i.publication_id is not null and i.created_at < clock_timestamp() - p_committed_retention
    and exists (select 1 from public.gear_catalog_publications p where p.id = i.publication_id and p.operation_id = i.operation_id and p.request_digest is not null);
  get diagnostics v_committed = row_count;
  insert into public.gear_audit_log (actor, event, detail) values (null, 'operations_cleanup',
    jsonb_build_object('pending_deleted', v_pending, 'committed_deleted', v_committed));
  return jsonb_build_object('pendingDeleted', v_pending, 'committedDeleted', v_committed);
end $$;

revoke all on function public.gear_find_operation(uuid), public.gear_operation_result(uuid),
  public.gear_cleanup_operations(interval, interval) from public, anon, authenticated;
grant execute on function public.gear_find_operation(uuid), public.gear_operation_result(uuid),
  public.gear_cleanup_operations(interval, interval) to service_role;
