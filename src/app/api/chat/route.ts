import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRateLimiter, clientIp } from '@/lib/rateLimit';
import { TurnLog, asUuid } from '@/lib/telemetry';

const DIFY_DATASET_API_KEY = process.env.DIFY_DATASET_API_KEY || '';
const DIFY_BASE_URL = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
const DIFY_DATASET_ID = process.env.DIFY_DATASET_ID || '';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
// 멀티턴 검색 질의 재작성용 경량 모델(비용·지연 최소화)
const REWRITE_MODEL = process.env.OPENAI_REWRITE_MODEL || 'gpt-4o-mini';
// 추론형 모델(gpt-5 계열)의 추론 강도. 명시한 경우에만 전달한다(미설정 = 모델 기본값).
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT as OpenAI.ReasoningEffort | undefined;

// 공개 API 남용(크레딧 소진) 방지 한도
const MAX_QUERY_LENGTH = 2000;
const MAX_HISTORY_ITEMS = 6;
const MAX_HISTORY_CONTENT_LENGTH = 4000;
const isRateLimited = createRateLimiter(20, 60_000);

// 사용자에게 보여줄 일반화된 오류 문구(내부 모델명·에러 원문은 서버 로그에만 남긴다)
const GENERIC_ERROR_MESSAGE = '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';

// 시스템 프롬프트 템플릿 로드
// Vercel 서버리스: process.cwd()가 소스 디렉토리를 포함하지 않을 수 있으므로 여러 경로 시도
function loadSystemPrompt(): string {
  const paths = [
    join(process.cwd(), 'src', 'prompts', 'system.md'),
    join(__dirname, '..', '..', '..', 'src', 'prompts', 'system.md'),
    join(process.cwd(), '.next', 'server', 'src', 'prompts', 'system.md'),
  ];
  for (const p of paths) {
    try {
      return readFileSync(p, 'utf-8');
    } catch { /* try next */ }
  }
  console.error('[Prompt] system.md를 찾을 수 없습니다. 기본 프롬프트를 사용합니다.');
  return '당신은 KCA 전파통신AX본부 AI특화망사업팀의 AI 어시스턴트입니다. 5G 특화망(이음5G) 가이드라인을 기반으로 답변하세요.\n\n{context}';
}

const SYSTEM_PROMPT_TEMPLATE = loadSystemPrompt();

interface DifySegment {
  id: string;
  content: string;
  document: {
    id: string;
    name: string;
    doc_type: string | null;
  };
}

interface DifyRecord {
  segment: DifySegment;
  score: number;
}

interface DifyRetrieveResponse {
  records: DifyRecord[];
}

type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string };

/** 멀티턴 후속 질문("그럼 비용은?")은 그 자체로는 검색이 되지 않으므로,
 * 직전 대화 맥락을 반영한 독립형 검색 질의로 재작성한다. 실패 시 원 질의를 그대로 사용. */
