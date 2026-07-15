// LoginPage.tsx — 로그인 화면. GitHub OAuth 는 SPA 라우팅이 아닌 풀 페이지 이동으로 시작.
import { useSearchParams } from 'react-router-dom';
import styles from './LoginPage.module.css';

const ERROR_MESSAGES: Record<string, string> = {
  denied: 'GitHub 인가가 거부되었습니다.',
  state: '세션이 만료되었습니다. 다시 시도해 주세요.',
  exchange: 'GitHub 인증에 실패했습니다. 잠시 후 다시 시도해 주세요.',
  profile: 'GitHub 인증에 실패했습니다. 잠시 후 다시 시도해 주세요.',
};

export default function LoginPage() {
  const [searchParams] = useSearchParams();
  const error = searchParams.get('error');
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? '로그인 중 오류가 발생했습니다.') : null;

  return (
    <div className={styles.wrap}>
      <div className={`panel ${styles.card}`}>
        <div className={styles.brand}>
          <span className={styles.logo}>◎</span>
          <span className={styles.brandName}>Trendar</span>
        </div>
        <p className={styles.tagline}>지금 뜨는 GitHub 레포를 포착하는 트렌드 레이더</p>

        {errorMessage && <div className={styles.errorBanner}>{errorMessage}</div>}

        <a href="/api/auth/github" className={`btn btn--primary ${styles.loginBtn}`}>
          <GithubIcon />
          GitHub로 로그인
        </a>
      </div>
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
