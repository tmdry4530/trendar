// middleware/errorHandler.js — 일관된 JSON 에러 포맷
export function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  res.status(status).json({
    ok: false,
    error: { code, message: err.message || 'Unexpected error' },
  });
}

// 던질 때 쓰는 헬퍼 (선택)
export function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code;
  return e;
}
