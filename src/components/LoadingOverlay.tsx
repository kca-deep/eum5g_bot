import styles from './LoadingOverlay.module.css';

interface Props {
  visible: boolean;
}

export default function LoadingOverlay({ visible }: Props) {
  return (
    <div className={`${styles.overlay} ${!visible ? styles.hidden : ''}`}>
      <div className={styles.dots}>
        <div className={styles.dot} />
        <div className={styles.dot} />
        <div className={styles.dot} />
      </div>
      <p className={styles.text}>AI가 오늘의 뉴스를 분석 중입니다</p>
    </div>
  );
}