async function rewriteSearchQuery(query: string, priorMessages: ChatHistoryMessage[]): Promise<string> {
  if (priorMessages.length === 0) return query;
  try {
    const historyText = priorMessages
      .map((m) => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content.slice(0, 500)}`)
      .join('\n');
    const res = await openai.chat.completions.create({
      model: REWRITE_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            '당신은 지식베이스 검색 질의 재작성기입니다. 사용자의 마지막 질문을 이전 대화 없이도 검색 가능한 독립적인 한국어 질의 한 문장으로 재작성하세요.',
            '',
            '규칙:',
            '- 마지막 질문의 대명사·생략된 주어("그럼", "그건", "거기")를 이전 대화에 나온 구체적 주제·키워드로 반드시 치환하세요.',
            '- 이전 대화의 핵심 주제(예: 5G 특화망, 주파수 할당)를 질의에 반드시 포함하세요.',
            '- 재작성한 질의만 출력하세요. 설명을 붙이지 마세요.',
            '',
            '예시:',
            '[이전 대화] 사용자: 5G 특화망 유형 알려줘 → [마지막 질문] 그럼 비용은? → 출력: 5G 특화망 유형별 구축 비용',
          ].join('\n'),
        },
        { role: 'user', content: `[이전 대화]\n${historyText}\n\n[마지막 질문]\n${query}` },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    const rewritten = res.choices[0]?.message?.content?.trim();
    return rewritten || query;
  } catch (err) {
    console.error('[Rewrite] 질의 재작성 실패, 원 질의로 검색:', err instanceof Error ? err.message : err);
    return query;
  }
}

/** Step 1: Dify Knowledge Base에서 관련 청크 검색.
 * ok=false는 검색 자체가 실패한 경우로, '관련 문서 없음(ok=true, 0건)'과 구분해 기록한다. */
async function retrieveChunks(query: string): Promise<{ records: DifyRecord[]; ok: boolean }> {
  if (!DIFY_DATASET_API_KEY || !DIFY_DATASET_ID) return { records: [], ok: false };

  const res = await fetch(
    `${DIFY_BASE_URL}/datasets/${DIFY_DATASET_ID}/retrieve`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_DATASET_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        retrieval_model: {
          search_method: 'semantic_search',
          reranking_enable: true,
          top_k: 6,
          // 유사도가 낮은 노이즈 청크 주입을 막아 잘못된 인용을 줄임.
          // 검색 품질에 따라 RAG_SCORE_THRESHOLD(0~1)로 조정 가능.
          score_threshold_enabled: true,
          score_threshold: Number(process.env.RAG_SCORE_THRESHOLD) || 0.4,
        },
      }),
    },
  );

  if (!res.ok) {
    console.error(`[RAG Error] Dify 검색 실패: ${res.status} ${res.statusText}`);
    try {
      const err = await res.json();
      console.error('[RAG Error] 상세:', JSON.stringify(err));
    } catch { /* ignore */ }
    return { records: [], ok: false };
  }

  const data = (await res.json()) as DifyRetrieveResponse;
  return { records: data.records || [], ok: true };
}

/** 문서 파일명을 사용자에게 노출해도 되는 자료 유형으로 매핑.
 * 파일명(구축사례.md 등)이 답변에 새어나가지 않도록 카테고리 라벨만 모델에 전달한다. */
function docCategory(name: string): string {
  if (/구축\s*사례/.test(name)) return '구축사례 DB';
  if (/문의|응답|로그/.test(name)) return '문의응답 사례';
  return '5G 특화망 가이드라인';
}

/** 참조 청크에서 개인정보(이메일)와 내부 페이지 마커를 제거.
 * 모델이 이메일·페이지 번호를 그대로 복창하는 것을 원천 차단한다. */
function sanitizeContent(content: string): string {
  return content
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[이메일 생략]')
    .replace(/\s*\[원본 p\.\d+\]/g, '');
}

/** Step 2: 검색된 청크로 시스템 프롬프트 조합 */
function buildSystemPrompt(records: DifyRecord[]): string {
  if (records.length === 0) {
    return SYSTEM_PROMPT_TEMPLATE.replace(
      '{context}',
      '(관련 참조 문서가 검색되지 않았습니다)',
    );
  }

  const context = records
    .map((r, i) => {
      const category = docCategory(r.segment.document?.name || '');
      // 파일명·유사도·페이지는 사용자 답변에 새어나가므로 라벨에 넣지 않는다.
      return `### 참조 ${i + 1} (자료 유형: ${category})\n${sanitizeContent(r.segment.content)}`;
    })
    .join('\n\n');

  // 디버깅: 검색된 chunk의 페이지 정보 확인 (RAG_DEBUG=1 일 때만 — 프로덕션에서 질의/문서 내용 노출 방지)
  if (process.env.RAG_DEBUG === '1') {
    console.log('[RAG Debug] 검색된 참조 수:', records.length);
    records.forEach((r, i) => {
      const pages = r.segment.content.match(/\[원본 p\.(\d+)\]/g);
      console.log(`[RAG Debug] 참조 ${i + 1}: ${r.segment.document?.name || '?'}, 유사도: ${Math.round(r.score * 100)}%, 페이지 마커: ${pages ? pages.join(', ') : '없음'}, 내용 미리보기: ${r.segment.content.substring(0, 100)}...`);
    });
  }

  // 함수형 치환: context에 $&, $' 같은 특수 치환 패턴이 있어도 원문 그대로 삽입되도록 한다.
  return SYSTEM_PROMPT_TEMPLATE.replace('{context}', () => context);
}

