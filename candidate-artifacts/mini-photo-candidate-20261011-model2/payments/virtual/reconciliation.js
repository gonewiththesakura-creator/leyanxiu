// Query reconciliation verifies transaction/refund balances. It is not a settlement-bank bill.
export async function reconcileVirtualPage({ ledger, adapter, afterId = '', reviewer }) {
  if (!reviewer || (afterId && !/^[a-f0-9]{32}$/.test(afterId))) throw new Error('XPAY_RECONCILIATION_INVALID');
  const orders = await ledger.reconciliationPage(afterId);
  const rows = await Promise.all(orders.map(async order => {
    try {
      const remote = (await adapter.query(order)).order;
      const identityMatches = remote?.order_id === order.id && remote.wx_order_id === order.providerId && remote.env_type === order.env + 1;
      const balanceMatches = remote?.order_fee === order.amountFen && remote.paid_fee === order.amountFen && remote.left_fee === order.amountFen - order.refundedFen;
      // Status 5 proves only the merchant debit, so it cannot independently
      // reconcile a completed refund. A partially refunded payment can retain
      // its paid/delivered status; the exact remaining balance is checked above.
      const stateMatches = order.status === 'refunded' ? remote?.status === 8
        || (order.refundedFen < order.amountFen && [2, 3, 4].includes(remote?.status)) : [2, 3, 4].includes(remote?.status);
      const settled = remote?.sett_state === 2;
      return { orderId: order.id, amountFen: order.amountFen, localRefundedFen: order.refundedFen,
        result: identityMatches && balanceMatches && stateMatches ? 'matched' : 'mismatch',
        remoteLeftFen: Number.isSafeInteger(remote?.left_fee) ? remote.left_fee : null,
        remoteStatus: Number.isSafeInteger(remote?.status) ? remote.status : null,
        settlement: settled ? 'channel_settled' : 'not_confirmed',
        platformFeeFen: settled && Number.isSafeInteger(remote.platform_fee_fen) ? remote.platform_fee_fen : null,
        cpsFeeFen: settled && Number.isSafeInteger(remote.cps_fee_fen) ? remote.cps_fee_fen : null };
    } catch { return { orderId: order.id, result: 'query_unconfirmed' }; }
  }));
  return ledger.saveReconciliation({ reviewer, rows, nextCursor: orders.length === 5 ? orders.at(-1).id : null,
    matched: rows.filter(x => x.result === 'matched').length, differences: rows.filter(x => x.result !== 'matched').length,
    scope: 'provider_order_query', bankSettlementVerified: false });
}
