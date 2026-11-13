-- LEGACY STORAGE PATH, EXPERIMENTAL EVIDENCE ONLY (not in the migration/deployment path; superseded by
-- decision D10 option 2, the database pointer). A commit-time guard for catalog objects.
--
-- Why: Storage runs RLS as a rolled-back dry run before the body arrives, then writes the row as a
-- superuser with no RLS (storage-api `Uploader.completeUpload`). The publication-safety review
-- (tests/publication_safety.test.mjs) showed two consequences:
--   PS1b: a publisher authorized on the headers, paused mid-body past its lease, overwrote a newer
--         verified publication when it resumed;
--   PS2:  two simultaneous requests both used one single-use grant (nothing persists in the dry run).
-- Triggers are not bypassed by superuser writes, and this BEFORE trigger runs inside the transaction
-- that actually commits the object row (Storage holds its per-object lock there). So it can consume
-- the grant atomically and re-check the lease, compare-and-swap, uploader, real size and real content
-- (the backend eTag, which is the MD5 of a single-part upload) at commit time.
--
-- Open hosted questions (plan §12 B): whether a project may add triggers to storage.objects (owned by
-- supabase_storage_admin), whether hosted Storage still writes the row through this path, and whether
-- the hosted eTag is the MD5 of the bytes (it is not for S3 multipart or some encryption modes).
-- Writes without a grant and without an owner (service/secret key) are NOT blocked here: they remain
-- the detected-drift case, unchanged.

create function private.gear_catalog_commit_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_target text := private.gear_object_target(new.name);
  v_nonce text := new.user_metadata ->> 'gear_write';
  v_key text := new.bucket_id || '/' || new.name;
  is_commit boolean := new.metadata ? 'eTag'; -- the RLS dry run carries only {mimetype, contentLength}
  v_exists boolean;
  v_old_version text;
  g private.gear_write_grants;
  h public.gear_publication_head;
  doc text;
begin
  if new.bucket_id <> 'recommended-gear' or v_target is null then return new; end if;

  if tg_op = 'INSERT' then
    -- Storage writes with INSERT ... ON CONFLICT DO UPDATE. This BEFORE INSERT trigger fires first and
    -- sees exactly what the caller sent, so the decision is made here; the UPDATE phase of the same
    -- statement defers to it (below). An overwrite that omits user_metadata would otherwise keep the
    -- old row's nonce, and a replayed nonce would look unchanged: neither may decide the outcome.
    perform set_config('gear.commit_guard.decided', v_key, true);
    -- No grant nonce: only a key holder (service/secret key, which bypasses RLS) can get here, because
    -- the RLS dry run refuses every signed-in caller without a live nonce. Not prevented: detected drift.
    if v_nonce is null then return new; end if;
    select true, o.version into v_exists, v_old_version from storage.objects o where o.bucket_id = new.bucket_id and o.name = new.name;
    v_exists := coalesce(v_exists, false);
  else
    if current_setting('gear.commit_guard.decided', true) = v_key then
      perform set_config('gear.commit_guard.decided', '', true);
      return new; -- the INSERT phase of this upsert already decided
    end if;
    -- A plain UPDATE (not part of an upsert) that does not carry a new nonce: not a grant write.
    if v_nonce is null or new.user_metadata is not distinct from old.user_metadata then return new; end if;
    v_exists := true;
    v_old_version := old.version;
  end if;

  -- Consume the grant in this transaction. A second request using the same nonce finds nothing.
  delete from private.gear_write_grants w where w.target = v_target and w.nonce::text = v_nonce returning * into g;
  if g.nonce is null then
    raise exception 'gear_commit_refused: no live single-use write grant (already used, expired, revoked or never issued)' using errcode = 'PT403';
  end if;
  select * into h from public.gear_publication_head x where x.target = v_target;
  if h.lease_token is distinct from g.lease_token or h.lease_expires_at < clock_timestamp() or g.expires_at < clock_timestamp() then
    raise exception 'gear_commit_refused: the publish lease expired or was taken over before the upload committed' using errcode = 'PT403';
  end if;
  if g.object_name <> new.name or g.user_id::text is distinct from new.owner_id then
    raise exception 'gear_commit_refused: grant is for another object or uploader' using errcode = 'PT403';
  end if;
  if not h.expected_object_known
     or (v_exists and h.expected_object_version is distinct from v_old_version)
     or (not v_exists and h.expected_object_version is not null) then
    raise exception 'gear_commit_refused: the object changed since it was prepared (compare-and-swap)' using errcode = 'PT403';
  end if;
  if is_commit then
    select p.document into doc from public.gear_catalog_publications p where p.id = g.publication_id;
    if (new.metadata ->> 'size')::bigint is distinct from g.declared_size
       or new.metadata ->> 'eTag' is distinct from '"' || md5(convert_to(doc, 'UTF8')) || '"' then
      raise exception 'gear_commit_refused: stored bytes are not the recorded publication' using errcode = 'PT403';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.gear_catalog_commit_guard() from public, anon, authenticated;

create trigger gear_catalog_commit_guard before insert or update on storage.objects
  for each row execute function private.gear_catalog_commit_guard();
