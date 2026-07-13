import Image from 'next/image';
import styles from './Header.module.css';

export default function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Image src="/logo.png" alt="이음5G" width={115} height={30} className={styles.logo} style={{ width: 'auto', height: 'auto' }} priority />
        </div>
        <div className={styles.icons}>
          <div className={styles.badge}>
            <svg viewBox="0 0 24 24">
              <path d="M7 2v11h3v9l7-12h-4l4-8z" />
            </svg>
            <span>시범운영</span>
          </div>
        </div>
      </div>
    </header>
  );
}
