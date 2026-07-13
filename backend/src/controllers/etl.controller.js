// controllers/etl.controller.js
import { runPipelineForUser, isRunning } from '../etl/pipeline.js';
import * as users from '../models/user.model.js';

export async function run(req, res, next) {
  try {
    const queryId = req.query.query_id ? Number(req.query.query_id) : undefined;
    const result = await runPipelineForUser(req.user.id, { queryId });
    res.json({ ok: true, data: result });
  } catch (e) { next(e); }
}

export async function status(req, res, next) {
  try {
    const user = await users.findById(req.user.id);
    res.json({ ok: true, data: {
      last_etl_at: user?.last_etl_at ?? null,
      last_etl_status: user?.last_etl_status ?? null,
      last_etl_message: user?.last_etl_message ?? null,
      running: isRunning(req.user.id),
      cron: process.env.ETL_CRON || '0 */6 * * *',
    }});
  } catch (e) { next(e); }
}
