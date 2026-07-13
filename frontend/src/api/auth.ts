// auth.ts — 인증 관련 호출 (me / logout / 회원 탈퇴).
import { api } from './client';
import type { Me } from '../types';

export const fetchMe = () => api.get<Me>('/auth/me');

export const logout = () => api.post<null>('/auth/logout');

export const deleteAccount = () => api.delete<null>('/auth/account');
