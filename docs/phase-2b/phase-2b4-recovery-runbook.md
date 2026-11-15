# Phase 2B.4 — Recovery and rollback runbook

How to recover from a migration failure in this package. The package has **no down migrations**, and only `009`/`010` are idempotent, so recovery is a deliberate procedure, not a re-run.

**Never blindly re-run a non-idempotent migration.** Re-running `001`–`008` against a database that partly applied them will fail — and the failure will look different from the original, sending you after the wrong problem.

## 1. The one distinction that drives every recovery decision

The Supabase CLI records applied migrations in `supabase_migrations.schema_migrations`. `db push` applies only migrations **absent** from that table.

So the question is never *"did the SQL run?"* but:

> **Did the history row get written?**

| History row | Objects | State | Recovery |
|---|---|---|---|
| absent | absent | clean, never applied | run it (normal path) |
| **absent** | **present** | **the dangerous case** — "uncertain result" | §6 before anything else |
| present | present | applied | nothing to do |
| present | absent | inconsistent (impossible via `db push`; possible after a manual restore) | §5 |

Determine the truth before acting:

```sql
-- 1. What does history say?
select version, name, inserted_at
from supabase_migrations.schema_migrations order by version;

-- 2. What does the catalog say? (spot-check per migration)
select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r';          -- 001: expect 36, final: 40
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='ff_private' and p.prosecdef;        -- final: expect 56
select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relrowsecurity;  -- final: expect 40
```

## 2. A migration failing halfway

**Measured behaviour (PG17.6):**

| How the file is applied | Result of a failure |
|---|---|
| Whole file inside one transaction | **rolls back atomically — zero orphaned objects** (43 functions before and after a failed `005`) |
| Batches with `COMMIT` between them | **partial objects persist** |

If the CLI applies each file atomically (the common behaviour), a half-failed migration leaves nothing behind: fix the SQL, re-run. Verify with the §1 catalog queries — if the object counts match the *previous* migration, nothing committed.

**If objects did persist**, you are in the batch-commit case and must use §6. Do **not** re-run the file: it will fail with `already exists` on the first object, and that error tells you nothing about what else is missing.

## 3. A partially created schema

Symptoms: the table count is between two migration boundaries (e.g. 37 when `001` should give 36 or the final should give 40), or `010` fails with `reviewed tables are missing`.

**Procedure:**

1. Identify the exact low-water mark using §1's catalog queries plus per-object checks:
   ```sql
   select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' order by 1;
   ```
2. Compare against the object inventory: `001` creates 36 tables, `004` adds 2, `007` adds 1, `008` adds 1.
3. **If the history row is absent and objects exist**, do not fabricate a history row unless the schema is *exactly* at that migration's end state. Partial state plus a fabricated history row is the worst outcome: every later migration is then computed against a schema that does not match, and the errors surface far from the cause.

**Sanctioned reset for a disposable environment:**

```sql
drop schema public cascade;
drop schema ff_private cascade;
-- then delete the corresponding rows from supabase_migrations.schema_migrations
```

`drop schema … cascade` was verified to succeed cleanly. This is only ever correct for an environment whose data has no value — it is **not** a production recovery path. For a hosted project the correct recovery is **restore from backup** (§7).

## 4. A failed Storage policy operation

The most likely failure in the whole package, because `CREATE POLICY … ON storage.objects` requires table ownership.

| Symptom | Meaning | Action |
|---|---|---|
| `42501 must be owner of table objects` | Ran as the migration role | Re-run **only** the single `CREATE POLICY` statement as `supabase_storage_admin` (see the [storage runbook](phase-2b4-storage-execution-runbook.md) §3). Do not grant ownership or membership. |
| `policy already exists` | B1 partly applied | B1 is written as `DROP POLICY IF EXISTS` + `CREATE`, so this should not occur; if it does, drop the policy by name as the owner and re-create |
| `010` fails on the storage assertions | B1 was skipped | Run B1. This is `010` doing its job — do not delete the assertion |

**`003` itself is unaffected by a failed B1**: the bucket insert and the helper live in Phase A and commit independently. A failed policy leaves a private bucket with **no** policy, which grants nothing — fail-closed, not open. `010` will refuse to complete.

## 5. A failed ownership/grant operation

`009` is idempotent by construction (revoke-then-grant, guarded `DO` blocks), so the recovery is simply to **re-run it** after fixing the cause. It is one of only two files in the package where that is true.

