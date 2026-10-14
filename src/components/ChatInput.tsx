'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import styles from './ChatInput.module.css';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export default function ChatInput({ onSend, onStop, isStreaming, inputRef }: Props) {
  const [value, setValue] = useState('');
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? ownRef;
  const barRef = useRef<HTMLDivElement>(null);

  // 고정 입력창 높이(입력 줄 수·안내문 줄바꿈·안전 영역에 따라 변함)를 본문 하단 여백에 반영해
  // 마지막 답변이 입력창 뒤에 가려지지 않게 한다.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty('--input-bar-height', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--input-bar-height');
    };
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }, []);

  const handleSend = useCallback(() => {
    const text = value.trim();
    // 답변 생성 중에는 보내지 않는다(입력은 유지되어 답변이 끝난 뒤 보낼 수 있음).
    if (!text || isStreaming) return;
    onSend(text);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, onSend, isStreaming, textareaRef]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 한글 조합 중 Enter는 글자 확정용이므로 전송하지 않는다(Safari는 keyCode 229로만 알려줌).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const hasText = value.trim().length > 0;

  return (
    <div ref={barRef} className={styles.bar}>
      <div className={styles.container}>
        <div className={styles.inputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.input}
            rows={1}
            placeholder="궁금한 점을 물어보세요"
            aria-label="질문 입력"
            maxLength={2000}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
          />
          {isStreaming ? (
            <button
              className={`${styles.sendBtn} ${styles.stopBtn}`}
              onClick={onStop}
              type="button"
              aria-label="답변 생성 중지"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className={styles.sendBtn}
              onClick={handleSend}
              type="button"
              aria-label="질문 보내기"
              disabled={!hasText}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <p className={styles.notice}>
        개인정보·민감정보는 입력하지 마세요. 답변 품질 개선을 위해 대화 내용이 저장됩니다. AI 답변에는 오류가 있을 수 있으니 중요한 내용은{' '}
        <a href="https://spectrummap.kr/eum5gportal/" target="_blank" rel="noopener noreferrer">
          5G 특화망 지원포털
        </a>
        ·지원센터에 확인하시기 바랍니다.
      </p>
    </div>
  );
}
