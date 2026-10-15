// Pure local projection. No database client, environment loading, or remote operation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { schema } from '../payments/virtual/database.js';
import { miniIdentitySchema } from '../payments/virtual/mini-identity.js';
import { photoContextSchema } from '../photo-jobs/context.js';
import { photoJobsSchema } from '../photo-jobs/repository.js';
import { photoUploadSchema, photoUploadCleanupSchema } from '../photo-jobs/upload-repository.js';
import { photoGenerationSchema } from '../photo-jobs/generation-repository.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const productionDatabase = 'leyanxiu_xpay_production';
export const productionAppId = 'REDACTED_APP_IDENTIFIER';
export const productionSchemaPath = path.join(server, 'deploy/mini-payment/production-schema-v1.sql');
const qualified = name => `\`${productionDatabase}\`.\`${name}\``;
const literal = value => `'${value}'`;

// The runtime's canonical indexes are not exported. Parse only its literal data
// declaration, never eval source or copy a sandbox migration's USE/INSERT block.
function paymentIndexes() {
  const text = fs.readFileSync(path.join(server, 'payments/virtual/database.js'), 'utf8');
  const match = text.match(/const indexes = (\[[\s\S]*?\n\]);/);
  if (!match || /[^\s\[\]',a-z_]/.test(match[1])) throw new Error('PRODUCTION_INDEX_SOURCE_CHANGED');
  const rows = JSON.parse(match[1].replaceAll("'", '"').replace(/,\s*]/g, ']'));
  if (rows.length !== 8 || rows.some(row => !Array.isArray(row) || row.length !== 3
    || !row.slice(0, 2).every(x => /^[a-z_]+$/.test(x)) || !/^[a-z_]+(?:,[a-z_]+)*$/.test(row[2]))) {
    throw new Error('PRODUCTION_INDEX_SOURCE_CHANGED');
  }
  return rows.map(([name, table, columns]) => `CREATE INDEX ${name} ON ${qualified(table)}(${columns})`);
}

function columns(sql) {
  const content = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  let depth = 0, quote = false, start = 0; const parts = [];
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "'") quote = !quote;
    if (!quote) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { parts.push(content.slice(start, i).trim()); start = i + 1; }
    }
  }
  parts.push(content.slice(start).trim());
  const names = parts.filter(x => !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX)\b/.test(x)).map(x => {
    const name = x.match(/^([a-z_][a-z0-9_]*)\s/)?.[1];
    if (!name) throw new Error('PRODUCTION_COLUMN_SOURCE_CHANGED');
    return name;
  });
  if (!names.length || new Set(names).size !== names.length) throw new Error('PRODUCTION_COLUMNS_CHANGED');
  return names;
}

