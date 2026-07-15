// Help.tsx — 작은 '?' 도움말 배지 + 툴팁. 툴팁은 body로 포탈 렌더링해
// 부모의 overflow(hidden/auto)에 잘리지 않게 하고, 화면 밖으로 넘치지 않게 위치를 보정한다.
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Help.module.css';

interface TipPos {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
}

export default function Help({ text, label = '도움말' }: { text: string; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<TipPos | null>(null);

  function show() {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 130; // 툴팁 max-width(240)의 절반 + 여유
    const left = Math.min(Math.max(r.left + r.width / 2, margin), window.innerWidth - margin);
    const placement: TipPos['placement'] = r.top < 120 ? 'bottom' : 'top';
    setPos({ left, top: placement === 'top' ? r.top : r.bottom, placement });
  }
  const hide = () => setPos(null);

  return (
    <span className={styles.wrap}>
      <button
        ref={ref}
        type="button"
        className={styles.badge}
        aria-label={label}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        ?
      </button>
      {pos &&
        createPortal(
          <span
            role="tooltip"
            className={`${styles.tip} ${pos.placement === 'bottom' ? styles.tipBottom : ''}`}
            style={{ left: pos.left, top: pos.top }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
