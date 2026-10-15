// No timer, automatic startup, lease expiry, provider retry, alternate provider, or payment refund.
// Provider output must already be private and durable; its asset ID is only published by repository ports.
export function createPhotoJobWorker({ repository, runProvider }) {
  if (!repository || typeof runProvider !== 'function') throw new Error('PHOTO_JOB_WORKER_PORTS_REQUIRED');
  let accepting = true;
  const active = new Set();
  const operate = async () => {
    // Recovery publishes a durably recorded result without repeating the paid provider request.
    const ready = await repository.publishNext();
    if (ready) return ready;
    // drain() may begin while publication recovery awaits the database. Admit
    // no new claim after that boundary. The synchronous check and claim call
    // have no intervening await, so drain cannot interleave between them.
    if (!accepting) return null;
    const job = await repository.claimNext();
    if (!job) return null;
    if (job.cancelled) return { id: job.id, state: 'cancelled' };
    // A claim request started before drain is already in flight. Finish that
    // one admitted job even if its committed response arrives during drain;
    // abandoning it would strand a durable claim or tempt unsafe redispatch.
    try {
      const result = await runProvider({ jobId: job.id, userId: job.user_id, spec: structuredClone(job.spec) });
      await repository.recordResult(job.id, job.claim_token, result);
    } catch {
      // A thrown request, malformed success or failed receipt persistence is an ambiguous outcome.
      // If this database write also fails, the durable claimed state still prevents resubmission.
      const state = await repository.recordUnknown(job.id, job.claim_token);
      return { id: job.id, state };
    }
    // A failed publication transaction retains result_ready for a DB-only recovery attempt.
    return await repository.publishNext() ?? { id: job.id, state: 'result_ready' };
  };
  return {
    runOnce() {
      if (!accepting) return Promise.resolve(null);
      const operation = operate(); active.add(operation);
      operation.finally(() => active.delete(operation)).catch(() => {});
      return operation;
    },
    async drain() {
      accepting = false;
      await Promise.allSettled([...active]);
      return { accepting, active: active.size, durableStates: await repository.counts() };
    },
    status: () => ({ accepting, active: active.size }),
  };
}
