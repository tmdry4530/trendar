export const PUBLIC_MIN_STARS = 20;
export const SLUG_RE = /^[a-z0-9-]{1,64}$/;
export const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const LANGUAGE_CATALOG = [
  { kind: 'language', slug: 'python', name: { en: 'Python', ko: 'Python' }, query: 'language:Python' },
  { kind: 'language', slug: 'typescript', name: { en: 'TypeScript', ko: 'TypeScript' }, query: 'language:TypeScript' },
  { kind: 'language', slug: 'javascript', name: { en: 'JavaScript', ko: 'JavaScript' }, query: 'language:JavaScript' },
  { kind: 'language', slug: 'go', name: { en: 'Go', ko: 'Go' }, query: 'language:Go' },
  { kind: 'language', slug: 'rust', name: { en: 'Rust', ko: 'Rust' }, query: 'language:Rust' },
  { kind: 'language', slug: 'java', name: { en: 'Java', ko: 'Java' }, query: 'language:Java' },
  { kind: 'language', slug: 'cpp', name: { en: 'C++', ko: 'C++' }, query: 'language:cpp' },
  { kind: 'language', slug: 'csharp', name: { en: 'C#', ko: 'C#' }, query: 'language:csharp' },
];

export const TOPIC_CATALOG = [
  { kind: 'topic', slug: 'llm', name: { en: 'LLM', ko: 'LLM' }, query: 'topic:llm' },
  { kind: 'topic', slug: 'ai-agents', name: { en: 'AI Agents', ko: 'AI 에이전트' }, query: 'topic:ai-agents' },
  { kind: 'topic', slug: 'rag', name: { en: 'RAG', ko: 'RAG' }, query: 'topic:rag' },
  { kind: 'topic', slug: 'mcp', name: { en: 'MCP', ko: 'MCP' }, query: 'topic:mcp' },
  { kind: 'topic', slug: 'generative-ai', name: { en: 'Generative AI', ko: '생성형 AI' }, query: 'topic:generative-ai' },
  { kind: 'topic', slug: 'machine-learning', name: { en: 'Machine Learning', ko: '머신러닝' }, query: 'topic:machine-learning' },
  { kind: 'topic', slug: 'deep-learning', name: { en: 'Deep Learning', ko: '딥러닝' }, query: 'topic:deep-learning' },
  { kind: 'topic', slug: 'computer-vision', name: { en: 'Computer Vision', ko: '컴퓨터 비전' }, query: 'topic:computer-vision' },
  { kind: 'topic', slug: 'nlp', name: { en: 'NLP', ko: '자연어 처리' }, query: 'topic:nlp' },
  { kind: 'topic', slug: 'react', name: { en: 'React', ko: 'React' }, query: 'topic:react' },
  { kind: 'topic', slug: 'nextjs', name: { en: 'Next.js', ko: 'Next.js' }, query: 'topic:nextjs' },
  { kind: 'topic', slug: 'vue', name: { en: 'Vue', ko: 'Vue' }, query: 'topic:vue' },
  { kind: 'topic', slug: 'developer-tools', name: { en: 'Developer Tools', ko: '개발자 도구' }, query: 'topic:developer-tools' },
  { kind: 'topic', slug: 'cli', name: { en: 'CLI', ko: 'CLI' }, query: 'topic:cli' },
  { kind: 'topic', slug: 'automation', name: { en: 'Automation', ko: '자동화' }, query: 'topic:automation' },
  { kind: 'topic', slug: 'devops', name: { en: 'DevOps', ko: 'DevOps' }, query: 'topic:devops' },
  { kind: 'topic', slug: 'kubernetes', name: { en: 'Kubernetes', ko: 'Kubernetes' }, query: 'topic:kubernetes' },
  { kind: 'topic', slug: 'docker', name: { en: 'Docker', ko: 'Docker' }, query: 'topic:docker' },
  { kind: 'topic', slug: 'observability', name: { en: 'Observability', ko: '관측 가능성' }, query: 'topic:observability' },
  { kind: 'topic', slug: 'self-hosted', name: { en: 'Self-hosted', ko: '셀프 호스팅' }, query: 'topic:self-hosted' },
  { kind: 'topic', slug: 'security', name: { en: 'Security', ko: '보안' }, query: 'topic:security' },
  { kind: 'topic', slug: 'database', name: { en: 'Databases', ko: '데이터베이스' }, query: 'topic:database' },
  { kind: 'topic', slug: 'data-engineering', name: { en: 'Data Engineering', ko: '데이터 엔지니어링' }, query: 'topic:data-engineering' },
  { kind: 'topic', slug: 'game-development', name: { en: 'Game Development', ko: '게임 개발' }, query: 'topic:game-development' },
];

function selectedFeeds(catalog, key, env) {
  const slugs = (env[key] || '').split(',').map((slug) => slug.trim()).filter(Boolean);
  if (!slugs.length) return catalog;
  const selected = new Set(slugs);
  for (const slug of selected) {
    if (!catalog.some((feed) => feed.slug === slug)) throw new Error(`${key}: unknown slug ${slug}`);
  }
  return catalog.filter((feed) => selected.has(feed.slug));
}

export function allFeeds(env = process.env) {
  return [
    { kind: 'all', slug: 'all', name: { en: 'All', ko: '전체' }, query: '' },
    ...selectedFeeds(LANGUAGE_CATALOG, 'PUBLIC_LANGUAGES', env),
    ...selectedFeeds(TOPIC_CATALOG, 'PUBLIC_TOPICS', env),
  ];
}

export function findFeedConfig(feeds, kind, slug) {
  return feeds.find((feed) => feed.kind === kind && feed.slug === slug) || null;
}

export function feedKey(kind, slug) {
  return `${kind}:${slug}`;
}
