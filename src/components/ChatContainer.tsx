'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChatMessage, GptResponse, DifyStreamEvent, TypingPhase } from '@/types';
import ChatBubble from './ChatBubble';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import LoadingOverlay from './LoadingOverlay';
import styles from './ChatContainer.module.css';

const STORAGE_KEY = 'eum5g-chat-v1';
const GENERIC_ERROR_MESSAGE = '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';

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

/** 새로고침 후에도 대화가 이어지도록 sessionStorage에서 복원.
 * 복원 시 스트리밍 플래그를 정리하고, id 충돌이 없도록 카운터를 이어받는다. */
function loadSavedMessages(): ChatMessage[] | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    for (const m of parsed) {
      const n = Number(m.id?.replace('msg-', ''));
      if (Number.isFinite(n) && n > msgIdCounter) msgIdCounter = n;
    }
    return parsed.map((m) => ({ ...m, isStreaming: false }));
  } catch {
    return null;
  }
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

  /** 사용자가 위로 스크롤해 과거 내용을 읽는 중이면 자동 스크롤을 멈춘다(sticky scroll).
   * force는 사용자 자신의 전송 직후 등 항상 내려가야 하는 경우에만 사용. */
  const scrollToBottom = useCallback((force = false) => {
    setTimeout(() => {
      const el = bottomRef.current;
      if (!el) return;
      const nearBottom = el.getBoundingClientRect().top < window.innerHeight + 200;
      if (force || nearBottom) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);
  }, []);

  // 대화 내용을 sessionStorage에 저장(새로고침 시 복원용)
  useEffect(() => {
    if (messages.length === 0) return;
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(messages.map((m) => ({ ...m, isStreaming: false }))),
      );
    } catch { /* 저장 실패는 무시 */ }
  }, [messages]);

  // 초기화: 저장된 대화가 있으면 복원, 없으면 인사말 + 뉴스 로드
  useEffect(() => {
    const saved = loadSavedMessages();
    if (saved) {
      setMessages(saved);
      return;
    }

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

  /** 스트리밍 중지: 진행 중인 요청을 끊는다. 후처리(플래그 정리)는 handleSend의 abort 분기에서 수행. */
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const pushErrorMessage = useCallback((text: string) => {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'ai',
      content: text,
      timestamp: getTimestamp(),
      type: 'text',
    }]);
  }, []);

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
    scrollToBottom(true);

    const streamingMsgId = nextId();
    let started = false;
    let buffer = '';

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    /** 이 요청이 여전히 최신 요청일 때만 상태를 정리(새 전송이 이전 요청을 abort한 경우와 구분) */
    const finalize = (markDone: boolean) => {
      if (abortRef.current !== controller) return;
      if (markDone) {
        setMessages(prev => prev.map(m =>
          m.id === streamingMsgId ? { ...m, isStreaming: false } : m
        ));
      }
      setIsTyping(false);
      setIsSending(false);
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, conversation_id: conversationId, history }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        // 서버가 알려준 사유(요청 제한·길이 초과 등)가 있으면 그대로 안내
        let msg = GENERIC_ERROR_MESSAGE;
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch { /* JSON 아님 — 일반 오류 문구 사용 */ }
        finalize(false);
        pushErrorMessage(msg);
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
              finalize(false);
              pushErrorMessage(evt.message || GENERIC_ERROR_MESSAGE);
            } else {
              setMessages(prev => prev.map(m =>
                m.id === streamingMsgId
                  ? { ...m, isStreaming: false, content: m.content + '\n\n(오류가 발생했습니다)' }
                  : m
              ));
              finalize(false);
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

          if (evt.event === 'message_end' && evt.conversation_id) {
            setConversationId(evt.conversation_id);
          }
        }
      }

      // 스트리밍 완료
      finalize(true);
      scrollToBottom();

    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // 사용자가 중지했거나 새 질문으로 대체된 경우: 최신 요청일 때만 정리
        finalize(started);
        return;
      }

      if (!started) {
        finalize(false);
        pushErrorMessage('네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      } else {
        finalize(true);
        scrollToBottom();
      }
    }
  }, [messages, conversationId, scrollToBottom, pushErrorMessage]);

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
            // 초기 로드 메시지만 순차 등장시키고, 이후 메시지는 즉시 표시(누적 딜레이 방지)
            style={{ animationDelay: i < 5 ? `${0.15 + i * 0.1}s` : '0s' }}
          />
        ))}

        <TypingIndicator visible={isTyping} phase={typingPhase} />
        <div ref={bottomRef} />
      </div>

      <ChatInput onSend={handleSend} onStop={handleStop} isStreaming={isSending} />
    </>
  );
}
