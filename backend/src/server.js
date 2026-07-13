import 'dotenv/config';
import cron from 'node-cron';
import app from './app.js';
import { runPipeline } from './etl/pipeline.js';
import { initDb } from './db/init.js';

const PORT = process.env.PORT || 4000;

async function start() {
  const requiredEnv = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'APP_URL'];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`필수 환경변수 누락으로 기동 중단: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.warn(`환경변수 경고 — 누락: ${missing.join(', ')} (dev에서는 계속 진행)`);
  }

  const usingUrl = Boolean(process.env.MYSQL_URL || process.env.DATABASE_URL);
  console.log(`DB target: ${usingUrl ? 'MYSQL_URL/DATABASE_URL' : `DB_HOST=${process.env.DB_HOST || '(none)'}`}`);
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      await initDb();
      app.listen(PORT, () => console.log(`AgentRadar API listening on :${PORT}`));
      return;
    } catch (e) {
      console.error(`DB init attempt ${attempt}/15 failed: code=${e.code || '-'} errno=${e.errno || '-'} msg=${e.message || '(empty)'}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.error('DB init failed after 15 attempts. MYSQL_URL 또는 MySQL 플러그인 연결을 확인하세요.');
  process.exit(1);
}

start();

const schedule = process.env.ETL_CRON || '0 */6 * * *';
cron.schedule(schedule, () => {
  runPipeline()
    .then((r) => console.log('[cron] ETL done', r))
    .catch((e) => console.error('[cron] ETL failed', e));
});
