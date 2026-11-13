-- Recommended Gear admin backend: validated image uploads and verifier support (LOCAL, fictional).
--
-- Images live at images/<brandId>/<sha256>.<png|jpg> in the public bucket. gear-publish validates
-- the bytes (type sniffing, PNG/JPEG only, dimensions, size, sha256 = name), then issues a
-- single-use image grant bound to the path, the uploading admin, the declared size and type.
-- Storage RLS allows INSERT only: no UPDATE (never overwritten) and no DELETE policy (nothing is
-- deleted automatically; the verifier only reports unreferenced images).
-- Same Storage limitation as catalogs: RLS sees only declared metadata before the bytes arrive, so
-- byte-level validity depends on the function (and is re-checked by the verifier).

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
  with check (bucket_id = 'recommended-gear' and name ~ '^images/[a-z0-9-]{1,64}/[a-f0-9]{64}\.(png|jpg)$'
              and private.gear_image_write_allowed(name, metadata, user_metadata));
create policy "gear images read: aal2 admins" on storage.objects for select to authenticated
  using (bucket_id = 'recommended-gear' and name like 'images/%' and private.gear_role() is not null);

-- Read-only listings for review checks and the verifier (service role only).
create function public.gear_image_objects(p_names text[]) returns table (name text, size bigint, mimetype text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
    from storage.objects o where o.bucket_id = 'recommended-gear' and o.name = any (p_names)
$$;
create function public.gear_list_images() returns table (name text, size bigint, mimetype text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select o.name, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.created_at
    from storage.objects o where o.bucket_id = 'recommended-gear' and o.name like 'images/%' order by o.created_at
$$;

do $$
declare f text;
begin
  foreach f in array array['public.gear_authorize_image(text, uuid, bigint, text)', 'public.gear_consume_image(text)',
                           'public.gear_image_objects(text[])', 'public.gear_list_images()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Lease overview for the verifier: whether a lease is set and expired (never the token itself).
create function public.gear_lease_overview() returns table (target text, lease_set boolean, lease_expired boolean)
  language sql stable security definer set search_path = '' as $$
  select h.target, h.lease_token is not null, h.lease_token is not null and h.lease_expires_at < clock_timestamp()
    from public.gear_publication_head h order by h.target
$$;
revoke all on function public.gear_lease_overview() from public, anon, authenticated;
grant execute on function public.gear_lease_overview() to service_role;
