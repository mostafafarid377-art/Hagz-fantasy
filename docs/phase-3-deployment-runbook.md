# Phase 3 — Remote Deployment Runbook (Windows)

**Target project:** the project you linked with `supabase link` — this document
does **not** name a project ref. Type your own ref where `<YOUR-REF>` appears.

> **Nothing in this runbook has been executed.** No migration has been applied to
> any Supabase project, and no remote SQL has been run. Everything below is a
> procedure that has been validated locally against PostgreSQL-compatible engines
> only — see §9 for exactly what that does and does not prove.

**Read this first:** §0 lists the commands that change your remote project. Each
one is marked **⚠️ REMOTE WRITE** and needs your explicit go-ahead before you run
it. Everything not so marked is read-only.

---

## 0. The approval checkpoint

Only these commands can change your hosted project. Nothing else in this guide can.

| # | Command | What it changes | Reversible? |
|---|---|---|---|
| 1 | `supabase link` | Writes `supabase/.temp/project-ref` **locally** and may store your DB password in the OS keyring. No change to the database. | Yes — `supabase unlink` |
| 2 | `supabase db push --remote` | **⚠️ REMOTE WRITE** — creates schemas, 40 tables, ~104 functions, 1 role, 1 storage bucket, and the migration history table. | No automatic rollback. Restore from §2's backup. |
| 3 | §6 Storage SQL (in the dashboard) | **⚠️ REMOTE WRITE** — creates one RLS policy on `storage.objects`. | Yes — `drop policy`. |
| 4 | `supabase migration repair --remote` | **⚠️ REMOTE WRITE** — edits the migration history table only. | Yes (re-repair). |

Everything else — `whoami`, `projects list`, `db dump`, `migration list --remote`,
`db query --read-only`, the SQL Editor `SELECT`s, `npm run check:migrations` — is
read-only. Running them cannot damage the project.

**Do not run steps 2 and 3 until you have read §2 and have a backup.** Say
"approved" for a specific step and I will confirm what it does before you run it.

---

## 1. Prerequisites on Windows

### 1a. Supabase CLI

```powershell
# Confirm you have the CLI. Recent versions are v2.x or v3.x.
supabase --version
```

**If missing**, install with either (they are equivalent; pick one):

```powershell
# Scoop
scoop install supabase

# or npm (needs Node 20+)
npm install --global supabase
```

> **Version matters.** Supabase CLI **v3 changed the default target of `db push`,
> `db dump`, `migration list` and friends from "the linked project" to "the local
> database".** Every hosted command in this guide therefore passes `--remote`
> explicitly. On v2 the flag is also accepted, so these commands are correct on
> both. `--linked` is deprecated in v3 and removed in v4 — do not use it.
> Run `supabase --version` and tell me the number if it is not v2 or v3.

### 1b. `pg_dump` / `pg_restore` (only needed for §2 backups)

Check the client version — it must be **greater than or equal to** the server's:

```powershell
pg_dump --version
psql --version
```

Supabase currently runs PostgreSQL **15 or 17**. If your `pg_dump` is older than
the server (e.g. 15 client against a 17 server), the dump fails with
`server version mismatch` / `aborting because of server version mismatch`.
Install the matching client from <https://www.postgresql.org/download/windows/>
(PostgreSQL **17** binaries work against both 15 and 17 servers).

Alternatively, use `supabase db dump` (§2b) which runs `pg_dump` inside a
container and needs **Docker Desktop** instead.

---

## 2. Back up before anything else

Pick **one** of these two methods. If the project already holds data you care
about, this is mandatory — **there are no down migrations**. Once `db push` runs,
restoring a backup is the only real rollback.

### 2a. Method A — `pg_dump` direct connection (no Docker)

Get the URI from **Dashboard → Project Settings → Database → Connection string →
URI**. It is the **direct** connection, port **5432** — not the pooler on 6543.

```powershell
# Keeps the password in this PowerShell session only. It is never written to disk
# and never leaves your machine.
$env:SUPABASE_DB_URL = Read-Host "Paste the direct (port 5432) connection URI"
```

Create a timestamped backup directory, then dump:

```powershell
New-Item -ItemType Directory -Force -Path .\backups | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$env:FF_BACKUP = ".\backups\before-migrations-$stamp.dump"

& pg_dump "$env:SUPABASE_DB_URL" --format=custom --no-owner --no-privileges "--file=$env:FF_BACKUP"
```

### 2b. Method B — `supabase db dump` (needs Docker Desktop running)

