-- Test stand-ins only. Never use as a Supabase deployment migration.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users(id uuid primary key);
-- The HOSTED auth.uid() definition (supabase/auth 20211202183645_update_auth_uid.up.sql),
-- not the shorter local/CLI one. Hosted PostgREST sets only request.jwt.claims, so a
-- per-claim-only stand-in makes the harness disagree with production.
create function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(current_setting('request.jwt.claim.sub',true),(current_setting('request.jwt.claims',true)::jsonb->>'sub')),'')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select on storage.objects to authenticated;
