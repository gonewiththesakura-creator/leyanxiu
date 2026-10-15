import '../env.js';
import { connectBillingDatabase } from '../payments/database.js';

// Additive, explicit migration only. It neither imports nor rewrites the legacy compliance snapshot.
if (!process.argv.includes('--apply')) {
  console.log('Plan: create the App PostgreSQL billing, entitlement, refund, audit and phone-binding tables. No database was changed. Use --apply only against the reviewed target database.');
} else {
  const db=connectBillingDatabase();
  try {
    await db.initialize();
    console.log('App billing schema initialized. Sales remain controlled by PAYMENT_MODE and acceptance evidence. Legacy paid orders require a separately reviewed migration.');
  } catch {
    console.error('App billing schema initialization failed. Inspect the database with the operator; credentials are not printed.');
    process.exitCode=1;
  } finally {await db.close();}
}
