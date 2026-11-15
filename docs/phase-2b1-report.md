# Phase 2B.1 — Report

**Fantasy Friends — Supabase CLI & Migration Preparation**

Phase 2B.1 is **preparation only**. No Supabase project was connected, no migration was applied, no credentials were created, and no commit or push was made.

## 1. Branch and starting commit

| Item | Value |
|---|---|
| Branch | `arena/4da779c0-hagz-fantasy` (unchanged; no branch switch, no rename) |
| Starting commit | `1a78ccb` — *Merge pull request #7 from mostafafarid377-art/arena/53775cb5-hagz-fantasy* |
| Base of branch | `1a78ccb84613ab374a7ec735a510cc54bfe7d17a` on `main` |
| Working tree at start | Clean |
| Phase 2A work | All 13 `docs/phase-2a/` documents and the 6 SQL design drafts present and intact |
| Commits made | **None** (per instruction) |
| Pushes / PRs | **None** (per instruction) |

## 2. Files created or changed

Created (5):

| File | Purpose |
|---|---|
| `supabase/config.toml` | Local-only CLI configuration. `supabase init` output (CLI 3.1.0), with `project_id`, seeding disabled, and a header documenting that the directory is unlinked. No secrets, no `project_ref`. |
| `supabase/.gitignore` | CLI-provided ignore for `.temp/`, `.branches`, `.env.keys`, `.env.local`, `.env.*.local`. |
| `docs/phase-2b1-migration-package.md` | The versioned migration package: proposed filenames and ordering, per-draft required changes, pristine-database requirement, mandatory correction-attempt and fork-idempotency work. |
| `docs/phase-2b1-supabase-cli-setup.md` | CLI installation and verification record, config decisions, what remains unverified, forbidden commands. |
| `scripts/check-migration-package.mjs` | Repo guard: fails if a design draft changes, if any SQL lands in `supabase/migrations/`, if the project is linked, or if `config.toml` gains a secret. |

Changed (1):

| File | Change |
|---|---|
| `package.json` | Added one script: `"check:migrations": "node scripts/check-migration-package.mjs"`. No dependency changes, no version changes. |

**Not changed:** all six files in `supabase/design/migrations/` (checksums verified below), every Phase 2A document, all frontend source, Demo mode, the Pages workflow.

```
5207d5938696…  001_schema.sql
8986954237db…  002_security.sql
1b54e2f35ade…  003_storage.sql
e3ced92af953…  004_integrity_workflows.sql
98e55433868b…  005_concurrency_hardening.sql
8f427e86b8b3…  006_revision_lineage.sql
```

## 3. Supabase CLI setup and verification

- **Official approach only.** Verified on 2026-11-15 against <https://supabase.com/docs/guides/local-development/cli/getting-started> (updated 2026-11-02) and <https://supabase.com/docs/guides/local-development/cli-workflows> (updated 2026-11-03): npm package **`supabase`**, installed with `--save-dev`, run through `npx`; requires **Node.js 20+** (sandbox has v22.22.3). `supabase init` is documented as local only and does not sign in or link.
- **Version installed for verification: 3.1.0** (`latest` dist-tag). Installed in a throwaway `/tmp` directory so this repository's dependency tree is untouched.
- **Verified:** `init` produces `config.toml` + `.gitignore` without touching the existing `supabase/design/`; `migration new` writes `supabase/migrations/<timestamp>_<name>.sql`; the committed config parses as TOML and the CLI accepts it with **no unknown-key warnings**; a deliberately malformed config is rejected and a deliberately bogus key is reported (so silence means clean); `supabase status` reports `Not linked.`
- **Not verified:** the local stack could not start in this sandbox — `docker: command not found (podman also not found)`. This is an environment limitation. The CLI's experimental native runtime also requires a non-root supported host and downloads service archives on first start; it was not attempted.
- **No hosted project exists or was contacted.** No `login`, `link`, `db push`, `db pull`, or `migration up --linked`.

Details: [CLI setup and verification](phase-2b1-supabase-cli-setup.md).

## 4. Migration readiness, per file

The proposed executable package is ten migrations, not six: the six drafts replayed one-per-file, plus **two new design migrations that do not exist yet** (correction attempts; result-fork idempotency) and two ownership/grant-verification migrations. See [the migration package](phase-2b1-migration-package.md) §2.

