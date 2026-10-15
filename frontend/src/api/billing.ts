// api/billing.ts — Paddle 구독 관련 API.
import { api } from './client';

export interface BillingInfo {
  plan: 'free' | 'pro';
  subscription: {
    status: string;
    current_period_end: string | null;
    price_id: string | null;
  } | null;
  configured: boolean;
}

export const createCheckout = () =>
  api.post<{ checkout_url: string }>('/billing/checkout');

export const fetchBilling = () => api.get<BillingInfo>('/billing/me');

export const openCustomerPortal = () =>
  api.post<{ portal_url: string }>('/billing/portal');
