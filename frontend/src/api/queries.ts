// queries.ts — 검색 조건(watch_queries) CRUD 호출.
import { api } from './client';
import type {
  WatchQuery,
  CreateQueryInput,
  UpdateQueryInput,
  DeletedResult,
} from '../types';

export const listQueries = () => api.get<WatchQuery[]>('/queries');

export const createQuery = (input: CreateQueryInput) =>
  api.post<WatchQuery>('/queries', input);

export const updateQuery = (id: number, input: UpdateQueryInput) =>
  api.patch<WatchQuery>(`/queries/${id}`, input);

export const deleteQuery = (id: number) =>
  api.delete<DeletedResult>(`/queries/${id}`);
