// TokenInvalidBanner.tsx — GitHub 토큰이 무효화된 경우 전 화면 상단에 재로그인을 유도.
import { useAuth } from '../auth/AuthContext';
import styles from './TokenInvalidBanner.module.css';

export default function TokenInvalidBanner() {
  const { me } = useAuth();

  if (!me?.tokenInvalid) return null;

  return (
    <div className={styles.banner} role="alert">
      <span className={styles.text}>
        GitHub 연결이 만료되었습니다. 수집을 계속하려면 다시 로그인해 주세요.
      </span>
      <a href="/api/auth/github" className={`btn btn--sm ${styles.action}`}>
        다시 로그인
      </a>
    </div>
  );
}
