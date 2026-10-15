// Only the server-verified account ID selects a cache. This is a retry aid;
// ownership, prices and fulfilment are always checked by the server.
export interface PaymentAttempt { productId: string; key: string; orderId?: string }
type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storageError = () => new Error('无法保存购买进度，请检查设备存储后重试；如已付款，请先核对订单。');
const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
function cacheKey(userId: string) {
  if (!validText(userId)) throw new Error('账号尚未确认，请刷新后再购买。');
  return `lyx_payment_attempt_v2:${userId}`;
}
function validAttempt(value: unknown): value is PaymentAttempt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return validText(candidate.productId) && validText(candidate.key) && (candidate.orderId === undefined || validText(candidate.orderId));
}
export function loadPaymentAttempt(userId: string, storage: AttemptStorage = localStorage): PaymentAttempt | null {
  const key = cacheKey(userId);
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { throw storageError(); }
  let value;
  try { value = JSON.parse(raw || 'null'); } catch { return null; }
  // Never import the old unowned v1 cache into a different account.
  if (value?.version !== 2 || value.userId !== userId || !validAttempt(value.attempt)) return null;
  return value.attempt;
}
export function savePaymentAttempt(userId: string, attempt: PaymentAttempt | null, storage: AttemptStorage = localStorage) {
  const key = cacheKey(userId);
  if (attempt !== null && !validAttempt(attempt)) throw new Error('购买进度无效，请先核对订单。');
  try {
    if (attempt) storage.setItem(key, JSON.stringify({ version: 2, userId, attempt }));
    else storage.removeItem(key);
  } catch { throw storageError(); }
}
