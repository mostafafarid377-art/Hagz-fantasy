// Run the unchanged 2A.1 hardening suite against 006 as well. This remains a
// single-connection PGlite mock; native PostgreSQL covers concurrent sessions.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const create = PGlite.create.bind(PGlite);
PGlite.create = async (...args) => {
  const db = await create(...args);
  const exec = db.exec.bind(db);
  db.exec = async sql => {
    const result = await exec(sql);
    if (sql.includes('PHASE 2A.1 OFFLINE DESIGN ONLY')) {
      await exec(await readFile(new URL('../migrations/005_concurrency_hardening.sql',import.meta.url),'utf8'));
      await exec(await readFile(new URL('../migrations/006_revision_lineage.sql',import.meta.url),'utf8'));
    }
    return result;
  };
  return db;
};
await import('./hardening.test.mjs');
