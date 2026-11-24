// @ts-check
import * as Repo from '../models/repo.model.js';
import { httpError } from '../middleware/errorHandler.js';
import {
  REPO_BOOKMARKS_DEFAULT_LIMIT,
  REPO_LIST_DEFAULT_LIMIT,
  REPO_LIST_MAX_LIMIT,
  REPO_LIST_MAX_OFFSET,
  REPO_RANK_MAX_LIMIT,
  REPO_SEARCH_MAX_LENGTH,
  REPO_TRENDS_DEFAULT_LIMIT,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_DAYS,
  SNAPSHOT_MAX_LIMIT,
  clampBoundedInt,
  parsePositiveIntParam,
  publicRisingConfig,
} from '../utils/limits.js';
import { normalizeLimit } from '../services/rising-score.js';

function requireRepoId(raw) {
  const id = parsePositiveIntParam(raw);
  if (id === null) throw httpError(400, 'VALIDATION_ERROR', '유효하지 않은 프로젝트 ID입니다.');
  return id;
}

export function createRepoController(repoModel = Repo) {
  async function list(req, res, next) {
    try {
      const { query_id, bookmarked, search, sort, limit, offset } = req.query ?? {};
      let parsedQueryId;
      if (query_id !== undefined && query_id !== '') {
        parsedQueryId = parsePositiveIntParam(query_id);
        if (parsedQueryId === null) throw httpError(400, 'VALIDATION_ERROR', '유효하지 않은 수집 조건 ID입니다.');
      }
      const safeSearch = typeof search === 'string' && search.trim()
        ? search.trim().slice(0, REPO_SEARCH_MAX_LENGTH)
        : undefined;
      const data = await repoModel.findMany(req.user.id, {
        query_id: parsedQueryId,
        bookmarked: bookmarked === 'true',
        search: safeSearch,
        sort: typeof sort === 'string' ? sort : undefined,
        limit: clampBoundedInt(limit, { defaultValue: REPO_LIST_DEFAULT_LIMIT, min: 1, max: REPO_LIST_MAX_LIMIT }),
        offset: clampBoundedInt(offset, { defaultValue: 0, min: 0, max: REPO_LIST_MAX_OFFSET }),
      });
      res.json({ ok: true, data });
    } catch (e) { next(e); }
  }

  async function detail(req, res, next) {
    try {
      const id = requireRepoId(req.params?.id);
      const data = await repoModel.findById(req.user.id, id);
      if (!data) throw httpError(404, 'NOT_FOUND', '프로젝트를 찾을 수 없습니다.');
      res.json({ ok: true, data });
    } catch (e) { next(e); }
  }

  async function snapshots(req, res, next) {
    try {
      const id = requireRepoId(req.params?.id);
      const limit = clampBoundedInt(req.query?.limit, {
        defaultValue: SNAPSHOT_DEFAULT_LIMIT, min: 1, max: SNAPSHOT_MAX_LIMIT,
      });
      const rawDays = req.query?.days;
      const days = rawDays !== undefined && rawDays !== ''
        ? clampBoundedInt(rawDays, { defaultValue: SNAPSHOT_MAX_DAYS, min: 1, max: SNAPSHOT_MAX_DAYS })
        : null;
      res.json({ ok: true, data: await repoModel.getSnapshots(req.user.id, id, { limit, days }) });
    } catch (e) { next(e); }
  }

  async function update(req, res, next) {
    try {
      const id = requireRepoId(req.params?.id);
      const data = await repoModel.update(req.user.id, id, req.body ?? {});
      if (!data) throw httpError(404, 'NOT_FOUND', '프로젝트를 찾을 수 없습니다.');
      res.json({ ok: true, data });
    } catch (e) { next(e); }
  }

  async function remove(req, res, next) {
    try {
      const id = requireRepoId(req.params?.id);
      if (!await repoModel.remove(req.user.id, id)) throw httpError(404, 'NOT_FOUND', '프로젝트를 찾을 수 없습니다.');
      res.json({ ok: true, data: { deleted: true } });
    } catch (e) { next(e); }
  }

  async function stats(req, res, next) {
    try { res.json({ ok: true, data: await repoModel.stats(req.user.id) }); } catch (e) { next(e); }
  }

  async function trends(req, res, next) {
    try {
      const limit = clampBoundedInt(req.query?.limit, {
        defaultValue: REPO_TRENDS_DEFAULT_LIMIT, min: 1, max: REPO_RANK_MAX_LIMIT,
      });
      res.json({ ok: true, data: await repoModel.trends(req.user.id, limit) });
    } catch (e) { next(e); }
  }

  async function rising(req, res, next) {
    try {
      // 공개 피드와 같은 rising-score-v3 규칙 — 하루 환산 증가·증가율·보정 기준선·신선도·가속도
      const limit = normalizeLimit(req.query?.limit);
      const config = { ...publicRisingConfig(), limit };
      res.json({ ok: true, data: await repoModel.risingRepos(req.user.id, { config }) });
    } catch (e) { next(e); }
  }

  async function bookmarks(req, res, next) {
    try {
      const limit = clampBoundedInt(req.query?.limit, {
        defaultValue: REPO_BOOKMARKS_DEFAULT_LIMIT, min: 1, max: REPO_RANK_MAX_LIMIT,
      });
      res.json({ ok: true, data: await repoModel.bookmarkedRepos(req.user.id, limit) });
    } catch (e) { next(e); }
  }

  async function languages(req, res, next) {
    try { res.json({ ok: true, data: await repoModel.languageDist(req.user.id) }); } catch (e) { next(e); }
  }

  return { list, detail, snapshots, update, remove, stats, trends, rising, bookmarks, languages };
}

export const {
  list, detail, snapshots, update, remove, stats, trends, rising, bookmarks, languages,
} = createRepoController(Repo);
