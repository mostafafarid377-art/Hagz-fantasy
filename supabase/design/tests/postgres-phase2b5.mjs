// Optional native PostgreSQL run of the Phase 2B.5 ownership-transfer suite.
//
// Refuses TCP and requires a disposable cluster under /tmp/ff-pg-audit, matching
// the other native runners. This is NOT a Supabase integration test: setup.sql
// mocks Auth, Storage and the API roles. A green run shows that the ownership
// transfer behaves identically on a real server as in PGlite, and that the SQL
// is valid on this PostgreSQL version. It says nothing about hosted Supabase.
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
    console.log('PostgreSQL compatibility target:', info.rows[0].version.split(',')[0]);
    return {
      query: (sql, params = []) => client.query(sql, params),
      exec: sql => client.query(sql),
      close: () => client.end(),
    };
  } catch (error) { await client.end(); throw error; }
};

await import('./phase2b5-ownership.test.mjs');
