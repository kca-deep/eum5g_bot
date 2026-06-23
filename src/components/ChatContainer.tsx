'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChatMessage, GptResponse, DifyStreamEvent, DifyRetrievalResource, TypingPhase } from '@/types';
import ChatBubble from './ChatBubble';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import LoadingOverlay from './LoadingOverlay';
import styles from './ChatContainer.module.css';

function getTimestamp() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const period = hours < 12 ? '오전' : '오후';
  const displayHours = hours % 12 || 12;
  return `${period} ${displayHours}:${minutes}`;
}

function getDateLine() {
  const now = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  return `${y}.${m}.${d} ${days[now.getDay()]}요일`;
}

let msgIdCounter = 0;
function nextId() {
  return `msg-${++msgIdCounter}`;
}

/** SSE 스트림을 줄 단위로 파싱 */
function parseSSE(raw: string): DifyStreamEvent[] {
  const events: DifyStreamEvent[] = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ')) continue;

    const jsonStr = trimmed.slice(6);
    try {
      const parsed = JSON.parse(jsonStr) as DifyStreamEvent;
      events.push(parsed);
    } catch {
      // 불완전한 JSON — 다음 청크에서 완성
    }
  }
  return events;
}

export default function ChatContainer() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [typingPhase, setTypingPhase] = useState<TypingPhase>('searching');
  const [isSending, setIsSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  // 초기 뉴스 데이터 로드 (NEWS_API_URL 설정 시에만 호출)
  useEffect(() => {
    const ts = getTimestamp();
    const newsApiUrl = process.env.NEXT_PUBLIC_NEWS_API_URL;

    setMessages([{
      id: nextId(),
      role: 'ai',
      content: '안녕하세요! 5G 특화망에 대해 궁금한 점을 물어보세요.',
      timestamp: ts,
      type: 'text',
    }]);

    if (!newsApiUrl) return;

    fetch(newsApiUrl)
      .then(res => {
        if (!res.ok) throw new Error('not available');
        return res.json();
      })
      .then((data: GptResponse) => {
        const ts2 = getTimestamp();
        const newMessages: ChatMessage[] = [];

        if (data.image) {
          newMessages.push({
            id: nextId(),
            role: 'ai',
            content: '',
            timestamp: ts2,
            type: 'image',
            imageUrl: data.image,
          });
        }

        newMessages.push({
          id: nextId(),
          role: 'ai',
          content: '최근 5G 특화망과 관련된 주요 이슈를 정리해봤어요',
          timestamp: ts2,
          type: 'text',
        });

        if (data.result && data.result.length > 0) {
          newMessages.push({
            id: nextId(),
            role: 'ai',
            content: '',
            timestamp: ts2,
            type: 'news',
            newsItems: data.result,
          });
        }

        setMessages(prev => [...prev, ...newMessages]);
        setIsLoading(false);
        scrollToBottom();
      })
      .catch(() => {
        setIsLoading(false);
      });
  }, [scrollToBottom]);

  /** Blocking 폴백 */
  const sendBlocking = useCallback(async (text: string, history: { role: string; content: string }[]) => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, conversation_id: conversationId, history }),
      });

      const data = await res.json();
      setIsTyping(false);

      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'ai',
        content: data.answer || '죄송합니다. 현재 답변을 드리기 어렵습니다.',
        timestamp: getTimestamp(),
        type: 'text',
      }]);
    } catch {
      setIsTyping(false);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'ai',
        content: '네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
        timestamp: getTimestamp(),
        type: 'text',
      }]);
    } finally {
      setIsSending(false);
      scrollToBottom();
    }
  }, [conversationId, scrollToBottom]);

  /** Dify RAG + OpenAI 스트리밍 전송 */
  const handleSend = useCallback(async (text: string) => {
    const ts = getTimestamp();

    // 멀티턴: 현재 질문 이전의 대화에서 최근 6개(3턴)를 추려 함께 전송
    const history = messages
      .filter(m => m.type === 'text' && m.content)
      .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
      .slice(-6);

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user',
      content: text,
      timestamp: ts,
      type: 'text',
    }]);

    setTypingPhase('searching');
    setIsTyping(true);
    setIsSending(true);
    scrollToBottom();

    const streamingMsgId = nextId();
    let started = false;
    let buffer = '';
    let collectedSources: DifyRetrievalResource[] | undefined;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, conversation_id: conversationId, history }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        sendBlocking(text, history);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lastNewline = buffer.lastIndexOf('\n');
        if (lastNewline === -1) continue;

        const complete = buffer.slice(0, lastNewline + 1);
        buffer = buffer.slice(lastNewline + 1);

        const events = parseSSE(complete);

        for (const evt of events) {
          if (evt.event === 'ping') continue;

          if (evt.event === 'status') {
            if (evt.status === 'searching' || evt.status === 'generating') {
              setTypingPhase(evt.status);
            }
            continue;
          }

          if (evt.event === 'error') {
            reader.cancel();
            if (!started) {
              sendBlocking(text, history);
            } else {
              setMessages(prev => prev.map(m =>
                m.id === streamingMsgId
                  ? { ...m, isStreaming: false, content: m.content + '\n\n(오류가 발생했습니다)' }
                  : m
              ));
              setIsSending(false);
            }
            return;
          }

          if (evt.event === 'message' || evt.event === 'message_replace') {
            if (!started) {
              setIsTyping(false);
              setMessages(prev => [...prev, {
                id: streamingMsgId,
                role: 'ai',
                content: evt.answer || '',
                timestamp: getTimestamp(),
                type: 'text',
                isStreaming: true,
              }]);
              started = true;
              continue;
            }

            if (evt.conversation_id) {
              setConversationId(evt.conversation_id);
            }

            if (evt.event === 'message_replace') {
              setMessages(prev => prev.map(m =>
                m.id === streamingMsgId ? { ...m, content: evt.answer || '' } : m
              ));
            } else {
              setMessages(prev => prev.map(m =>
                m.id === streamingMsgId ? { ...m, content: m.content + (evt.answer || '') } : m
              ));
            }
            scrollToBottom();
          }

          if (evt.event === 'message_end') {
            if (evt.metadata?.retrieval_resources) {
              collectedSources = evt.metadata.retrieval_resources;
            }
            if (evt.conversation_id) {
              setConversationId(evt.conversation_id);
            }
          }
        }
      }

      // 스트리밍 완료
      setMessages(prev => prev.map(m =>
        m.id === streamingMsgId
          ? { ...m, isStreaming: false, sources: collectedSources }
          : m
      ));
      setIsSending(false);
      scrollToBottom();

    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;

      if (!started) {
        sendBlocking(text, history);
      } else {
        setMessages(prev => prev.map(m =>
          m.id === streamingMsgId ? { ...m, isStreaming: false } : m
        ));
        setIsSending(false);
        scrollToBottom();
      }
    }
  }, [messages, conversationId, scrollToBottom, sendBlocking]);

  return (
    <>
      <LoadingOverlay visible={isLoading} />

      <div className={styles.content}>
        <div className={styles.sectionTitle}>
          <h2>오늘의 주요 이슈</h2>
          <div className={styles.dateLine}>{getDateLine()}</div>
        </div>

        {messages.map((msg, i) => (
          <ChatBubble
            key={msg.id}
            message={msg}
            style={{ animationDelay: `${0.15 + i * 0.1}s` }}
          />
        ))}

        <TypingIndicator visible={isTyping} phase={typingPhase} />
        <div ref={bottomRef} />
      </div>

      <ChatInput onSend={handleSend} disabled={isSending} />
    </>
  );
}
