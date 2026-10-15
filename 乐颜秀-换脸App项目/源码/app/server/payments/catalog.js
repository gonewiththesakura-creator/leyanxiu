// Prices are always server-owned. Unlimited/lifetime sales remain deliberately unsupported.
export function validateProducts(items) {
  if (!Array.isArray(items) || items.length > 50) throw new Error('INVALID_PAYMENT_PRODUCTS');
  const seen = new Set();
  return items.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || seen.has(item.id)
      || !Number.isSafeInteger(item.amountFen) || item.amountFen <= 0 || item.amountFen > 1000000
      || !Number.isSafeInteger(item.credits) || item.credits <= 0 || item.credits > 100000
      || typeof item.name !== 'string' || !item.name.trim() || Buffer.byteLength(item.name.trim()) > 127) throw new Error('INVALID_PAYMENT_PRODUCTS');
    const type = item.type || 'credits';
    if (!['credits', 'monthly'].includes(type) || (type === 'monthly' && item.durationDays !== 30)) throw new Error('INVALID_PAYMENT_PRODUCT_TYPE');
    seen.add(item.id);
    return { id: item.id, name: item.name.trim(), amountFen: item.amountFen, credits: item.credits,
      type, durationDays: type === 'monthly' ? 30 : null, autoRenew: false };
  });
}
