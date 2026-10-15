// Draft prices are not a published catalog. Set an explicitly reviewed catalog to sell.
export const purchaseRulesVersion = 'mini-pay-v1-20260927';
export const draftProducts = [
  { id: 'photo10', name: '图片包 · 10次', amountFen: 990, type: 'pack', days: 365, components: [{ kind: 'photo', quantity: 10, valueFen: 990 }] },
  { id: 'video5', name: '标准视频包 · 5次', amountFen: 990, type: 'pack', days: 365, components: [{ kind: 'video', quantity: 5, valueFen: 990 }] },
  { id: 'member30', name: '30天会员 · 40张图片与10次标准视频', amountFen: 3990, type: 'membership', days: 30,
    components: [{ kind: 'photo', quantity: 40, valueFen: 2000 }, { kind: 'video', quantity: 10, valueFen: 1990 }] },
];
export function parseVirtualProducts(raw) {
  const values = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(values) || values.length > 50) throw new Error('XPAY_CATALOG_INVALID');
  const ids = new Set();
  return values.map(value => {
    if (!value || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) || ids.has(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80
      || !Number.isSafeInteger(value.amountFen) || value.amountFen < 100 || value.amountFen > 100000
      || !['pack', 'membership'].includes(value.type) || !Number.isSafeInteger(value.days) || value.days < 1 || value.days > 365
      || (value.type === 'membership' && value.days !== 30) || !Array.isArray(value.components) || !value.components.length || value.components.length > 2) throw new Error('XPAY_CATALOG_INVALID');
    ids.add(value.id); const kinds = new Set();
    const components = value.components.map(part => {
      if (!['photo', 'video'].includes(part.kind) || kinds.has(part.kind) || !Number.isSafeInteger(part.quantity) || part.quantity < 1 || part.quantity > 10000
        || !Number.isSafeInteger(part.valueFen) || part.valueFen < 1) throw new Error('XPAY_CATALOG_INVALID');
      kinds.add(part.kind); return { kind: part.kind, quantity: part.quantity, valueFen: part.valueFen };
    });
    if (components.reduce((sum, x) => sum + x.valueFen, 0) !== value.amountFen) throw new Error('XPAY_CATALOG_ALLOCATION_INVALID');
    return { id: value.id, name: value.name.trim(), amountFen: value.amountFen, type: value.type, days: value.days, components };
  });
}
