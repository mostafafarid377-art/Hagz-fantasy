# Phase 2B.2 — Storage ownership resolution

How to create the `player-images` bucket policy without granting broad ownership or privileges, and what remains unverified. **No Supabase project was contacted in this phase.**

## 1. The failure

`003_storage.sql` ends with:

```sql
create policy player_images_member_read
  on storage.objects for select to authenticated
  using (bucket_id = 'player-images' and ff_private.can_read_image(name));
```

On Supabase, `storage.objects` and `storage.buckets` are owned by `supabase_storage_admin`, **not** by the `postgres` role that runs migrations. Creating a policy requires table ownership, so this statement fails with:

```
ERROR: 42501: must be owner of table objects
```

This is a long-standing, well-documented Supabase issue ([discussion #36611](https://github.com/orgs/supabase/discussions/36611); the maintainer's answer is that `alter table storage.objects enable row level security` is unnecessary because RLS is already enabled, and that "due to recent permission changes on postgres platform, altering tables in storage schema is no longer possible").

### Reproduced locally on PostgreSQL 17.6

A disposable cluster was bootstrapped to mirror the documented Supabase layout — `storage.buckets`/`storage.objects` owned by `supabase_storage_admin`, ordinary grants handed to a non-owner `deployer` role — and then probed statement by statement:

| Statement, run as a **non-owner** with grants | Result |
|---|---|
| `insert into storage.buckets(...)` | **OK** |
| `alter table storage.objects enable row level security` | **FAILED** — `must be owner of table objects` |
| `create policy ... on storage.objects` | **FAILED** — `must be owner of table objects` |
| `create table ff_smoke(a int)` in `public` (control) | OK |

Running the same `create policy` as `supabase_storage_admin` (the actual owner) **succeeded**, and `pg_has_role('deployer','supabase_storage_admin','member')` was `false` — i.e. the owner path works without the deploying role borrowing ownership.

## 2. The supported execution role

| Role | What it is | Can it create a `storage.objects` policy? |
|---|---|---|
| `postgres` | The default admin role; what the SQL Editor and migrations use. **Not** a superuser, and does **not** own `auth`/`storage` objects. | No |
| `supabase_admin` | Superuser (`superuser createdb createrole replication bypassrls`). Platform-internal. | Yes, but **must not be used** — it is not exposed for application migrations and would bypass every guarantee. |
| `supabase_storage_admin` | Owns the Storage schema and its tables. | **Yes** — this is the correct owner. |
| `service_role` | `BYPASSRLS`, used by the Storage API at runtime. | Irrelevant to DDL, and must never appear in a migration. |

The conclusion is that the **migration role cannot be the role that creates this policy**, and the fix is not to escalate it.

## 3. The safe approach

Do **not** do any of these:

- `alter table storage.objects owner to postgres` — hands the app's storage table to the migration role permanently.
- `grant all on storage.objects to postgres` — DDL needs ownership, not privileges, so it would not even work, and it would widen runtime access if it did.
- `grant supabase_storage_admin to postgres` — silently gives `postgres` durable storage-schema administration.
- Put the policy in the migration and mark the failure "expected" — that turns a hard security boundary into a silent no-op.

**Do** this instead — split `003` into two reviewed parts:

| Part | Applied by | Contents |
|---|---|---|
| `003a` (bucket, no ownership needed) | Normal migration role via `supabase/migrations` | `insert into storage.buckets(...)`, the `ff_private.can_read_image(text)` function and its grants. Locally verified to succeed as a non-owner. |
| `003b` (the policy) | A single owner-authorized step, run by `supabase_storage_admin` | `create policy player_images_member_read on storage.objects for select to authenticated using (...)` — **and nothing else**: no `alter table`, no ownership change, no privilege grant. |

`003b` must be:

- **idempotent or explicitly one-shot.** Prefer `drop policy if exists player_images_member_read on storage.objects;` followed by `create policy ...`, so a re-run converges instead of failing on a duplicate name.
- **verified, not assumed.** Migration `010_privilege_verification.sql` asserts that the policy exists, is `SELECT`-only, and that RLS is enabled on `storage.objects`. If the owner step was skipped, the deployment **fails** rather than shipping an unprotected bucket.
- **recorded.** The exact statement that was run, by which role, and when, belongs in the deployment log for the environment. A policy that exists but is not in version control is an audit gap.

### Why `alter table storage.objects enable row level security` is removed

The draft never contained that statement, but the supported fix path must not introduce it: RLS is already enabled on `storage.objects` on Supabase, and the statement is owner-only DDL that adds nothing. `010` asserts `relrowsecurity` instead of trying to set it.

## 4. What this preserves

- No ownership is transferred. `storage.objects` stays owned by `supabase_storage_admin`.
- No privilege is granted to `postgres`, `anon`, `authenticated` or `service_role` on any `storage` object.
- The bucket stays **private**, and the policy remains `SELECT`-only with a reference check (`ff_private.can_read_image`), so an authenticated member cannot enumerate arbitrary object names.
- There is still **no upload, update or delete policy**. Image upload remains closed, as Phase 2A designed.

## 5. Limitations — explicitly not claimed

- **Not verified on Supabase.** The ownership model was emulated from Supabase's published bootstrap scripts on a local PostgreSQL 17.6 cluster. No Supabase project, Storage service, or signed-URL flow was exercised.
- **The `003b` split is a proposal, not a measurement.** Whether a hosted project permits a one-off `supabase_storage_admin` step from the dashboard, SQL Editor or a CLI `db push` flag, and how that is audited, is unconfirmed. The CLI's own guidance for a non-owner statement is `supabase migrations repair --status applied` after correcting the migration, which presumes the statement was removed from the migration rather than run as another role.
- **Storage service behaviour is untested.** RLS on `storage.objects` is necessary but not sufficient: download authorisation, signed URLs, `allow_only_operation`/`allow_any_operation` semantics, MIME enforcement and the `file_size_limit` interaction with `config.toml`'s `[storage] file_size_limit = "50MiB"` are all unverified.
- **`storage.foldername`/`storage.extension` were not used.** The draft's path check is a strict regex in `ff_private.can_read_image`, so it does not depend on Storage helper functions — but that also means the regex has not been exercised against real Storage object names.
- **No byte-level verification exists.** A member may read any object whose path is registered against a `player_profiles`/`player_suggestions` row in their league; the bytes themselves are not validated.
