// api/webhook.ts — 급상승 알림 웹훅 설정 API.
import { api } from './client';
import type {
  DeletedResult,
  WebhookEndpointResult,
  WebhookSaveResult,
  WebhookSecretResult,
  WebhookSettings,
  WebhookTestResult,
} from '../types';

export const fetchWebhook = () => api.get<WebhookSettings>('/webhook');

export const saveWebhookUrl = (url: string) => api.put<WebhookSaveResult>('/webhook', { url });

export const setWebhookEnabled = (enabled: boolean) => api.patch<WebhookEndpointResult>('/webhook', { enabled });

export const rotateWebhookSecret = () => api.post<WebhookSecretResult>('/webhook/secret');

export const sendWebhookTest = () => api.post<WebhookTestResult>('/webhook/test');

export const deleteWebhook = () => api.delete<DeletedResult>('/webhook');
