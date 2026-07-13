import * as Query from '../models/query.model.js';
import { httpError } from '../middleware/errorHandler.js';
import { assertQueryLimit } from '../utils/limits.js';

export async function list(req, res, next) {
  try { res.json({ ok: true, data: await Query.findAll(req.user.id) }); }
  catch (e) { next(e); }
}

export async function create(req, res, next) {
  try {
    const { query, query_type = 'keyword' } = req.body ?? {};
    if (typeof query !== 'string' || query.trim().length < 1 || query.trim().length > 200)
      throw httpError(400, 'VALIDATION_ERROR', 'query는 1~200자여야 합니다.');
    if (!['topic', 'keyword'].includes(query_type))
      throw httpError(400, 'VALIDATION_ERROR', 'query_type이 올바르지 않습니다.');
    assertQueryLimit(await Query.countByUser(req.user.id));
    res.status(201).json({ ok: true, data: await Query.create(req.user.id, { query: query.trim(), query_type }) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return next(httpError(409, 'DUPLICATE', '이미 존재하는 조건입니다.'));
    next(e);
  }
}

export async function update(req, res, next) {
  try {
    const data = await Query.update(req.user.id, Number(req.params.id), req.body ?? {});
    if (!data) throw httpError(404, 'NOT_FOUND', '조건을 찾을 수 없습니다.');
    res.json({ ok: true, data });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return next(httpError(409, 'DUPLICATE', '이미 존재하는 조건입니다.'));
    next(e);
  }
}

export async function remove(req, res, next) {
  try {
    if (!await Query.remove(req.user.id, Number(req.params.id))) throw httpError(404, 'NOT_FOUND', '조건을 찾을 수 없습니다.');
    res.json({ ok: true, data: { deleted: true } });
  } catch (e) { next(e); }
}
