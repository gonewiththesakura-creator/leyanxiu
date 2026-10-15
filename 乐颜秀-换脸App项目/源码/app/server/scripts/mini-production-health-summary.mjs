// Pure projection of one wx.cloud.callContainer GET /health response. This
// performs no request and proves neither the selected cloud version nor its
// traffic share; the caller must verify those separately from control-plane
// state and an already-configured, exact test route.
const empty = () => ({ receivedHttp200: false, productionScopeConfirmed: false,
  paymentPrepared: false, paymentOperationsReady: false, photoPrepared: false,
  acceptingRequests: false, salesClosed: false, generationClosed: false, closedHostHealthy: false });
const field = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};

export function summarizeMiniProductionHealth(response) {
  const summary = empty();
  try {
    let data = field(response, 'data');
    if (typeof data === 'string') {
      if (Buffer.byteLength(data, 'utf8') > 16384) return Object.freeze(summary);
      data = JSON.parse(data);
    }
    const payment = field(data, 'payment'), photo = field(data, 'photo');
    summary.receivedHttp200 = field(response, 'statusCode') === 200;
    summary.productionScopeConfirmed = field(data, 'service') === 'mini-photo-production'
      && field(data, 'env') === 0 && field(data, 'mode') === 'closed' && field(data, 'ledgerOnlySandbox') === false;
    summary.paymentPrepared = field(payment, 'prepared') === true;
    summary.paymentOperationsReady = field(payment, 'operationsReady') === true;
    summary.photoPrepared = field(photo, 'prepared') === true;
    summary.acceptingRequests = field(data, 'accepting') === true;
    summary.salesClosed = field(data, 'productionPaymentsEnabled') === false && field(data, 'salesEnabled') === false;
    summary.generationClosed = field(data, 'generationAvailable') === false
      && field(photo, 'generationEnabled') === false && field(photo, 'available') === false;
    summary.closedHostHealthy = field(data, 'ok') === true && Object.values(summary).slice(0, -1).every(value => value === true);
    return Object.freeze(summary);
  } catch { return Object.freeze(empty()); }
}