```powershell
New-Item -ItemType Directory -Force -Path .\backups | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$env:FF_BACKUP = ".\backups\before-migrations-$stamp.dump"

supabase db dump --remote --file "$env:FF_BACKUP"
```

> Note: `db dump` **excludes** Supabase-managed schemas (`auth`, `storage`) by
> default. Method A does not. For a full pre-migration safety net, prefer **A**.

### 2c. Verify the backup actually exists and is readable

This is the step people skip. A `.dump` file that `pg_restore` cannot list is not
a backup.

```powershell
Get-Item "$env:FF_BACKUP" | Select-Object Name, Length, LastWriteTime
& pg_restore --list "$env:FF_BACKUP" | Select-Object -First 20
& pg_restore --list "$env:FF_BACKUP" | Measure-Object -Line
```

**Expected output:** `Length` well above 0 (tens of KB even for an empty project).
The listing shows table/type entries. The line count is in the hundreds.

**Success criteria — all three must be true:**
1. `Length` > 0.
2. `pg_restore --list` prints without error (this parses the archive header).
3. The listing contains at least one `TABLE DATA` or `TABLE` line.

**Recovery — if you ever need to restore:**

```powershell
# ⚠️ REMOTE WRITE. This is destructive: use only on a project you intend to reset.
# Do NOT run this unless we have discussed it. It is here so the backup is usable.
& pg_restore "--dbname=$env:SUPABASE_DB_URL" --no-owner --no-privileges `
  --clean --if-exists "$env:FF_BACKUP"
```

Partial restore of one table, without dropping anything:

```powershell
& pg_restore "--dbname=$env:SUPABASE_DB_URL" --no-owner --no-privileges `
  --data-only --table=public.leagues "$env:FF_BACKUP"
```

**Report back:** the file size, and the output count from 2c. **Never send the
dump or the connection URI.**

> The `.dump` file contains **every row in your project** — real user emails, every
> league, every squad. `backups/` and `*.dump` were added to `.gitignore` for this
> reason. Keep it off any cloud-synced folder you would not store the database in,
> and delete it once the deployment is confirmed good.

---

## 3. Confirm the CLI is pointed at the right project

```powershell
cd C:\path\to\Hagz-fantasy
supabase whoami
supabase projects list
```

**Expected:** `whoami` prints your account. `projects list` prints your projects
with one marked as linked (`●`).

Now link, if not already linked:

```powershell
supabase link --project-ref <YOUR-REF>
```

It may prompt for the database password — that goes into the OS keyring, not into
any file in the repo. Then confirm the link state:

```powershell
supabase status --output env 2>$null
Get-Content .\supabase\.temp\project-ref -ErrorAction SilentlyContinue
```

**Expected:** the `project-ref` file contains exactly your 20-character ref.

`supabase link` writes `supabase/.temp/project-ref`. Our migration guard
(`npm run check:migrations`) **fails** if that file is ever committed. It is
already git-ignored, but confirm:

```powershell
git status --short
```

**Expected:** no line mentioning `supabase/.temp/`. If you see one, stop and tell me.

---

## 4. Prove the local package is the reviewed one (read-only)

Before sending anything to the database, confirm the 13 files on your machine are
byte-identical to the reviewed package.

```powershell
node scripts/promote-migrations.mjs
npm run check:migrations
```

**Expected:** `Wrote 13 migration(s)` then `29 check(s) passed, 0 failed.`

The promotion script is deterministic — it re-reads the frozen design sources and
regenerates the executable package. Running it twice produces identical bytes. If
`check:migrations` reports drift, **stop**: your checkout differs from what was
audited.

> **Windows note.** The guard hashes file *content with line endings normalised*.
> An earlier version hashed raw bytes, so a `core.autocrlf=true` checkout (the Git
> for Windows default) produced ~24 spurious failures while CI on Linux stayed
> green. `.gitattributes` now pins SQL to LF, and the guard normalises regardless,
> so `git status` and the guard agree on either platform.

Optionally verify by hash. This is the manifest hash of all 13 files concatenated
in sorted order:

```powershell
Get-ChildItem .\supabase\migrations\*.sql | Sort-Object Name |
  Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLower())  $($_.Path | Split-Path -Leaf)" }
```

**Expected file set — exactly these 13, in this order.** If any other `.sql` file
appears in `supabase/migrations/`, the guard would have failed above.

