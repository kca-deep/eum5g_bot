'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import Image from 'next/image';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { ChatMessage, FeedbackReason } from '@/types';
import styles from './ChatBubble.module.css';

interface Props {
  message: ChatMessage;
  style?: React.CSSProperties;
  onFeedback?: (messageId: string, score: 1 | -1, reason?: FeedbackReason) => void;
  onRetry?: (text: string) => void;
}

/**
 * 한글 인접 굵게(**...**) 렌더 보정.
 * CommonMark의 flanking 규칙상 닫는 `**`가 구두점 뒤 + 한글 앞일 때
 * (예: `...(EMSIT)**에서`) 강조로 인식되지 않아 `**`가 그대로 노출된다.
 * rehypeRaw가 켜져 있으므로 인라인 굵게를 <strong>으로 변환해 우회한다.
 */
function normalizeMarkdown(text: string): string {
  return text.replace(/\*\*(\S(?:[^\n*]*\S)?)\*\*/g, '<strong>$1</strong>');
}

/** 서버가 알려준 자료 유형 라벨을 짧은 표시명으로 */
const CATEGORY_LABEL: Record<string, string> = {
  '5G 특화망 가이드라인': '가이드라인',
  '구축사례 DB': '구축사례',
  '문의응답 사례': '문의응답 사례',
};

const FEEDBACK_REASONS: { value: FeedbackReason; label: string }[] = [
  { value: 'wrong', label: '정보가 틀려요' },
  { value: 'off_topic', label: '질문과 달라요' },
  { value: 'too_long', label: '너무 길어요' },
  { value: 'other', label: '기타' },
];

/** 넓은 표: 가로 스크롤 + 첫 열 고정 + 오른쪽에 더 있음을 알리는 흐림 */
function ScrollTable({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ any: false, right: false });

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const any = el.scrollWidth > el.clientWidth + 2;
    setOverflow({ any, right: any && el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [update]);

  return (
    <div className={`${styles.tableFrame} ${overflow.right ? styles.tableMore : ''}`}>
      <div
        ref={scrollRef}
        className={styles.tableScroll}
        onScroll={update}
        // 가로로 넘치는 표만 키보드로 스크롤할 수 있게 초점을 받는다.
        tabIndex={overflow.any ? 0 : undefined}
        role={overflow.any ? 'region' : undefined}
        aria-label={overflow.any ? '표 (좌우로 스크롤)' : undefined}
      >
        <table>{children}</table>
      </div>
    </div>
  );
}

const markdownComponents: Components = {
  table: ({ children }) => <ScrollTable>{children}</ScrollTable>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={styles.link}>
      {children}
      <svg className={styles.linkIcon} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
      <span className="sr-only">(새 창)</span>
    </a>
  ),
};

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    // 화면에 보이는 그대로(마크다운 기호 없이, 표는 탭 구분) 복사해 문서에 붙여 넣기 쉽게 한다.
    const text = getText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 클립보드 API 미지원 폴백
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [getText]);

  return (
    <button
      className={`${styles.actionBtn} ${copied ? styles.actionDone : ''}`}
      onClick={handleCopy}
      type="button"
      aria-label={copied ? '복사됨' : '답변 복사'}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
        </svg>
      )}
      <span>{copied ? '복사됨' : '복사'}</span>
    </button>
  );
}

function GroundingChip({ grounding }: { grounding: NonNullable<ChatMessage['grounding']> }) {
  if (!grounding.grounded) {
    return <span className={`${styles.chip} ${styles.chipNone}`}>참고 자료 없음 · 일반 안내</span>;
  }
  const labels = grounding.categories.map((c) => CATEGORY_LABEL[c] || c);
  return (
    <span className={styles.chip}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9.5 14l2 2 3.5-4" />
      </svg>
      참고 · {labels.join(', ')}
    </span>
  );
}

