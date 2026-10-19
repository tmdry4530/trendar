// api/billing.ts — Paddle 구독 관련 API.
import { api } from './client';
import type { BillingInfo, CheckoutResult, PortalResult } from '../types';

export const fetchBilling = () => api.get<BillingInfo>('/billing/me');

export const createCheckout = () => api.post<CheckoutResult>('/billing/checkout');

export const openCustomerPortal = () => api.post<PortalResult>('/billing/portal');
