// AccountBillingPage.tsx — 무료 이용 안내, 현재 사용량, 이전 구독의 상태 확인과 고객 포털(해지·영수증).
// 신규 결제 진입은 없다. 포털은 구독 기록의 has_customer 로만 연다.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchBilling, openCustomerPortal } from '../api/billing';
import { ApiError } from '../api/client';
import { toSupportedLocale } from '../i18n';
import { useAsync } from '../lib/useAsync';
import { formatDateTime, formatInt } from '../lib/format';
import { LoadingState, ErrorState } from '../components/States';
import StatCard from '../components/StatCard';
import { LEGAL } from './LegalPages';
import type { BillingInfo, BillingSubscription } from '../types';
import styles from './AccountBillingPage.module.css';

type View = 'active' | 'trialing' | 'pastDue' | 'canceling' | 'ended' | 'paused' | 'unknown';

const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });

// 해지된 구독은 기간 종료일이 앞으로일 때만 '해지됨(종료 예정)', 아니면 '종료됨'.
function viewOf(sub: BillingSubscription): View {
  switch (sub.status) {
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'pastDue';
    case 'paused':
      return 'paused';
    case 'canceled':
      return sub.current_period_end && new Date(sub.current_period_end) > new Date() ? 'canceling' : 'ended';
    case 'active':
      return 'active';
    default:
      return 'unknown';
  }
}

const STATUS_PILL: Record<View, string> = {
  active: `pill ${styles.pillWarn}`,
  trialing: `pill ${styles.pillWarn}`,
  pastDue: `pill ${styles.pillDanger}`,
  canceling: 'pill',
  ended: 'pill',
  paused: 'pill',
  unknown: 'pill',
};

// 자동 갱신 중이거나 곧 결제될 수 있는 상태: 요약에 날짜가 있으면 날짜 문구를 쓴다.
const DATED_VIEWS: View[] = ['active', 'trialing', 'canceling'];

export default function AccountBillingPage() {
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';
  const { data: info, loading, error, reload } = useAsync<BillingInfo>(() => fetchBilling(), []);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  async function handlePortal() {
    setPortalError(null);
    setPortalBusy(true);
    try {
      const { portal_url: portalUrl } = await openCustomerPortal();
      window.location.assign(portalUrl);
    } catch (err) {
      setPortalBusy(false);
      const noSubscription = err instanceof ApiError && err.code === 'NO_SUBSCRIPTION';
      setPortalError(t(noSubscription ? 'billing.errors.noSubscription' : 'billing.errors.portal'));
    }
  }

  if (!info) {
    return (
      <div className="page">
        <div className="page__title">{t('billing.title')}</div>
        <div className="panel">
          {loading && <LoadingState />}
          {!loading && error && <ErrorState message={error} onRetry={reload} />}
        </div>
      </div>
    );
  }

  const sub = info.subscription;
  const view = sub ? viewOf(sub) : null;
  const periodEnd = sub?.current_period_end ? DATE_FORMAT.format(new Date(sub.current_period_end)) : null;
  const summaryKey = view && (periodEnd || !DATED_VIEWS.includes(view) ? view : `${view}NoDate`);

  return (
    <div className="page">
      <div className="page__title">{t('billing.title')}</div>

      <div className="stack">
        <section className={`panel ${styles.planPanel}`}>
          <div className="uppercase-label">{t('billing.access.title')}</div>
          <p className={styles.summary}>{t('billing.access.body')}</p>
        </section>

        <section>
          <div className={`uppercase-label ${styles.sectionLabel}`}>{t('billing.usage.title')}</div>
          <div className={styles.usageGrid}>
            <StatCard
              label={t('billing.usage.queries')}
              value={t('billing.usage.value', {
                used: formatInt(info.usage.queries_used, locale),
                limit: formatInt(info.usage.queries_limit, locale),
              })}
              hint={t('billing.usage.queriesHint')}
            />
            <StatCard
              label={t('billing.usage.manual')}
              value={t('billing.usage.value', {
                used: formatInt(info.usage.manual_used_today, locale),
                limit: formatInt(info.usage.manual_limit, locale),
              })}
              hint={t('billing.usage.manualReset', { time: formatDateTime(info.usage.manual_reset_at, locale) })}
            />
          </div>
        </section>

        <section className={`panel ${styles.planPanel}`}>
          <div className={styles.planHead}>
            <div className="uppercase-label">{t('billing.subscription.title')}</div>
            {view && <span className={STATUS_PILL[view]}>{t(`billing.subscription.status.${view}`)}</span>}
          </div>

          {sub && view && summaryKey ? (
            <>
              {view === 'pastDue' ? (
                <div className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
                  <span className={styles.bannerIcon} aria-hidden>!</span>
                  <span>{t(`billing.subscription.summary.${summaryKey}`)}</span>
                </div>
              ) : (
                <p className={styles.summary}>{t(`billing.subscription.summary.${summaryKey}`, { date: periodEnd })}</p>
              )}

              {portalError && (
                <div className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
                  <span className={styles.bannerIcon} aria-hidden>✕</span>
                  <span>{portalError}</span>
                </div>
              )}

              {sub.has_customer ? (
                <>
                  <p className={styles.hint}>{t('billing.subscription.manageHint')}</p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={view === 'pastDue' ? 'btn btn--primary' : 'btn'}
                      onClick={handlePortal}
                      disabled={portalBusy}
                    >
                      {portalBusy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
                      {t(
                        portalBusy
                          ? 'billing.actions.redirecting'
                          : view === 'pastDue'
                            ? 'billing.actions.updatePayment'
                            : 'billing.actions.manage',
                      )}
                    </button>
                  </div>
                </>
              ) : (
                <p className={styles.hint}>{t('billing.subscription.noCustomer', { email: LEGAL.email })}</p>
              )}
            </>
          ) : (
            <p className={styles.summary}>{t('billing.subscription.none')}</p>
          )}
        </section>

        <p className={styles.note}>
          {t('billing.note')}{' '}
          <Link to="/refund">{t('billing.refund')}</Link>
          {' · '}
          <Link to="/pricing">{t('billing.pricing')}</Link>
        </p>
      </div>
    </div>
  );
}
