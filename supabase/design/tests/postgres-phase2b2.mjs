// Optional native PostgreSQL run of the Phase 2B.2 suite (007-010).
//
// It refuses TCP and requires a disposable cluster under /tmp/ff-pg-audit, using
// the same guard as the existing native runners. It is NOT a Supabase
// integration test: setup.sql mocks Auth, Storage and the API roles. A green run
// shows the reviewed SQL is valid on this PostgreSQL version; it says nothing
// about hosted Supabase, real JWTs, PostgREST or concurrency.
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import assert from 'node:assert/strict';

const socket = process.env.FF_PG_AUDIT_SOCKET;
const modulePath = process.env.FF_PG_AUDIT_DRIVER;
if (!socket || !modulePath) throw new Error('Set FF_PG_AUDIT_SOCKET and FF_PG_AUDIT_DRIVER for the disposable local test cluster');
const socketDir = await realpath(socket);
if (!socketDir.startsWith('/tmp/ff-pg-audit/')) throw new Error('Only the disposable /tmp/ff-pg-audit socket is allowed');
const require = createRequire(import.meta.url);
const { Client } = require(modulePath);

PGlite.create = async () => {
  const client = new Client({ host: socketDir, port: 55432, user: 'audit', database: 'postgres' });
  await client.connect();
  try {
    const info = await client.query("select version() as version, current_setting('data_directory') as data_dir, inet_server_addr() as tcp_addr");
    assert.match(info.rows[0].version, /^PostgreSQL /);
    assert.match(info.rows[0].data_dir, /^\/tmp\/ff-pg-audit\//);
    assert.equal(info.rows[0].tcp_addr, null, 'test connection must use a local Unix socket');
    console.log('PostgreSQL compatibility target:', info.rows[0].version);
    return {
      query: (sql, params = []) => client.query(sql, params),
      exec: sql => client.query(sql),
      close: () => client.end(),
    };
  } catch (error) { await client.end(); throw error; }
};

await import('./phase2b2-pglite.test.mjs');
