import { Capacitor, registerPlugin } from "@capacitor/core";
import { apiFetch, getAccountSessionGeneration } from "./api";

export interface Product { id: string; name: string; amountFen: number; credits: number; type?: 'credits'|'monthly'; durationDays?: number|null }
export interface PurchaseOrder { id: string; productId: string; amountFen: number; credits: number; status: string; createdAt: string; productSnapshot?:Product; startsAt?:string; expiresAt?:string|null; refundedFen?:number }
export interface WechatPayment { appid: string; partnerid: string; prepayid: string; package: string; noncestr: string; timestamp: string; sign: string }
const WechatPay = registerPlugin<{
  status(): Promise<{ configured: boolean; installed: boolean; returnCode?: number }>;
  pay(options: WechatPayment): Promise<{ launched: boolean }>;
}>("WechatPay");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const generation = getAccountSessionGeneration();
  const response = await apiFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (generation !== getAccountSessionGeneration()) throw new Error('账号已切换，请在当前账号中重新查询订单。');
  if (!response.ok || body.code !== 0) throw new Error(body.message || "支付服务暂时不可用，请稍后重试");
  return body.data as T;
}
export const paymentProducts = () => request<{ available: boolean; mode: string; products: Product[] }>("/api/products");
export const paymentOrders = () => request<PurchaseOrder[]>("/api/orders");
export const paymentOrder = (id: string) => request<PurchaseOrder>(`/api/orders/${encodeURIComponent(id)}`);
export const closePaymentOrder = async (id: string) => (await request<{ order: PurchaseOrder }>(`/api/orders/${encodeURIComponent(id)}/close`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
})).order;
export interface PurchaseRefund { id: string; orderId: string; status: string; reason?: string; amountFen:number }
export const paymentIdentity = () => request<{userId:string;available:boolean;bound:boolean;maskedPhone:string|null}>("/api/account/payment-identity");
export const paymentRefundQuote = (id:string) => request<{amountFen:number;credits:number}>(`/api/orders/${encodeURIComponent(id)}/refund-quote`);
export const paymentRefunds = () => request<PurchaseRefund[]>("/api/refunds");
export const requestPaymentRefund = async (orderId: string, reason: string, expectedAmountFen?:number) => (await request<{ refund: PurchaseRefund }>(`/api/orders/${encodeURIComponent(orderId)}/refund`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, expectedAmountFen }),
})).refund;
export const createPaymentOrder = (productId: string, idempotencyKey: string) => request<{ order: PurchaseOrder; paymentRequired: boolean; payment?: WechatPayment }>("/api/orders", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId, idempotencyKey, channel: "android", termsVersion:'paid-plans-v1' }),
});
export async function nativePaymentStatus() {
  if (Capacitor.getPlatform() !== "android" || !Capacitor.isPluginAvailable("WechatPay")) return { configured: false, installed: false };
  return WechatPay.status();
}
export const launchWechatPayment = (payment: WechatPayment) => WechatPay.pay(payment);
export const orderStatusLabel = (status: string) => ({ pending: "待支付", created: "待支付", paid: "已到账", refunded: "已退款", partially_refunded:"已部分退款", refund_pending: "退款处理中", refunding: "退款处理中", closed: "已关闭", failed: "支付失败", cancelled: "已取消" }[status] || "状态确认中");
