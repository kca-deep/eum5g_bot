'use client';

import { useRef, useState, useCallback } from 'react';
import styles from './ChatInput.module.css';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming?: boolean;
}

export default function ChatInput({ onSend, onStop, isStreaming }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }, []);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const hasText = value.trim().length > 0;

  return (
    <div className={styles.bar}>
      <div className={styles.container}>
        <div className={styles.inputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.input}
            rows={1}
            placeholder="궁금한 점을 물어보세요"
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
          />
          {isStreaming ? (
            <button
              className={`${styles.sendBtn} ${styles.sendBtnActive}`}
              onClick={onStop}
              type="button"
              title="생성 중지"
            >
              <svg viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className={`${styles.sendBtn} ${hasText ? styles.sendBtnActive : ''}`}
              onClick={handleSend}
              type="button"
              title="전송"
            >
              <svg viewBox="0 0 24 24">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <p className={styles.notice}>
        개인정보·민감정보는 입력하지 마세요. AI 답변에는 오류가 있을 수 있으니 중요한 내용은{' '}
        <a href="https://spectrummap.kr/eum5gportal/" target="_blank" rel="noopener noreferrer">
          5G 특화망 지원포털
        </a>
        ·지원센터에 확인하시기 바랍니다.
      </p>
    </div>
  );
}