| # | File | What it does |
|---|---|---|
| 1 | `20261115000001_schema.sql` | 40 tables, constraints, indexes |
| 2 | `20261115000002_security.sql` | RLS everywhere, SELECT-only grants |
| 3 | `20261115000003_storage.sql` | private `player-images` bucket (policy conditionally) |
| 4 | `20261115000004_integrity_workflows.sql` | workflow triggers, definer functions |
| 5 | `20261115000005_concurrency_hardening.sql` | advisory locks, serialization guards |
| 6 | `20261115000006_revision_lineage.sql` | result revision lineage |
| 7 | `20261115000007_correction_attempts.sql` | correction attempts |
| 8 | `20261115000008_result_fork_idempotency.sql` | idempotent result forking |
| 9 | `20261115000009_ownership_and_grants.sql` | `ff_migration_owner`, explicit grants |
| 10 | `20261115000010_definer_ownership_transfer.sql` | transfers every definer to that role |
| 11 | `20261115000011_application_api.sql` | the 40 client-callable `ff_*` RPCs |
| 12 | `20261115000012_privilege_verification.sql` | **asserts** privileges; aborts push if wrong |
| 13 | `20261115000013_api_surface_verification.sql` | **asserts** the API surface; aborts push if wrong |

> **Note the order.** 10 runs before 12, and 11 before 12/13, because 12 and 13 are
> assertions about what 10 and 11 did. Filenames sort correctly by timestamp, so
> the CLI applies them in this order without extra flags.

---

## 5. Review what would be applied (read-only)

```powershell
supabase migration list --remote
supabase db push --dry-run --remote
```

**Expected for `migration list`:** a `LOCAL │ REMOTE │ TIME` table where the
`REMOTE` column is **empty** for all 13 rows (nothing applied yet), and every one
of the 13 timestamps appears in `LOCAL`.

**Expected for `db push --dry-run`:** a `Target: project … (<ref>) · production`
line, then a list of the 13 migrations above, in that order.

**Stop and report if:**
- the dry run lists **fewer than 13** (some are already recorded as applied),
- the dry run lists **anything not in the table above**,
- `Target:` names a project you did not intend.

> On a brand-new project the `REMOTE` column may show Supabase's own pre-existing
> history entries. That is normal. What matters is that our 13 are **all** in
> `LOCAL` and **none** of our 13 are in `REMOTE`.

---

## 6. Apply the migrations — **⚠️ REMOTE WRITE, NEEDS YOUR APPROVAL**

> **Do not run this until you have (a) a verified backup from §2 and (b) sent me
> the §5 dry-run output.** Say "approved" and I will re-confirm the blast radius.

```powershell
supabase db push --remote
```

The CLI prints the target and **asks once, defaulting to No**. Read the list, then
answer `y`. Do **not** add `--yes` for this first run — you want to read the prompt.

**Expected output:** `Applying migration 20261115000001_schema.sql…` through
`…00013_api_surface_verification.sql`, then `Finished supabase db push.`

### Two outcomes you must expect

**1. A WARNING about `storage.objects` — expected, not an error.**

> `storage.objects is owned by supabase_storage_admin, which the current role does
> not own. The player-images policy was NOT created.`

This is **by design and fail-closed**: the bucket exists with no policy, so nobody
can read or write it. Continue to §7.

**2. A HARD FAILURE in migrations 12 or 13 — expected behaviour, not a bug.**

Those two migrations are assertions. They abort the push if the privilege or API
surface drifted. When that happens, migration 12/13 rolls back; **1–11 stay
applied**. Do **not** retry blindly. Run the read-only check below, then §8.

```powershell
supabase migration list --remote
```

`migration list` is the source of truth for half-applied state — trust it over the
console scrollback.

**Report back:** the complete console output plus `migration list --remote`.

---

## 6a. THE CRITICAL ORDERING PROBLEM — read before you run §6

**On a standard Supabase project, `supabase db push` will almost certainly FAIL at
migration 12, and that is the designed behaviour — not a bug and not something to
improvise around.**

Here is the chain, verified by simulation:

1. Migration **3** tries to create the `player-images` policy. `storage.objects` is
   owned by `supabase_storage_admin`, which the migration role is not a member of,
   so it cannot. Migration 3 **skips** the policy with a WARNING (fail-closed).
2. Migration **12** asserts the policy exists. It does not. Migration 12 raises
   `42501: storage policy player_images_member_read is missing or not SELECT-only`.
3. The push aborts. Migrations **1–11 remain applied**; 12 and 13 do not.

So the correct sequence is **not** "push, then fix storage". It is:

| Step | Action | Result |
|---|---|---|
| A | `supabase db push --remote` | applies 1–11, aborts at 12 with the storage error |
| B | `supabase migration list --remote` | confirms 1–11 applied, 12–13 not |
| C | §7: create the policy in the SQL Editor | policy now exists |
| D | `supabase db push --remote` again | applies 12 and 13, skips 1–11 |

