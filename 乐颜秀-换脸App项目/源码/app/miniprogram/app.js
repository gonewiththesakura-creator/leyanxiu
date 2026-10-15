App({
  onLaunch() {
    if (wx.cloud) wx.cloud.init({ traceUser: false });
  },
  globalData: {
    // Local candidate for env=0 merchant testing. The same server must confirm
    // identity, test-user admission, photo capabilities and required consent.
    creationEnabled: true,
    // Keep the existing buildtest transport. Its actual env=0 merchant-test
    // routing must be verified before use; this client flag cannot open sales.
    apiTransport: { mode: 'cloud', env: 'leyanxiu-prod-d5gimob8af6a6e5c9', service: 'buildtest' },
  },
});
