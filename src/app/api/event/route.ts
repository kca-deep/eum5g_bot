import { NextRequest } from 'next/server';
import { createRateLimiter, clientIp } from '@/lib/rateLimit';
import { EVENT_TYPES, type EventType, asUuid, logEvent } from '@/lib/telemetry';

// 브라우저 신호(실측 시간·피드백·대화 종료 카드)는 질문보다 잦으므로 한도를 넉넉히 둔다.
const isRateLimited = createRateLimiter(60, 60_000);

const TRIGGERS = new Set(['idle', 'closing_phrase', 'new_button', 'repeated_unresolved']);
const FEEDBACK_REASONS = new Set(['wrong', 'off_topic', 'too_long', 'other']);
const TIMING_OUTCOMES = new Set(['completed', 'stopped', 'error', 'superseded']);

/** 측정값은 0~10분 범위의 정수만 받는다(조작·오류값이 집계에 섞이지 않도록). */
function asDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 600_000
    ? Math.round(value)
    : null;
}

/** 이벤트 종류별로 허용한 필드만 남긴다. 자유 서술 텍스트는 받지 않는다. */
function sanitizeValue(type: EventType, value: unknown): Record<string, unknown> | null | undefined {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  switch (type) {
    case 'client_timing':
      return {
        first_char_ms: asDuration(v.first_char_ms),
        done_ms: asDuration(v.done_ms),
        outcome: TIMING_OUTCOMES.has(v.outcome as string) ? v.outcome : null,
      };
    case 'feedback':
      if (v.score !== 1 && v.score !== -1) return undefined;
      return {
        score: v.score,
        reason: FEEDBACK_REASONS.has(v.reason as string) ? v.reason : null,
      };
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  if (isRateLimited(clientIp(req.headers))) {
    return new Response(null, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  const type = body.type as EventType;
  if (!EVENT_TYPES.includes(type)) return new Response(null, { status: 400 });

  const sessionId = asUuid(body.session_id);
  const turnId = asUuid(body.turn_id);
  // 답변 단위 신호는 처리ID가, 대화 단위 신호는 대화 ID가 있어야 집계에 묶인다.
  if ((type === 'client_timing' || type === 'feedback') ? !turnId : !sessionId) {
    return new Response(null, { status: 400 });
  }

  const value = sanitizeValue(type, body.value);
  if (value === undefined) return new Response(null, { status: 400 });

  logEvent({
    session_id: sessionId,
    turn_id: turnId,
    type,
    trigger: TRIGGERS.has(body.trigger as string) ? (body.trigger as string) : null,
    value,
  });

  return new Response(null, { status: 204 });
}
