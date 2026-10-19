// paddle.ts — Paddle.js v2 로더 + 오버레이 결제창. 구독 화면에서만 호출한다.
import type { PaddleClientConfig } from '../types';

export const PADDLE_SCRIPT_SRC = 'https://cdn.paddle.com/paddle/v2/paddle.js';

export interface PaddleEvent {
  name?: string;
  data?: unknown;
}

export type PaddleEventHandler = (event: PaddleEvent) => void;

interface PaddleGlobal {
  Environment: { set: (environment: 'sandbox') => void };
  Initialize: (options: { token: string; eventCallback: PaddleEventHandler }) => void;
  Checkout: {
    open: (options: {
      transactionId: string;
      settings: { displayMode: 'overlay'; locale: 'ko' | 'en' };
    }) => void;
  };
}

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

let scriptPromise: Promise<PaddleGlobal> | null = null;
let readyPromise: Promise<PaddleGlobal> | null = null;
let currentHandler: PaddleEventHandler | null = null;

// 스크립트는 한 번만 넣는다. 실패하면 태그를 지우고 메모를 비워 다시 시도할 수 있게 한다.
function loadScript(): Promise<PaddleGlobal> {
  if (scriptPromise) return scriptPromise;
  const script = document.createElement('script');
  script.src = PADDLE_SCRIPT_SRC;
  script.async = true;
  scriptPromise = new Promise<PaddleGlobal>((resolve, reject) => {
    script.onload = () => {
      if (window.Paddle) resolve(window.Paddle);
      else reject(new Error('Paddle.js loaded without window.Paddle'));
    };
    script.onerror = () => reject(new Error('Paddle.js failed to load'));
  }).catch((err: unknown) => {
    script.remove();
    scriptPromise = null;
    throw err;
  });
  document.head.appendChild(script);
  return scriptPromise;
}

/**
 * 스크립트 로드 + 환경 설정 + Initialize 를 한 번만 수행한다.
 * Paddle.js 는 Initialize 시점 URL 에 `_ptxn` 이 있으면 결제창을 스스로 연다. 호출부는 그 전에 `_ptxn` 을
 * URL 에서 지우고 openPaddleCheckout 으로 직접 열어야 한 번만 열린다.
 */
export function initPaddle(client: PaddleClientConfig): Promise<PaddleGlobal> {
  if (readyPromise) return readyPromise;
  readyPromise = loadScript()
    .then((paddle) => {
      if (client.environment === 'sandbox') paddle.Environment.set('sandbox');
      paddle.Initialize({
        token: client.token,
        eventCallback: (event) => currentHandler?.(event),
      });
      return paddle;
    })
    .catch((err: unknown) => {
      readyPromise = null;
      throw err;
    });
  return readyPromise;
}

export interface OpenCheckoutOptions {
  client: PaddleClientConfig;
  transactionId: string;
  locale: 'ko' | 'en';
  onEvent: PaddleEventHandler;
  /** 준비를 기다리는 동안 화면을 떠나면 결제창을 열지 않는다. */
  signal?: AbortSignal;
}

/** 결제창을 열었으면 true, 준비 중 signal 이 abort 되어 열지 않았으면 false. */
export async function openPaddleCheckout({ client, transactionId, locale, onEvent, signal }: OpenCheckoutOptions): Promise<boolean> {
  const paddle = await initPaddle(client);
  if (signal?.aborted) return false;
  currentHandler = onEvent;
  paddle.Checkout.open({ transactionId, settings: { displayMode: 'overlay', locale } });
  return true;
}