**This is the expected path. It is not a failure you need to report as a bug.**
The re-run in step D is safe: the CLI skips migrations already recorded as applied,
and 12/13 are pure assertions that mutate nothing.

> If you would rather avoid the aborted run entirely, do §7 **before** §6. The
> policy creation does not depend on the application schema, so creating it first
> is safe and makes the first push succeed end to end. Either order works; the
> "policy first" order is tidier.

**Do not** disable assertion 8, drop the check, or mark 12 as applied without
running it. That would leave the deployment unverified, which is the whole point
of the assertion existing.

---

## 6b. The ownership-transfer trap (`must be able to SET ROLE`)

> **Fixed in migration 10 itself.** This section explains the failure, how to
> recover if you already hit it, and what to do in the one case the migration
> cannot repair by itself. If your push has not run yet, you need to read this but
> you do not need to do anything: 010 now performs the pre-flight itself.

### 6b.1 What the error means

If you hit this, the push aborted at migration 10 with:

```
ERROR: must be able to SET ROLE "ff_migration_owner"   (SQLSTATE 42501)
```

Migrations 1–9 are recorded as applied; 10–13 are not. **Nothing is corrupted,
and the database is in a defined, safe state.** Migration 10 only changes object
owners; it has not run, so nothing has been re-pointed.

`ALTER <object> OWNER TO <role>` is not a privilege you can be "granted" in the
ordinary sense. Postgres requires the *executing* role to be able to `SET ROLE`
into the *target* role. A superuser always can. On Supabase the deploying role is
`postgres`, which is **NOSUPERUSER** (it holds CREATEROLE and BYPASSRLS instead),
so it needs a membership in `ff_migration_owner` that carries **`set_option`**.

The trap is subtle, and it is why this failed on a reviewed package:

| `pg_auth_members` option | What it controls |
|---|---|
| `admin_option` | whether you may **grant** the role onward |
| `inherit_option` | whether the role's privileges apply **implicitly** |
| `set_option` | whether you may **`SET ROLE`** into it — **this is the one `ALTER OWNER` needs** |

Because 009 creates `ff_migration_owner` while running as `postgres`, Postgres
gives `postgres` `admin_option = TRUE` automatically — but `set_option` is
**FALSE**. So `postgres` administers the role and still cannot become it. Running
`grant ff_migration_owner to postgres;` again does **not** fix this: a bare grant
refreshes `admin_option` and leaves `set_option = FALSE`.

There is a **second, latent blocker** immediately behind the first. Once
`SET ROLE` works, `ALTER FUNCTION ... OWNER TO ff_migration_owner` fails with
`42501 permission denied for schema ff_private`, because the **new owner** must
hold `CREATE` on a schema to own an object inside it. 009 grants `usage` only, on
`ff_private`. Granting `CREATE` to the *executing* role does not help — it has to
be the *new owner*. Fixing only the first error just moves the failure a few lines
down the file.

### 6b.2 What migration 10 now does about it

Before the 56 ownership statements, 010 runs a guarded pre-flight that:

1. gives the current role a `SET ROLE` path, **only if it does not already have
   one**, and **only to itself** (`grant ff_migration_owner to <current_user> with
   set true`) — it never touches an internal Supabase role, and it can only
   succeed for a role that already administered `ff_migration_owner` via
   `admin_option`;
2. grants `CREATE` on `ff_private` to `ff_migration_owner`, which is the
   unavoidable minimum for ownership of the functions inside it to be transferable
   at all;
3. asserts the result, so a genuine permission problem raises **one** precise
   message with a hint instead of 56 misleading ones.

Both statements are idempotent; a retried push is safe. **Neither changes the
security model**: `ff_migration_owner` stays NOLOGIN, NOINHERIT, NOSUPERUSER,
NOCREATEDB, NOCREATEROLE, BYPASSRLS, it still owns the functions and no relations,
and the membership is a property of the *migrating* role, not of the definer.

### 6b.3 Recovery if your push already aborted at 10

You do **not** need to reset, re-run 1–9, or mark anything applied.

| Step | Command / action | Expected |
|---|---|---|
| 1 | Dashboard → SQL Editor → run the **read-only** diagnostic in 6b.4 | see 6b.5 |
| 2 | `supabase migration list --remote` | 1–9 applied, 10–13 pending |
| 3 | `supabase db push --dry-run --remote` | lists 10–13 only |
| 4 | `supabase db push --remote` | 10 now passes the pre-flight; aborts at 12 with the **storage** error — see 6a, that is expected |
| 5 | §7 (storage owner step), then `supabase db push --remote` again | 12 and 13 apply |
| 6 | `supabase migration list --remote` | all 13 applied |

