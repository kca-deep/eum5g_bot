'use client';

import { useState, useCallback } from 'react';
import Image from 'next/image';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { ChatMessage } from '@/types';
import NewsItem from './NewsItem';
import styles from './ChatBubble.module.css';

interface Props {
  message: ChatMessage;
  style?: React.CSSProperties;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 API 미지원 폴백
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

  return (
    <button
      className={`${styles.copyBtn} ${copied ? styles.copyBtnCopied : ''}`}
      onClick={handleCopy}
      type="button"
      title={copied ? '복사됨' : '복사'}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" width="13" height="13">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="13" height="13">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
        </svg>
      )}
    </button>
  );
}

export default function ChatBubble({ message, style }: Props) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className={`${styles.wrapper} ${styles.wrapperUser}`} style={style}>
        <div className={`${styles.col} ${styles.colUser}`}>
          <div className={`${styles.bubble} ${styles.bubbleUser}`}>
            <div className={`${styles.bubbleText} ${styles.bubbleTextUser}`}>
              {message.content}
            </div>
          </div>
          <div className={styles.timestamp}>{message.timestamp}</div>
        </div>
      </div>
    );
  }

  const showCopy = message.type === 'text' && message.content && !message.isStreaming;

  return (
    <div className={styles.wrapper} style={style}>
      <div className={styles.profileImg}>
        <Image src="/chat_img2.png" alt="AI" width={48} height={48} />
      </div>
      <div className={styles.col}>
        <div className={styles.name}>이음5G AI</div>

        {message.type === 'image' && message.imageUrl && (
          <div className={styles.bubble}>
            <div className={styles.imageWrapper}>
              <img
                className={styles.mainImage}
                src={message.imageUrl}
                alt="AI 생성 이미지"
                onClick={() => window.open(message.imageUrl, '_blank')}
              />
            </div>
          </div>
        )}

        {message.type === 'news' && message.newsItems && (
          <div className={styles.bubble}>
            {message.newsItems.map((item, i) => (
              <NewsItem key={i} item={item} />
            ))}
          </div>
        )}

        {message.type === 'text' && (
          <div className={styles.bubble}>
            <div className={`${styles.bubbleText} ${styles.markdown}`}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={{
                  table: ({ children, ...props }) => (
                    <div className="table-wrapper">
                      <table {...props}>{children}</table>
                    </div>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
              {message.isStreaming && <span className={styles.cursor}>▍</span>}
            </div>
          </div>
        )}


        <div className={styles.timestampRow}>
          <span className={styles.timestamp}>{message.timestamp}</span>
          {showCopy && <CopyButton text={message.content} />}
        </div>
      </div>
    </div>
  );
}
