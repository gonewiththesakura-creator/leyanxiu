// Default is inert. --prepare assembles private local receipts only; --run is explicit.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { merchantReadonlyPlan, runMerchantReadonlyProbe, recoverMerchantReadonlyProbe } from './probe-mini-merchant-readonly.mjs';
import { fallbackMerchantProfile, fallbackMerchantRouteFilename, fallbackOperationId, fallbackTaskId,
  prepareFallbackProbeRoute } from './mini-disclosure-fallback-probe-route.mjs';
export const fallbackMerchantReadonlyPlan = Object.freeze({ ...merchantReadonlyPlan, profile: fallbackMerchantProfile,
  requiredRouteFilename: fallbackMerchantRouteFilename, operationId: fallbackOperationId, taskId: fallbackTaskId,
  candidateVersionRequiresCorrelatedReceipt: true, requiresExactPublicFacts: true, consentWriteCalled: false,
  expectedEffectIds: Object.freeze(['natural-avatar', 'modern-comic', 'gentle-watercolor']) });
export const runFallbackMerchantReadonlyProbe = options => runMerchantReadonlyProbe({ ...options, profile: fallbackMerchantProfile });
export const recoverFallbackMerchantReadonlyProbe = options => recoverMerchantReadonlyProbe({ ...options, profile: fallbackMerchantProfile });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const show = result => { console.log(JSON.stringify(result)); if (result.completed && !result.ok) process.exitCode = 1; };
  const error = value => { console.error(/^MERCHANT_PROBE_[A-Z_]+$/.test(value?.message) ? value.message : 'MERCHANT_PROBE_UNCONFIRMED'); process.exitCode = 1; };
  if (!args.length || args.length === 1 && args[0] === '--plan') show(fallbackMerchantReadonlyPlan);
  else if (args.length === 3 && args[0] === '--prepare') prepareFallbackProbeRoute({ snapshotFile: path.resolve(args[1]), routeFile: path.resolve(args[2]) }).then(show, error);
  else if (args.length === 5 && args[0] === '--run') runFallbackMerchantReadonlyProbe({ routeFile: path.resolve(args[1]), identityFile: path.resolve(args[2]), outputFile: path.resolve(args[3]), project: path.resolve(args[4]) }).then(show, error);
  else if (args.length === 2 && args[0] === '--poll') recoverFallbackMerchantReadonlyProbe({ outputFile: path.resolve(args[1]) }).then(show, error);
  else error(new Error('MERCHANT_PROBE_ARGUMENT_INVALID'));
}
