# Phase 2B.4 — Storage execution runbook

Exact, ordered instructions for applying `003_storage.sql`'s content to Supabase. **These instructions have not been executed.** No Supabase project was contacted in this phase.

`003_storage.sql` is frozen (checksum-guarded by `npm run check:migrations`), so this runbook decomposes it at execution time rather than editing it.

## 1. Why the split exists

`003` ends with a policy on `storage.objects`. On Supabase that table is owned by `supabase_storage_admin`, and creating a policy requires table ownership, so the migrating role gets:

```
ERROR: 42501: must be owner of table objects
```

Measured on a Supabase-like PG17.6 cluster: the bucket `INSERT` succeeds as a non-owner; `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and `CREATE POLICY … ON storage.objects` both fail; the same `CREATE POLICY` as `supabase_storage_admin` succeeds; and `pg_has_role('deployer','supabase_storage_admin','member')` stays `false` afterwards — the owner path needs no membership.

> **The local test suite cannot catch this.** `setup.sql` creates `storage.objects` owned by the migration role, so `003` applies cleanly in every offline test. **A green `test:db:design` run is not evidence that `003` is applicable to Supabase.** This is the single most important thing to remember about this runbook.

## 2. Phase A — statements that run as the migration role

Run as part of the normal migration sequence (i.e. materialized into the `<timestamp>_baseline_003a_storage_bucket.sql` migration). **All of these are safe for the migration role** — none requires ownership of a `storage` table.

```sql
-- A1. Bucket row. A plain INSERT: needs INSERT on storage.buckets, which the
--     migration role has. Verified to succeed as a non-owner.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('player-images', 'player-images', false, 5242880,
        array['image/jpeg','image/png','image/webp']);

