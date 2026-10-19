// AccountBillingPage.tsx — 현재 플랜·사용량·구독 상태, Paddle 오버레이 업그레이드, 결제 직후 Pro 확인, 구독 관리.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchBilling, createCheckout, openCustomerPortal } from '../api/billing';
import { ApiError, USE_MOCK } from '../api/client';
import { mockOpenCheckout } from '../api/mock';
import { useAuth } from '../auth/AuthContext';
import { toSupportedLocale } from '../i18n';
import { useAsync } from '../lib/useAsync';
import { formatDateTime, formatInt } from '../lib/format';
import { initPaddle, openPaddleCheckout, type PaddleEvent } from '../lib/paddle';
import { LoadingState, ErrorState } from '../components/States';
import StatCard from '../components/StatCard';
import type { BillingInfo, Plan } from '../types';
import styles from './AccountBillingPage.module.css';

const CONFIRM_INTERVAL_MS = 2000;
const CONFIRM_WINDOW_MS = 60_000; // 2초 간격, 최대 60초
const REQUEST_TIMEOUT_MS = 8000; // 확인 요청 1건이 멈춰도 전체 60초 안에 끝나도록

// 응답이 늦거나 실패하면 null. 멈춘 요청이 확인 루프를 붙잡지 않게 한다.
function fetchBillingWithin(ms: number): Promise<BillingInfo | null> {
  let timer: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(resolve, ms, null);
  });
  return Promise.race([fetchBilling().catch(() => null), timeout]).finally(() => window.clearTimeout(timer));
}

type View = 'free' | 'unconfigured' | 'active' | 'trialing' | 'pastDue' | 'canceling';
type Phase = 'idle' | 'opening' | 'checkout' | 'confirming' | 'success' | 'delayed' | 'rechecking';

function viewOf(info: BillingInfo): View {
  if (info.plan === 'free') return info.configured ? 'free' : 'unconfigured';
  switch (info.subscription?.status) {
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'pastDue';
    case 'canceled':
      return 'canceling';
    default:
      return 'active';
  }
}

const STATUS_PILL: Record<View, string> = {
  free: 'pill',
  unconfigured: 'pill',
  active: 'pill pill--accent',
  trialing: 'pill pill--accent',
  pastDue: `pill ${styles.pillDanger}`,
  canceling: `pill ${styles.pillWarn}`,
};

const PLANS: Plan[] = ['free', 'pro'];

