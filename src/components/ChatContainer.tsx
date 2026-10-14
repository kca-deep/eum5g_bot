'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChatMessage, DifyStreamEvent, TypingPhase, FeedbackReason, EndCardTrigger } from '@/types';
import Header from './Header';
import ChatBubble from './ChatBubble';
import EndCard from './EndCard';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import styles from './ChatContainer.module.css';

const STORAGE_KEY = 'eum5g-chat-v2';
const SESSION_KEY = 'eum5g-session-v1';
const GENERIC_ERROR_MESSAGE = '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
const NETWORK_ERROR_MESSAGE = '네트워크 오류로 답변을 받지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';

const GREETING =
  '안녕하세요. 5G 특화망(이음5G) 도입 절차, 주파수 할당, 구축 사례를 안내해 드립니다.\n\n' +
  '궁금한 점을 입력하시거나 아래 질문으로 시작해 보세요.';

const STARTER_QUESTIONS = [
  '5G 특화망 유형별 차이점은 무엇인가요?',
  '주파수 할당은 어떻게 신청하나요?',
  '국내 구축 사례를 알려주세요',
  '지원센터 컨설팅은 어떻게 받나요?',
];

/** 마지막 답변 뒤 입력이 없으면 대화가 끝난 것으로 보고 종료 카드를 띄운다. */
const IDLE_END_CARD_MS = 3 * 60_000;
/** 짧은 마무리 인사(감사합니다·알겠습니다 등) — 답변이 끝나면 바로 종료 카드를 띄운다. */
const CLOSING_PHRASE_RE = /^(네|넵|아|오|아하)?[\s,.!]*(감사|고맙|고마워|알겠|잘 알겠|이해했|이해됐|됐어요|됐습니다|수고)/;

function getTimestamp() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const period = hours < 12 ? '오전' : '오후';
  const displayHours = hours % 12 || 12;
  return `${period} ${displayHours}:${minutes}`;
}

/** 처리 기록을 대화 단위로 묶는 무작위 ID(탭을 닫으면 사라짐, 개인 식별 정보 아님) */
function getSessionId(renew = false): string | null {
  try {
    let id = renew ? null : sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/** 처리 기록용 신호 전송. 페이지를 떠나는 중에도 전달되도록 sendBeacon을 우선 사용한다. */
function sendEvent(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon?.('/api/event', new Blob([body], { type: 'application/json' }))) return;
  } catch { /* fetch로 대체 */ }
  fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => { /* 기록 실패는 사용자에게 알리지 않는다 */ });
}

let msgIdCounter = 0;
function nextId() {
  return `msg-${++msgIdCounter}`;
}

function createGreeting(): ChatMessage {
  return {
    id: nextId(),
    role: 'ai',
    content: GREETING,
    timestamp: getTimestamp(),
    type: 'text',
    greeting: true,
  };
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
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    try {
      events.push(JSON.parse(trimmed.slice(6)) as DifyStreamEvent);
    } catch {
      // 불완전한 JSON — 다음 청크에서 완성
    }
  }
  return events;
}

