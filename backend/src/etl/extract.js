const PER = Number(process.env.ETL_PER_QUERY) || 30;
const DEFAULT_MIN_STARS = Number(process.env.ETL_MIN_STARS) || 0;

export async function extractRepos(wq, octokit, { minStars, createdAfter } = {}) {
  const effectiveMinStars = minStars === undefined ? DEFAULT_MIN_STARS : minStars;
  let q = wq.query_type === 'topic'
    ? `topic:${wq.query}`
    : `${wq.query} in:name,description,readme`;
  if (createdAfter) q += ` created:>${createdAfter}`;
  if (effectiveMinStars > 0) q += ` stars:>=${effectiveMinStars}`;
  const res = await octokit.rest.search.repos({ q, sort: 'stars', order: 'desc', per_page: PER });
  return res.data.items;
}