> Do **not** use `supabase migration repair`, and do **not** edit an already-applied
> migration (1–9 cannot be changed remotely; the CLI would refuse to re-run them).
> Do **not** run `supabase db reset --remote` — it drops your schemas.

### 6b.4 Read-only diagnostic — run this first

```sql
-- Who is executing, and can they become the definer?
select current_user as executor;

select rolname, rolsuper, rolcreaterole, rolbypassrls, rolcanlogin, rolinherit
from pg_roles where rolname in ('postgres', 'ff_migration_owner');

-- The decisive one: set_option is what ALTER OWNER consults.
select r.rolname as target_role, m.rolname as member,
       am.admin_option, am.inherit_option, am.set_option
from pg_auth_members am
join pg_roles r on r.oid = am.roleid
join pg_roles m on m.oid = am.member
where r.rolname = 'ff_migration_owner';

-- The latent blocker.
select nspname,
       has_schema_privilege('ff_migration_owner', oid, 'USAGE')  as usage,
       has_schema_privilege('ff_migration_owner', oid, 'CREATE') as create_priv
from pg_namespace where nspname in ('public', 'ff_private');

-- Which migrations are actually recorded.
select version from supabase_migrations.schema_migrations order by version;
```

### 6b.5 Reading the result

* **`executor` is `postgres`** and `ff_migration_owner` has `rolbypassrls = true`,
  `rolcanlogin = false` — the expected profile. Continue to 6b.3 step 2.
* **A `pg_auth_members` row exists with `set_option = false`** — exactly the
  condition migration 10 now repairs. Nothing for you to do; re-push.
* **No `pg_auth_members` row at all** for `postgres` — 009's `create role` did not
  run under `postgres`, so the executor does not administer the role and 010's
  self-grant cannot succeed. In that case only, run the reviewed one-time
  bootstrap below as a role that *does* administer `ff_migration_owner`, then
  re-push. This is the single case where a manual statement is required.
* **`create_priv` is `false` for `ff_private`** — expected before the push;
  010 grants it.
* **10–13 absent from the version list** — expected; that is what the push will add.

### 6b.6 One-time bootstrap — only for the "no membership row" case

**⚠️ REMOTE WRITE, NEEDS YOUR APPROVAL.** Run as a role that administers
`ff_migration_owner` (usually `postgres`) **only if 6b.4 showed no membership row**:

```sql
begin;

-- 1. Give the migrating role a SET ROLE path. `with set true` is the part that
--    matters; a bare grant leaves set_option = false and fixes nothing.
grant ff_migration_owner to postgres with set true;

-- 2. The new owner needs CREATE on the schema it will own objects in.
grant create on schema ff_private to ff_migration_owner;

commit;
```

Verify before moving on:

```sql
select pg_has_role('postgres', 'ff_migration_owner', 'set')                     as can_set_role,
       has_schema_privilege('ff_migration_owner', 'ff_private', 'CREATE')       as can_create;
```

Both must be `true`. Then continue at 6b.3 step 2.

### 6b.7 Optional tidy-up, after all 13 are applied

The membership is not required at runtime — only `ALTER OWNER` needed it. You may
remove it once the deployment is verified, and it is safe to do so:

```sql
revoke ff_migration_owner from postgres;
```