/** 마지막 종료 카드 이후 새 질문이 있었고, 마지막 메시지가 끝난 답변일 때만 종료 카드를 띄울 수 있다. */
function canShowEndCard(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'ai' || last.type !== 'text' || last.greeting || last.isStreaming) return false;
  const lastCard = messages.map((m) => m.type).lastIndexOf('endcard');
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  return lastUser > lastCard;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function ChatContainer() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState<{ phase: TypingPhase; startedAt: number } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const hasUserMessage = messages.some((m) => m.role === 'user');

  /** 화면낭독기 알림: 단계가 바뀔 때만 짧게 알린다(스트리밍 조각마다 읽히지 않도록). */
  const announce = useCallback((text: string) => {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  /** 사용자가 위로 스크롤해 과거 내용을 읽는 중이면 자동 스크롤을 멈춘다(sticky scroll).
   * force는 사용자 자신의 전송 직후 등 항상 내려가야 하는 경우에만 사용. */
  const scrollToBottom = useCallback((force = false) => {
    setTimeout(() => {
      const el = bottomRef.current;
      if (!el) return;
      const nearBottom = el.getBoundingClientRect().top < window.innerHeight + 200;
      if (force || nearBottom) {
        el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    }, 100);
  }, []);

  // 대화 내용을 sessionStorage에 저장(새로고침 시 복원용) — 평가·종료 카드 상태도 함께 남는다.
  useEffect(() => {
    if (messages.length === 0) return;
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(messages.map((m) => ({ ...m, isStreaming: false }))),
      );
    } catch { /* 저장 실패는 무시 */ }
  }, [messages]);

  // 초기화: 저장된 대화가 있으면 복원(가장 최근 답변 위치로), 없으면 인사말
  useEffect(() => {
    const saved = loadSavedMessages();
    if (saved) {
      setMessages(saved);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'auto' }), 50);
      return;
    }
    setMessages([createGreeting()]);
  }, []);

  /** 종료 카드는 대화 묶음당 한 번만, 조건이 맞을 때만 추가한다. */
  const showEndCard = useCallback((trigger: EndCardTrigger) => {
    if (!canShowEndCard(messagesRef.current)) return;
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'ai',
      content: '',
      timestamp: getTimestamp(),
      type: 'endcard',
      endCard: { trigger, state: 'asking' },
    }]);
    sendEvent({ type: 'end_card_shown', session_id: getSessionId(), trigger });
    announce('궁금한 점이 해결되셨는지 묻는 안내가 표시되었습니다.');
    scrollToBottom();
  }, [announce, scrollToBottom]);

  // 유휴 트리거: 마지막 답변 뒤 일정 시간 입력이 없으면 종료 카드
  useEffect(() => {
    if (isSending || !canShowEndCard(messages)) return;
    const timer = setTimeout(() => showEndCard('idle'), IDLE_END_CARD_MS);
    return () => clearTimeout(timer);
  }, [messages, isSending, showEndCard]);

  /** 스트리밍 중지: 진행 중인 요청을 끊는다. 후처리는 handleSend의 abort 분기에서 수행. */
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const pushMessage = useCallback((message: Omit<ChatMessage, 'id' | 'timestamp' | 'role'>) => {
    setMessages(prev => [...prev, { id: nextId(), role: 'ai', timestamp: getTimestamp(), ...message }]);
  }, []);

  /** Dify RAG + OpenAI 스트리밍 전송 */
  const handleSend = useCallback(async (text: string) => {
    // 답변 생성 중에는 새 질문을 보내지 않는다(이전 답변이 조용히 끊기지 않도록, 중지 버튼으로만 멈춤).
    if (abortRef.current) return;

    // 멀티턴: 현재 질문 이전의 대화에서 최근 6개(3턴)를 추려 함께 전송.
    // 첫 질문 앞의 인사말은 대화 맥락이 아니므로 빼야 첫 질문이 재작성 단계를 거치지 않는다.
    const current = messagesRef.current;
    const firstUserIdx = current.findIndex(m => m.role === 'user');
    const history = (firstUserIdx === -1 ? [] : current.slice(firstUserIdx))
      .filter(m => m.type === 'text' && m.content)
      .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
      .slice(-6);
    const isClosing = text.length <= 30 && CLOSING_PHRASE_RE.test(text.trim());

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user',
      content: text,
      timestamp: getTimestamp(),
      type: 'text',
    }]);

    setTyping({ phase: 'searching', startedAt: Date.now() });
    setIsSending(true);
    announce('질문을 보냈습니다. 관련 자료를 찾고 있습니다.');
    scrollToBottom(true);

    const streamingMsgId = nextId();
    let started = false;
    let buffer = '';
    let grounding: ChatMessage['grounding'];

    // 처리 기록: 전송 시점부터 첫 글자·마지막 글자까지의 체감 시간(네트워크 포함)을 잰다.
    const sessionId = getSessionId();
    const turnIndex = current.filter(m => m.role === 'user').length;
    const sentAt = performance.now();
    let turnId: string | undefined;
    let firstCharMs: number | null = null;
    let timingReported = false;
    const reportTiming = (outcome: 'completed' | 'stopped' | 'error') => {
      if (!turnId || timingReported) return;
      timingReported = true;
      sendEvent({
        type: 'client_timing',
        session_id: sessionId,
        turn_id: turnId,
        value: { first_char_ms: firstCharMs, done_ms: Math.round(performance.now() - sentAt), outcome },
      });
    };

    const controller = new AbortController();
    abortRef.current = controller;

    /** 입력 상태 정리. 새 대화로 초기화된 경우(다른 요청이 주인)는 건드리지 않는다. */
    const finish = (patch?: Partial<ChatMessage>) => {
      if (started) {
        setMessages(prev => prev.map(m =>
          m.id === streamingMsgId ? { ...m, isStreaming: false, ...patch } : m
        ));
      }
      if (abortRef.current === controller) abortRef.current = null;
      setTyping(null);
      setIsSending(false);
    };

    const failBeforeAnswer = (msg: string) => {
      finish();
      pushMessage({ content: msg, type: 'error', retryText: text });
      announce(msg);
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, history, session_id: sessionId, turn_index: turnIndex }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        // 서버가 알려준 사유(요청 제한·길이 초과 등)가 있으면 그대로 안내
        let msg = GENERIC_ERROR_MESSAGE;
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch { /* JSON 아님 — 일반 오류 문구 사용 */ }
        failBeforeAnswer(msg);
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

        for (const evt of parseSSE(complete)) {
          if (evt.event === 'ping') continue;

          if (evt.event === 'meta') {
            turnId = evt.turn_id;
            continue;
          }

          if (evt.event === 'context') {
            grounding = { grounded: Boolean(evt.grounded), categories: evt.categories || [] };
            continue;
          }

          if (evt.event === 'status') {
            if (evt.status === 'searching' || evt.status === 'generating') {
              setTyping(prev => prev && { ...prev, phase: evt.status as TypingPhase });
              if (evt.status === 'generating') announce('답변을 작성하고 있습니다.');
            }
            continue;
          }

          if (evt.event === 'error') {
            reader.cancel();
            reportTiming('error');
            if (!started) {
              failBeforeAnswer(evt.message || GENERIC_ERROR_MESSAGE);
            } else {
              finish({ interrupted: true });
              announce('답변이 중간에 끊겼습니다.');
            }
            return;
          }

          if (evt.event === 'message' || evt.event === 'message_replace') {
            if (!started) {
              firstCharMs = Math.round(performance.now() - sentAt);
              started = true;
              setTyping(null);
              setMessages(prev => [...prev, {
                id: streamingMsgId,
                role: 'ai',
                content: evt.answer || '',
                timestamp: getTimestamp(),
                type: 'text',
                isStreaming: true,
                turnId,
                grounding,
              }]);
              continue;
            }

            setMessages(prev => prev.map(m => {
              if (m.id !== streamingMsgId) return m;
              return { ...m, content: evt.event === 'message_replace' ? evt.answer || '' : m.content + (evt.answer || '') };
            }));
            scrollToBottom();
          }
        }
      }

      // 스트리밍 완료
      reportTiming('completed');
      finish();
      announce('답변이 완료되었습니다.');
      scrollToBottom();
      if (isClosing) setTimeout(() => showEndCard('closing_phrase'), 600);

    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // 새 대화로 초기화하며 끊은 경우는 화면이 이미 비워졌으므로 아무것도 하지 않는다.
        if (abortRef.current !== controller) return;
        reportTiming('stopped');
        finish({ stopped: true });
        if (!started) pushMessage({ content: '답변 생성을 중지했습니다.', type: 'notice' });
        announce('답변을 중지했습니다.');
        return;
      }

      reportTiming('error');
      if (!started) {
        failBeforeAnswer(NETWORK_ERROR_MESSAGE);
      } else {
        finish({ interrupted: true });
        announce('답변이 중간에 끊겼습니다.');
      }
    }
  }, [announce, scrollToBottom, pushMessage, showEndCard]);

  const handleFeedback = useCallback((messageId: string, score: 1 | -1, reason?: FeedbackReason) => {
    const target = messagesRef.current.find(m => m.id === messageId);
    if (!target?.turnId) return;

    const next = messagesRef.current.map(m =>
      m.id === messageId ? { ...m, feedback: score, feedbackReason: score === -1 ? reason : undefined } : m
    );
    setMessages(next);
    sendEvent({
      type: 'feedback',
      session_id: getSessionId(),
      turn_id: target.turnId,
      value: { score, reason: reason ?? null },
    });
    announce(reason || score === 1 ? '의견이 전달되었습니다.' : '아쉬운 점을 선택할 수 있습니다.');

    // 최근 평가한 두 답변이 모두 '아쉬워요'면 지원센터 안내로 이어지게 한다.
    if (score === -1 && !reason) {
      const rated = next.filter(m => m.role === 'ai' && m.feedback !== undefined);
      const lastTwo = rated.slice(-2);
      if (lastTwo.length === 2 && lastTwo.every(m => m.feedback === -1)) {
        setTimeout(() => showEndCard('repeated_unresolved'), 400);
      }
    }
  }, [announce, showEndCard]);

  const handleEndCardAnswer = useCallback((messageId: string, resolved: boolean) => {
    const card = messagesRef.current.find(m => m.id === messageId);
    if (!card?.endCard) return;
    setMessages(prev => prev.map(m =>
      m.id === messageId && m.endCard
        ? { ...m, endCard: { ...m.endCard, state: resolved ? 'resolved' : 'unresolved' } }
        : m
    ));
    sendEvent({
      type: resolved ? 'resolved_yes' : 'resolved_no',
      session_id: getSessionId(),
      trigger: card.endCard.trigger,
    });
    announce(resolved ? '응답해 주셔서 감사합니다.' : '지원센터 안내가 표시되었습니다.');
    scrollToBottom();
  }, [announce, scrollToBottom]);

  const handleSupportClick = useCallback(() => {
    sendEvent({ type: 'support_click', session_id: getSessionId() });
  }, []);

  /** 새 대화: 진행 중인 답변을 끊고 대화 ID를 새로 발급한다. */
  const handleNewConversation = useCallback(() => {
    if (messagesRef.current.some(m => m.role === 'user')) {
      sendEvent({ type: 'new_conversation', session_id: getSessionId(), trigger: 'new_button' });
    }
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    getSessionId(true);
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* 무시 */ }
    setTyping(null);
    setIsSending(false);
    setMessages([createGreeting()]);
    announce('새 대화를 시작했습니다.');
    window.scrollTo({ top: 0, behavior: 'auto' });
    inputRef.current?.focus();
  }, [announce]);

  return (
    <>
      <Header onNewConversation={handleNewConversation} canReset={hasUserMessage} />

      <main className={styles.content}>
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>

        {messages.map((msg, i) => {
          // 초기 로드 메시지만 순차 등장시키고, 이후 메시지는 즉시 표시(누적 딜레이 방지)
          const style = { animationDelay: i < 5 ? `${0.15 + i * 0.1}s` : '0s' };

          if (msg.type === 'endcard') {
            return (
              <EndCard
                key={msg.id}
                message={msg}
                onAnswer={handleEndCardAnswer}
                onSupportClick={handleSupportClick}
              />
            );
          }
          if (msg.type === 'notice') {
            return <p key={msg.id} className={styles.notice}>{msg.content}</p>;
          }
          return (
            <div key={msg.id}>
              <ChatBubble message={msg} style={style} onFeedback={handleFeedback} onRetry={handleSend} />
              {msg.greeting && !hasUserMessage && (
                <div className={styles.starters} role="group" aria-label="추천 질문">
                  {STARTER_QUESTIONS.map((q) => (
                    <button key={q} type="button" className={styles.starter} onClick={() => handleSend(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {typing && <TypingIndicator phase={typing.phase} startedAt={typing.startedAt} />}
        <div ref={bottomRef} />

        <ChatInput onSend={handleSend} onStop={handleStop} isStreaming={isSending} inputRef={inputRef} />
      </main>
    </>
  );
}
