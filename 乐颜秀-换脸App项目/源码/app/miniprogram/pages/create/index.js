const { createCreationClient } = require('../../creation');
const { prepareLocalPhoto } = require('../../photo-input');
const stages = { authorizing: '正在记录本次授权', uploading: '正在上传照片', generating: '正在制作，请勿重复提交' };
const jobMessages = { queued: '制作任务已接收，正在排队。', claimed: '照片正在制作，请勿重复提交。',
  result_ready: '正在保存制作结果。', blocked: '作品暂不能提供，请联系客户支持核实；不要重复制作。',
  upload_staging: '正在核实照片上传，请勿重复上传。', upload_queued: '照片已上传，等待审核。',
  upload_claimed: '正在审核照片。', upload_reviewed: '正在保存审核结果。', upload_ready: '照片已通过审核，正在继续原制作任务。',
  upload_review: '照片需要进一步审核，请联系客户支持。', upload_unknown: '照片处理状态需要核实，请联系客户支持；不要重复上传。',
  unknown: '制作结果需要核实，请联系客户支持；不要重复制作。', unconfirmed: '正在核对原制作任务，请勿重复提交。' };
const callNative = (method, args = {}) => new Promise((resolve, reject) => wx[method]({ ...args, success: resolve, fail: reject }));
const effectPreviews = Object.freeze({
  'natural-avatar': '/assets/effects/previews/natural-avatar.webp',
  'modern-comic': '/assets/effects/previews/modern-comic.webp',
  'gentle-watercolor': '/assets/effects/previews/gentle-watercolor.webp',
});
const effectTitles = Object.freeze({ 'natural-avatar': '自然 AI 头像', 'modern-comic': '现代漫画像', 'gentle-watercolor': '温润水彩像' });
const displayedEffect = value => value && ['account-pending', 'server-job'].includes(value.effectSource)
  && Object.prototype.hasOwnProperty.call(effectTitles, value.effectId) ? value.effectId : '';