| Design draft | Executable today? | Blockers |
|---|---|---|
| `001_schema.sql` | **No** | Business rules not enforced by DDL (squad/budget/formation/deadline/transfer); ×1,000,000 money conversion undocumented; FK index/`EXPLAIN` review outstanding; PostgreSQL 17 replay unproven. |
| `002_security.sql` | **No** | Not the approved permission baseline on its own — `004` deliberately narrows its organizer reads. Funcdefiner ownership is not assigned anywhere (59 `SECURITY DEFINER` functions, all with pinned `search_path`). Interacts with Supabase default grants (§3.3 of the package). |
| `003_storage.sql` | **No — highest deployment risk** | `create policy … on storage.objects` needs Storage-table ownership; `storage.objects` is owned by `supabase_storage_admin`, not the migration role. Locally reproduced: bucket insert **succeeded** with grants, policy creation **failed** with `must be owner of table objects`. Requires an owner-authorized path. No upload policy exists by design. |
| `004_integrity_workflows.sql` | **No** | Cannot model numbered correction retry attempts (needs a new migration). `fork_result` creates a duplicate draft on every retry (needs a new migration). Scoring writes are intentionally blocked, so runs can never complete. |
| `005_concurrency_hardening.sql` | **No** | Locking is not idempotency. Requires `READ COMMITTED` at runtime and whole-transaction retry on `40P01` — no caller exists. Roster-overlap preflight aborts on any pre-existing conflict. |
| `006_revision_lineage.sql` | **No — and it must stay last on a pristine database** | Raises `23514` if any `match_revisions` row exists: *"revision lineage cannot be inferred for existing data; human migration review required."* Adds lineage only — still no correction attempts, no fork idempotency. |

## 5. Prerequisite verification

| Prerequisite | Finding |
|---|---|
| **`auth` schema and `auth.uid()`** | Design depends on `auth.uid()` (46 uses) and `auth.users(id)` for the `profiles` FK. Supabase's own bootstrap defines `auth.uid()` reading `request.jwt.claim.sub`, so the *shape* matches, but the mock stand-in used in tests is **not** evidence. Access to `auth` is a real requirement: a non-owner role reproduced `permission denied for schema auth`. Must be confirmed on a real project. |
| **Storage schema and policies** | Bucket insert and `storage.objects` policy are **different privileges**. Ownership failure reproduced locally. Unverified on Supabase. |
| **Roles and grants** | `anon`, `authenticated`, `service_role`, `authenticator`, `supabase_auth_admin`, `supabase_storage_admin` are platform-managed. Crucially the migration role is **not** a superuser and does **not** own `auth`/`storage` objects — the design must not assume it does. Supabase also grants `ALL` on new `public` tables to `anon`/`authenticated` by default; the drafts' revokes land correctly in the local emulation, but this must be pinned (config switch or explicit migration) rather than assumed. |
| **PostgreSQL version** | Committed config targets **`17`** (current CLI/platform default). Phase 2A evidence is PostgreSQL **15.18** and PGlite 0.5.16 (**18.6**). **PostgreSQL 17 replay is unproven.** |
| **Migration ownership and function security** | No owner is created or assigned in `001`–`006`. All **59** `SECURITY DEFINER` functions pin `search_path` (verified by script and by catalog query: 48 definer functions in `ff_private`, 0 without `search_path`). Least-privilege: only the **10** read helpers are granted to `authenticated`; every mutation function is unreachable. That fail-closed posture is correct and must not be relaxed before the two mandatory migrations land. |

### Disposable local verification performed

Two throwaway probes (PGlite in memory, plus a scratch PostgreSQL 16 cluster under `/tmp` that was not part of the repository and is not persisted):

1. **Superuser, Supabase-like bootstrap emulated** (`anon`/`authenticated`/`service_role(bypassrls)`, default privileges granting ALL to API roles, `auth.users` + `auth.uid()`, `storage.buckets`/`storage.objects` owned by `supabase_storage_admin`): all six drafts applied in order; end state was RLS enabled on **all 36** `public` tables, `anon` with **zero** table privileges, `authenticated` with `SELECT` only.
2. **Non-owner role with ordinary grants** (hosted-like): the bucket insert succeeded, but `alter table storage.objects enable row level security` and `create policy … on storage.objects` both failed with `must be owner of table objects`; `create table` in `public` succeeded as a control; and referencing `auth.users` failed with `permission denied for schema auth`.