/** 커스텀 SSE 이벤트 인코딩 */
function sseEncode(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** 오류를 처리 기록용 코드로 분류(원문 메시지는 서버 로그에만 남긴다) */
function errorCode(err: unknown): string {
  if (err instanceof OpenAI.APIError) return `openai_${err.status ?? 'unknown'}`;
  if (err instanceof Error && err.name === 'AbortError') return 'aborted';
  return 'internal';
}

export async function POST(req: NextRequest) {
  // 접수시각은 요청을 받은 즉시 잡는다(처리 후 기록하면 접수·완료 시각이 같아진다).
  const receivedAt = new Date();
  try {
    if (isRateLimited(clientIp(req.headers))) {
      return Response.json(
        { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
        { status: 429 },
      );
    }

    const body = await req.json();
    const { query, conversation_id, history, session_id, turn_index } = body;

    // 멀티턴: 클라이언트가 보낸 직전 대화 이력을 검증·정리(최근 6개 = 3턴, 항목당 길이 제한).
    const priorMessages: ChatHistoryMessage[] = Array.isArray(history)
      ? history
          .filter(
            (m: unknown): m is { role: string; content: string } =>
              !!m &&
              typeof (m as { content?: unknown }).content === 'string' &&
              ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant'),
          )
          .slice(-MAX_HISTORY_ITEMS)
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content.slice(0, MAX_HISTORY_CONTENT_LENGTH),
          }))
      : [];

    const turn = new TurnLog({
      receivedAt,
      sessionId: asUuid(session_id),
      turnIndex: Number.isInteger(turn_index) && turn_index >= 0 ? turn_index : null,
      historyCount: priorMessages.length,
    });

    if (!query || typeof query !== 'string') {
      turn.finish('rejected', { errorCode: 'invalid_query' });
      return Response.json({ error: 'query is required' }, { status: 400 });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      turn.finish('rejected', { errorCode: 'query_too_long' });
      return Response.json(
        { error: `질문은 ${MAX_QUERY_LENGTH}자 이내로 입력해 주세요.` },
        { status: 400 },
      );
    }

    // 사용자가 중지하거나 연결이 끊기면 생성 모델 호출도 끊어 비용을 막고, '중지'로 기록한다.
    const llmAbort = new AbortController();
    let cancelled = false;
    let answer = '';
    const stop = () => {
      if (cancelled) return;
      cancelled = true;
      llmAbort.abort();
      turn.finish('stopped', { query, answer });
    };
    req.signal.addEventListener('abort', stop);

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          if (!cancelled) controller.enqueue(sseEncode(event));
        };
        try {
          // 처리ID를 먼저 알려 클라이언트 실측·피드백을 같은 기록에 묶는다.
          send({ event: 'meta', turn_id: turn.id });

          // Phase 1: 지식 검색 시작 알림
          send({ event: 'status', status: 'searching' });

          // 후속 질문이면 대화 맥락을 반영한 독립형 질의로 재작성 후 검색
          let searchQuery = query;
          if (priorMessages.length > 0) {
            turn.mark('rewrite_started_at');
            searchQuery = await rewriteSearchQuery(query, priorMessages);
            turn.mark('rewrite_ended_at');
            turn.set({ rewrite_model: REWRITE_MODEL, rewritten_query: searchQuery });
            if (process.env.RAG_DEBUG === '1' && searchQuery !== query) {
              console.log(`[Rewrite] "${query}" → "${searchQuery}"`);
            }
          }

          turn.mark('retrieval_started_at');
          const { records, ok: retrievalOk } = await retrieveChunks(searchQuery);
          turn.mark('retrieval_ended_at');
          const categories = [...new Set(records.map((r) => docCategory(r.segment.document?.name || '')))];
          turn.set({
            retrieval_ok: retrievalOk,
            records_count: records.length,
            top_score: records.length > 0 ? Math.max(...records.map((r) => r.score)) : null,
            doc_categories: categories,
          });
          if (cancelled) return;

          // 근거 표시는 모델 문장이 아니라 검색 결과로 정한다. 공개 라벨만 보내고 파일명·원문은 보내지 않는다.
          send({ event: 'context', grounded: records.length > 0, categories });

          const systemPrompt = buildSystemPrompt(records);

          // Phase 2: 답변 생성 시작 알림
          send({ event: 'status', status: 'generating' });

          // system(현재 질문용 RAG 컨텍스트 포함) → 직전 대화 이력 → 현재 질문
          const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...priorMessages,
            { role: 'user', content: query },
          ];

          console.log(`[Chat] turn=${turn.id}, model=${MODEL}, records=${records.length}, history=${priorMessages.length}, promptLen=${systemPrompt.length}`);
          const createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
            model: MODEL,
            messages,
            stream: true,
            // 마지막 청크로 토큰 사용량을 받아 처리 기록에 남긴다.
            stream_options: { include_usage: true },
          };
          // gpt-5 계열 등 일부 모델은 기본값(1) 외 temperature를 거부하므로,
          // OPENAI_TEMPERATURE가 명시된 경우에만 전달한다(예: gpt-4o에서 0.3).
          if (process.env.OPENAI_TEMPERATURE) {
            createParams.temperature = Number(process.env.OPENAI_TEMPERATURE);
          }
          if (REASONING_EFFORT) {
            createParams.reasoning_effort = REASONING_EFFORT;
          }
          turn.set({ model: MODEL, reasoning_effort: REASONING_EFFORT || null });

          turn.mark('llm_started_at');
          const completion = await openai.chat.completions.create(createParams, { signal: llmAbort.signal });

          for await (const chunk of completion) {
            if (chunk.usage) {
              turn.set({
                prompt_tokens: chunk.usage.prompt_tokens,
                completion_tokens: chunk.usage.completion_tokens,
                reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? null,
              });
            }
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              if (!turn.has('first_token_at')) turn.mark('first_token_at');
              answer += delta;
              send({
                event: 'message',
                answer: delta,
                conversation_id: conversation_id || null,
                message_id: chunk.id,
              });
            }
          }
          turn.mark('llm_ended_at');

          // 검색 원문·파일명은 클라이언트로 내려보내지 않는다(개인정보·내부정보 유출 방지).
          send({
            event: 'message_end',
            conversation_id: conversation_id || null,
            metadata: {},
          });

          turn.mark('completed_at');
          if (!cancelled) controller.close();
          turn.finish('completed', { query, answer });
        } catch (err) {
          // 중지로 생성 호출이 끊긴 경우는 stop()에서 이미 기록했다.
          if (cancelled) return;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error('[Chat Error]', `turn=${turn.id}`, errMsg);
          turn.finish('error', { query, answer, errorCode: errorCode(err) });
          send({
            event: 'error',
            message: GENERIC_ERROR_MESSAGE,
          });
          controller.close();
        } finally {
          req.signal.removeEventListener('abort', stop);
        }
      },
      cancel: stop,
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
