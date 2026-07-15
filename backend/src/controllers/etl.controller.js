// controllers/etl.controller.js — 수동 수집(일일 한도 게이트) + 상태 조회
import { runPipelineForUser, isRunning } from '../etl/pipeline.js';
import * as usersModel from '../models/user.model.js';
import { httpError } from '../middleware/errorHandler.js';
import { maxManualEtlPerDay } from '../utils/limits.js';
import { kstToday, kstNextMidnight } from '../utils/kst.js';

export function createEtlController(deps) {
  const { pipeline, users, limit, clock } = deps;

  async function run(req, res, next) {
    const today = kstToday(clock());
    const max = limit();
    try {
      const consumed = await users.consumeManualEtl(req.user.id, today, max);
      if (!consumed) {
        throw httpError(
          429,
          'ETL_DAILY_LIMIT_EXCEEDED',
          `오늘의 수동 수집 한도(${max}회)를 모두 사용했습니다. KST 자정에 초기화됩니다.`
        );
      }
      const queryId = req.query.query_id ? Number(req.query.query_id) : undefined;
      let result;
      try {
        result = await pipeline.runPipelineForUser(req.user.id, { queryId });
      } catch (e) {
        // 수집 루프에 진입하기 전(작업 전) 거부만 환불한다. 루프 도중 실패는
        // 이미 자원을 소비했으므로 환불하지 않는다 (R1.4). 환불 자체가 실패해도
        // 원래 에러를 그대로 사용자에게 전달한다.
        if (e.refundable) {
          try { await users.refundManualEtl(req.user.id, today); }
          catch (refundErr) { console.error(`[etl] user#${req.user.id} 한도 환불 실패:`, refundErr.message); }
        }
        throw e;
      }
      res.json({ ok: true, data: result });
    } catch (e) { next(e); }
  }

  async function status(req, res, next) {
    try {
      const now = clock();
      const today = kstToday(now);
      const max = limit();
      const [user, used] = await Promise.all([
        users.findById(req.user.id),
        users.getManualEtlUsage(req.user.id, today),
      ]);
      res.json({ ok: true, data: {
        last_etl_at: user?.last_etl_at ?? null,
        last_etl_status: user?.last_etl_status ?? null,
        last_etl_message: user?.last_etl_message ?? null,
        running: pipeline.isRunning(req.user.id),
        cron: process.env.ETL_CRON || '0 */6 * * *',
        manual_used_today: used,
        manual_limit: max,
        manual_remaining: Math.max(max - used, 0),
        manual_reset_at: kstNextMidnight(now).toISOString(),
      }});
    } catch (e) { next(e); }
  }

  return { run, status };
}

export const { run, status } = createEtlController({
  pipeline: { runPipelineForUser, isRunning },
  users: usersModel,
  limit: maxManualEtlPerDay,
  clock: () => new Date(),
});
