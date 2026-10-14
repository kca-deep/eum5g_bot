// Dify RAG + OpenAI Streaming types
export type TypingPhase = 'searching' | 'generating';

export interface DifyStreamEvent {
  event: 'meta' | 'context' | 'message' | 'message_end' | 'message_replace' | 'error' | 'ping' | 'status';
  /** 서버 처리ID(meta 이벤트). 브라우저 실측·피드백을 같은 처리 기록에 묶는다. */
  turn_id?: string;
  /** 지식베이스 검색 결과(context 이벤트): 근거 문서가 있었는지와 자료 유형 라벨 */
  grounded?: boolean;
  categories?: string[];
  task_id?: string;
  message_id?: string;
  conversation_id?: string;
  answer?: string;
  created_at?: number;
  metadata?: {
    usage?: Record<string, number>;
  };
  code?: string;
  message?: string;
  status?: number | TypingPhase;
}

export type EndCardTrigger = 'idle' | 'closing_phrase' | 'repeated_unresolved';

export interface ChatMessage {
  id: string;
  role: 'ai' | 'user';
  content: string;
  timestamp: string;
  /** text: 일반 말풍선 · notice: 중지 등 짧은 상태 안내 · error: 재시도 가능한 오류 · endcard: 대화 종료 카드 */
  type: 'text' | 'notice' | 'error' | 'endcard';
  isStreaming?: boolean;
  /** AI 답변의 서버 처리ID */
  turnId?: string;
  /** 첫 인사말(복사·평가 대상 아님, 시작 질문 칩 표시) */
  greeting?: boolean;
  /** 서버 검색 결과 기준 근거 표시 */
  grounding?: { grounded: boolean; categories: string[] };
  feedback?: 1 | -1;
  feedbackReason?: FeedbackReason;
  /** 사용자가 답변 도중 중지 */
  stopped?: boolean;
  /** 답변 도중 오류로 끊김 */
  interrupted?: boolean;
  /** 오류 말풍선의 '다시 시도'가 보낼 질문 */
  retryText?: string;
  endCard?: { trigger: EndCardTrigger; state: 'asking' | 'resolved' | 'unresolved' };
}

export type FeedbackReason = 'wrong' | 'off_topic' | 'too_long' | 'other';
