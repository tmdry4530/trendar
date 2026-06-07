import { NavLink } from 'react-router-dom';
import { USE_MOCK } from '../api/client';
import styles from './TopNav.module.css';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.link} ${styles.active}` : styles.link;

export default function TopNav() {
  return (
    <header className={styles.nav}>
      <div className={styles.inner}>
        <NavLink to="/" className={styles.brand}>
          <span className={styles.logo}>◎</span>
          <span className={styles.brandName}>AgentRadar</span>
          <span className={styles.tagline}>// agent ecosystem radar</span>
        </NavLink>

        <nav className={styles.links}>
          <NavLink to="/" end className={linkClass}>
            Dashboard
          </NavLink>
          <NavLink to="/queries" className={linkClass}>
            Queries
          </NavLink>
          <NavLink to="/repos" className={linkClass}>
            Repos
          </NavLink>
        </nav>

        <div className={styles.status} title={USE_MOCK ? '목 데이터 모드' : '실시간 API'}>
          <span className={`dot ${USE_MOCK ? 'dot--off' : ''}`} />
          <span className={styles.statusText}>{USE_MOCK ? 'mock' : 'live'}</span>
        </div>
      </div>
    </header>
  );
}
