-- PHASE 2A DESIGN DRAFT: private bucket, read-only policy. No client upload,
-- update, or delete policy exists until byte-level verification is implemented.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('player-images','player-images',false,5242880,array['image/jpeg','image/png','image/webp']);
-- Names are <league UUID>/players/<random UUID>.<jpg|jpeg|png|webp>. A strict
-- regex before casting avoids errors/unsafe path components; no user-supplied role.
create function ff_private.can_read_image(object_name text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, ff_private
as $$
declare league_text text;
begin
  if object_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/players/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$' then return false; end if;
  league_text := split_part(object_name,'/',1);
  if not ff_private.is_member(league_text::uuid) then return false; end if;
  return exists(select 1 from public.player_profiles p where p.league_id=league_text::uuid and p.image_path=object_name)
     or exists(select 1 from public.player_suggestions s where s.league_id=league_text::uuid and s.image_path=object_name
               and (s.submitted_by=auth.uid() or ff_private.is_leader(s.league_id)));
end $$;
revoke all on function ff_private.can_read_image(text) from public, anon, authenticated;
grant execute on function ff_private.can_read_image(text) to authenticated;
create policy player_images_member_read on storage.objects for select to authenticated using(bucket_id='player-images' and ff_private.can_read_image(name));