export default function AccountBillingPage() {
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';
  const { refresh } = useAuth();
  const { data: info, loading, error, reload, setData } = useAsync<BillingInfo>(() => fetchBilling(), []);
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const completedRef = useRef(false);
  // 화면을 떠나면 abort — 진행 중인 결제창 열기·확인 루프를 멈춘다.
  const lifeRef = useRef<AbortController | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const ptxn = searchParams.get('_ptxn');
  // Paddle 결제 링크(?_ptxn=txn_…)로 받은 거래. 결제창이 실제로 열린 뒤에만 비운다.
  const [pendingTxn, setPendingTxn] = useState<string | null>(null);
  const [txnState, setTxnState] = useState<'idle' | 'opening' | 'failed'>('idle');

  useEffect(() => {
    const controller = new AbortController();
    lifeRef.current = controller;
    return () => controller.abort();
  }, []);

  // _ptxn 은 Paddle.Initialize 전에 URL 에서 지운다(Initialize 의 자동 열기와 직접 열기가 겹치지 않게).
  // layout effect 라 커밋과 같은 작업 안에서 지워져, 그 사이에 스크립트 onload → Initialize 가 끼어들 수 없다.
  useLayoutEffect(() => {
    if (!ptxn) return;
    setPendingTxn(ptxn);
    setTxnState('idle');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('_ptxn');
      return next;
    }, { replace: true });
  }, [ptxn, setSearchParams]);

  // 업그레이드할 수 있는 화면에서만 Paddle.js 를 미리 불러온다. 실패는 버튼을 누를 때 다시 시도·안내한다.
  useEffect(() => {
    if (USE_MOCK || !info?.client || info.plan !== 'free') return;
    initPaddle(info.client).catch(() => {});
  }, [info]);

  // 결제 링크로 받은 거래는 플랜과 무관하게 직접 연다(예: past_due 의 결제 수단 업데이트).
  useEffect(() => {
    if (pendingTxn && info?.client && txnState === 'idle') void openPendingTxn(pendingTxn);
  }, [pendingTxn, info, txnState]);

  function openCheckout(transactionId: string, signal: AbortSignal): Promise<boolean> {
    const open = USE_MOCK ? mockOpenCheckout : openPaddleCheckout;
    completedRef.current = false;
    return open({ client: info!.client!, transactionId, locale, onEvent: handleCheckoutEvent, signal });
  }

  async function openPendingTxn(transactionId: string) {
    const signal = lifeRef.current!.signal;
    setTxnState('opening');
    try {
      await openCheckout(transactionId, signal);
      if (signal.aborted) return;
      setPendingTxn(null);
      setTxnState('idle');
    } catch {
      if (!signal.aborted) setTxnState('failed');
    }
  }

  // 업그레이드는 Pro 전환, _ptxn 결제 수단 업데이트(past_due)는 결제 성공으로 past_due 가 풀려야 반영된 것이다.
  function paymentApplied(next: BillingInfo | null): next is BillingInfo {
    return next?.plan === 'pro' && next.subscription?.status !== 'past_due';
  }

  function applyPro(next: BillingInfo) {
    setData(next);
    setPhase('success');
    void refresh();
  }

  // 모든 대기(간격·요청)를 남은 시간으로 묶어, 요청이 멈춰도 60초 안에 지연 안내로 넘어간다.
  async function confirmUpgrade() {
    const signal = lifeRef.current!.signal;
    setPhase('confirming');
    const deadline = Date.now() + CONFIRM_WINDOW_MS;
    while (deadline - Date.now() > CONFIRM_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_INTERVAL_MS));
      if (signal.aborted) return;
      const next = await fetchBillingWithin(Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
      if (signal.aborted) return;
      if (paymentApplied(next)) {
        applyPro(next);
        return;
      }
    }
    setPhase('delayed');
  }

  async function recheck() {
    const signal = lifeRef.current!.signal;
    setPhase('rechecking');
    const next = await fetchBillingWithin(REQUEST_TIMEOUT_MS);
    if (signal.aborted) return;
    if (paymentApplied(next)) applyPro(next);
    else setPhase('delayed');
  }

  function handleCheckoutEvent(event: PaddleEvent) {
    if (lifeRef.current?.signal.aborted) return;
    if (event.name === 'checkout.completed' && !completedRef.current) {
      completedRef.current = true;
      void confirmUpgrade();
    } else if (event.name === 'checkout.closed' && !completedRef.current) {
      setPhase('idle');
    }
  }

  async function handleUpgrade() {
    if (!info?.client) return;
    const signal = lifeRef.current!.signal;
    setNotice(null);
    setPhase('opening');
    try {
      const { transaction_id: transactionId } = await createCheckout();
      if (signal.aborted) return;
      await openCheckout(transactionId, signal);
      if (!signal.aborted) setPhase((p) => (p === 'opening' ? 'checkout' : p));
    } catch (err) {
      if (signal.aborted) return;
      setPhase('idle');
      if (err instanceof ApiError && err.code === 'ALREADY_PRO') {
        setNotice({ kind: 'info', text: t('billing.errors.alreadyPro') });
        reload();
        void refresh();
      } else if (err instanceof ApiError && err.code === 'BILLING_NOT_CONFIGURED') {
        setNotice({ kind: 'error', text: t('billing.errors.notConfigured') });
        reload();
      } else if (err instanceof ApiError) {
        setNotice({ kind: 'error', text: err.message });
      } else {
        setNotice({ kind: 'error', text: t('billing.errors.load') });
      }
    }
  }

  async function handlePortal() {
    const signal = lifeRef.current!.signal;
    setNotice(null);
    setPortalBusy(true);
    try {
      const { portal_url: portalUrl } = await openCustomerPortal();
      if (signal.aborted) return;
      window.location.assign(portalUrl);
    } catch (err) {
      if (signal.aborted) return;
      setPortalBusy(false);
      const noSubscription = err instanceof ApiError && err.code === 'NO_SUBSCRIPTION';
      setNotice({ kind: 'error', text: t(noSubscription ? 'billing.errors.noSubscription' : 'billing.errors.portal') });
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

  const view = viewOf(info);
  const periodEnd = info.subscription?.current_period_end
    ? new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
        new Date(info.subscription.current_period_end),
      )
    : null;
  const summary =
    (view === 'active' || view === 'trialing' || view === 'canceling') && !periodEnd
      ? t('billing.summary.activeNoDate')
      : t(`billing.summary.${view}`, { date: periodEnd });
  const afterCheckout = phase === 'confirming' || phase === 'delayed' || phase === 'rechecking';
  const checkoutBusy = phase === 'opening' || phase === 'checkout';

  return (
    <div className="page">
      <div className="page__title">{t('billing.title')}</div>

      <div className="stack">
        <section className={`panel ${styles.planPanel}${info.plan === 'pro' ? ` ${styles.planPro}` : ''}`}>
          <div className={styles.planHead}>
            <div>
              <div className="uppercase-label">{t('billing.currentPlan')}</div>
              <div className={styles.planName}>{t(`billing.plan.${info.plan}`)}</div>
            </div>
            <span className={STATUS_PILL[view]}>{t(`billing.status.${view}`)}</span>
          </div>

          {view === 'pastDue' ? (
            <div className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
              <span className={styles.bannerIcon} aria-hidden>!</span>
              <span>{summary}</span>
            </div>
          ) : (
            <p className={styles.summary}>{summary}</p>
          )}

          {phase === 'confirming' && (
            <div className={`${styles.banner} ${styles.bannerAccent}`} role="status">
              <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden />
              <div className={styles.bannerBody}>
                <span>{t('billing.checkout.confirming')}</span>
                <span className={styles.bannerHint}>{t('billing.checkout.confirmingHint')}</span>
              </div>
            </div>
          )}
          {phase === 'success' && (
            <div className={`${styles.banner} ${styles.bannerAccent}`} role="status">
              <span className={`${styles.bannerIcon} ${styles.iconAccent}`} aria-hidden>✓</span>
              <span>{t('billing.checkout.success')}</span>
            </div>
          )}
          {(phase === 'delayed' || phase === 'rechecking') && (
            <div className={`${styles.banner} ${styles.bannerWarn}`} role="status">
              <span className={`${styles.bannerIcon} ${styles.iconWarn}`} aria-hidden>›</span>
              <div className={styles.bannerBody}>
                <span>{t('billing.checkout.delayed')}</span>
                <button type="button" className="btn btn--sm" onClick={recheck} disabled={phase === 'rechecking'}>
                  {phase === 'rechecking' ? <span className="spinner" style={{ width: 10, height: 10 }} /> : null}
                  {t(phase === 'rechecking' ? 'billing.actions.checking' : 'billing.actions.recheck')}
                </button>
              </div>
            </div>
          )}
          {pendingTxn && txnState === 'failed' && (
            <div className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
              <span className={styles.bannerIcon} aria-hidden>✕</span>
              <div className={styles.bannerBody}>
                <span>{t('billing.errors.load')}</span>
                <button type="button" className="btn btn--sm" onClick={() => void openPendingTxn(pendingTxn)}>
                  {t('billing.actions.reopen')}
                </button>
              </div>
            </div>
          )}
          {notice && (
            <div
              className={`${styles.banner} ${notice.kind === 'error' ? styles.bannerDanger : ''}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              <span className={styles.bannerIcon} aria-hidden>{notice.kind === 'error' ? '✕' : '›'}</span>
              <span>{notice.text}</span>
            </div>
          )}

          {!afterCheckout && (
            <div className={styles.actions}>
              {view === 'free' && (
                <button type="button" className="btn btn--primary" onClick={handleUpgrade} disabled={checkoutBusy}>
                  {checkoutBusy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
                  {t(checkoutBusy ? 'billing.actions.opening' : 'billing.actions.upgrade')}
                </button>
              )}
              {view === 'unconfigured' && (
                <button type="button" className="btn" disabled>
                  {t('billing.actions.notReady')}
                </button>
              )}
              {info.plan === 'pro' && (
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
              )}
            </div>
          )}
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

        <section className="panel panel--flush">
          <div className={`panel__head ${styles.compareHead}`}>
            <span className="panel__title">{t('billing.compare.title')}</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={`table ${styles.compareTable}`}>
              <thead>
                <tr>
                  <th>{t('billing.compare.item')}</th>
                  {PLANS.map((plan) => (
                    <th key={plan} className={plan === info.plan ? styles.currentCol : undefined}>
                      {t(`billing.plan.${plan}`)}
                      {plan === info.plan && <span className="pill pill--accent">{t('billing.compare.current')}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{t('billing.compare.price')}</td>
                  <td className="num">{t('pricing.free.price')}</td>
                  <td className="num">
                    {t('pricing.pro.price')}
                    <span className="faint">{t('pricing.perMonth')}</span>
                  </td>
                </tr>
                <tr>
                  <td>{t('billing.compare.queries')}</td>
                  {PLANS.map((plan) => (
                    <td key={plan} className="num">
                      {t('billing.compare.queriesValue', { count: info.limits[plan].queriesPerUser })}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td>{t('billing.compare.manual')}</td>
                  {PLANS.map((plan) => (
                    <td key={plan} className="num">
                      {t('billing.compare.manualValue', { count: info.limits[plan].manualEtlPerDay })}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
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