**These are clean-room emulations of documented platform behaviour. They are not Supabase, and they do not establish Supabase compatibility.** No claim is made on that basis.

## 6. Mandatory items that remain open

Both are **implementation blockers**, not unresolved design choices, and both must land before any match workflow is exposed:

1. **Correction-attempt records.** `004`'s `match_corrections` is one row with one immutable `draft_revision_id` and `unique(official_result_id)`. It cannot represent numbered retry attempts after a rejected correction lineup. An append-only attempt relation is required (proposed migration 7), must fail closed on pre-existing correction rows, and needs rejection→retry, stale-attempt and latest-attempt tests.
2. **Persisted result-fork idempotency.** Business key `(league_id, match_id, workflow_case_id, lineup_approval_id, result_attempt_no)` plus a unique request UUID. `006`'s `fork_result` still creates a **new revision on every call**; `005`'s locking serialises forks but does not deduplicate them. A persisted unique mapping is required (proposed migration 8), with same-key concurrent replay, sequential replay and payload-mismatch tests.

## 7. Test and check results

| Check | Command | Result |
|---|---|---|
| Unit tests | `npm test` | ✅ **36/36** passed (6 files) |
| PGlite design tests | `npm run test:db:design` | ✅ **31/31** passed |
| Typecheck | `npm run typecheck` | ✅ passed (no output) |
| Production build | `npm run build` | ✅ built in ~3.9 s |
| Pages asset checks | `npm run test:pages:assets` | ✅ `Pages build assets verified for /Hagz-fantasy/` |
| Migration package guard | `npm run check:migrations` | ✅ **12/12** checks passed |
| Whitespace | `git diff --check` (working tree and index) | ✅ clean |

`npm ci` was run to install dependencies for the test suite. Browser E2E suites were **not** run: this phase changes no frontend behaviour, and no browser is pinned in this environment. The 36 unit tests, typecheck, build and Pages asset checks cover the same non-regression surface as Phase 2A's reported results (36/36, typecheck, build, pages assets all passing).

## 8. Explicit limits of this evidence

- **No Supabase compatibility is claimed.** Local PGlite and the scratch PostgreSQL 16 cluster mock Auth, Storage, roles and default privileges. They do not exercise Supabase Auth JWT issuance, PostgREST, the real Storage service, actual role inheritance, connection pooling, `READ COMMITTED` under real parallel sessions, or PostgreSQL 17.
- A green local test is not a security certification, and the emulation is not a substitute for a disposable local Supabase stack.
- No migration was applied to any persistent database. No SQL in this phase targeted anything outside an in-memory or `/tmp` scratch instance.

## 9. Exact next step for Phase 2B.2

**Bring up a disposable local Supabase stack and replay the corrected baseline there — but first resolve the two items that must precede executable SQL.**

1. **Obtain human approval** of the migration package [`docs/phase-2b1-migration-package.md`](phase-2b1-migration-package.md) — specifically the ten-migration ordering, the `auto_expose_new_tables` decision (§3.3), and the owner-authorized Storage path for `003` (§3.4).
2. **Decide and record** how `supabase/migrations/` will be populated: the six replayed baseline migrations created with `npx supabase migration new <name>`, each carrying the fixes listed in package §3 for its draft and a comment tracing it to the unchanged design file. Keep `npm run check:migrations` green apart from its intentional "no SQL in `supabase/migrations/`" assertion, which must be updated in the same reviewed change.
3. **Then, and only with a container runtime present:** `npx supabase start` on a fresh local project, `npx supabase db reset` **twice** from empty, and confirm on **PostgreSQL 17**: `auth.uid()` behaviour, `storage.objects` policy creation, effective `anon`/`authenticated` grants per table, `pg_trigger` deferral of `require_run_source`, and that `006` refuses a non-empty `match_revisions`.
4. **Do not** run `supabase login`, `supabase link`, `db push` or `db pull` in Phase 2B.2 either. No hosted project is required to complete the replay, and none should be created before the two mandatory migrations and their tests exist.

Phase 2B.1 stops here as instructed: no Supabase connection, no migration execution, no commit, no push.
