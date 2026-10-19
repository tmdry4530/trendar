import { createHash } from 'node:crypto';

function revisionFields(row) {
  if (!row) return null;
  return {
    kind: row.kind,
    slug: row.slug,
    rank: row.rank,
    id: row.id,
    stars: row.stars,
    rate_24h: row.rate_24h,
    baseline_source: row.baseline_source,
    last_success_at: row.last_success_at,
  };
}

function revisionOf(view) {
  const fields = view.rows
    ? { feed: revisionFields(view.feed), rows: view.rows.map(revisionFields) }
    : {
      repo: revisionFields(view.repo),
      latest: revisionFields(view.latest),
      feeds: view.feeds?.map(revisionFields),
      best: revisionFields(view.best),
    };
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex').slice(0, 12);
}

const KIND_ORDER = { all: 0, language: 1, topic: 2 };

export function createPublicData({ model, feeds, rankRising, measureCandidate, risingConfig, cache, now = () => new Date() }) {
  const configByKey = new Map(feeds.map((feed) => [`${feed.kind}:${feed.slug}`, feed]));

  function getRuns() {
    return cache.getOrCompute('feeds', async () => {
      const runs = await model.listFeedRuns();
      const runsByKey = new Map(runs.map((run) => [`${run.kind}:${run.slug}`, run]));
      return feeds.map((feed) => {
        const run = runsByKey.get(`${feed.kind}:${feed.slug}`);
        return {
          id: run?.id,
          kind: feed.kind,
          slug: feed.slug,
          name: feed.name,
          last_attempt_at: run?.last_attempt_at ?? null,
          last_success_at: run?.last_success_at ?? null,
          last_status: run?.last_status ?? null,
        };
      });
    });
  }

  function publicFeed({ id, ...feed }) {
    return feed;
  }

  async function getFeedIndex() {
    return (await getRuns()).map(publicFeed);
  }

  async function getFeed(kind, slug) {
    if (!configByKey.has(`${kind}:${slug}`)) return null;
    return cache.getOrCompute(`feed:${kind}:${slug}`, async ({ dependsOn }) => {
      const run = (await getRuns()).find((feed) => feed.kind === kind && feed.slug === slug);
      dependsOn('feeds');
      const candidates = run.id == null ? [] : await model.feedCandidates(run.id, { windowDays: risingConfig.windowDays });
      const rows = rankRising(candidates, { ...risingConfig, limit: 50 }, now());
      const view = { feed: publicFeed(run), rows };
      return { ...view, revision: revisionOf(view) };
    });
  }

  async function getRepo(owner, name) {
    // 레포 뷰의 순위는 캐시된 피드 뷰에서 나오므로, 피드 뷰보다 오래 캐시되지 않게 의존성을 알린다(R4.8 최대 10분).
    return cache.getOrCompute(`repo:${owner}/${name}`.toLowerCase(), async ({ dependsOn }) => {
      const repo = await model.findPublicRepo(owner, name);
      if (!repo) return null;
      const [memberships, candidate, snapshots] = await Promise.all([
        model.repoFeeds(repo.id),
        model.repoCandidate(repo.id),
        model.repoSnapshots(repo.id, { days: 30 }),
      ]);
      const repoFeeds = await Promise.all(memberships.map(async (membership) => {
        const feed = configByKey.get(`${membership.kind}:${membership.slug}`);
        if (!feed) return null;
        const view = await getFeed(feed.kind, feed.slug);
        dependsOn(`feed:${feed.kind}:${feed.slug}`);
        const row = view.rows.find((item) => String(item.id) === String(repo.id));
        return { kind: feed.kind, slug: feed.slug, name: feed.name, rank: row?.rank ?? null };
      }));
      const visibleFeeds = repoFeeds.filter(Boolean);
      const rankedFeeds = visibleFeeds.filter((feed) => feed.rank != null);
      rankedFeeds.sort((a, b) => a.rank - b.rank || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      const view = {
        repo,
        latest: candidate ? measureCandidate(candidate, risingConfig, now()) : null,
        snapshots: snapshots.map(({ stars, forks, captured_at }) => ({ stars, forks, captured_at })),
        feeds: visibleFeeds,
        best: rankedFeeds[0] ?? null,
      };
      return { ...view, revision: revisionOf(view) };
    });
  }

  async function getSitemapEntries() {
    const views = await Promise.all(feeds.map((feed) => getFeed(feed.kind, feed.slug)));
    const repos = new Map();
    for (const view of views) {
      for (const row of view.rows) {
        const key = `${row.owner}/${row.name}`.toLowerCase();
        const lastmod = view.feed.last_success_at;
        const previous = repos.get(key);
        if (!previous || (lastmod && (!previous.lastmod || new Date(lastmod) > new Date(previous.lastmod)))) {
          repos.set(key, { owner: row.owner, name: row.name, lastmod });
        }
      }
    }
    return {
      feeds: views.map(({ feed }) => ({ kind: feed.kind, slug: feed.slug, lastmod: feed.last_success_at })),
      repos: [...repos.values()],
    };
  }

  return { getFeedIndex, getFeed, getRepo, getSitemapEntries, revisionOf };
}
