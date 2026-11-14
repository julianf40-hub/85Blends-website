#!/usr/bin/env node
// Prints an inventory of the Recommended Gear database objects of the running LOCAL stack (tables and
// columns, check constraints, functions with a hash of their source and their grants, RLS and Storage
// policies, triggers), as JSON. Used to compare the deployment migration with the development history.
//   node tools/schema-inventory.mjs <supabase-workdir> > inventory.json
import { execSync } from 'node:child_process';
const dir = process.argv[2] ?? new URL('..', import.meta.url).pathname;
const env = JSON.parse(execSync('supabase status -o json', { cwd: dir, encoding: 'utf8', env: { GEAR_LOCAL_JWT_EXPIRY: '3600', ...process.env } }));
const q = (sql) => execSync(`psql "${env.DB_URL}" -At -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const gearTables = `(c.relname like 'gear%')`;
const inventory = {
  columns: q(`select n.nspname||'.'||c.relname||'.'||a.attname||' '||format_type(a.atttypid, a.atttypmod)||case when a.attnotnull then ' not null' else '' end
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','private') and c.relkind = 'r' and ${gearTables} and a.attnum > 0 and not a.attisdropped order by 1`),
  constraints: q(`select n.nspname||'.'||c.relname||' '||pg_get_constraintdef(k.oid) from pg_constraint k join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and ${gearTables} order by 1`),
  functions: q(`select n.nspname||'.'||p.oid::regprocedure::text||' src:'||md5(p.prosrc)||' acl:'||coalesce(array_to_string(array(select x from unnest(p.proacl) x order by x::text), ','), 'default')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private') and (p.proname like 'gear%' or p.proname = 'save_gear_draft') order by 1`),
  policies: q(`select schemaname||'.'||tablename||' "'||policyname||'" '||cmd||' '||array_to_string(roles, ',')||' using:'||coalesce(md5(qual), '-')||' check:'||coalesce(md5(with_check), '-')
    from pg_policies where (schemaname = 'public' and tablename like 'gear%') or (schemaname = 'storage' and policyname like 'gear%') order by 1`),
  triggers: q(`select c.relname||' '||t.tgname||' '||p.proname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and (c.relname like 'gear%' or c.relname = 'objects') and (t.tgname like 'gear%') order by 1`),
  tableGrants: q(`select table_schema||'.'||table_name||' '||grantee||' '||privilege_type from information_schema.role_table_grants
    where table_schema in ('public','private') and table_name like 'gear%' and grantee in ('anon','authenticated','service_role') order by 1`),
};
process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
