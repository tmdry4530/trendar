import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { USE_MOCK } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useTranslation } from 'react-i18next';
import { toSupportedLocale } from '../i18n';
import ConfirmDialog from './ConfirmDialog';
import LanguageSwitcher from './LanguageSwitcher';
import styles from './TopNav.module.css';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.link} ${styles.active}` : styles.link;

export default function TopNav() {
  const { me, logout, deleteAccount } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';
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
            <span className={styles.tagline}>{t('nav.tagline')}</span>
          </NavLink>

          <nav className={styles.links}>
            <NavLink to="/" end className={linkClass}>
              {t('nav.dashboard')}
            </NavLink>
            <NavLink to="/queries" className={linkClass}>
              {t('nav.filters')}
            </NavLink>
            <NavLink to="/repos" className={linkClass}>
              {t('nav.projects')}
            </NavLink>
            <a href={locale === 'ko' ? '/ko/trending' : '/trending'} className={styles.link}>
              {t('nav.trending')}
            </a>
          </nav>

          <div className={styles.language}>
            <LanguageSwitcher />
          </div>

          {USE_MOCK && (
            <div className={styles.status} title={t('nav.sampleDataMode')}>
              <span className="dot dot--off" />
              <span className={styles.statusText}>{t('nav.sampleData')}</span>
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
                aria-label={t('nav.accountMenu', { user: me.user.login })}
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
                  <div className={styles.dropdownHead}>
                    <span className={styles.dropdownUser}>{me.user.login}</span>
                    <span className={me.plan === 'pro' ? 'pill pill--accent' : 'pill'}>
                      {t(me.plan === 'pro' ? 'billing.plan.pro' : 'billing.plan.free')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.dropdownItem}
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/account/billing');
                    }}
                  >
                    {t('nav.billing')}
                  </button>
                  <div className={styles.dropdownDivider} role="separator" />
                  <button type="button" className={styles.dropdownItem} role="menuitem" onClick={handleLogout}>
                    {t('nav.logout')}
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
                    {t('nav.deleteAccount')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <ConfirmDialog
        open={confirmOpen}
        title={t('nav.deleteAccount')}
        message={t('nav.deleteAccountMessage')}
        confirmLabel={t('nav.deletePermanently')}
        danger
        busy={deleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