Verified behaviour: ownership of all 104 SECURITY DEFINER functions persists,
`ff_migration_owner` keeps BYPASSRLS and NOLOGIN, and `postgres` loses `SET ROLE`
into it. `admin_option` remains (Postgres keeps the creator's admin path), so this
does not fully erase the relationship — do not claim otherwise. Leaving the
membership in place is also acceptable; `ff_migration_owner` is NOLOGIN and owns
no relation, so the membership grants no reachable authority.

---

## 6c. The `auth`-schema trap — **unfixable by GRANT; repaired by migration**

> **Fixed forward-only in executable migration 12 (`definer_actor_identity`).**
> Read this if your push aborted at the privilege verification with
> `ff_migration_owner needs USAGE on schema auth to call auth.uid()`, and to
> understand why no GRANT can solve it.

### 6c.1 Why the grant in 009 cannot work

On hosted Supabase:

* the `auth` **schema** is owned by `supabase_admin`;
* the **tables and functions** inside it are owned by `supabase_auth_admin`;
* `postgres` holds `USAGE` on `auth` **without the grant option**, and is **not a
  member** of either owner role — membership in them is reserved to superusers,
  and `postgres` is `NOSUPERUSER`.

PostgreSQL lets a role grant a privilege only if it holds that privilege **WITH
GRANT OPTION**. `postgres` does not, so migration 009's

```sql
grant usage on schema auth to ff_migration_owner;
```

**does not fail — it silently succeeds and changes nothing.** Postgres logs only:

```
WARNING:  no privileges were granted for "auth"
```

`has_schema_privilege('ff_migration_owner','auth','USAGE')` stays `false`.

This is not a bug in the migration; it is the platform's privilege model, and
Supabase documents it: see *"Permission errors when granting custom roles access
to the auth schema"* in the Supabase knowledge base. That page also states that
`postgres` cannot become `supabase_auth_admin`, so **there is no role available to
the deployment that can perform this grant.**

### 6c.2 Why the assertion was still right

It was not cosmetic. With `auth` unreachable, every SECURITY DEFINER function that
calls `auth.uid()` failed **at runtime** with `42501 permission denied for schema
auth`. In the deployment harness, all client RPCs failed this way: migrations
001–011 applied cleanly and produced a database whose API was unusable. The
verification aborting was the correct outcome.

### 6c.3 What migration 12 does instead

`auth.uid()` is only a thin reader of the request JWT claims, which Supabase sets
as ordinary GUCs. Reading those GUCs needs **no privilege on the `auth` schema**.
Migration 12:

1. creates `ff_private.current_actor_id()`, which reads the same GUCs with
   `auth.uid()`'s exact semantics plus the PostgREST `request.jwt.claims`
   fallback (same value, never a different one);
2. repoints the **46** definer functions that called `auth.uid()` at it, rewriting
   only that token via `pg_get_functiondef`;
3. keeps every other property identical, and asserts it.

This is Supabase's own recommended remedy for this exact situation ("Option 2:
read the user ID from the JWT claims").

**Not chosen, and why:**

| Alternative | Why rejected |
|---|---|
| Grant `authenticated` to `ff_migration_owner` (Supabase "Option 3") | Makes the definer inherit SELECT on all 40 public tables and membership in a client role. 013 assertion 9 forbids a client role in the definer's membership chain; it also widens a BYPASSRLS role. |
| Drop 012's assertion | Ships a database whose API returns 42501 on every call. |
| Ask for an owner-authorised superuser grant | Not available on hosted Supabase (6c.1). |

**Unchanged:** no privilege is granted on `auth`, `auth.users`, or any auth
function; no auth object is altered or re-owned; `ff_migration_owner` keeps
NOLOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, BYPASSRLS; RLS policies
still call `auth.uid()` directly and are untouched (they run as the querying
role, which always could).

### 6c.4 Recovery from the aborted push

Migrations 001–011 are applied; 012–013 were rolled back. Nothing to repair.

| Step | Command / action | Expected |
|---|---|---|
| 1 | `supabase migration list --remote` | 1–11 applied, 12–13 pending |
| 2 | `supabase db push --dry-run --remote` | lists the two pending migrations |
| 3 | `supabase db push --remote` | the repair applies, then the assertion passes; the push aborts at the **storage** assertion — see 6a, expected |
| 4 | §7 storage owner step, then `supabase db push --remote` again | final assertion applies |
| 5 | `supabase migration list --remote` | all 14 applied |

> **On the renumbering.** The repair had to run *before* the assertion that
> polices it, and the CLI applies migrations in version order. 012 and 013 were
> never recorded as applied, so they are renumbered rather than edited in place:
> the repair is now `12`, and the two assertions become `13` and `14`. Applied
> migrations 001–011 keep their versions and are untouched.

### 6c.5 Verification (read-only)

```sql
-- 1. Must be 0: no definer owned by ff_migration_owner still calls auth.uid().
select count(*) as definers_using_auth_uid
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','ff_private') and p.prosecdef
  and pg_get_userbyid(p.proowner) = 'ff_migration_owner'
  and position('auth.uid()' in p.prosrc) > 0;

-- 2. The helper exists, the definer can call it, clients cannot.
select has_function_privilege('ff_migration_owner','ff_private.current_actor_id()','execute') as definer_can_call,
       has_function_privilege('authenticated','ff_private.current_actor_id()','execute')   as client_can_call;

-- 3. Unchanged: still no USAGE on auth, and it no longer matters.
select has_schema_privilege('ff_migration_owner','auth','USAGE') as usage_on_auth;

-- 4. The definer still owns everything and still has BYPASSRLS.
select count(*) as definers,
       count(*) filter (where pg_get_userbyid(p.proowner) = 'ff_migration_owner') as owned_by_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','ff_private') and p.prosecdef;

select rolcanlogin, rolinherit, rolsuper, rolbypassrls
from pg_roles where rolname = 'ff_migration_owner';
```

Expected: `definers_using_auth_uid = 0`; `definer_can_call = true`,
`client_can_call = false`; `usage_on_auth = false` (and that is fine — it is no
longer used); `definers = owned_by_definer`; and the role still NOLOGIN with
`rolbypassrls = true`.

**The real proof is a live API call.** From the app (or the dashboard with a
signed-in session), call any RPC. Before the repair it returned
`42501 permission denied for schema auth`; after it, it returns data or a
domain-level refusal. That single call is worth more than every row above.

---

## 7. Storage: the owner-authorised step — **⚠️ REMOTE WRITE, NEEDS YOUR APPROVAL**

This is separate from the CLI because only the role that owns `storage.objects`
can create a policy on it. On Supabase that is `supabase_storage_admin`, which the
migration role is not a member of. You do this in the **Dashboard SQL Editor**.

### 7a. Confirm the owner (read-only)

Dashboard → **SQL Editor** → New query → run:

```sql
select pg_get_userbyid(relowner) as owner,
       relrowsecurity             as rls_enabled
from pg_class
where oid = 'storage.objects'::regclass;
```

**Expected:** `owner = supabase_storage_admin`, `rls_enabled = true`.

If `owner` is something else, **stop and report it** — the instructions below
assume the standard Supabase layout.

### 7b. Check whether the push already created it (read-only)

Sometimes the push succeeded in creating the policy (if the deploying role did own
the table). Check before doing anything:

```sql
select polname, polcmd
from pg_policy
where polrelid = 'storage.objects'::regclass;
```

- **If `player_images_member_read` is listed with `polcmd = 'r'`** → already done.
  Skip to §7d.
- **If the result is empty** → continue to §7c.

### 7c. Apply the policy

Open `supabase/design/storage/003b_storage_policy_owner_step.sql` from this repo,
read it, then paste the whole file into the SQL Editor and run it.

It creates exactly one `SELECT` policy, is idempotent (`drop policy if exists`
first), raises if `storage.objects` is missing or RLS is off, and **creates no
write policy**. It does not change ownership, grant internal role membership, or
run `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.

If the SQL Editor refuses with `must be owner of table objects`, **stop and tell
me**. Every workaround (changing ownership, granting `supabase_storage_admin`)
trades a broken feature for a broken security boundary — the remaining option is a
support ticket.

### 7d. Verify the Storage setup (read-only)

Run `supabase/design/storage/verify_storage_setup.sql` in the SQL Editor. It is
read-only.

**Expected:** C1 `is_public = false`, limit `5242880`, 3 MIME types; C2 `t`;
C3 one row with `polcmd = 'r'`; C4 `write_policies = 0`; C5 `anon_can = f`,
`authenticated_can = t`; C6 zero rows; C7 `supabase_storage_admin`.

**Report back:** the output of 7a, 7b and 7d.

---

## 8. The 18 read-only remote checks

Open `supabase/design/verify/remote-checks.sql`, copy the entire file, paste it
into the SQL Editor, and run it in one go.

It is read-only — the build fails if anyone ever adds an `INSERT`/`UPDATE`/
`DELETE`/DDL/`GRANT` to it — so it is safe to run as often as you like. It returns
**18 rows** rather than stopping at the first problem.

You can also run it from the CLI once the project is linked:

```powershell
supabase db query --remote --read-only --file supabase/design/verify/remote-checks.sql
```

> `--read-only` is what makes this safe and prompt-free: it runs the statement in a
> read-only transaction and skips the confirmation.

**Expected:** all 18 rows read `PASS`.

| # | Check | A FAIL means |
|---|---|---|
| 01 | 40 public tables exist | migrations did not fully apply |
| 02 | RLS on every public table | a table is world-readable |
| 03 | `anon` holds zero table privileges | anonymous data exposure |
| 04 | `authenticated` holds `SELECT` only | clients can bypass the RPC layer |
| 05 | `ff_migration_owner` is `NOLOGIN` + `BYPASSRLS` | definer role misconfigured |
| 06 | definer owns no table | ownership drift |
| 07 | every definer owned by `ff_migration_owner` | privilege-escalation surface |
| 08 | every definer pins `search_path` | hijack via `search_path` |
| 09 | no definer reachable by `anon`/`PUBLIC` | unauthenticated RPC access |
| 10 | all 40 `ff_*` RPCs granted to `authenticated` | a screen will 401/42501 |
| 11 | definer can execute every `ff_private` helper | internal grant gap (42501) |
| 12 | `player-images` bucket private, 5 MB, jpeg/png/webp | read config wrong |
| 13 | read policy present and `SELECT`-only | images unreadable |
| 14 | no write policy on the bucket | upload bypasses the intended flow |
| 15 | RLS enabled on `storage.objects` | storage reads unchecked |
| 16 | 3 scoring write-blockers installed | scoring values could be invented |
| 17 | no API role inherits the definer | role escalation |
| 18 | no `ff_*` executable by `PUBLIC` | unauthenticated RPC access |

Check 07 is not theoretical: it failed the first time it ran locally, catching a
definer left owned by `postgres`. Migration 12 now transfers ownership
structurally and migration 13 asserts it.

**Report back:** the full 18-row output. A single `FAIL` row is enough to stop.

---

## 9. Frontend configuration (local only — nothing here touches the database)

Dashboard → **Project Settings → API**:

- **Project URL** → `VITE_SUPABASE_URL`
- **anon / publishable** key → `VITE_SUPABASE_ANON_KEY`

⚠️ **Not** the `service_role` key. The app detects it and refuses to start, because
shipping it would expose the whole database.

```powershell
Copy-Item .env.example .env.local
notepad .env.local     # paste the two values
npm run dev
```

**Expected:** `/login` renders a real form; signing up creates a row in
**Authentication → Users**.

**Auth settings to check** (Dashboard → Authentication → Providers → Email):
- If **Confirm email** is ON, signup will not create a session and the UI says
  "check your email". That is correct, not a bug.
- **Site URL** and **Redirect URLs** must include `http://localhost:5173` (and your
  deployed origin later) or confirmation/reset links will fail.

