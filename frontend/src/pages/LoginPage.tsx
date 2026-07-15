// LoginPage.tsx — 비로그인 랜딩. 서비스를 예시로 보여주고 GitHub 로그인을 유도한다.
// GitHub OAuth 는 SPA 라우팅이 아닌 풀 페이지 이동으로 시작.
import { useSearchParams } from 'react-router-dom';
import styles from './LoginPage.module.css';

const ERROR_MESSAGES: Record<string, string> = {
  denied: 'GitHub 인가가 거부되었습니다.',
  state: '세션이 만료되었습니다. 다시 시도해 주세요.',
  exchange: 'GitHub 인증에 실패했습니다. 잠시 후 다시 시도해 주세요.',
  profile: 'GitHub 인증에 실패했습니다. 잠시 후 다시 시도해 주세요.',
};

// 예시(미리보기)용 정적 샘플 — 실제 수집 데이터가 아니다.
const SAMPLE_REPOS = [
  { name: 'agent-mesh/orchestrator', lang: 'Python', stars: '14.2k', growth: '+9.1%' },
  { name: 'mcp-tools/registry', lang: 'TypeScript', stars: '8.7k', growth: '+15.3%' },
  { name: 'swarm-labs/autoflow', lang: 'Rust', stars: '5.1k', growth: '+22.4%' },
  { name: 'context-kit/memory', lang: 'Go', stars: '3.3k', growth: '+11.8%' },
];

const STEPS = [
  { n: '1', title: '키워드 등록', desc: '관심 주제를 등록합니다. 예: ai agent, mcp' },
  { n: '2', title: '자동 수집', desc: '6시간마다 매칭 레포의 스타를 스냅샷으로 기록합니다.' },
  { n: '3', title: '급상승 확인', desc: '증가율 순으로 지금 뜨는 레포를 발견합니다.' },
];

export default function LoginPage() {
  const [searchParams] = useSearchParams();
  const error = searchParams.get('error');
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? '로그인 중 오류가 발생했습니다.') : null;

  return (
    <div className={styles.landing}>
      {/* ── hero ─────────────────────────────────────────────── */}
      <section className={styles.hero}>
        <div className={styles.brand}>
          <span className={styles.logo}>◎</span>
          <span className={styles.brandName}>Trendar</span>
          <span className={styles.eyebrow}>// github trend radar</span>
        </div>

        <h1 className={styles.headline}>
          지금 뜨는 오픈소스를<br />
          <span className={styles.accent}>남들보다 먼저</span>.
        </h1>
        <p className={styles.sub}>
          GitHub 검색은 “현재 스타 수”만 알려줍니다. Trendar는 관심 키워드의 레포를
          6시간마다 추적해 <b>스타 증가율(추세)</b>로 급상승 레포를 골라줍니다.
        </p>

        {errorMessage && <div className={styles.errorBanner}>{errorMessage}</div>}

        <a href="/api/auth/github" className={`btn btn--primary ${styles.loginBtn}`}>
          <GithubIcon />
          GitHub로 시작하기
        </a>
        <p className={styles.trust}>가입 없이 GitHub 계정으로 · 공개 정보만 사용 · 무료</p>
      </section>

      {/* ── preview + steps ──────────────────────────────────── */}
      <section className={styles.showcase}>
        {/* 예시 미리보기 */}
        <div className={`panel panel--flush ${styles.previewCard}`}>
          <div className={styles.previewHead}>
            <span className={styles.previewTitle}>지금 뜨는 레포</span>
            <span className="pill">예시 미리보기</span>
          </div>
          <table className="table table--center">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Lang</th>
                <th className="col-num">Stars</th>
                <th className="col-num">Δ 성장</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_REPOS.map((r) => (
                <tr key={r.name}>
                  <td><b className="mono">{r.name}</b></td>
                  <td><span className="tag">{r.lang}</span></td>
                  <td className="col-num"><span className="num">★ {r.stars}</span></td>
                  <td className="col-num"><span className="delta delta--up">{r.growth}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 사용법 3단계 */}
        <div className={styles.steps}>
          <div className={styles.stepsTitle}>3단계면 끝</div>
          {STEPS.map((s) => (
            <div key={s.n} className={styles.step}>
              <span className={styles.stepNum}>{s.n}</span>
              <div>
                <div className={styles.stepTitle}>{s.title}</div>
                <div className={styles.stepDesc}>{s.desc}</div>
              </div>
            </div>
          ))}
          <a href="/api/auth/github" className={`btn btn--primary ${styles.loginBtnSm}`}>
            <GithubIcon />
            GitHub로 시작하기
          </a>
        </div>
      </section>
    </div>
  );
}

function GithubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
