'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import type { TypingPhase } from '@/types';
import styles from './TypingIndicator.module.css';

interface Props {
  phase: TypingPhase;
  /** 질문을 보낸 시각(Date.now) — 경과 시간 표시용 */
  startedAt: number;
}

/** 첫 글자까지 20~50초가 걸리는 경우가 있어, 단계와 경과 시간에 따라 안내 문구를 바꾼다. */
function phaseLabel(phase: TypingPhase, seconds: number): string {
  if (phase === 'searching') return '관련 자료를 찾고 있어요';
  if (seconds < 10) return '답변을 작성하고 있어요';
  if (seconds < 25) return '내용을 정리해 답변을 작성하고 있어요';
  return '답변이 길어 조금 더 걸리고 있어요';
}

export default function TypingIndicator({ phase, startedAt }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <div className={styles.wrapper} aria-hidden="true">
      <div className={styles.profileImg}>
        <Image src="/chat_img2.png" alt="" width={48} height={48} />
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
          <span key={phaseLabel(phase, seconds)} className={styles.label}>
            {phaseLabel(phase, seconds)}
          </span>
          {seconds >= 3 && <span className={styles.elapsed}>{seconds}초</span>}
        </div>
      </div>
    </div>
  );
}
