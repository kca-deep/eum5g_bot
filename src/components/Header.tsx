import Image from 'next/image';
import styles from './Header.module.css';

interface Props {
  onNewConversation: () => void;
  canReset: boolean;
}

export default function Header({ onNewConversation, canReset }: Props) {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <div className={styles.brand}>
          <a
            href="https://spectrummap.kr/eum5gportal/"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.logoLink}
          >
            <Image src="/logo.png" alt="이음5G 지원포털" width={115} height={31} className={styles.logo} priority />
            <span className="sr-only">(새 창)</span>
          </a>
          <h1 className={styles.title}>5G 특화망 AI 상담</h1>
          <span className={styles.badge}>시범운영</span>
        </div>
        <button
          type="button"
          className={styles.newBtn}
          onClick={onNewConversation}
          disabled={!canReset}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          새 대화
        </button>
      </div>
    </header>
  );
}