-- A2. The reference-checking helper. Created in ff_private (created by 002),
--     owned by the migration role. No storage privileges needed to define it.
create function ff_private.can_read_image(object_name text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, ff_private
as $$
declare league_text text;
begin
  if object_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/players/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$' then
    return false;
  end if;
  league_text := split_part(object_name, '/', 1);
  if not ff_private.is_member(league_text::uuid) then return false; end if;
  return exists (select 1 from public.player_profiles p
                 where p.league_id = league_text::uuid and p.image_path = object_name)
      or exists (select 1 from public.player_suggestions s
                 where s.league_id = league_text::uuid and s.image_path = object_name
                   and (s.submitted_by = auth.uid() or ff_private.is_leader(s.league_id)));
end $$;

-- A3. Grants: the helper is never public, and only authenticated may call it.
revoke all on function ff_private.can_read_image(text) from public, anon, authenticated;
grant execute on function ff_private.can_read_image(text) to authenticated;
```

**Do not add an `ALTER TABLE … ENABLE ROW LEVEL SECURITY` here.** RLS is already enabled on `storage.objects` by Supabase, and the statement is owner-only DDL that adds nothing.

## 3. Phase B — the one statement that requires the actual Storage owner

Run **once per environment**, as `supabase_storage_admin` (or a role that owns `storage.objects`). This is **not** a CLI migration and must not be left in the chain as a failing statement.

```sql
-- B1. Idempotent: drop-then-create so a re-run converges.
drop policy if exists player_images_member_read on storage.objects;
create policy player_images_member_read on storage.objects
  for select to authenticated
  using (bucket_id = 'player-images' and ff_private.can_read_image(name));
```

This is the **entire** owner-authorised step. It contains:

- **no** `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (already on; owner-only DDL that adds nothing)
- **no** ownership transfer
- **no** privilege grant
- **no** role membership change

### Which role actually is the owner

Determine it, do not assume it:

```sql
select pg_get_userbyid(relowner) as owner
from pg_class where oid = 'storage.objects'::regclass;
```

Expect `supabase_storage_admin`. Then run B1 as that role. If your environment gives you no way to act as `supabase_storage_admin`, **stop** — do not work around it by granting ownership or membership. See §5.

## 4. Phase C — verification (run after B1, and again after any reset)

```sql
-- C1. The policy exists, is SELECT-only, and uses the right bucket + helper.
select polname, polcmd, polpermissive,
       pg_get_expr(polqual, polrelid) as using_expression
from pg_policy
where polrelid = 'storage.objects'::regclass;

-- Expected: exactly one row, polname = player_images_member_read, polcmd = 'r'
-- (SELECT), and the USING expression referencing bucket_id = 'player-images'
-- and ff_private.can_read_image(name).

-- C2. RLS is enabled on storage.objects (Supabase enables this; assert it, don't set it).
select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;
-- Expected: t

-- C3. The bucket exists, is private, and has the expected limits.
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'player-images';
-- Expected: public = false, file_size_limit = 5242880, three MIME types.

-- C4. No upload/update/delete policy exists (upload stays closed by design).
select count(*) from pg_policy
where polrelid = 'storage.objects'::regclass and polcmd <> 'r';
-- Expected: 0

-- C5. The helper is not executable by anon or PUBLIC.
select has_function_privilege('anon', 'ff_private.can_read_image(text)', 'execute') as anon_can,
       has_function_privilege('authenticated', 'ff_private.can_read_image(text)', 'execute') as auth_can;
-- Expected: anon_can = f, auth_can = t
```

Migration `010` runs the equivalent of **C1, C2 and C5** as hard assertions. **If Phase B was skipped, `010` fails and the deployment stops.** That failure is the control that prevents shipping an unprotected bucket — it is a feature, not an obstacle to work around.

## 5. Forbidden workarounds

Each of these has been considered and each is wrong:

| Workaround | Why it is forbidden |
|---|---|
| `ALTER TABLE storage.objects OWNER TO postgres` | Permanently hands the app's storage table to the migration role |
| `GRANT ALL ON storage.objects TO postgres` | DDL needs ownership, not privileges — it would not work, and would widen runtime access if it did |
| `GRANT supabase_storage_admin TO postgres` | Durable storage-schema administration for the app role |
| Using `supabase_admin` (superuser) for the whole deployment | Bypasses every guarantee this package establishes |
| Leaving B1 in the migration chain and accepting the error | Turns a hard security boundary into a silent no-op |
| Marking the migration "applied" without running B1 | Produces a bucket with **no** policy — `010` catches it, but never do it deliberately |

## 6. Ordering constraints

| Must happen | Before | Why |
|---|---|---|
| A1–A3 (`003a`) | B1 | B1's policy references `ff_private.can_read_image` |
| B1 | `010` | `010` asserts the policy exists with the right shape |
| A1 (bucket) | any image upload | the bucket must exist |
| `002` (`ff_private`, `is_member`) | A2 | `can_read_image` calls `is_member` |
| Definer ownership transfer (if ever applied) | after B1 is verified | `can_read_image` is referenced by the policy; a broken definer denies all image access **with no error** |

## 7. What this does not validate

- **Nothing here was run against Supabase.** The ownership model was emulated from published bootstrap scripts.
- **Whether a hosted project permits an owner-authorised one-off step** — and how it is audited — is unconfirmed.
- Storage **runtime** behaviour is untested: download authorisation, signed URLs, `allow_only_operation`/`allow_any_operation`, MIME enforcement, `[storage] file_size_limit` interaction.
- `can_read_image`'s **regex** has only been exercised on synthetic names, never against real Storage object names.
- **No byte-level verification**: a member may read any object whose path is registered against a `player_profiles`/`player_suggestions` row in their league.
- **No upload path exists at all** — there is no insert/update/delete policy, by design.

## 8. Deployment log requirement

Record, per environment: the exact SQL of B1, the role that executed it, the timestamp, and the commit the SQL came from. A policy that exists but is not traceable to a reviewed statement is an audit gap — and `010` proves the policy is *correct*, not that it is *accounted for*.
