import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { productionSchemaPlan, renderProductionSchema, productionSchemaPath, productionDatabase, productionAppId } from '../scripts/generate-mini-production-schema.mjs';

test('reviewed SQL is the current export projection with no sandbox source or implicit commit command', () => {
  const sql = renderProductionSchema(); assert.equal(fs.readFileSync(productionSchemaPath, 'utf8'), sql);
  const executable = sql.replace(/^--.*$/gm, '');
  assert.doesNotMatch(executable, /IF NOT EXISTS|INSERT IGNORE|\bREPLACE\b|\bDROP\b|\bALTER\b|\bGRANT\b|CREATE USER|\bCOMMIT\b|leyanxiu_xpay_sandbox/i);
  assert.match(sql, /DDL.*remains/); assert.match(sql, /Restore is NOT verified/);
});

test('all 23 tables, references and independent indexes are confined to the production schema', () => {
  const plan = productionSchemaPlan(); assert.equal(plan.tables.length, 23); assert.equal(plan.businessTables.length, 21);
  assert.equal(plan.ddl.filter(sql => sql.startsWith('CREATE INDEX')).length, 9);
  for (const table of plan.tables) {
    assert.ok(table.sql.startsWith(`CREATE TABLE \`${productionDatabase}\`.\`${table.name}\``));
    for (const match of table.sql.matchAll(/REFERENCES ([^\s(]+)/g)) assert.ok(match[1].startsWith(`\`${productionDatabase}\`.`));
    assert.ok(plan.beforeBinding.some(sql => sql.includes(`FROM \`${productionDatabase}\`.\`${table.name}\` LIMIT 0`)));
  }
});

test('binding inspects every business table and never overwrites any existing environment row', () => {
  const plan = productionSchemaPlan(), bind = plan.bind.find(sql => sql.startsWith('INSERT'));
  assert.match(bind, new RegExp(`SELECT 1,'${productionAppId}',0`));
  assert.match(bind, /DATABASE\(\) = 'leyanxiu_xpay_production'/);
  assert.match(bind, /NOT EXISTS \(SELECT 1 FROM `leyanxiu_xpay_production`.`vp_environment`\)/);
  for (const name of plan.businessTables) assert.ok(bind.includes(`NOT EXISTS (SELECT 1 FROM \`${productionDatabase}\`.\`${name}\`)`));
  assert.ok(plan.bind.includes('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'));
  assert.ok(plan.preflight.every(sql => sql.startsWith('SELECT')));
  assert.ok(plan.beforeBinding.every(sql => sql.startsWith('SELECT')));
  assert.ok(plan.postflight.every(sql => sql.startsWith('SELECT')));
});