Page({
  data: { busy: false, selecting: false, refreshing: false, available: false, effectAvailable: false, photo: null, effects: [], effectId: '',
    selectedPhoto: '', works: [], result: null, pending: false, basicAgreed: false, faceAgreed: false,
    subjectAuthorization: '', basicVersion: '', faceVersion: '', notice: '正在加载', status: '',
    operator: '', supplierText: '', sourceHours: '', resultHours: '', supplierPolicy: '',
    privacyVisible: false, privacyName: '用户隐私保护指引', erasureNotice: '', effectTitle: '图片创作', effectSubtitle: '', initialView: '',
    readOnly: false, readAccessReady: false, connecting: false,
    flowView: 'upload', effectPreview: '', detailsOpen: false,
    resultTitle: '上次制作的作品', resultEffectId: '', processingTitle: '正在制作', processingDifferentEffect: false },
  currentView(revision) { return this.visible === true && !this.unloaded && revision === (this.viewRevision || 0); },
  showError(error) {
    if (this.unloaded) return;
    const changed = error?.code === 'XPAY_ACCOUNT_CHANGED';
    if (changed) { this.accountChanged = true; this.photoData = null; this.viewRevision = (this.viewRevision || 0) + 1; this.jobState = null; this.stopPolling(); }
    this.setData({ available: false, effectAvailable: false, notice: changed ? '微信账号已变化，请重新打开创作页。'
      : error?.message || '暂时无法连接服务，请稍后刷新。',
      ...(changed ? { photo: null, works: [], result: null, selectedPhoto: '', effects: [], pending: false, status: '',
        basicAgreed: false, faceAgreed: false, subjectAuthorization: '', basicVersion: '', faceVersion: '', flowView: this.readOnly ? this.data.initialView : 'upload' } : {}) });
  },
  async onLoad(options = {}) {
    this.unloaded = false;
    this.visible = true; this.pollsLeft = 20; this.viewRevision = 0; this.readAccessReady = false; this.accountChanged = false;
    // A catalog selection is binding. If the server no longer offers it, keep
    // the selection unavailable instead of silently buying a different effect.
    const requestedId = typeof options.effectId === 'string' ? options.effectId : '';
    this.requestedEffectId = requestedId;
    this.readOnly = ['works', 'privacy'].includes(options.view);
    this.setData({ effectId: requestedId, effectPreview: Object.prototype.hasOwnProperty.call(effectPreviews, requestedId) ? effectPreviews[requestedId] : '',
      initialView: this.readOnly ? options.view : '', readOnly: this.readOnly, flowView: this.readOnly ? options.view : 'upload' });
    const config = getApp().globalData;
    try {
      this.client = createCreationClient(wx, config.apiTransport || config.apiBase, { enabled: config.creationEnabled === true });
      this.client.setActive?.(false);
      await this.connectReadAccess();
    } catch { this.setData({ notice: '图片制作和购买暂未开放，请稍后再来。', available: false }); }
  },
  async connectReadAccess() {
    if (!this.visible || this.unloaded || !this.client || this.data.connecting) return;
    const revision = this.viewRevision || 0;
    this.setData({ connecting: true });
    try {
      await this.nativePrivacy();
      if (!this.currentView(revision)) return;
      this.readAccessReady = true;
      this.setData({ readAccessReady: true });
      this.client.setActive?.(!this.readOnly);
      await this.refresh();
      if (this.currentView(revision) && this.data.initialView) wx.pageScrollTo({ selector: this.data.initialView === 'works' ? '#my-works' : '#photo-consent', duration: 0 });
    } catch (error) {
      if (this.currentView(revision)) this.setData({ notice: error?.message || '尚未启用账号服务，请确认隐私指引后重试。' });
    } finally { if (this.currentView(revision)) this.setData({ connecting: false }); }
  },
  async onShow() {
    this.visible = true; this.pollsLeft = 20;
    this.client?.setActive?.(this.readAccessReady === true && !this.readOnly);
    if (this.readAccessReady === true && this.client && !this.data.busy && !this.data.refreshing) await this.refresh();
  },
  onHide() {
    this.visible = false; this.viewRevision = (this.viewRevision || 0) + 1;
    this.client?.setActive?.(false); this.stopPolling(); this.cancelNativePrivacy();
    this.refreshTask = null; this.photoData = null;
    this.setData({ refreshing: false, connecting: false, selecting: false, photo: null, works: [], result: null,
      selectedPhoto: '', faceAgreed: false, subjectAuthorization: '', basicAgreed: false, status: '',
      flowView: this.readOnly ? this.data.initialView : 'upload', detailsOpen: false });
  },
  stopPolling() { if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; } },
  schedulePolling() {
    this.stopPolling();
    if (!this.visible || this.unloaded || !this.readAccessReady || !this.data.pending || this.pollsLeft <= 0
      || !['queued', 'claimed', 'result_ready', 'unconfirmed', 'upload_staging', 'upload_queued', 'upload_claimed', 'upload_reviewed', 'upload_ready'].includes(this.jobState)) return;
    this.pollsLeft--;
    this.pollTimer = setTimeout(() => { this.pollTimer = null; if (this.visible && !this.unloaded) void this.refresh(); }, 3000);
  },
  onUnload() {
    this.onHide();
    this.unloaded = true;
  },
  async onPullDownRefresh() { this.pollsLeft = 20; try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  async refresh(event) {
    if (!this.client || !this.readAccessReady || !this.visible || this.unloaded || this.data.refreshing || this.data.busy) return false;
    const revision = this.viewRevision || 0;
    const task = {}; this.refreshTask = task;
    if (event?.type === 'tap') this.pollsLeft = 20;
    this.setData({ refreshing: true });
    try {
      // Rights remain readable when the payment-only service has no creation API.
      try {
        const rights = await this.client.entitlements();
        if (!this.currentView(revision)) return false;
        if (Number.isSafeInteger(rights?.available?.photo)) this.setData({ photo: rights.available.photo });
      } catch (error) {
        if (!this.currentView(revision)) return false;
        if (error?.code === 'XPAY_ACCOUNT_CHANGED') { this.showError(error); return false; }
      }
      if (!this.currentView(revision)) return false;
      const value = await this.client.refresh();
      if (!this.currentView(revision)) return false;
      const compliance = value.compliance;
      const versionChanged = this.data.basicVersion !== (compliance.consentVersions?.basic || '')
        || this.data.faceVersion !== (compliance.consentVersions?.faceProcessing || '');
      const selected = value.effects.filter(item => item.id === this.data.effectId);
      const effect = selected.length === 1 ? selected[0] : null;
      const candidateResult = value.result || this.data.result;
      const visibleResult = candidateResult && candidateResult.assetId !== this.dismissedResultAssetId
        && value.works.some(work => work.assetId === candidateResult.assetId) ? candidateResult : null;
      const resultEffectId = displayedEffect(visibleResult);
      const processingEffectId = displayedEffect(value.job);
      this.jobState = value.job?.state;
      this.setData({ available: value.available, effectAvailable: effect?.available === true && effect?.included === true, photo: value.photo, effects: value.effects, effectId: this.data.effectId,
        effectTitle: effect?.title || (this.data.effectId ? '所选效果暂不可用' : '图片创作'), effectSubtitle: effect?.subtitle || '',
        pending: Boolean(value.pending), works: value.works.map(work => ({ ...work,
          time: new Date(work.createdAt).toLocaleString(), retention: work.expiresAt ? new Date(work.expiresAt).toLocaleString() : '' })),
        basicVersion: compliance.consentVersions?.basic || '', faceVersion: compliance.consentVersions?.faceProcessing || '',
        operator: compliance.operatorName || '', sourceHours: compliance.retention?.sourceHours || '',
        resultHours: compliance.retention?.resultHours || '', supplierPolicy: compliance.retention?.supplierPolicy || '',
        supplierText: value.services.map(service => `${service.provider} / ${service.model}（${service.region}）`).join('；'),
        notice: value.pending && this.readOnly ? '当前只查看原制作记录，不会继续提交制作。请从百变图片进入创作页继续原任务。'
          : value.pending ? (jobMessages[this.jobState] || '上一张照片的制作结果仍待确认。请刷新我的作品，勿重复制作。')
          : value.available ? '本次制作使用 1 次图片次数，选图与预览不会扣次。' : '图片制作暂未开放，已有权益和作品仍可查询。',
        result: visibleResult, resultEffectId,
        resultTitle: resultEffectId ? effectTitles[resultEffectId] : '上次制作的作品',
        processingTitle: processingEffectId ? effectTitles[processingEffectId] + ' · 制作中'
          : value.pending ? '正在核对上次制作' : '正在制作',
        processingDifferentEffect: Boolean(processingEffectId && processingEffectId !== this.data.effectId),
        ...(!this.readOnly && !['works', 'privacy'].includes(this.data.flowView) ? {
          flowView: value.pending ? 'processing' : visibleResult ? 'result' : this.data.flowView === 'processing' ? 'upload' : this.data.flowView,
        } : {}),
        ...(value.result && visibleResult ? { status: '制作完成。作品保留 AI 标识。' } : {}),
        ...(this.jobState === 'cancelled' ? { status: '本次制作已取消，剩余次数已更新。' } : {}),
        ...(this.jobState === 'upload_rejected' ? { status: '照片未通过审核，本次未开始制作。' } : {}),
        ...(this.jobState === 'upload_cancelled' ? { status: '照片处理已取消，本次未开始制作。' } : {}),
        ...(versionChanged ? { basicAgreed: false, faceAgreed: false, subjectAuthorization: '' } : {}) });
      return true;
    } catch (error) { if (this.currentView(revision)) this.showError(error?.code === 'XPAY_ACCOUNT_CHANGED' ? error
      : new Error('图片制作暂不可用；已有购买可在套餐与订单中查询。')); return false; }
    finally { if (!this.unloaded && this.refreshTask === task) { this.refreshTask = null; this.setData({ refreshing: false }); if (this.currentView(revision)) this.schedulePolling(); } }
  },
  basicChanged(event) { this.setData({ basicAgreed: event.detail.value.includes('basic') }); },
  faceChanged(event) { this.setData({ faceAgreed: event.detail.value.includes('face') }); },
  authorizationChanged(event) { this.setData({ subjectAuthorization: event.detail.value }); },
  chooseEffect(event) {
    if (this.requestedEffectId || this.data.busy || this.data.pending) return;
    const id = event.currentTarget.dataset.id, selected = this.data.effects.filter(item => item.id === id);
    const effect = selected.length === 1 ? selected[0] : null;
    this.setData({ effectId: typeof id === 'string' ? id : '',
      effectAvailable: effect?.available === true && effect?.included === true,
      effectTitle: effect?.title || '所选效果暂不可用', effectSubtitle: effect?.subtitle || '' });
  },
  async nativePrivacy() {
    const revision = this.viewRevision || 0;
    if (!this.currentView(revision)) throw new Error('页面已离开，本次操作取消。');
    if (typeof wx.getPrivacySetting !== 'function' || typeof wx.requirePrivacyAuthorize !== 'function') throw new Error('请升级微信后使用照片功能。');
    const setting = await callNative('getPrivacySetting');
    if (!this.currentView(revision)) throw new Error('页面已离开，本次操作取消。');
    if (!setting.needAuthorization) {
      await callNative('requirePrivacyAuthorize');
      if (!this.currentView(revision)) throw new Error('页面已离开，本次操作取消。');
      return;
    }
    if (this.privacyTask) throw new Error('请先完成隐私指引确认。');
    return new Promise((resolve, reject) => {
      this.privacyTask = { resolve, reject, revision };
      this.setData({ privacyVisible: true, privacyName: setting.privacyContractName || '用户隐私保护指引' });
    });
  },
  async agreeNativePrivacy() {
    const task = this.privacyTask; if (!task || task.agreeing) return;
    task.agreeing = true;
    try { await callNative('requirePrivacyAuthorize'); if (!this.currentView(task.revision) || this.privacyTask !== task) throw new Error('页面已离开'); task.resolve(); }
    catch { task.reject(new Error('尚未同意隐私指引，本次操作已取消。')); }
    finally { if (this.privacyTask === task) { this.privacyTask = null; if (!this.unloaded) this.setData({ privacyVisible: false }); } }
  },
  declineNativePrivacy() {
    this.cancelNativePrivacy();
  },
  cancelNativePrivacy() {
    this.privacyTask?.reject(new Error('本次照片操作已取消。'));
    this.privacyTask = null; this.setData({ privacyVisible: false });
  },
  openPrivacy() { wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引暂时无法打开', icon: 'none' }) }); },
  async selectPhoto(event) {
    if (this.readOnly || !this.readAccessReady || !this.visible || this.unloaded || this.data.busy || this.data.pending || this.data.selecting) return;
    const revision = this.viewRevision || 0;
    const client = this.client;
    const isCurrent = () => this.currentView(revision) && this.client === client && !this.accountChanged;
    this.setData({ selecting: true });
    try {
      await this.nativePrivacy();
      if (!isCurrent()) return;
      const source = event?.currentTarget?.dataset?.source === 'camera' ? 'camera' : 'album';
      const selection = await callNative('chooseMedia', { count: 1, mediaType: ['image'], sourceType: [source], sizeType: ['original'] });
      if (!isCurrent()) return;
      const prepared = await prepareLocalPhoto(wx, selection.tempFiles?.[0], { isCurrent });
      if (!isCurrent()) return;
      this.photoData = prepared.dataUrl;
      this.setData({ selectedPhoto: prepared.path, status: '照片仅在本页预览，确认授权并开始制作后才会上传。',
        basicAgreed: false, faceAgreed: false, subjectAuthorization: '', result: null, flowView: 'upload' });
    } catch (error) { if (this.currentView(revision) && !String(error?.errMsg || '').includes('cancel')) wx.showToast({ title: error?.message || '未能选择照片，请重试', icon: 'none' }); }
    finally { if (this.currentView(revision)) this.setData({ selecting: false }); }
  },
  clearPhoto() { if (!this.data.busy && !this.data.pending && !this.data.selecting) { this.photoData = null; this.setData({ selectedPhoto: '', basicAgreed: false, faceAgreed: false, subjectAuthorization: '', status: '', flowView: 'upload' }); } },
  continueToConsent() {
    if (this.readOnly || !this.currentView(this.viewRevision || 0) || !this.readAccessReady || this.data.busy || this.data.pending || this.data.selecting) return;
    if (!this.data.available || !this.data.effectAvailable) return wx.showToast({ title: '所选效果暂未开放制作', icon: 'none' });
    if (!this.photoData) return wx.showToast({ title: '请先选择照片', icon: 'none' });
    if (this.data.photo === 0) { this.setData({ status: '图片次数不足，请先查看套餐。' }); return; }
    this.setData({ flowView: 'consent', detailsOpen: false, status: '' });
    wx.pageScrollTo?.({ scrollTop: 0, duration: 0 });
  },
  toggleDetails() { this.setData({ detailsOpen: !this.data.detailsOpen }); },
  backToPhoto() { if (!this.readOnly && !this.data.busy && !this.data.pending) this.setData({ flowView: 'upload' }); },
  restartCreation() {
    if (this.readOnly || this.data.busy || this.data.pending || this.data.selecting) return;
    this.dismissedResultAssetId = this.data.result?.assetId || this.dismissedResultAssetId;
    this.clearPhoto(); this.setData({ result: null });
  },
  openWorks() { if (!this.data.busy) { this.setData({ flowView: 'works' }); wx.pageScrollTo?.({ scrollTop: 0, duration: 0 }); } },
  closeWorks() {
    if (this.data.busy || this.readOnly) return;
    this.setData({ flowView: this.data.pending ? 'processing' : this.data.result ? 'result' : 'upload' });
  },
  finishCreation() { if (!this.data.busy) wx.switchTab({ url: '/pages/photos/index' }); },
  async generate() {
    if (this.readOnly || !this.readAccessReady || !this.visible || this.unloaded || !this.client || this.data.busy || this.data.pending || this.data.selecting) return;
    if (!this.data.available || !this.data.effectAvailable || !this.data.effectId) return wx.showToast({ title: '所选效果暂未开放制作', icon: 'none' });
    if (this.data.photo === 0) { this.setData({ status: '图片次数不足，请先查看套餐。', flowView: 'upload' }); return; }
    if (!this.photoData) return wx.showToast({ title: '请先选择照片', icon: 'none' });
    if (!this.data.basicAgreed || !this.data.faceAgreed || !this.data.subjectAuthorization) return wx.showToast({ title: '请分别确认说明和照片授权', icon: 'none' });
    const revision = this.viewRevision || 0;
    this.setData({ busy: true, result: null, flowView: 'processing', processingTitle: '正在制作', processingDifferentEffect: false, status: '正在确认效果和剩余次数' });
    try {
      const result = await this.client.generate({ image: this.photoData, effectId: this.data.effectId, consent: {
        basicAgreed: this.data.basicAgreed, faceAgreed: this.data.faceAgreed, subjectAuthorization: this.data.subjectAuthorization,
        basicVersion: this.data.basicVersion, faceVersion: this.data.faceVersion,
      } }, stage => { if (this.currentView(revision)) this.setData({ status: stages[stage] || '正在制作' }); });
      if (this.currentView(revision)) {
        this.pollsLeft = 20; this.jobState = result.job?.state;
        this.setData({ busy: false, pending: result.pending === true,
          status: result.pending ? (jobMessages[this.jobState] || '任务已接收，正在核实。') : '正在核对作品。' });
        await this.refresh();
      }
    } catch (error) {
      if (this.currentView(revision)) {
        if (error?.code === 'XPAY_ACCOUNT_CHANGED') this.showError(error);
        else {
          const pending = error?.code === 'CREATION_UNCONFIRMED' || error?.code === 'CREATION_PENDING_INVALID';
          this.jobState = pending ? 'unconfirmed' : null; this.pollsLeft = 20;
          this.setData({ status: error?.message || '制作未确认，请刷新作品。', pending, flowView: pending ? 'processing' : 'upload',
            ...(error?.code === 'INSUFFICIENT_ENTITLEMENT' ? { photo: 0 } : {}) });
        }
      }
    } finally {
      if (!this.unloaded) {
        this.setData({ busy: false });
        // A quick hide/show may happen before the original submit resolves.
        // Recover its durable record in the new view; never replay generate.
        if (this.visible && !this.currentView(revision) && !this.accountChanged) void this.refresh();
        else this.schedulePolling();
      }
    }
  },
  openPayments() {
    const id = this.data.effectId;
    const returnRoute = Object.prototype.hasOwnProperty.call(effectPreviews, id)
      ? '?returnTo=creation&effectId=' + encodeURIComponent(id) : '';
    wx.navigateTo({ url: '/pages/payments/index' + returnRoute });
  },
  openService() { wx.navigateTo({ url: '/pages/service/index' }); },
  async saveWork(event) {
    if (!this.client || !this.readAccessReady || !this.visible || this.unloaded || this.data.busy) return;
    const revision = this.viewRevision || 0;
    this.setData({ busy: true });
    try { await this.nativePrivacy(); if (!this.currentView(revision)) return; await this.client.saveAsset(event.currentTarget.dataset.id); if (this.currentView(revision)) wx.showToast({ title: '已保存到相册', icon: 'success' }); }
    catch (error) { if (this.currentView(revision)) { if (error?.code === 'XPAY_ACCOUNT_CHANGED') this.showError(error); else wx.showToast({ title: '保存未完成，请确认相册权限后重试', icon: 'none' }); } }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
  async deleteWork(event) {
    if (!this.client || !this.readAccessReady || !this.visible || this.unloaded || this.data.busy) return;
    const revision = this.viewRevision || 0;
    const answer = await callNative('showModal', { title: '删除云端照片', content: '删除后将无法再次下载。已经保存到手机相册的副本需由您自行删除。' });
    if (!answer.confirm || !this.currentView(revision)) return;
    this.viewRevision = (this.viewRevision || 0) + 1;
    this.setData({ busy: true });
    try {
      const assetId = event.currentTarget.dataset.id;
      const deletion = await this.client.deleteAsset(assetId);
      const deletesInput = this.data.result?.inputAssetId === assetId;
      if (!this.unloaded) this.setData({ works: this.data.works.filter(work => work.assetId !== assetId),
        result: this.data.result?.assetId === assetId ? null : this.data.result,
        ...(this.data.result?.assetId === assetId && this.data.flowView === 'result' ? { flowView: 'upload' } : {}),
        ...(deletesInput ? { selectedPhoto: '', faceAgreed: false, subjectAuthorization: '' } : {}),
        erasureNotice: deletion.partial ? '照片访问已撤销，云端和处理方副本删除仍待确认，请稍后核实。' : '云端照片已删除，手机相册副本请自行管理。' });
      if (deletesInput) this.photoData = null;
    } catch (error) { if (error?.code === 'XPAY_ACCOUNT_CHANGED') this.showError(error); else this.setData({ erasureNotice: '删除结果尚未确认，请稍后刷新核实。' }); }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
  async withdrawConsent() {
    if (!this.client || !this.readAccessReady || !this.visible || this.unloaded || this.data.busy) return;
    const revision = this.viewRevision || 0;
    const answer = await callNative('showModal', { title: '撤回人脸处理授权', content: '将停止后续处理并删除账号关联的上传照片和云端作品；制作中的请求仍需核实。已购订单不因撤回而删除。' });
    if (!answer.confirm || !this.currentView(revision)) return;
    this.viewRevision = (this.viewRevision || 0) + 1;
    this.setData({ busy: true });
    try {
      const deletion = await this.client.withdrawFaceConsent();
      this.photoData = null;
      if (!this.unloaded) this.setData({ faceAgreed: false, subjectAuthorization: '', selectedPhoto: '', result: null, works: [],
        flowView: this.readOnly ? this.data.initialView : 'upload',
        erasureNotice: deletion.partial ? '授权已撤回，照片访问已撤销，云端和处理方副本删除仍待确认。' : '授权已撤回，相关云端照片已删除。' });
    } catch (error) { if (error?.code === 'XPAY_ACCOUNT_CHANGED') this.showError(error); else this.setData({ erasureNotice: '撤回或删除结果尚未确认，请稍后核实。' }); }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
});