function Feedback({ message, onFeedback }: { message: ChatMessage; onFeedback: NonNullable<Props['onFeedback']> }) {
  const vote = message.feedback;
  return (
    <div className={styles.feedback} role="group" aria-label="이 답변 평가">
      <button
        type="button"
        className={`${styles.actionBtn} ${vote === 1 ? styles.actionOn : ''}`}
        aria-pressed={vote === 1}
        onClick={() => onFeedback(message.id, 1)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 10v10H4V10h3zM7 10l4-7a2 2 0 0 1 3 2l-1 5h6a2 2 0 0 1 2 2.3l-1.3 6.5A2 2 0 0 1 17.7 20H7" />
        </svg>
        <span>도움됐어요</span>
      </button>
      <button
        type="button"
        className={`${styles.actionBtn} ${vote === -1 ? styles.actionOn : ''}`}
        aria-pressed={vote === -1}
        onClick={() => onFeedback(message.id, -1)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M17 14V4h3v10h-3zM17 14l-4 7a2 2 0 0 1-3-2l1-5H5a2 2 0 0 1-2-2.3l1.3-6.5A2 2 0 0 1 6.3 4H17" />
        </svg>
        <span>아쉬워요</span>
      </button>
    </div>
  );
}

export default function ChatBubble({ message, style, onFeedback, onRetry }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const getText = useCallback(
    () => bodyRef.current?.innerText.trim() || message.content,
    [message.content],
  );

  if (message.role === 'user') {
    return (
      <article className={`${styles.wrapper} ${styles.wrapperUser}`} style={style} aria-label="내 질문">
        <div className={`${styles.col} ${styles.colUser}`}>
          <div className={`${styles.bubble} ${styles.bubbleUser}`}>
            <div className={`${styles.bubbleText} ${styles.bubbleTextUser}`}>
              {message.content}
            </div>
          </div>
          <div className={styles.actions}>
            <span className={styles.timestamp}>{message.timestamp}</span>
          </div>
        </div>
      </article>
    );
  }

  if (message.type === 'error') {
    return (
      <article className={styles.wrapper} style={style} aria-label="오류 안내">
        <div className={styles.profileImg}>
          <Image src="/chat_img2.png" alt="" width={48} height={48} />
        </div>
        <div className={styles.col}>
          <div className={styles.meta}>
            <span className={styles.name}>이음5G AI</span>
          </div>
          <div className={`${styles.bubble} ${styles.bubbleError}`}>
            <svg className={styles.errorIcon} viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.5v.01" />
            </svg>
            <div className={styles.bubbleText}>{message.content}</div>
          </div>
          <div className={styles.actions}>
            <span className={styles.timestamp}>{message.timestamp}</span>
            {message.retryText && onRetry && (
              <button type="button" className={styles.actionBtn} onClick={() => onRetry(message.retryText!)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5" /></svg>
                <span>다시 시도</span>
              </button>
            )}
          </div>
        </div>
      </article>
    );
  }

  const done = !message.isStreaming && Boolean(message.content);
  const canRate = done && !message.greeting && Boolean(message.turnId) && Boolean(onFeedback);

  return (
    <article className={styles.wrapper} style={style} aria-label="이음5G AI 답변">
      <div className={styles.profileImg}>
        <Image src="/chat_img2.png" alt="" width={48} height={48} />
      </div>
      <div className={styles.col}>
        <div className={styles.meta}>
          <span className={styles.name}>이음5G AI</span>
          {message.grounding && <GroundingChip grounding={message.grounding} />}
        </div>
        <div className={styles.bubble}>
          <div ref={bodyRef} className={`${styles.bubbleText} ${styles.markdown}`}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              // rehypeRaw는 normalizeMarkdown의 <strong> 변환에 필요하지만 그대로 두면
              // 모델 출력의 임의 HTML(XSS)이 렌더링되므로, 바로 뒤에서 sanitize로 걸러낸다.
              rehypePlugins={[rehypeRaw, rehypeSanitize]}
              components={markdownComponents}
            >
              {normalizeMarkdown(message.content)}
            </ReactMarkdown>
            {message.isStreaming && <span className={styles.cursor} aria-hidden="true">▍</span>}
          </div>
        </div>

        {message.interrupted && (
          <p className={styles.stateNote}>답변이 중간에 끊겼습니다. 잠시 후 다시 질문해 주세요.</p>
        )}

        <div className={styles.actions}>
          <span className={styles.timestamp}>{message.timestamp}</span>
          {message.stopped && <span className={styles.stateTag}>중지됨</span>}
          {done && !message.greeting && <CopyButton getText={getText} />}
          {canRate && <Feedback message={message} onFeedback={onFeedback!} />}
        </div>

        {canRate && message.feedback === -1 && (
          message.feedbackReason ? (
            <p className={styles.thanks}>의견이 전달되었습니다. 감사합니다.</p>
          ) : (
            <div className={styles.reasons} role="group" aria-label="아쉬운 점 선택">
              <span className={styles.reasonsLabel}>어떤 점이 아쉬웠나요?</span>
              {FEEDBACK_REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  className={styles.reasonChip}
                  onClick={() => onFeedback!(message.id, -1, r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )
        )}
      </div>
    </article>
  );
}
