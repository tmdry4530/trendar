export function normalizeRepo(raw, queryId, userId) {
  return {
    github_id: raw.id,
    query_id: queryId,
    user_id: userId,
    full_name: raw.full_name,
    owner: raw.owner?.login ?? raw.full_name.split('/')[0],
    name: raw.name,
    html_url: raw.html_url,
    description: raw.description ?? null,
    language: raw.language ?? null,
    stars: raw.stargazers_count ?? 0,
    forks: raw.forks_count ?? 0,
    open_issues: raw.open_issues_count ?? 0,
    watchers: raw.watchers_count ?? 0,
  };
}

export function computeDelta(current, prevSnapshot) {
  const prev = prevSnapshot?.stars ?? current.stars;
  const star_delta = current.stars - prev;
  return { star_delta, growth_rate: star_delta / Math.max(prev, 1) };
}
