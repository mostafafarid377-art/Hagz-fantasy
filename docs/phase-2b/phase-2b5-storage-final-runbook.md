# Phase 2B.5 — Storage execution: final runbook

Reproducible execution package for the Storage part of the schema. **Not executed against any Supabase project.** `003_storage.sql` is unchanged (checksum-pinned).

Artefacts:

| File | Role | Runs as |
|---|---|---|
| `supabase/design/migrations/003_storage.sql` | The frozen draft (3a + 3b in one file) | — |
| *3a portion* of `003` | bucket, helper, grants | **migration role** |
| `supabase/design/storage/003b_storage_policy_owner_step.sql` | the policy only, idempotent, self-checking | **Storage owner** |
| `supabase/design/storage/verify_storage_setup.sql` | read-only verification | any role |

## 1. Why the split is unavoidable

`003_storage.sql` ends with:

```sql
create policy player_images_member_read on storage.objects
  for select to authenticated using (bucket_id='player-images' and ff_private.can_read_image(name));
```

On Supabase, `storage.objects` is owned by `supabase_storage_admin`. Creating a policy requires table ownership, so the migrating role gets `42501 must be owner of table objects`.

### Measured this phase (PostgreSQL 17.6, non-superuser)

| Operation | Role | Result |
|---|---|---|
| `insert into storage.buckets(...)` | non-owner | **succeeds** |
| `create function ff_private.can_read_image(text)` | non-owner | **succeeds** |
| `create policy … on storage.objects` | non-owner | **`must be owner of table objects`** |
| `create policy … on storage.objects` | owner | succeeds |

Recovery-case 6 additionally records what a *failure* leaves behind: **bucket present, zero policies, fail-closed.** No policy means no access — the failure mode is never "open".

> **A green local suite proves nothing about this.** In `setup.sql` the mock owns `storage.objects` as the migrating role, so the frozen `003` applies as one unit locally and can **never** reproduce the ownership failure. A dedicated test asserts this limitation on purpose. PGlite is worse: its `postgres` is a superuser and bypasses the ownership check entirely, so the denial is only reproducible natively as a non-superuser.

## 2. Phase A — statements the migration role executes

Materialised as the `3a` migration (bucket + helper + grants). **None of it requires ownership of any `storage` object.**

```sql
-- A1. Private bucket. A plain INSERT.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('player-images', 'player-images', false, 5242880,
        array['image/jpeg','image/png','image/webp']);

-- A2. Reference-checking helper, in ff_private (created by 002).
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

-- A3. Never public; only authenticated may call it.
revoke all on function ff_private.can_read_image(text) from public, anon, authenticated;
grant execute on function ff_private.can_read_image(text) to authenticated;
```

**Do not add `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.** Supabase already enables RLS on `storage.objects`; the statement is owner-only DDL that adds nothing. `010` asserts `relrowsecurity` instead of setting it.

## 3. Phase B — the one owner-authorised step

Run `supabase/design/storage/003b_storage_policy_owner_step.sql` once per environment, as the role that owns `storage.objects`.

**Determine the owner first — do not assume it:**

```sql
select pg_get_userbyid(relowner) as owner
from pg_class where oid = 'storage.objects'::regclass;
```

Expect `supabase_storage_admin`. If you cannot act as that role, **stop** (§5).

The file, in full:

```sql
begin;

do $$
begin
  if to_regclass('storage.objects') is null then
    raise exception 'storage.objects does not exist; this is not a Supabase Storage database'
      using errcode = '42P01';
  end if;
end $$;

drop policy if exists player_images_member_read on storage.objects;

create policy player_images_member_read on storage.objects
  for select to authenticated
  using (bucket_id = 'player-images' and ff_private.can_read_image(name));

do $$
declare n_select int; n_write int;
begin
  select count(*) filter (where polcmd = 'r'),
         count(*) filter (where polcmd <> 'r')
    into n_select, n_write
  from pg_policy
  where polrelid = 'storage.objects'::regclass
    and polname = 'player_images_member_read';
  if n_select <> 1 then
    raise exception 'expected exactly one SELECT policy for player-images, found %', n_select using errcode='42501';
  end if;
  if n_write <> 0 then
    raise exception 'write policy present on storage.objects; upload must stay closed' using errcode='42501';
  end if;
  if not exists (select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity) then
    raise exception 'ROW LEVEL SECURITY is not enabled on storage.objects; refuse to continue' using errcode='42501';
  end if;
