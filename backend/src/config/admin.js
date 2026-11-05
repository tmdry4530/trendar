// 관리자 권한은 로그인명이 아니라 서버 설정의 단일 GitHub ID로만 판정한다.
function canonicalId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value !== 'string' || value.length === 0 || /[^0-9]/.test(value)) return null;
  const id = value.replace(/^0+/, '');
  return id || null;
}

export function isAdmin(user, env = process.env) {
  const configured = typeof env.ADMIN_GITHUB_ID === 'string'
    ? canonicalId(env.ADMIN_GITHUB_ID)
    : null;
  return configured !== null && canonicalId(user?.github_id) === configured;
}
