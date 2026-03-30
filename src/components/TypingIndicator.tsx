import Image from 'next/image';
import type { TypingPhase } from '@/types';
import styles from './TypingIndicator.module.css';

interface Props {
  visible: boolean;
  phase?: TypingPhase;
}

const PHASE_CONFIG = {
  searching: {
    label: '관련 자료를 검색 중',
  },
  generating: {
    label: '답변을 생성 중',
  },
} as const;

export default function TypingIndicator({ visible, phase = 'searching' }: Props) {
  const config = PHASE_CONFIG[phase];

  return (
    <div className={`${styles.wrapper} ${!visible ? styles.hidden : ''}`}>
      <div className={styles.profileImg}>
        <Image src="/chat_img2.png" alt="AI" width={48} height={48} />
      </div>
      <div className={styles.col}>
        <div className={styles.name}>이음5G AI</div>
        <div className={`${styles.bubble} ${styles[phase]}`}>
          <div className={styles.waveBars}>
            <span className={styles.bar} />
            <span className={styles.bar} />
            <span className={styles.bar} />
            <span className={styles.bar} />
            <span className={styles.bar} />
          </div>
          <span className={styles.label}>{config.label}</span>
        </div>
      </div>
    </div>
  );
}
