// services/github-oauth.js — GitHub OAuth: authorize URL 생성, code 교환, 프로필 조회 (내장 fetch)
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

function redirectUri() {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  return `${appUrl}/api/auth/github/callback`;
}

export function buildAuthorizeUrl({ state }) {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const data = await res.json();
  if (data.error || !data.access_token) {
    throw new Error(`GitHub 토큰 교환 실패: ${data.error || 'access_token 없음'}`);
  }
  return data.access_token;
}

export async function fetchGithubUser(accessToken) {
  const res = await fetch(USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Trendar',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub 사용자 조회 실패: ${res.status}`);
  }
  const u = await res.json();
  return { id: u.id, login: u.login, name: u.name, avatar_url: u.avatar_url };
}
