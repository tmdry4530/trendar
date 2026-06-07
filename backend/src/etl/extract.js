import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const PER = Number(process.env.ETL_PER_QUERY) || 30;
const MIN_STARS = Number(process.env.ETL_MIN_STARS) || 0;

export async function extractRepos(wq) {
  let q = wq.query_type === 'topic'
    ? `topic:${wq.query}`
    : `${wq.query} in:name,description,readme`;
  if (MIN_STARS > 0) q += ` stars:>=${MIN_STARS}`;
  const res = await octokit.rest.search.repos({ q, sort: 'stars', order: 'desc', per_page: PER });
  return res.data.items;
}
