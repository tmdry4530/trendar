// middleware/errorHandler.js — 일관된 JSON 에러 포맷
const USER_MESSAGES = {
  VALIDATION_ERROR: '입력한 내용을 확인해 주세요.',
  UNAUTHORIZED: '로그인이 필요합니다.',
  FORBIDDEN: '이 작업을 할 권한이 없습니다.',
  NOT_FOUND: '요청한 항목을 찾지 못했습니다.',
  DUPLICATE: '이미 등록된 내용입니다.',
  QUERY_LIMIT_EXCEEDED: '등록할 수 있는 수집 조건 수를 모두 사용했습니다.',
  ETL_DAILY_LIMIT_EXCEEDED: '오늘 수동 수집 횟수를 모두 사용했습니다. 한국 시간 자정에 다시 사용할 수 있습니다.',
  ETL_ALREADY_RUNNING: '이미 수집이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.',
  GITHUB_TOKEN_INVALID: 'GitHub 연결이 만료되었습니다. 다시 로그인해 주세요.',
  WEBHOOK_URL_INVALID: '수신 URL을 확인해 주세요. https로 시작하는 주소만 등록할 수 있습니다.',
  WEBHOOK_URL_BLOCKED: '이 주소로는 보낼 수 없습니다. 인터넷에서 접근할 수 있는 주소를 입력해 주세요.',
  WEBHOOK_TEST_RATE_LIMITED: '테스트 발신은 10초에 한 번만 할 수 있습니다.',
  WEBHOOK_SAVE_IN_PROGRESS: '이전 저장 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.',
  INTERNAL_ERROR: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  console.error('[api]', { status, code, name: err.name || 'Error' });
  res.status(status).json({
    ok: false,
    error: { code, message: USER_MESSAGES[code] || USER_MESSAGES.INTERNAL_ERROR },
  });
}

// 던질 때 쓰는 헬퍼 (선택)
export function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code;
  return e;
}
