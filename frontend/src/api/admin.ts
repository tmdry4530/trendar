// admin.ts — 관리자 운영 현황 조회 전용 API (GET only).
import { api } from './client';
import type { AdminFeedsResult, AdminOverview, AdminUsersResult } from '../types';

export const fetchAdminOverview = () => api.get<AdminOverview>('/admin/overview');

export const fetchAdminUsers = (search: string, page: number) =>
  api.get<AdminUsersResult>('/admin/users', { search: search || undefined, page });

export const fetchAdminFeeds = () => api.get<AdminFeedsResult>('/admin/feeds');
