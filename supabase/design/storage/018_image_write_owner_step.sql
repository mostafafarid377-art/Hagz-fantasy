-- OWNER-ASSISTED STEP, NOT A CLI MIGRATION. Run only after security review and
-- migration 018, as the actual owner of storage.objects (normally
-- supabase_storage_admin). No table ownership, grants or existing SELECT policy
-- are modified. Existing objects are immutable: replacements use new names.
-- Supabase Storage already enables RLS; this script refuses to run if it is off.
begin;
do $$
begin
  if not exists (select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity) then
    raise exception 'storage.objects RLS must be enabled';
  end if;
  if not pg_has_role(current_user, (select relowner from pg_class where oid='storage.objects'::regclass), 'member') then
    raise exception 'Execute as the owner of storage.objects';
  end if;
end $$;
-- A tiny owner-run helper lets the checked application RPC confirm that the
-- object exists without granting the application role broad storage table reads.
create or replace function storage.ff_player_image_exists(p_name text) returns boolean
language sql stable security definer set search_path = pg_catalog as $$
  select exists(select 1 from storage.objects where bucket_id='player-images' and name=p_name)
$$;
revoke all on function storage.ff_player_image_exists(text) from public, anon, authenticated;
grant execute on function storage.ff_player_image_exists(text) to ff_migration_owner;

drop policy if exists player_images_reserved_insert on storage.objects;
create policy player_images_reserved_insert on storage.objects for insert to authenticated
  with check (bucket_id='player-images' and ff_private.can_write_reserved_image(name,'insert'));
-- Storage requires SELECT for deleting an object. Only the reservation owner can
-- see their staged/retired object, not other users or other leagues.
drop policy if exists player_images_reserved_owner_read on storage.objects;
create policy player_images_reserved_owner_read on storage.objects for select to authenticated
  using (bucket_id='player-images' and ff_private.can_write_reserved_image(name,'read'));
drop policy if exists player_images_reserved_delete on storage.objects;
create policy player_images_reserved_delete on storage.objects for delete to authenticated
  using (bucket_id='player-images' and ff_private.can_write_reserved_image(name,'delete'));
-- Only retired, unreferenced objects may be deleted. Staged uploads are retained
-- for operator cleanup to avoid racing attachment.
-- No UPDATE policy: changing the bytes of a referenced object is forbidden.
commit;
