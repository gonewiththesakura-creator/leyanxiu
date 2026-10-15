const previews = new Set(['dance-preview-r12.mp4', 'quote-preview-r12.mp4', 'night-song-preview-r9.mp4', 'classic-song-preview-r9.mp4']);
Component({
  properties: {
    src: { type: String, observer() { this.prepare(); } }, poster: String, muted: { type: Boolean, value: true },
    active: { type: Boolean, value: false, observer(value) {
      this.revision = (this.revision || 0) + 1;
      this.pause(); this.setData({ mediaSrc: '' });
      if (value) this.prepare();
    } },
  },
  data: { mediaSrc: '' },
  methods: {
    prepare() {
      if (!this.live || !this.properties.active) return;
      const revision = this.revision = (this.revision || 0) + 1;
      const filename = String(this.properties.src || '').split('/').pop();
      this.setData({ mediaSrc: '' });
      if (!previews.has(filename) || this.properties.src !== '/preview-media/templates/' + filename) {
        this.triggerEvent('previewerror', { errMsg: 'UNKNOWN_PREVIEW' });
        return;
      }
      // Native video cannot consistently stream a code-package path. Copy only
      // our four public, versioned demos into the bounded local media cache.
      const destPath = wx.env.USER_DATA_PATH + '/lyx-preview-' + filename;
      wx.getFileSystemManager().copyFile({
        srcPath: this.properties.src, destPath,
        success: () => { if (this.live && revision === this.revision) this.setData({ mediaSrc: destPath }, () => this.resume()); },
        fail: () => { if (this.live && revision === this.revision) this.triggerEvent('previewerror', { errMsg: 'PREVIEW_CACHE_UNAVAILABLE' }); },
      });
    },
    resume() {
      const revision = this.revision;
      const play = () => {
        if (this.live && this.properties.active && this.data.mediaSrc && revision === this.revision) {
          try { wx.createVideoContext('preview', this).play(); } catch (_) {}
        }
      };
      if (typeof wx.nextTick === 'function') wx.nextTick(play); else play();
    },
    pause() { try { wx.createVideoContext('preview', this).pause(); } catch (_) {} },
    played() { if (this.live && this.properties.active) this.triggerEvent('previewplay'); },
    failed(event) { if (this.live && this.properties.active) this.triggerEvent('previewerror', { errMsg: event.detail.errMsg || 'VIDEO_PREVIEW_UNAVAILABLE' }); },
  },
  pageLifetimes: {
    hide() { this.live = false; this.revision++; this.pause(); this.setData({ mediaSrc: '' }); },
    show() { this.live = true; this.prepare(); },
  },
  lifetimes: {
    attached() { this.live = true; this.prepare(); },
    detached() { this.live = false; this.revision++; this.pause(); },
  },
});
