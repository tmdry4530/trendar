import * as Repo from '../models/repo.model.js';
import { httpError } from '../middleware/errorHandler.js';

export async function list(req, res, next) {
  try {
    const { query_id, bookmarked, search, sort, limit, offset } = req.query;
    const data = await Repo.findMany({
      query_id: query_id ? Number(query_id) : undefined,
      bookmarked: bookmarked === 'true',
      search: search || undefined,
      sort,
      limit: limit ? Number(limit) : 30,
      offset: offset ? Number(offset) : 0,
    });
    res.json({ ok: true, data });
  } catch (e) { next(e); }
}

export async function detail(req, res, next) {
  try {
    const data = await Repo.findById(Number(req.params.id));
    if (!data) throw httpError(404, 'NOT_FOUND', '레포를 찾을 수 없습니다.');
    res.json({ ok: true, data });
  } catch (e) { next(e); }
}

export async function snapshots(req, res, next) {
  try { res.json({ ok: true, data: await Repo.getSnapshots(Number(req.params.id)) }); }
  catch (e) { next(e); }
}

export async function update(req, res, next) {
  try {
    const data = await Repo.update(Number(req.params.id), req.body ?? {});
    if (!data) throw httpError(404, 'NOT_FOUND', '레포를 찾을 수 없습니다.');
    res.json({ ok: true, data });
  } catch (e) { next(e); }
}

export async function remove(req, res, next) {
  try {
    if (!await Repo.remove(Number(req.params.id))) throw httpError(404, 'NOT_FOUND', '레포를 찾을 수 없습니다.');
    res.json({ ok: true, data: { deleted: true } });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try { res.json({ ok: true, data: await Repo.stats() }); } catch (e) { next(e); }
}

export async function trends(req, res, next) {
  try { res.json({ ok: true, data: await Repo.trends(req.query.limit ? Number(req.query.limit) : 10) }); }
  catch (e) { next(e); }
}

export async function languages(req, res, next) {
  try { res.json({ ok: true, data: await Repo.languageDist() }); } catch (e) { next(e); }
}
