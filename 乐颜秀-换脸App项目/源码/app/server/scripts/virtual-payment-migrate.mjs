import '../env.js';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { virtualMysqlOptions } from '../payments/virtual/runtime.js';

if (!process.argv.includes('--apply')) throw new Error('Explicit --apply required; creates only vp_ tables. Back up the target database first.');
const backend = process.env.XPAY_DB_BACKEND;
if (process.env.DEPLOY_ENV === 'production' && backend !== 'mysql') throw new Error('Production requires MySQL');
const database = await openVirtualDatabase({ backend, filename: process.env.XPAY_SQLITE_FILE,
  mysqlOptions: backend === 'mysql' ? virtualMysqlOptions() : undefined, migrate: true });
await database.close();
console.log('Virtual payment schema v1 ready; no legacy data was imported or changed.');
