// 수집이 끝났을 때 대시보드 신생 급상승 상위 8개에 새로 들어온 저장소를 알림 대기열에 넣는다.
import { randomUUID } from 'node:crypto';
import * as repoModel from '../models/repo.model.js';
import * as webhookModel from '../models/webhook.model.js';
import { publicRisingConfig } from '../utils/limits.js';
import { buildEvent, dispatcher as defaultDispatcher } from './webhook-delivery.js';

// 대시보드 신생 급상승 패널이 보여 주는 개수와 같다(frontend DashboardPage getRising(8)).
export const RISING_NOTIFY_LIMIT = 8;

function toEventRepo(row) {
  return {
    github_id: Number(row.github_id),
    full_name: row.full_name,
    html_url: row.html_url ?? null,
    description: row.description ?? null,
    language: row.language ?? null,
    stars: row.stars,
    rate_24h: row.rate_24h,
    growth_rate_24h: row.growth_rate_24h,
    age_days: row.age_days,
    rank: row.rank,
    estimated: row.baseline_source !== 'snapshot',
  };
}

export function createRisingNotifier({ repos, model, config, dispatcher, now = () => new Date(), newId = randomUUID, log = console }) {
  function topRising(userId, at) {
    return repos.risingRepos(userId, { config: { ...config(), limit: RISING_NOTIFY_LIMIT }, now: at });
  }

  // 등록하거나 다시 켠 시점에 이미 보이던 저장소는 새 진입이 아니므로 보낸 것으로 기록한다(D-011).
  async function seedSeen(userId) {
    const at = new Date(now());
    const rows = await topRising(userId, at);
    const fresh = await model.markNotified(userId, rows.map((row) => row.github_id), at);
    return fresh.length;
  }

  async function notifyRising(userId) {
    const endpoint = await model.getEndpoint(userId);
    if (!endpoint?.enabled) return { queued: 0 };
    const at = new Date(now());
    const rows = await topRising(userId, at);
    if (!rows.length) return { queued: 0 };
    const deliveryId = newId();
    const queued = await model.enqueueRising(userId, {
      githubIds: rows.map((row) => row.github_id),
      deliveryId,
      at,
      buildPayload: (fresh) => JSON.stringify(buildEvent({
        id: deliveryId, event: 'rising.new', createdAt: at,
        repos: rows.filter((row) => fresh.includes(Number(row.github_id))).map(toEventRepo),
      })),
    });
    if (!queued) return { queued: 0 };
    // 발신은 기다리지 않는다. 실패하면 대기열에 남아 주기 실행이 다시 보낸다.
    dispatcher.dispatchOne(deliveryId).catch((error) => {
      log.warn(`[webhook] user#${userId} dispatch error=${error?.code ?? error?.name ?? 'error'}`);
    });
    return { queued: queued.github_ids.length };
  }

  return { seedSeen, notifyRising };
}

export const { seedSeen, notifyRising } = createRisingNotifier({
  repos: repoModel, model: webhookModel, config: publicRisingConfig, dispatcher: defaultDispatcher,
});
