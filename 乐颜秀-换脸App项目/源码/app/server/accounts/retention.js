export const ACCOUNT_RETENTION_INTERVAL_MS = 5 * 60_000;
const DAY = 86_400_000;

function failure(code) { return Object.assign(new Error(code), { code }); }
function counts(row) { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])); }

// Dependencies are already initialized by the host. Importing this module reads no
// env/config/data, opens no connections, and never contacts an SMS/model provider.
export function createAccountRetention({ db, store, flush = async () => {}, now = Date.now }) {
  if (!db?.query || !db?.transaction || !store?.retainAccountSessions || !store?.revokeUserSessions || typeof flush !== 'function' || typeof now !== 'function') throw failure('ACCOUNT_RETENTION_DEPENDENCIES_REQUIRED');
  const state = { running: false, lastRunAt: null, lastSuccessAt: null, lastAppliedAt: null, lastError: null, lastReport: null };
  return {
    status() {
      return { ...structuredClone(state), overdue: state.lastSuccessAt === null || now() - state.lastSuccessAt > 2 * ACCOUNT_RETENTION_INTERVAL_MS };
    },
    async run({ apply = false } = {}) {
      if (typeof apply !== 'boolean') throw failure('ACCOUNT_RETENTION_OPTIONS_INVALID');
      if (state.running) throw failure('ACCOUNT_RETENTION_RUNNING');
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) throw failure('ACCOUNT_RETENTION_OPTIONS_INVALID');
      state.running = true;
      state.lastRunAt = time;
      try {
        const otpParams = [time - DAY, time - 300_000];
        let otpCounts;
        if (apply) {
          otpCounts = await db.transaction('system:sms-limit', async q => {
            const deleted = await q.query('WITH removed AS (DELETE FROM billing_otp WHERE created_at<$1 RETURNING id) SELECT COUNT(*) AS n FROM removed', [otpParams[0]]);
            return { otpRowsDeleted: Number(deleted.rows[0].n) };
          });
        } else {
          otpCounts = counts((await db.query("SELECT COUNT(*) FILTER (WHERE created_at<$1) AS \"otpRowsDeleted\", COUNT(*) FILTER (WHERE created_at>=$1 AND code_hash<>'' AND (consumed OR attempts>=5 OR created_at<=$2)) AS \"otpValuesCleared\" FROM billing_otp", otpParams)).rows[0]);
        }
        const deviceCutoff = time - 7 * DAY;
        const deviceCounts = apply
          ? await db.transaction('system:account-binding', async q => {
            // Verification/attach share this lock and may update every OTP for a
            // device. Scrubbing under the SMS lock could deadlock on those rows.
            const cleared = await q.query("WITH cleared AS (UPDATE billing_otp SET consumed=true,code_hash='' WHERE code_hash<>'' AND (consumed OR attempts>=5 OR created_at<=$1) RETURNING id) SELECT COUNT(*) AS n FROM cleared", [otpParams[1]]);
            const devices = (await q.query('SELECT device_id FROM app_login_devices WHERE user_id IS NULL OR expires_at<=$1 FOR UPDATE', [deviceCutoff])).rows;
            // Also close historical guest-token revival windows. Persist revocation
            // BEFORE removing its marker; on a store failure the PG deletion rolls
            // back, so the next sweep can retry rather than losing the device IDs.
            for (const device of devices) store.revokeUserSessions(device.device_id, 'account_device_retention');
            if (devices.length) await flush();
            await q.query('DELETE FROM app_login_devices WHERE user_id IS NULL OR expires_at<=$1', [deviceCutoff]);
            return { otpValuesCleared: Number(cleared.rows[0].n), deviceMappingsDeleted: devices.length };
          })
          : counts((await db.query('SELECT COUNT(*) AS "deviceMappingsDeleted" FROM app_login_devices WHERE user_id IS NULL OR expires_at<=$1', [deviceCutoff])).rows[0]);
        const sessionCounts = store.retainAccountSessions({ now: time, apply });
        if (apply) await flush();
        const report = { version: 1, mode: apply ? 'apply' : 'dry-run', checkedAt: time, ...otpCounts, ...deviceCounts, ...sessionCounts };
        state.lastReport = report;
        state.lastSuccessAt = now();
        if (apply) state.lastAppliedAt = state.lastSuccessAt;
        state.lastError = null;
        return structuredClone(report);
      } catch {
        // Do not expose SQL/config/connection errors or row identifiers in job status.
        // Transactions across PG and the session store are separate; a retry is idempotent.
        state.lastError = { code: 'ACCOUNT_RETENTION_FAILED', at: now(), mode: apply ? 'apply' : 'dry-run' };
        throw failure('ACCOUNT_RETENTION_FAILED');
      } finally { state.running = false; }
    },
  };
}

// Default schedules read-only counts. Enable apply explicitly after reviewing the
// first counts and a consistent backup. Timers run without incoming HTTP requests.
export function startAccountRetentionJob(retention, { apply = false, onError = () => {}, onResult = () => {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (typeof apply !== 'boolean') throw failure('ACCOUNT_RETENTION_OPTIONS_INVALID');
  let stopped = false;
  let pending;
  let lastNotificationError = null;
  const run = async () => {
    if (stopped) return null;
    try {
      const report = await retention.run({ apply });
      try { await onResult(report); lastNotificationError = null; }
      catch { lastNotificationError = { code: 'ACCOUNT_RETENTION_NOTIFICATION_FAILED', at: Date.now() }; throw failure('ACCOUNT_RETENTION_NOTIFICATION_FAILED'); }
      return report;
    } catch (error) {
      // A failed notification must not turn a background timer into an unhandled
      // rejection. Cleanup failure remains observable through retention.status().
      try { await onError({ code: error.code || 'ACCOUNT_RETENTION_FAILED' }); }
      catch { lastNotificationError = { code: 'ACCOUNT_RETENTION_NOTIFICATION_FAILED', at: Date.now() }; }
      return null;
    }
  };
  const ready = pending = run();
  const timer = setIntervalImpl(() => {
    if (retention.status().running || stopped) return null;
    return pending = run();
  }, ACCOUNT_RETENTION_INTERVAL_MS);
  timer.unref?.();
  return { ready, stop() { stopped = true; clearIntervalImpl(timer); return pending; }, status: () => ({ ...retention.status(), scheduled: true, stopped, lastNotificationError: structuredClone(lastNotificationError) }) };
}
