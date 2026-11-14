// Regenerate *design* types against the offline draft only, not Supabase types.
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile } from 'node:fs/promises';
const db=await PGlite.create();
await db.exec(await readFile(new URL('tests/setup.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('migrations/001_schema.sql',import.meta.url),'utf8'));
const {rows}=await db.query("select table_name,column_name,udt_name,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position");
const {rows:foreignKeys}=await db.query(`select c.conname, a.relname as table_name, b.relname as referenced_table,
  array(select x.attname from unnest(c.conkey) with ordinality as k(attnum,ord) join pg_attribute x on x.attrelid=c.conrelid and x.attnum=k.attnum order by k.ord) as columns,
  array(select x.attname from unnest(c.confkey) with ordinality as k(attnum,ord) join pg_attribute x on x.attrelid=c.confrelid and x.attnum=k.attnum order by k.ord) as referenced_columns,
  exists(select 1 from pg_constraint u where u.conrelid=c.conrelid and u.contype in ('p','u') and u.conkey=c.conkey) as one_to_one
  from pg_constraint c join pg_class a on a.oid=c.conrelid join pg_namespace n on n.oid=a.relnamespace join pg_class b on b.oid=c.confrelid
  join pg_namespace f on f.oid=b.relnamespace where c.contype='f' and n.nspname='public' and f.nspname='public' order by a.relname,c.conname`);
const unions={
  'league_members.role':"'leader' | 'manager'",'league_members.status':"'active' | 'inactive'",'player_suggestions.status':"'pending' | 'approved' | 'rejected'",
  'fantasy_lineups.status':"'draft' | 'confirmed' | 'superseded'",'match_revisions.state':"'draft' | 'submitted' | 'approved' | 'rejected' | 'corrected'",
  'real_match_lineup_players.selection':"'starter' | 'substitute'",'real_match_lineup_players.eligibility_kind':"'registered' | 'temporary'",
  'match_submissions.kind':"'lineup' | 'result'",'match_approvals.kind':"'lineup' | 'result'",'match_approvals.decision':"'approved' | 'rejected'",
  'scoring_rule_sets.state':"'draft' | 'published' | 'retired'",'scoring_runs.status':"'pending' | 'complete' | 'superseded' | 'failed'",
  'league_standings.mode':"'fantasy_total' | 'head_to_head'",'fantasy_lineups.formation':'Formation'
};
function type(c){const key=c.table_name+'.'+c.column_name;let t=unions[key] ?? (['position','actual_position','position_snapshot'].includes(c.column_name)?'Position':({uuid:'string',text:'string',timestamptz:'string',bool:'boolean',int2:'number',int4:'number',int8:'number',numeric:'number',jsonb:'Json'}[c.udt_name]??'unknown'));return c.is_nullable==='YES'?`${t} | null`:t;}
const tables=Object.groupBy(rows,c=>c.table_name);let out=`// GENERATED FROM OFFLINE PHASE 2A DESIGN; not Supabase-generated or production-ready.\n// Numeric fields follow PostgREST's number shape; validate exact-money transport before integration.\nimport type { Formation, Position } from './index';\nexport type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];\nexport type DatabaseDesign = { public: { Tables: {\n`;
for(const [name,cols] of Object.entries(tables)){
  out+=`  ${name}: {\n`;
  for(const mode of ['Row','Insert','Update']){
    out+=`    ${mode}: {\n`;
    for(const c of cols){const optional=mode==='Update'||(mode==='Insert'&&(c.is_nullable==='YES'||c.column_default!==null));out+=`      ${c.column_name}${optional?'?':''}: ${type(c)};\n`;}
    out+='    };\n';
  }
  const relations=foreignKeys.filter(f=>f.table_name===name).map(f=>`{ foreignKeyName: ${JSON.stringify(f.conname)}; columns: ${JSON.stringify(f.columns)}; isOneToOne: ${f.one_to_one}; referencedRelation: ${JSON.stringify(f.referenced_table)}; referencedColumns: ${JSON.stringify(f.referenced_columns)} }`);
  out+=`    Relationships: [${relations.join(', ')}];\n  };\n`;
}
out+='}; Views: Record<string, never>; Functions: Record<string, never>; Enums: Record<string, never>; CompositeTypes: Record<string, never> } };\n';
await writeFile(new URL('../../src/types/database.design.ts',import.meta.url),out);await db.close();
