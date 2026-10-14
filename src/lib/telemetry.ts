import { waitUntil } from '@vercel/functions';

/** 처리 기록(chat_turn·chat_event)을 Supabase(PostgREST)에 남긴다.
 * - SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY가 없으면 아무것도 하지 않는다(로컬 개발·미연동 배포).
 * - 쓰기는 waitUntil로 응답 뒤에 처리하고, 실패해도 답변에는 영향을 주지 않는다. */
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const telemetryEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/** 저장 전 개인정보 마스킹: 이메일·주민등록번호·전화번호 */
export function maskPII(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[이메일]')
    .replace(/\b\d{6}\s?-\s?[1-4]\d{6}\b/g, '[주민번호]')
    .replace(/\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, '[전화번호]');
}

/** 답변에 지원센터·담당 부서 문의 안내가 들어갔는지(안내 문구 위치 변경 효과 측정용) */
const SUPPORT_PHRASE_RE =
  /(지원\s*센터|사업팀|담당\s*부서)[^.\n]{0,60}(문의|상담|연락)|(문의|상담|연락)[^.\n]{0,60}(지원\s*센터|사업팀|담당\s*부서)/;

export function hasSupportPhrase(text: string): boolean {
  return SUPPORT_PHRASE_RE.test(text);
}

export type TurnStatus = 'completed' | 'stopped' | 'error' | 'rejected';

type TimeField =
  | 'rewrite_started_at' | 'rewrite_ended_at'
  | 'retrieval_started_at' | 'retrieval_ended_at'
  | 'llm_started_at' | 'first_token_at' | 'llm_ended_at'
  | 'completed_at';

interface TurnRow {
  id: string;
  session_id: string | null;
  turn_index: number | null;
  history_count: number | null;
  received_at: string;
  status?: TurnStatus;
  error_code?: string | null;
  model?: string;
  rewrite_model?: string | null;
  reasoning_effort?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  reasoning_tokens?: number | null;
  retrieval_ok?: boolean;
  records_count?: number;
  top_score?: number | null;
  doc_categories?: string[];
  query_text?: string | null;
  rewritten_query?: string | null;
  answer_text?: string | null;
  has_support_phrase?: boolean | null;
}

/** 질문 1건의 처리 기록. 단계마다 mark()로 시각을 남기고 finish()에서 한 번만 저장한다. */
export class TurnLog {
  readonly id = crypto.randomUUID();
  private row: TurnRow & Partial<Record<TimeField, string>>;
  private finished = false;

  constructor(init: { receivedAt: Date; sessionId: string | null; turnIndex: number | null; historyCount: number }) {
    this.row = {
      id: this.id,
      session_id: init.sessionId,
      turn_index: init.turnIndex,
      history_count: init.historyCount,
      received_at: init.receivedAt.toISOString(),
    };
  }

  mark(field: TimeField): void {
    this.row[field] = new Date().toISOString();
  }

  has(field: TimeField): boolean {
    return Boolean(this.row[field]);
  }

  set(fields: Partial<TurnRow>): void {
    Object.assign(this.row, fields);
  }

  /** 상태를 확정하고 저장한다. 중지·오류가 겹쳐 여러 번 불려도 처음 한 번만 기록한다. */
  finish(status: TurnStatus, opts: { query?: string; answer?: string; errorCode?: string } = {}): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.row.completed_at) this.mark('completed_at');
    this.row.status = status;
    if (opts.errorCode) this.row.error_code = opts.errorCode;
    if (opts.query) this.row.query_text = maskPII(opts.query);
    if (opts.answer) {
      this.row.answer_text = maskPII(opts.answer);
      this.row.has_support_phrase = hasSupportPhrase(opts.answer);
    }
    if (this.row.rewritten_query) this.row.rewritten_query = maskPII(this.row.rewritten_query);
    persist('chat_turn', this.row);
  }
}

export const EVENT_TYPES = [
  'client_timing', 'feedback',
  'end_card_shown', 'resolved_yes', 'resolved_no', 'support_click', 'new_conversation',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function logEvent(event: {
  session_id: string | null;
  turn_id: string | null;
  type: EventType;
  trigger?: string | null;
  value?: Record<string, unknown> | null;
}): void {
  persist('chat_event', event);
}

function persist(table: 'chat_turn' | 'chat_event', row: object): void {
  if (!telemetryEnabled) return;
  const task = fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  })
    .then(async (res) => {
      if (!res.ok) {
        console.error(`[Telemetry] ${table} 저장 실패: ${res.status} ${await res.text().catch(() => '')}`);
      }
    })
    .catch((err) => {
      console.error(`[Telemetry] ${table} 저장 오류:`, err instanceof Error ? err.message : err);
    });
  waitUntil(task);
}
