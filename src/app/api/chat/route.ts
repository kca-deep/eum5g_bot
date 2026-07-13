import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join } from 'path';

const DIFY_DATASET_API_KEY = process.env.DIFY_DATASET_API_KEY || '';
const DIFY_BASE_URL = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
const DIFY_DATASET_ID = process.env.DIFY_DATASET_ID || '';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

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

/** Step 1: Dify Knowledge Base에서 관련 청크 검색 */
async function retrieveChunks(query: string): Promise<DifyRecord[]> {
  if (!DIFY_DATASET_API_KEY || !DIFY_DATASET_ID) return [];

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
          reranking_enable: false,
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
    return [];
  }

  const data = (await res.json()) as DifyRetrieveResponse;
  return data.records || [];
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

  return SYSTEM_PROMPT_TEMPLATE.replace('{context}', context);
}

/** 커스텀 SSE 이벤트 인코딩 */
function sseEncode(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { query, conversation_id, history } = body;

    if (!query) {
      return Response.json({ error: 'query is required' }, { status: 400 });
    }

    // 멀티턴: 클라이언트가 보낸 직전 대화 이력을 검증·정리(최근 6개 = 3턴까지).
    const priorMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = Array.isArray(history)
      ? history
          .filter(
            (m: unknown): m is { role: string; content: string } =>
              !!m &&
              typeof (m as { content?: unknown }).content === 'string' &&
              ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant'),
          )
          .slice(-6)
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      : [];

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Phase 1: 지식 검색 시작 알림
          controller.enqueue(sseEncode({
            event: 'status',
            status: 'searching',
          }));

          const records = await retrieveChunks(query);
          const systemPrompt = buildSystemPrompt(records);

          // Phase 2: 답변 생성 시작 알림
          controller.enqueue(sseEncode({
            event: 'status',
            status: 'generating',
          }));

          // system(현재 질문용 RAG 컨텍스트 포함) → 직전 대화 이력 → 현재 질문
          const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...priorMessages,
            { role: 'user', content: query },
          ];

          console.log(`[Chat] model=${MODEL}, envModel=${process.env.OPENAI_MODEL}, records=${records.length}, history=${priorMessages.length}, promptLen=${systemPrompt.length}`);
          const createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
            model: MODEL,
            messages,
            stream: true,
          };
          // gpt-5 계열 등 일부 모델은 기본값(1) 외 temperature를 거부하므로,
          // OPENAI_TEMPERATURE가 명시된 경우에만 전달한다(예: gpt-4o에서 0.3).
          if (process.env.OPENAI_TEMPERATURE) {
            createParams.temperature = Number(process.env.OPENAI_TEMPERATURE);
          }
          const completion = await openai.chat.completions.create(createParams);

          const sources = records.map(r => ({
            dataset_id: DIFY_DATASET_ID,
            dataset_name: '',
            document_id: r.segment.document?.id || '',
            document_name: r.segment.document?.name || '',
            segment_id: r.segment.id,
            content: r.segment.content,
            score: r.score,
            position: 0,
          }));

          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              controller.enqueue(sseEncode({
                event: 'message',
                answer: delta,
                conversation_id: conversation_id || null,
                message_id: chunk.id,
              }));
            }
          }

          controller.enqueue(sseEncode({
            event: 'message_end',
            conversation_id: conversation_id || null,
            metadata: {
              retrieval_resources: sources,
            },
          }));

          controller.close();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error('[Chat Error]', errMsg);
          controller.enqueue(sseEncode({
            event: 'error',
            message: `오류(model=${MODEL}): ${errMsg}`,
          }));
          controller.close();
        }
      },
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
