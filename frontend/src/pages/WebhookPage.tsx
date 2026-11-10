// WebhookPage.tsx — 급상승 알림 웹훅: 수신 URL 등록·켜기/끄기·테스트 발신·서명 키 재발급·삭제, 최근 발신 기록.
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import {
  deleteWebhook,
  fetchWebhook,
  rotateWebhookSecret,
  saveWebhookUrl,
  sendWebhookTest,
  setWebhookEnabled,
} from '../api/webhook';
import ConfirmDialog from '../components/ConfirmDialog';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { toSupportedLocale } from '../i18n';
import { useAsync } from '../lib/useAsync';
import type { WebhookDelivery, WebhookEndpoint, WebhookSettings } from '../types';
import styles from './WebhookPage.module.css';

type Status = 'none' | 'active' | 'disabled' | 'autoDisabled';
type Busy = 'save' | 'toggle' | 'test' | 'rotate' | 'delete' | null;
type Notice = { kind: 'ok' | 'error'; text: string } | null;

const FIELD_ERROR_CODES: Record<string, true> = { WEBHOOK_URL_INVALID: true, WEBHOOK_URL_BLOCKED: true, VALIDATION_ERROR: true };
const REASON_CODES = ['TIMEOUT', 'DNS', 'CONNECT', 'TLS', 'NETWORK', 'BLOCKED_TARGET', 'DISABLED', 'CONFIG'] as const;
type ReasonCode = (typeof REASON_CODES)[number];

function statusOf(endpoint: WebhookEndpoint | null): Status {
  if (!endpoint) return 'none';
  if (endpoint.enabled) return 'active';
  return endpoint.auto_disabled ? 'autoDisabled' : 'disabled';
}

const STATUS_PILL: Record<Status, string> = {
  none: 'pill',
  active: 'pill pill--accent',
  disabled: 'pill',
  autoDisabled: `pill ${styles.pillDanger}`,
};

const RESULT_PILL: Record<WebhookDelivery['status'], string> = {
  success: 'pill pill--accent',
  pending: `pill ${styles.pillWarn}`,
  failed: `pill ${styles.pillDanger}`,
};

const GUIDE_HEADERS = [
  ['X-Trendar-Event', 'event'],
  ['X-Trendar-Delivery', 'delivery'],
  ['X-Trendar-Signature', 'signature'],
] as const;

// 받는 쪽이 어떤 필드를 받는지 화면에서 바로 볼 수 있게 한 일반 형식(JSON) 본문 예시.
const BODY_EXAMPLE = `{
  "id": "3f1c9c0e-6c1b-4f5e-9d0a-2b7f0f6f3a11",
  "event": "rising.new",
  "created_at": "2026-11-10T06:00:12.000Z",
  "data": {
    "repos": [
      {
        "github_id": 123456789,
        "full_name": "owner/name",
        "html_url": "https://github.com/owner/name",
        "description": "…",
        "language": "Go",
        "stars": 1840,
        "rate_24h": 612.5,
        "growth_rate_24h": 0.5,
        "age_days": 3.2,
        "rank": 1,
        "estimated": false
      }
    ]
  }
}`;