export function productionSchemaPlan() {
  const source = [...schema('mysql'), ...miniIdentitySchema('mysql'), ...photoContextSchema('mysql'),
    photoJobsSchema('mysql'), photoUploadSchema('mysql'), photoUploadCleanupSchema('mysql'), ...photoGenerationSchema('mysql')];
  const tables = source.map(sql => {
    const name = sql.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+) /)?.[1];
    if (!name || /;|`|\bUSE\b/.test(sql)) throw new Error('PRODUCTION_SCHEMA_SOURCE_CHANGED');
    return { name, columns: columns(sql), sql: sql.replace(/^CREATE TABLE IF NOT EXISTS [a-z_]+/, `CREATE TABLE ${qualified(name)}`)
      .replace(/REFERENCES ([a-z_]+)\(/g, (_, parent) => `REFERENCES ${qualified(parent)}(`) };
  });
  if (tables.length !== 23 || new Set(tables.map(t => t.name)).size !== 23) throw new Error('PRODUCTION_TABLE_SET_CHANGED');
  const names = tables.map(t => t.name), businessTables = names.filter(name => !['vp_schema', 'vp_environment'].includes(name));
  const shape = `(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${productionDatabase}') = 23
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${productionDatabase}'
    AND TABLE_NAME IN (${names.map(literal).join(', ')}) AND TABLE_TYPE = 'BASE TABLE'
    AND ENGINE = 'InnoDB' AND TABLE_COLLATION = 'utf8mb4_bin') = 23
  AND (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${productionDatabase}') = 0
  AND (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = '${productionDatabase}') = 0`;
  const empty = businessTables.map(name => `NOT EXISTS (SELECT 1 FROM ${qualified(name)})`).join('\n  AND ');
  const preflight = [
    "SELECT VERSION() AS mysql_version, @@version_comment AS mysql_distribution, @@GLOBAL.partial_revokes AS partial_revokes",
    `SELECT '${productionDatabase}' AS target_database,
  CASE WHEN COUNT(*) = 0 THEN 'READY_NEW_DATABASE' ELSE 'STOP_DATABASE_ALREADY_EXISTS' END AS preflight
FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${productionDatabase}'`,
    `SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COLLATION FROM information_schema.TABLES
WHERE TABLE_SCHEMA = '${productionDatabase}' ORDER BY TABLE_NAME`,
  ];
  const ddl = [`CREATE DATABASE \`${productionDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    ...tables.map(t => t.sql), ...paymentIndexes(),
    `CREATE INDEX mini_photo_jobs_pending ON ${qualified('mini_photo_jobs')}(state,created_at,id)`,
    `INSERT INTO ${qualified('vp_schema')}(version) VALUES (1)`];
  const beforeBinding = [
    ...tables.map(t => `SELECT ${t.columns.map(c => `\`${c}\``).join(',')} FROM ${qualified(t.name)} LIMIT 0`),
    `SELECT TABLE_NAME,ENGINE,TABLE_COLLATION,ROW_FORMAT FROM information_schema.TABLES
WHERE TABLE_SCHEMA = '${productionDatabase}' ORDER BY TABLE_NAME`,
    `SELECT TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE,ENFORCED FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = '${productionDatabase}' ORDER BY TABLE_NAME,CONSTRAINT_NAME`,
    businessTables.map((name, i) => `${i ? 'UNION ALL ' : ''}SELECT '${name}' AS table_name,COUNT(*) AS row_count FROM ${qualified(name)}`).join('\n'),
    `SELECT (${shape}
  AND (SELECT COUNT(*) FROM ${qualified('vp_schema')}) = 1
  AND (SELECT COUNT(*) FROM ${qualified('vp_schema')} WHERE version = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM ${qualified('vp_environment')})
  AND ${empty}) AS ready_to_bind`,
  ];
  // A single INSERT SELECT checks every business table again while binding.
  // MySQL uses locking source reads for this write in SERIALIZABLE isolation.
  // No IGNORE, UPSERT, old binding replacement, copied accounts, or test credit.
  const bind = [`USE \`${productionDatabase}\``, 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'START TRANSACTION',
    `INSERT INTO ${qualified('vp_environment')}(id,app_id,env)
SELECT 1,'${productionAppId}',0
WHERE DATABASE() = '${productionDatabase}'
  AND ${shape}
  AND (SELECT COUNT(*) FROM ${qualified('vp_schema')}) = 1
  AND (SELECT COUNT(*) FROM ${qualified('vp_schema')} WHERE version = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM ${qualified('vp_environment')})
  AND ${empty}`,
    'SELECT ROW_COUNT() AS inserted_binding_rows'];
  const postflight = [
    `SELECT id,app_id,env FROM ${qualified('vp_environment')}`,
    `SELECT (${shape}
  AND (SELECT COUNT(*) FROM ${qualified('vp_schema')}) = 1
  AND (SELECT COUNT(*) FROM ${qualified('vp_schema')} WHERE version = 1) = 1
  AND (SELECT COUNT(*) FROM ${qualified('vp_environment')}) = 1
  AND (SELECT COUNT(*) FROM ${qualified('vp_environment')} WHERE id=1 AND app_id='${productionAppId}' AND env=0) = 1
  AND ${empty}) AS production_initialization_verified`,
  ];
  return { tables, businessTables, preflight, ddl, beforeBinding, bind, postflight };
}

export function renderProductionSchema() {
  const plan = productionSchemaPlan();
  const section = (title, statements) => `\n-- ${title}\n${statements.join(';\n\n')};\n`;
  return `-- GENERATED by scripts/generate-mini-production-schema.mjs; local review only.
-- Fixed NEW database: ${productionDatabase}; AppID: ${productionAppId}; env=0.
-- Do not execute this file as a whole. Run each numbered stage separately.
-- Stop on EVERY error. Never choose continue/ignore/force; never rerun after partial DDL.
-- No passwords, users, grants, copied sandbox data, runtime activation, or cloud calls.
-- MySQL CREATE DATABASE/TABLE/INDEX commits implicitly: ROLLBACK cannot undo DDL.
-- Keep applications disconnected from this NEW database through all stages.
-- Operator prerequisite (reported by root): cloud snapshot backup10935107,
-- task17507506 succeeded 2026-10-11 18:15 Asia/Shanghai. Restore is NOT verified.
-- STOP 0: verify the intended existing instance, snapshot status, MySQL >=8.0.16,
-- MySQL CHECK support, and permission scope separately. This SQL cannot prove them.
${section('1 READ-ONLY PREFLIGHT: require READY_NEW_DATABASE and zero target tables. Otherwise STOP.', plan.preflight)}
-- STOP 1: inspect the preflight. Existing target, even empty, is NOT this fresh-create workflow.
${section('2 NEW SCHEMA ONLY: all objects qualified; no IF NOT EXISTS. STOP on any error.', plan.ddl)}
-- STOP 2: if any DDL failed, leave the database unbound and stop. Do not drop or retry it.
${section('3 READ-ONLY BEFORE BINDING: 23 tables; all 21 business tables empty; ready_to_bind=1.', plan.beforeBinding)}
-- STOP 3: inspect all prior errors/results. Missing columns/tables, unexpected rows or objects STOP.
${section('4 CONDITIONAL BINDING: run on one connection; require inserted_binding_rows=1.', plan.bind)}
-- STOP 4: if inserted_binding_rows is not exactly 1, run ROLLBACK and stop.
-- If any binding statement failed or its response is unknown: do not retry; inspect first.
${section('5 READ-ONLY IN-TRANSACTION POSTFLIGHT: require production_initialization_verified=1.', plan.postflight)}
-- STOP 5: commit ONLY after stage 4 returned exactly 1 and stage 5 verified exactly 1.
-- Otherwise ROLLBACK the binding; DDL from stage 2 remains for investigation.
-- COMMIT;
-- After the explicit COMMIT, rerun stage 5 from a fresh connection.
-- Then stop: this file does not enable purchases, generation, workers, or grant access.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 2) console.log('NO_OP: use --check or --write; never connects to a database.');
  else if (process.argv.length === 3 && process.argv[2] === '--write') {
    const sql = renderProductionSchema(); fs.writeFileSync(productionSchemaPath, sql, { flag: 'wx' });
    console.log(JSON.stringify({ path: productionSchemaPath, sha256: createHash('sha256').update(sql).digest('hex'), tables: 23, cloudSqlExecuted: false }));
  } else if (process.argv.length === 3 && process.argv[2] === '--check') {
    if (fs.readFileSync(productionSchemaPath, 'utf8') !== renderProductionSchema()) throw new Error('PRODUCTION_SCHEMA_STALE');
    console.log('PASS production schema matches current exports; no database connected.');
  } else throw new Error('PRODUCTION_SCHEMA_ARGUMENTS_INVALID');
}
