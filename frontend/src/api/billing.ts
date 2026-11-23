// api/billing.ts — 이전 구독 기록·사용량 조회와 고객 포털. 신규 결제 API는 없다.
import { api } from './client';
import type { BillingInfo, PortalResult } from '../types';

export const fetchBilling = () => api.get<BillingInfo>('/billing/me');

export const openCustomerPortal = () => api.post<PortalResult>('/billing/portal');