end $$;

commit;
```

**Properties, each deliberate:**

- **idempotent** — `DROP POLICY IF EXISTS` + `CREATE`, so a re-run converges instead of failing on a duplicate name. Tested (applied twice, exactly one policy).
- **self-checking** — asserts one `SELECT` policy, zero write policies, and RLS enabled, inside the same transaction.
- **refuses** on a database without `storage.objects`, rather than silently no-op-ing. Tested.
- **no ownership transfer**, **no privilege grant**, **no role membership**, **no `ENABLE RLS`**.
- **no write policy** — upload stays closed by design.

## 4. Phase C — verification

Run `supabase/design/storage/verify_storage_setup.sql` (read-only). It checks:

| # | Check | Expected |
|---|---|---|
| C1 | bucket exists, `public = false`, `file_size_limit = 5242880`, 3 MIME types | one row |
| C2 | `relrowsecurity` on `storage.objects` | `t` |
| C3 | exactly one policy, `polcmd = 'r'`, `USING` references `player-images` and `can_read_image` | one row |
| C4 | write policies on `storage.objects` | `0` |
| C5 | helper `EXECUTE`: `anon_can = f`, `authenticated_can = t` | as stated |
| C6 | `PUBLIC` EXECUTE on the helper | 0 rows |
| C7 | owner of `storage.objects` (informational — proves no ownership was taken) | `supabase_storage_admin`, **not** the migration role |

Migration `010` asserts the critical subset (**C2, C3-shape, C5/C6**) automatically and **fails the deployment** if Phase B was skipped. That failure is the control; do not remove the assertion.

## 5. If a Storage step fails

| Symptom | Meaning | Action |
|---|---|---|
| `42501 must be owner of table objects` | ran as the migration role | re-run **only** `003b` as the owner. Never grant ownership or membership. |
| `storage.objects does not exist` | wrong database / no Storage schema | stop; this is not a Storage-enabled project |
| `policy already exists` | cannot happen with this file (it drops first); if seen, a different definition exists | inspect with C3, then re-run `003b` |
| `010` fails on storage assertions | Phase B skipped | run Phase B. This is `010` working. |
| Phase B partially applied (crashed mid-transaction) | transaction rolled back | re-run `003b`; it is idempotent |

**Fail-closed guarantee:** a failed Phase B leaves the bucket present with **zero** policies. No policy = no access. There is no state in which this procedure leaves the bucket readable.

## 6. Forbidden workarounds

| Workaround | Why forbidden |
|---|---|
| `ALTER TABLE storage.objects OWNER TO postgres` | permanent ownership transfer of the app's storage table |
| `GRANT ALL ON storage.objects TO postgres` | DDL needs ownership, not privileges; would widen runtime access |
| `GRANT supabase_storage_admin TO postgres` | durable storage-schema admin for the app role |
| using `supabase_admin` for the deployment | bypasses every guarantee in this package |
| leaving `003b` in the CLI chain and accepting the error | turns a security boundary into a silent no-op |
| marking the migration applied without running `003b` | ships a bucket with no policy (`010` catches it; still never do it) |

## 7. What this package cannot prove

- Nothing here ran against Supabase; the ownership model is emulated from published bootstrap scripts.
- Whether a hosted project permits an owner-authorised one-off step, and how it is audited, is **unconfirmed**.
- Storage runtime behaviour is untested: download authorisation, signed URLs, `allow_only_operation`/`allow_any_operation`, MIME/size enforcement, `[storage] file_size_limit`.
- `can_read_image`'s regex has only been exercised on synthetic names.
- No byte-level verification: a member may read any object whose path is registered against a league player row.
- **No upload path exists** — no insert/update/delete policy, by design.

## 8. Deployment log requirement

Record per environment: the exact SQL of Phase B, the role that ran it, the timestamp, and the commit. `010` proves the policy is *correct*; it does not prove it is *accounted for*.
