// Inert by default. Explicit --run uses the reviewed official-IDE auth/read/logout
// path with a fixed new profile and route file; never performs a paid/media write.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { merchantReadonlyPlan, threeEffectsMerchantProfile, threeEffectsMerchantRouteFilename,
  runMerchantReadonlyProbe, recoverMerchantReadonlyProbe } from './probe-mini-merchant-readonly.mjs';

export const threeEffectsMerchantReadonlyPlan = Object.freeze({ ...merchantReadonlyPlan,
  profile: threeEffectsMerchantProfile, requiredRouteFilename: threeEffectsMerchantRouteFilename,
  expectedEffectIds: Object.freeze(['natural-avatar', 'modern-comic', 'gentle-watercolor']),
  consentWriteCalled: false });
export const runThreeEffectsMerchantReadonlyProbe = options => runMerchantReadonlyProbe({ ...options, profile: threeEffectsMerchantProfile });
export const recoverThreeEffectsMerchantReadonlyProbe = options => recoverMerchantReadonlyProbe({ ...options, profile: threeEffectsMerchantProfile });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const show = result => { console.log(JSON.stringify(result)); if (result.completed && !result.ok) process.exitCode = 1; };
  const error = value => { console.error(/^MERCHANT_PROBE_[A-Z_]+$/.test(value?.message) ? value.message : 'MERCHANT_PROBE_UNCONFIRMED'); process.exitCode = 1; };
  if (!args.length || args.length === 1 && args[0] === '--plan') console.log(JSON.stringify(threeEffectsMerchantReadonlyPlan));
  else if (args.length === 5 && args[0] === '--run') {
    runThreeEffectsMerchantReadonlyProbe({ routeFile: path.resolve(args[1]), identityFile: path.resolve(args[2]),
      outputFile: path.resolve(args[3]), project: path.resolve(args[4]) }).then(show, error);
  } else if (args.length === 2 && args[0] === '--poll') recoverThreeEffectsMerchantReadonlyProbe({ outputFile: path.resolve(args[1]) }).then(show, error);
  else error(new Error('MERCHANT_PROBE_ARGUMENT_INVALID'));
}