| Symptom | Cause | Action |
|---|---|---|
| `permission denied to change default privileges` | Not a member of `postgres` | Already guarded in `009` (`pg_has_role` check, both branches verified). If seen, the file predates the guard — update it, do not grant membership |
| `ff_migration_owner must not be granted to an API role` | A role was granted to a client role | `REVOKE ff_migration_owner FROM <role>;` then re-run `009` |
| `ff_migration_owner must have BYPASSRLS` (from `010`) | The role was created or altered without it | `ALTER ROLE ff_migration_owner BYPASSRLS;` then re-run `010` |
| `ff_migration_owner must not own public relations` | Table ownership was transferred | Transfer ownership back to the migration role. This is why table transfer was rejected |
| `010` fails on `anon`/`authenticated` privileges | A grant was missed or over-granted | Re-run `009` (idempotent), then `010` |

**Never fix a grant failure by granting more.** If `010` says an API role has too much, the fix is to revoke, not to relax the assertion.

## 6. Re-running after an uncertain result

The dangerous case: an operation whose outcome you cannot confirm — a dropped connection, a timed-out `db push`, an operator who is not sure whether it ran.

**Procedure — in this order, no skipping:**

1. **Read before writing.**
   ```sql
   select version from supabase_migrations.schema_migrations order by version;
   ```
2. **Establish the catalog state** with §1's counts.
3. **Classify** against the §1 table. Only two rows permit action:
   - *absent / absent* → safe to apply normally.
   - *present / present* → already applied; do nothing.
4. **For *absent / present*** (the risky quadrant): decide between exactly two remedies —
   - **if the schema is exactly at that migration's end state**, record history without re-running:
     ```
     supabase migration repair --status applied <version> --remote
     ```
     Then run the **next** migration. Do not re-run the one you just recorded.
   - **if the schema is partial**, do not repair. Restore from backup (§7), or reset a disposable environment (§3).

**Never** use `migration repair --status reverted` to "undo" a migration whose objects still exist — that makes the history lie, and the next `db push` will re-run the file against existing objects and fail confusingly.

**Never** re-run `001`–`008` off the back of an uncertain result. Measured: a second application fails immediately with `already exists`, and the error identifies only the *first* collision, not the true state.

## 7. Backups and the honest rollback story

| Fact | Value |
|---|---|
| Down migrations in the package | **0 of 10** |
| Recovery direction | **forward-only** |
| Production rollback path | **restore from a verified backup** |

There is no `supabase db reset`-free rollback for production, and none is proposed. `db reset` is a destructive local-development operation, and even it does not restore the Storage policy because B1 is not a CLI migration — every reset needs B1 re-run, which `010` will catch.

**Required before the first hosted migration:**

1. Take a verified backup (and confirm the restore actually works — an untested backup is not a backup).
2. Record the pre-migration catalog counts from §1 as the reference to compare against.
3. Run `supabase db push --dry-run` first; it prints the migrations that *would* be applied without applying them.
4. Apply in one window, running `010` last. Treat `010` failing as a stop signal, not a warning.

## 8. Recovery decision tree

```
Something failed or is uncertain
├─ Can you confirm the history row?  (query schema_migrations)
│   ├─ No history row, no objects      → apply normally
│   ├─ No history row, objects EXACT   → migration repair --status applied, then continue
│   ├─ No history row, objects PARTIAL → DO NOT repair
│   │        ├─ disposable environment → drop schema cascade + reset history
│   │        └─ anything else          → restore from backup
│   └─ History row present
│        ├─ objects present            → nothing to do
│        └─ objects absent             → restore from backup (§5 last row)
├─ Failed Storage policy?              → re-run ONLY the CREATE POLICY as the storage owner
├─ Failed 009/010?                     → fix the cause, re-run (both are idempotent)
└─ Tempted to re-run 001–008?          → STOP. Read §6 first.
```

## 9. What is not covered

- No restore has been exercised. The backup/restore path is a recommendation, not a tested procedure.
- Recovery under real data volumes, concurrent traffic, or a pooled connection is untested.
- The CLI's exact per-file transaction behaviour was not observed on a hosted project. The atomicity measurement in §2 is from a local cluster applying the file in one transaction; if the hosted path commits per statement, the partial-state branches of the decision tree apply and §6 governs.
- `migration repair` semantics were read from CLI 3.1.0 help output, not exercised against a project.
