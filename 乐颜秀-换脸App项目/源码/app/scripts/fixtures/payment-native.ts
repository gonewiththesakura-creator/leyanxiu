export * from '../../src/lib/payments';
// Selected only by payment-switch-preview.mjs, never by the App build.
export const nativePaymentStatus = async () => ({ configured: true, installed: true });
export const launchWechatPayment = async () => ({ launched: true });