export default function WebhookPage() {
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';
  const { data, loading, error, reload, setData } = useAsync<WebhookSettings>(() => fetchWebhook(), []);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null);

  // HTTP 응답이 있으면 상태 코드를, 없으면 실패 이유를 보여 준다.
  function responseText(delivery: WebhookDelivery): string {
    if (delivery.status_code != null) return `HTTP ${delivery.status_code}`;
    if (!delivery.error_code) return '—';
    const known = REASON_CODES.includes(delivery.error_code as ReasonCode);
    return t(`webhook.reasons.${known ? (delivery.error_code as ReasonCode) : 'unknown'}`);
  }

  // 좁은 화면에서 날짜와 시각이 낱말 중간에서 갈라지지 않게 따로 만든다.
  function dateText(iso: string): string {
    return new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
  }
  function timeText(iso: string): string {
    return new Date(iso).toLocaleTimeString(locale, { timeStyle: 'short' });
  }

  function showFailure(err: unknown) {
    setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : t('errors.generic') });
  }

  function updateEndpoint(endpoint: WebhookEndpoint | null) {
    setData((prev) => ({ endpoint, deliveries: endpoint ? (prev?.deliveries ?? []) : [] }));
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const value = url.trim();
    setNotice(null);
    if (!value) {
      setFieldError(t('webhook.form.required'));
      return;
    }
    setFieldError(null);
    setBusy('save');
    try {
      const result = await saveWebhookUrl(value);
      updateEndpoint(result.endpoint);
      setUrl('');
      if (result.secret) {
        setSecret(result.secret);
        setCopied(false);
      }
      setNotice({ kind: 'ok', text: t(result.secret ? 'webhook.notice.saved' : 'webhook.notice.changed') });
    } catch (err) {
      if (err instanceof ApiError && FIELD_ERROR_CODES[err.code]) setFieldError(err.message);
      else showFailure(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleToggle(endpoint: WebhookEndpoint) {
    setNotice(null);
    setBusy('toggle');
    try {
      const result = await setWebhookEnabled(!endpoint.enabled);
      updateEndpoint(result.endpoint);
      setNotice({ kind: 'ok', text: t(result.endpoint.enabled ? 'webhook.notice.enabled' : 'webhook.notice.disabled') });
      // 끄면 대기 중이던 발신이 취소되므로 기록을 다시 불러온다.
      reload();
    } catch (err) {
      showFailure(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setNotice(null);
    setBusy('test');
    try {
      const { delivery } = await sendWebhookTest();
      if (delivery) {
        setData((prev) => ({
          endpoint: prev?.endpoint ?? null,
          deliveries: [delivery, ...(prev?.deliveries ?? []).filter((item) => item.id !== delivery.id)].slice(0, 10),
        }));
        const ok = delivery.status === 'success';
        setNotice({
          kind: ok ? 'ok' : 'error',
          text: t(ok ? 'webhook.notice.testOk' : 'webhook.notice.testFail', { detail: responseText(delivery) }),
        });
      } else {
        reload();
      }
    } catch (err) {
      showFailure(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleRotate() {
    setNotice(null);
    setBusy('rotate');
    try {
      const result = await rotateWebhookSecret();
      setSecret(result.secret);
      setCopied(false);
      setNotice({ kind: 'ok', text: t('webhook.notice.rotated') });
    } catch (err) {
      showFailure(err);
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function handleDelete() {
    setNotice(null);
    setBusy('delete');
    try {
      await deleteWebhook();
      updateEndpoint(null);
      setSecret(null);
      setUrl('');
      setFieldError(null);
      setNotice({ kind: 'ok', text: t('webhook.notice.deleted') });
    } catch (err) {
      showFailure(err);
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function handleCopy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // 복사 권한이 없으면 화면의 키를 직접 선택해 복사할 수 있다.
      setCopied(false);
    }
  }

  if (!data) {
    return (
      <div className={`page ${styles.root}`}>
        <div className="page__title">{t('webhook.title')}</div>
        <div className="panel">
          {loading && <LoadingState />}
          {!loading && error && <ErrorState message={t('webhook.loadError')} onRetry={reload} />}
        </div>
      </div>
    );
  }

  const { endpoint, deliveries } = data;
  const status = statusOf(endpoint);
  const working = busy !== null;

  return (
    <div className={`page ${styles.root}`}>
      <div className="page__title">{t('webhook.title')}</div>

      <div className="stack">
        <section className={`panel ${styles.mainPanel}`}>
          <div className={styles.head}>
            <div>
              <div className="uppercase-label">{t('webhook.eyebrow')}</div>
              <h2 className={styles.heading}>{t('webhook.heading')}</h2>
            </div>
            <span className={STATUS_PILL[status]}>{t(`webhook.status.${status}`)}</span>
          </div>

          <p className={styles.lead}>{t('webhook.lead')}</p>

          {status === 'autoDisabled' ? (
            <div className={`${styles.banner} ${styles.bannerDanger}`} role="alert">
              <span className={styles.bannerIcon} aria-hidden>!</span>
              <span>{t('webhook.summary.autoDisabled')}</span>
            </div>
          ) : (
            <p className={styles.summary}>{t(`webhook.summary.${status}`)}</p>
          )}

          {endpoint && (
            <div className={styles.current}>
              <span className={styles.currentUrl}>{endpoint.url_hint}</span>
              <span className="pill">{t(`webhook.format.${endpoint.format}`)}</span>
            </div>
          )}

          <form className={styles.form} onSubmit={handleSave} noValidate>
            <label className="label" htmlFor="webhook-url">
              {t(endpoint ? 'webhook.form.labelChange' : 'webhook.form.label')}
            </label>
            <input
              id="webhook-url"
              className={`input ${styles.urlInput}`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('webhook.form.placeholder')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (fieldError) setFieldError(null);
              }}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? 'webhook-url-error' : 'webhook-url-hint'}
              disabled={working}
            />
            <button type="submit" className={`${endpoint ? 'btn' : 'btn btn--primary'} ${styles.submit}`} disabled={working}>
              {busy === 'save' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
              {t(busy === 'save' ? 'webhook.form.saving' : endpoint ? 'webhook.form.change' : 'webhook.form.save')}
            </button>
            {fieldError ? (
              <p id="webhook-url-error" className={styles.fieldError} role="alert">
                {fieldError}
              </p>
            ) : (
              <p id="webhook-url-hint" className={styles.hint}>
                {t('webhook.form.hint')}
              </p>
            )}
          </form>

          {notice && (
            <div
              className={`${styles.banner} ${notice.kind === 'error' ? styles.bannerDanger : styles.bannerAccent}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              <span className={`${styles.bannerIcon} ${notice.kind === 'ok' ? styles.iconAccent : ''}`} aria-hidden>
                {notice.kind === 'error' ? '✕' : '✓'}
              </span>
              <span>{notice.text}</span>
            </div>
          )}

          {endpoint && (
            <div className={styles.actions}>
              <button type="button" className="btn" onClick={handleTest} disabled={working}>
                {busy === 'test' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
                {t(busy === 'test' ? 'webhook.actions.testing' : 'webhook.actions.test')}
              </button>
              <button
                type="button"
                className={endpoint.enabled ? 'btn' : 'btn btn--primary'}
                onClick={() => void handleToggle(endpoint)}
                disabled={working}
              >
                {busy === 'toggle' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
                {t(endpoint.enabled ? 'webhook.actions.disable' : 'webhook.actions.enable')}
              </button>
              <button type="button" className="btn" onClick={() => setConfirm('rotate')} disabled={working}>
                {t('webhook.actions.rotate')}
              </button>
              <button
                type="button"
                className={`btn btn--danger ${styles.deleteButton}`}
                onClick={() => setConfirm('delete')}
                disabled={working}
              >
                {t('webhook.actions.delete')}
              </button>
            </div>
          )}
        </section>

        {secret && (
          <section className={`panel ${styles.secretPanel}`} aria-live="polite">
            <div className="panel__head">
              <span className="panel__title">{t('webhook.secret.title')}</span>
              <button type="button" className="btn btn--sm" onClick={() => void handleCopy()}>
                {t(copied ? 'webhook.secret.copied' : 'webhook.secret.copy')}
              </button>
            </div>
            <code className={styles.secretValue}>{secret}</code>
            <p className={styles.secretNote}>{t('webhook.secret.once')}</p>
          </section>
        )}

        <section className="panel panel--flush">
          <div className={`panel__head ${styles.tableHead}`}>
            <span className="panel__title">{t('webhook.deliveries.title')}</span>
          </div>
          {deliveries.length === 0 ? (
            <EmptyState
              title={t('webhook.deliveries.empty')}
              hint={t(endpoint ? 'webhook.deliveries.emptyHint' : 'webhook.deliveries.emptyHintNone')}
            />
          ) : (
            <div className={styles.tableWrap}>
              <table className={`table ${styles.deliveryTable}`}>
                <thead>
                  <tr>
                    <th>{t('webhook.deliveries.time')}</th>
                    <th>{t('webhook.deliveries.event')}</th>
                    <th>{t('webhook.deliveries.result')}</th>
                    <th>{t('webhook.deliveries.response')}</th>
                    <th className="col-num">{t('webhook.deliveries.attempts')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td className="num">
                        <span className={styles.nowrap}>{dateText(delivery.created_at)}</span>{' '}
                        <span className={styles.nowrap}>{timeText(delivery.created_at)}</span>
                      </td>
                      <td>{t(delivery.event === 'ping' ? 'webhook.events.ping' : 'webhook.events.rising')}</td>
                      <td>
                        <span className={RESULT_PILL[delivery.status]}>{t(`webhook.result.${delivery.status}`)}</span>
                      </td>
                      <td className={styles.response}>
                        {delivery.status_code != null ? <span className={styles.nowrap}>{responseText(delivery)}</span> : responseText(delivery)}
                      </td>
                      <td className={`num ${styles.attempts}`}>
                        <span className={styles.attemptsNumber}>{delivery.attempts}</span>
                        <span className={styles.attemptsText}>{t('webhook.deliveries.attemptsCount', { count: delivery.attempts })}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">{t('webhook.guide.title')}</span>
          </div>
          <dl className={styles.guide}>
            {GUIDE_HEADERS.map(([header, key]) => (
              <div key={header} className={styles.guideRow}>
                <dt className={styles.guideName}>{header}</dt>
                <dd className={styles.guideDesc}>{t(`webhook.guide.${key}`)}</dd>
              </div>
            ))}
          </dl>
          <div className={styles.bodyExample}>
            <div className="label">{t('webhook.guide.body')}</div>
            <pre className={styles.code} tabIndex={0} aria-label={t('webhook.guide.body')}>
              {BODY_EXAMPLE}
            </pre>
            <p className={styles.guideDesc}>{t('webhook.guide.bodyNote')}</p>
          </div>
          <p className={styles.guideNote}>{t('webhook.guide.chat')}</p>
          <p className={styles.guideFoot}>{t('webhook.guide.retry')}</p>
        </section>
      </div>

      <ConfirmDialog
        open={confirm === 'rotate'}
        title={t('webhook.confirm.rotateTitle')}
        message={t('webhook.confirm.rotateMessage')}
        confirmLabel={t('webhook.confirm.rotateConfirm')}
        danger={false}
        busy={busy === 'rotate'}
        onConfirm={() => void handleRotate()}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={t('webhook.confirm.deleteTitle')}
        message={t('webhook.confirm.deleteMessage')}
        confirmLabel={t('webhook.confirm.deleteConfirm')}
        busy={busy === 'delete'}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
