-- Fix found by the full run on d0c02eb: a duplicate request whose lookup ran before the original
-- committed reached gear_prepare_intent after the commit and was refused (operation_conflict) by the
-- "already published" check, instead of getting the original back. An existing intent for the same
-- operation is now returned first, exactly as before that check; the retired/published refusal only
-- applies when no intent exists (for example after cleanup).
create or replace function public.gear_prepare_intent(p jsonb) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare i private.gear_publish_intents;
begin
  if not exists (select 1 from private.gear_publish_intents w where w.operation_id = (p ->> 'operation_id')::uuid) then
    if exists (select 1 from private.gear_retired_operations r where r.operation_id = (p ->> 'operation_id')::uuid)
       or exists (select 1 from public.gear_catalog_publications c where c.operation_id = (p ->> 'operation_id')::uuid) then
      raise exception 'operation_conflict: this operation ID was already used' using errcode = 'PT409';
    end if;
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
