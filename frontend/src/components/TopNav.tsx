import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { USE_MOCK } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ConfirmDialog from './ConfirmDialog';
import styles from './TopNav.module.css';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.link} ${styles.active}` : styles.link;

export default function TopNav() {
  const { me, logout, deleteAccount } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 바깥 클릭 · Escape 로 드롭다운 닫기
  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const handleLogout = useCallback(() => {
    setMenuOpen(false);
    logout().catch((err) => console.error(err));
  }, [logout]);

  const handleDeleteConfirm = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteAccount();
    } catch (err) {
      console.error(err);
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }, [deleteAccount]);

  return (
    <>
      <header className={styles.nav}>
        <div className={styles.inner}>
          <NavLink to="/" className={styles.brand}>
            <span className={styles.logo}>◎</span>
            <span className={styles.brandName}>Trendar</span>
            <span className={styles.tagline}>// github trend radar</span>
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

          {USE_MOCK && (
            <div className={styles.status} title="목 데이터 모드">
              <span className="dot dot--off" />
              <span className={styles.statusText}>mock</span>
            </div>
          )}

          {me && (
            <div className={styles.userMenu} ref={menuRef}>
              <button
                type="button"
                className={styles.userTrigger}
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                {me.user.avatarUrl ? (
                  <img src={me.user.avatarUrl} alt="" className={styles.avatar} />
                ) : (
                  <span className={styles.avatarFallback} aria-hidden>
                    {me.user.login.charAt(0).toUpperCase()}
                  </span>
                )}
                <span className={styles.userName}>{me.user.login}</span>
              </button>

              {menuOpen && (
                <div className={styles.dropdown} role="menu">
                  <button type="button" className={styles.dropdownItem} role="menuitem" onClick={handleLogout}>
                    로그아웃
                  </button>
                  <button
                    type="button"
                    className={`${styles.dropdownItem} ${styles.dropdownDanger}`}
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmOpen(true);
                    }}
                  >
                    계정 삭제
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <ConfirmDialog
        open={confirmOpen}
        title="계정 삭제"
        message="계정과 모든 데이터(검색 조건·수집 레포·북마크·메모)가 영구 삭제됩니다. 되돌릴 수 없습니다."
        confirmLabel="영구 삭제"
        danger
        busy={deleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
