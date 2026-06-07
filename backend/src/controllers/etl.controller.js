// controllers/etl.controller.js
import { runPipeline, etlState } from '../etl/pipeline.js';

export async function run(req, res, next) {
  try {
    const queryId = req.query.query_id ? Number(req.query.query_id) : undefined;
    const result = await runPipeline({ queryId });
    res.json({ ok: true, data: result });
  } catch (e) { next(e); }
}
export async function status(req, res, next) {
  res.json({ ok: true, data: {
    last_run_at: etlState.last_run_at,
    last_result: etlState.last_result,
    cron: process.env.ETL_CRON || '0 */6 * * *',
  }});
}
