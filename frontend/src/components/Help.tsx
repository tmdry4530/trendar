// Help.tsx — 작은 '?' 도움말 배지 + 호버/포커스 시 툴팁. 용어·버튼 안내용.
import styles from './Help.module.css';

export default function Help({ text, label = '도움말' }: { text: string; label?: string }) {
  return (
    <span className={styles.wrap}>
      <button type="button" className={styles.badge} aria-label={label}>
        ?
      </button>
      <span className={styles.tip} role="tooltip">
        {text}
      </span>
    </span>
  );
}
