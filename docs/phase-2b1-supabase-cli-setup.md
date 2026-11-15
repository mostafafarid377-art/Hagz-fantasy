# Phase 2B.1 — Supabase CLI setup and verification

Local-only setup record. **No Supabase project was contacted, linked or migrated.** This page records what was installed, what was verified, and what could not be verified in this environment.

## 1. Officially documented installation

Verified against the current Supabase documentation on 2026-11-15:

- Source: <https://supabase.com/docs/guides/local-development/cli/getting-started> (page updated 2026-11-02) and <https://supabase.com/docs/guides/local-development/cli-workflows> (updated 2026-11-03).
- Officially supported npm form: `npm install supabase --save-dev`, then run via `npx supabase <command>`.
- The CLI requires **Node.js 20 or later** when run through `npx`/`npm`. This repository's sandbox runs Node **v22.22.3**, which satisfies that.
- `Homebrew` (`brew install supabase/tap/supabase`), `Scoop`, and the Linux packages from [GitHub Releases](https://github.com/supabase/cli/releases) are the other supported forms. None are used here.
- `supabase init` is **local only**: *"`init` creates local files only: it doesn't sign you in or connect the directory to a project on the Supabase Platform."*
- `supabase start` runs the full local stack in Docker/Podman (or, experimentally, a native runtime on Linux `amd64`/`arm64` and macOS Apple silicon).

### Version installed for verification

- npm package `supabase`, current `latest` dist-tag: **3.1.0** (checked with `npm view supabase dist-tags`).
- Installed into a **throwaway directory outside the repository** (`/tmp`), not into this project, because committing a node_modules change is out of scope for a preparation phase.
- `supabase --version` → `3.1.0`.

## 2. What was verified, and how

| Check | Result |
|---|---|
| Package name and install command match the docs | ✅ `supabase` from npm, `--save-dev`, run via `npx` |
| `supabase init` creates `supabase/config.toml` and `supabase/.gitignore` | ✅ verified in a scratch directory |
| `init` does **not** link or sign in | ✅ no `project_ref`, no credentials written |
| `init` is safe when `supabase/` already contains `design/` | ✅ verified in a scratch copy of this repo tree; existing files untouched |
| `init` emits a schema pointer and full commented reference | ✅ `#:schema https://supabase.com/schemas/config/v1.json`, 16 KB reference config |
| Migrations live in `supabase/migrations/<timestamp>_<name>.sql` | ✅ `npx supabase migration new test_name` → `supabase/migrations/20261115012555_test_name.sql` |
| `supabase/.gitignore` excludes `.temp/`, `.branches`, `.env.keys` | ✅ copied into the repository |
| Committed `config.toml` parses as valid TOML | ✅ `tomllib` parses; all expected sections present |
| CLI accepts the committed `config.toml` with no unknown-key warnings | ✅ `supabase start` produced no config warning |
| CLI rejects an unintentionally malformed config | ✅ a deliberately broken TOML produced `failed to read config: Invalid TOML document` |
| CLI reports unknown keys instead of ignoring them silently | ✅ a deliberately bogus key produced a `WARN: … keys this version … does not recognize` |
| Project is **not** linked | ✅ `supabase status` → `Not linked.` |
| Local stack cannot start in this sandbox | ⚠️ `docker: command not found (podman also not found)`. This is an environment limitation, not a project defect. |

## 3. Config decisions and their reasons

The committed [`supabase/config.toml`](../../supabase/config.toml) is the CLI 3.1.0 `init` output with three deliberate edits:

| Setting | Committed value | Why |
|---|---|---|
| `project_id` | `"hagz-fantasy"` | `init` defaults to the working-directory name; it was `ffinit` because init ran in a scratch directory. `project_id` distinguishes local stacks on one host; it is **not** a hosted project reference. |
| `[db.seed] enabled` | `false` | The default config enables seeding and points at `./seed.sql`, which does not exist. `db reset` fails on a missing seed file. There is no reviewed seed data in this repository, and the Phase 2A tests seed identities and scoring values that must **never** become project data. |
| `[db.seed] sql_paths` | `[]` | Same reason: no seed file should be implied. |

Everything else is the CLI's documented default, including `db.major_version = 17` (the CLI default and the current Supabase platform default), `[api] schemas = ["public", "graphql_public"]`, and the full commented reference. Defaults are kept so the file stays auditable against `supabase init` output.

Deliberately **not** changed:

- `auto_expose_new_tables` is left uncommented-off, i.e. the documented cloud-equivalent default. See the migration package §3.3 — turning it off is a real decision that belongs with the executable migration review, not a silent config flip in a preparation phase.
- No `project_ref`, no `env()` secrets, no SMTP credentials, no OAuth providers, no `db.vault` secrets.

## 4. Exactly how to run the CLI

The CLI is **not** a dependency of this repository (adding it would change `package.json`/`package-lock.json` beyond a preparation phase). Use one of the documented forms:

```sh
# Global install (Homebrew / Scoop / Linux package), or:
npx supabase@3.1.0 --version
```

If you prefer a pinned project dependency, that is a deliberate, reviewable change:

```sh
npm install supabase@3.1.0 --save-dev   # then run: npx supabase <command>
```

Before the stack will start you need a container runtime (Docker Desktop, Podman, Rancher/colima) or, on supported Linux/macOS hosts, the experimental native runtime:

```sh
npx supabase start                      # Docker/Podman
npx supabase start --runtime native     # no container engine (experimental)
npx supabase stop
```

## 5. What is still unverified

None of the following has been demonstrated, and none may be claimed:

- That the six drafts apply to a real Supabase PostgreSQL 17 instance.
- That `auth.uid()` behaves as the design assumes under real JWT issuance.
- That the `storage.objects` policy can be created by the migration role (see package §3.4 — a documented owner limitation).
- That default privileges do not silently grant `anon`/`authenticated` more than the drafts revoke.
- That PostgREST, RLS composition, the pooler and `READ COMMITTED` behave as the design requires.
- Anything about concurrency under real parallel sessions.

`supabase start` could not run here, so **no local Supabase stack was ever started**, no migration was applied, and no `supabase db reset` or `db push` was executed.

## 6. Commands that must stay forbidden until Phase 2B.2 review

```sh
supabase login            # contacts the Supabase Platform
supabase link             # binds this directory to a hosted project
supabase db push          # applies migrations to the linked project
supabase db pull          # reads the linked project's schema
supabase migration up --linked
```

Phase 2B.1 ran none of these.
