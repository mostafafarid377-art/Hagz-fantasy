# Phase 2B.3 — Storage ownership: execution procedure for the 3a/3b split

The reviewed procedure for applying `003_storage.sql` without ever granting broad ownership or privileges. **No Supabase project was contacted and no procedure below has been executed against a hosted project.** Everything marked *verified* was measured on a disposable PostgreSQL 17.6 cluster.

`003_storage.sql` is frozen (checksum-guarded). This document is therefore a **procedure**, not an edit: it says how the file is decomposed when it becomes executable, and how each part is applied.

## 1. Why `003` cannot be applied as one unit on Supabase

`003` ends with:

```sql
create policy player_images_member_read on storage.objects
  for select to authenticated using (bucket_id='player-images' and ff_private.can_read_image(name));
```

On Supabase `storage.objects` is owned by `supabase_storage_admin`, not by the role that runs migrations. Creating a policy requires table ownership, so the statement fails `42501 must be owner of table objects`.

*Verified on PG17.6* with a Supabase-like cluster: `insert into storage.buckets` succeeds as a non-owner; `alter table storage.objects enable row level security` and `create policy … on storage.objects` both fail; the same `create policy` as `supabase_storage_admin` succeeds; `pg_has_role('deployer','supabase_storage_admin','member')` remains `false`.

## 2. A fidelity gap in the local tests — read this before trusting a green run

The repository's `setup.sql` mock creates `storage.objects` **owned by the migration role**, so `003` applies cleanly in PGlite and in the mock-bootstrapped native run. *Verified:* in that mock the owner is `postgres`.

**The mock therefore cannot catch the Storage failure, ever.** It is not the same situation as Supabase. This is why the split is a procedure rather than a test: no amount of offline testing will reproduce an ownership boundary the fixture does not contain. Do not treat a green `test:db:design` run as evidence that `003` is applicable to Supabase.

## 3. The split

| Part | Applied by | Contents | Ownership needed |
|---|---|---|---|
| **3a** | the normal migration role, as an ordinary migration | `insert into storage.buckets(...)`; `create function ff_private.can_read_image(text)`; its `revoke`/`grant` | none — *verified to succeed as a non-owner* |
| **3b** | a single owner-authorised step, run as `supabase_storage_admin` | `drop policy if exists` + `create policy player_images_member_read …` | table ownership |

### 3a — safe to run as the migration role

```sql
-- bucket row + can_read_image + grants, exactly as in 003 lines 1-14.
```

Both statements that 3a needs are ones a non-owner can execute: the bucket is a plain `INSERT`, and `ff_private` is created by `002`. *Verified as a non-owner on PG17.6.*

> **Prerequisite:** `ff_private.can_read_image` calls `ff_private.is_member`, which calls `auth.uid()`. If the definer ownership change of Phase 2B.3 §5 is ever applied, `ff_private.can_read_image` is one of the functions whose definer must be able to reach schema `auth` and bypass RLS. Until then it is owned by the migration role and works.

### 3b — must run as `supabase_storage_admin`

```sql
drop policy if exists player_images_member_read on storage.objects;
create policy player_images_member_read on storage.objects
  for select to authenticated
  using (bucket_id = 'player-images' and ff_private.can_read_image(name));
```

Rules for 3b, all deliberate:

- **No `alter table … enable row level security`.** RLS is already enabled on `storage.objects` by Supabase, and the statement is owner-only DDL that adds nothing. `010` asserts `relrowsecurity` instead of trying to set it.
- **No ownership transfer.** `storage.objects` stays owned by `supabase_storage_admin`. `alter table storage.objects owner to postgres` is forbidden.
- **No privilege grant.** `GRANT ALL ON storage.objects` would not enable DDL (which needs ownership) and would widen runtime access if it did.
- **No role membership.** Never `grant supabase_storage_admin to postgres`; *verified* that the working path needs no membership at all.
- **Idempotent.** `drop policy if exists` + `create policy` so a re-run converges instead of failing on a duplicate name.
- **One statement.** 3b contains the policy and nothing else, so the owner-authorised step has the smallest possible blast radius.

## 4. Execution procedure

1. Apply `3a` as part of the normal migration sequence. It is safe for the migration role.
2. **Skip** `3b` in the CLI-managed chain. Do not leave a failing statement in a migration and do not mark it "expected to fail".
3. Run `3b` once per environment through a path that executes as `supabase_storage_admin` — the dashboard SQL editor under an owner-capable role, or an equivalent owner-authorised step.
4. Run migration `010`. It asserts the policy exists, is `SELECT`-only, targets the right bucket, and that `relrowsecurity` is true on `storage.objects`. **If step 3 was skipped, `010` fails and the deployment stops** — this is the control that prevents shipping an unprotected bucket.
5. Record in the deployment log: the exact statement run, the role that ran it, the commit it came from, and the timestamp. A policy that exists but is not traceable is an audit gap.

### Verifying step 3 actually took effect

`010` covers it, but for a manual check:

```sql
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy where polrelid = 'storage.objects'::regclass;
select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;
```

## 5. Limitations — explicitly not claimed

- **Not verified on Supabase.** The ownership model was emulated from published Supabase bootstrap scripts; no project, Storage service or signed-URL flow was exercised.
- **The 3b execution path is unconfirmed.** Whether a hosted project permits a one-off `supabase_storage_admin` step, and how that is audited, is untested. The CLI's own guidance for a non-owner statement (`supabase migrations repair --status applied` after correcting the migration) presumes the statement was *removed* from the migration, which is consistent with this procedure but is not the same as confirming it.
- **Storage runtime behaviour is untested**: download authorisation, signed URLs, `allow_only_operation`/`allow_any_operation`, MIME enforcement, and the interaction with `[storage] file_size_limit`.
- **`can_read_image`'s regex is unexercised against real Storage object names.** It is a strict path check that does not depend on `storage.foldername`/`storage.extension`, so it does not inherit their semantics — but that also means it has never been run against real object names.
- **No byte-level verification.** A member may read any object whose path is registered against a `player_profiles`/`player_suggestions` row in their league; the bytes are not validated.
- **There is still no upload, update or delete policy.** Image upload remains closed by design.
