import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { productionSchemaPlan, productionDatabase } from '../scripts/generate-mini-production-schema.mjs';
import { productionDmcBindingPlan, renderProductionDmcBinding, dmcBindingPath } from '../scripts/generate-mini-production-dmc-binding.mjs';

test('DMC binding is exactly one conditional INSERT SELECT with all 21 canonical empty-table guards', () => {
  const plan = productionDmcBindingPlan(), original = productionSchemaPlan();
  assert.equal(plan.statement.includes(';'), false);
  assert.match(plan.statement, /^INSERT INTO `leyanxiu_xpay_production`\.`vp_environment`\(id,app_id,env\)\nSELECT 1,'REDACTED_APP_IDENTIFIER',0/);
  assert.equal(plan.businessTables.length, 21);
  for (const table of plan.businessTables) assert.ok(plan.statement.includes(`NOT EXISTS (SELECT 1 FROM \`${productionDatabase}\`.\`${table}\`)`));
  assert.ok(plan.statement.includes(`NOT EXISTS (SELECT 1 FROM \`${productionDatabase}\`.\`vp_environment\`)`));
  const previousConditions = original.bind.find(sql => sql.startsWith('INSERT INTO ')).split(`WHERE DATABASE() = '${productionDatabase}'`)[1];
  assert.ok(plan.statement.includes(previousConditions));
  assert.match(plan.statement, /@@SESSION\.autocommit = 1/);
  assert.match(plan.statement, /@@SESSION\.transaction_isolation IN \('READ-COMMITTED','REPEATABLE-READ','SERIALIZABLE'\)/);
  assert.match(plan.statement, /ENFORCED = 'YES'\) = 36/);
  assert.doesNotMatch(plan.statement, /\b(?:SET|USE|START|COMMIT|ROLLBACK|IGNORE|UPDATE|DELETE|REPLACE|CREATE|DROP)\b/);
});

test('DMC generated artifact preserves stop conditions without assuming connection-local ROW_COUNT or manual commit', () => {
  assert.equal(fs.readFileSync(dmcBindingPath, 'utf8'), renderProductionDmcBinding());
  const statements = renderProductionDmcBinding().replace(/^--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean);
  assert.equal(statements.length, 1); assert.equal(statements[0], productionDmcBindingPlan().statement);
  assert.match(renderProductionDmcBinding(), /NO later manual COMMIT\/ROLLBACK/);
  assert.match(renderProductionDmcBinding(), /REQUIRED external maintenance isolation/);
  assert.match(renderProductionDmcBinding(), /NOT a lock against arbitrary concurrent writers/);
  assert.match(productionDmcBindingPlan().preflight, /AS selected_database/);
  assert.match(productionDmcBindingPlan().preflight, /AS ready_to_bind$/);
});
