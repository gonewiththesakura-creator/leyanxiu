export class OperationDrain {
  active = 0;
  draining = false;
  waiters = new Set();
  transition = null;
  status() { return { draining: this.draining, active: this.active, ready: this.draining && this.active === 0 && !this.transition }; }
  async run(operation) {
    if (this.draining) throw Object.assign(new Error('Service deployment in progress'), { code: 'STAGE_DRAINING' });
    this.active += 1;
    try { return await operation(); }
    finally {
      this.active -= 1;
      if (!this.active) { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
    }
  }
  async begin(flush) {
    if (this.transition) return this.transition;
    this.draining = true;
    this.transition = (async () => {
      if (this.active) await new Promise(resolve => this.waiters.add(resolve));
      await flush();
    })();
    try { await this.transition; }
    finally { this.transition = null; }
    return this.status();
  }
  resume() {
    if (this.transition) throw new Error('Drain still in progress');
    this.draining = false;
    return this.status();
  }
}

export const stageDrain = new OperationDrain();
export function registerStageDrainMiddleware(app, { enabled, authorized, flush, drain = stageDrain }) {
  if (!enabled) return;
  const endpoint = '/api/internal/deployment-drain';
  app.use('/api/*', async (c, next) => {
    if (c.req.path === endpoint) return next();
    try { return await drain.run(next); }
    catch (error) {
      if (error.code !== 'STAGE_DRAINING') throw error;
      c.header('Retry-After', '60');
      return c.json({ code: 'STAGE_DRAINING', message: '测试服务正在更新，请稍后重试' }, 503);
    }
  });
  app.get(endpoint, c => authorized(c) || c.json({ code: 0, data: drain.status() }));
  app.post(endpoint, async c => {
    const denied = authorized(c);
    if (denied) return denied;
    const { action } = await c.req.json().catch(() => ({}));
    if (!['drain', 'resume'].includes(action)) return c.json({ code: 'INVALID_ACTION' }, 400);
    try {
      const data = action === 'drain' ? await drain.begin(flush) : drain.resume();
      return c.json({ code: 0, data });
    } catch { return c.json({ code: 'DRAIN_NOT_READY', message: '保存或排空尚未完成，未允许部署' }, 503); }
  });
}