---

## 10. If something fails: forward repair

**Never rerun a migration that is not idempotent.** Migration 1 (`schema`) and the
bucket insert are the non-idempotent ones. From `009` onward each migration is
written to converge on a re-run.

| Symptom | Cause | Repair |
|---|---|---|
| `12` fails: `anon holds table privileges` | a pre-existing grant on a `public` table | `REVOKE` that specific grant, then `db push --remote` |
| `12` fails: `… not executable by ff_migration_owner` | `009` did not complete | re-run `db push --remote` (skips applied ones); inspect with the query in the error |
| `12` fails: `storage policy player_images_member_read is missing` | you have not done §7 yet | do §7, then `db push --remote` |
| `13` fails: `… not granted to authenticated` | an API grant was lost | re-run `db push --remote`; if it persists, tell me |
| `relation "storage.objects" does not exist` | not a Supabase database | stop — wrong target |
| `permission denied to change default privileges` | deployer is not a member of `postgres` | should be skipped by the guard in `009`; send me the log if not |
| `Target: local stack (127.0.0.1:54322)` | **you forgot `--remote`** on CLI v3 | re-run with `--remote`. Nothing was touched on your hosted project. |

To mark a migration as applied **without** running it (only if we agree the
objects already exist):

```powershell
# ⚠️ REMOTE WRITE (history table only). Do not use this to skip a failed migration.
supabase migration repair <VERSION> --status applied --remote
```

---

## 11. What has and has not been verified

| Claim | Status |
|---|---|
| SQL is valid on PostgreSQL 17.6 | **Verified** — native PG 17.6 runs, Phase 2B.5 |
| All 13 apply in order on a clean database | **Verified** against a mocked Supabase bootstrap (roles, `auth.uid()`, storage tables simulated) |
| Privilege model is as asserted | **Verified** — migrations 12 and 13 fail loudly if not |
| Authorization is enforced server-side | **Verified** — 26 end-to-end API tests, each action tested allowed *and* refused |
| The app builds, typechecks and renders | **Verified** — build clean, 48 unit/render tests |
| Pre-deployment security audit | **Done** — 2 defects found and fixed (silent empty-data, cross-league fixture) |
| Works against your hosted project | **NOT verified** — needs your run |
| Auth, email confirmation, password reset remotely | **NOT verified** — depends on your email settings |
| Storage policies behave on hosted Supabase | **NOT verified** — §7 is unrun |
| Real browser end-to-end flow | **NOT verified** — no Chromium in the review environment; run `npm run test:e2e` on your machine |

The gap between the top half and the bottom half is the point of this runbook: it
turns "untested remotely" into a sequence of checks you run and report back.
