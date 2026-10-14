'use client';

import type { ChatMessage } from '@/types';
import styles from './EndCard.module.css';

const PORTAL_URL = 'https://spectrummap.kr/eum5gportal/';
// 지원센터 대표 연락처는 확정된 값이 있을 때만 표시한다(없으면 지원포털 안내만).
const SUPPORT_PHONE = process.env.NEXT_PUBLIC_SUPPORT_PHONE || '';

interface Props {
  message: ChatMessage;
  onAnswer: (messageId: string, resolved: boolean) => void;
  onSupportClick: () => void;
}

/** 연속 질문이 끝났을 때 한 번 보여주는 카드: 해결 여부를 묻고, 아직이면 지원센터로 안내한다. */
export default function EndCard({ message, onAnswer, onSupportClick }: Props) {
  const state = message.endCard?.state ?? 'asking';

  return (
    <section className={styles.card} aria-label="상담 마무리">
      {state === 'asking' && (
        <div className={styles.row}>
          <p className={styles.question}>궁금한 점이 해결되셨나요?</p>
          <div className={styles.choices}>
            <button type="button" className={styles.choice} onClick={() => onAnswer(message.id, true)}>
              해결됐어요
            </button>
            <button type="button" className={styles.choice} onClick={() => onAnswer(message.id, false)}>
              아직 궁금해요
            </button>
          </div>
        </div>
      )}

      {state === 'resolved' && (
        <p className={styles.result}>
          도움이 되어 다행입니다. 더 궁금한 점이 생기면 언제든 물어보세요.
        </p>
      )}

      {state === 'unresolved' && (
        <div className={styles.row}>
          <p className={styles.result}>
            <strong>KCA 5G 특화망 지원센터</strong>에서 도입 상담과 주파수 할당 컨설팅을 자세히 안내해 드립니다.
          </p>
          <div className={styles.supportLinks}>
            <a
              href={PORTAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.supportLink}
              onClick={onSupportClick}
            >
              5G 특화망 지원포털 바로가기
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
              </svg>
              <span className="sr-only">(새 창)</span>
            </a>
            {SUPPORT_PHONE && (
              <a href={`tel:${SUPPORT_PHONE.replace(/[^\d+]/g, '')}`} className={styles.phone} onClick={onSupportClick}>
                지원센터 {SUPPORT_PHONE}
              </a>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
