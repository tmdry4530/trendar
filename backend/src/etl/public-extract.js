export function buildPublicSearchQuery(feed, { createdAfter, minStars }) {
  return `is:public ${feed.query} created:>${createdAfter} stars:>=${minStars}`.replace(/\s+/g, ' ').trim();
}

export async function searchPublicRepos(octokit, q) {
  const { data } = await octokit.rest.search.repos({ q, sort: 'stars', order: 'desc', per_page: 100 });
  return data.items;
}

export function createPacer({ intervalMs, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  let lastStartedAt = null;
  return {
    async pace() {
      if (lastStartedAt !== null) {
        let remaining = intervalMs - (now() - lastStartedAt);
        while (remaining > 0) {
          await sleep(remaining);
          remaining = intervalMs - (now() - lastStartedAt);
        }
      }
      lastStartedAt = now();
    },
  };
}
