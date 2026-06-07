import 'dotenv/config';
import cron from 'node-cron';
import app from './app.js';
import { runPipeline } from './etl/pipeline.js';
import { initDb } from './db/init.js';

const PORT = process.env.PORT || 4000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`AgentRadar API listening on :${PORT}`));
  })
  .catch((e) => {
    console.error('DB init failed:', e.message);
    process.exit(1);
  });

const schedule = process.env.ETL_CRON || '0 */6 * * *';
cron.schedule(schedule, () => {
  runPipeline()
    .then((r) => console.log('[cron] ETL done', r))
    .catch((e) => console.error('[cron] ETL failed', e));
});
