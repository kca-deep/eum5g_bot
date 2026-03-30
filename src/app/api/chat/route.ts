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
  return '당신은 KCA 이음5G사업팀의 AI 어시스턴트입니다. 5G 특화망 가이드라인을 기반으로 답변하세요.\n\n{context}';
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
          top_k: 8,
          score_threshold_enabled: false,
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
      const doc = r.segment.document?.name || '알 수 없는 문서';
      const score = Math.round(r.score * 100);

      // chunk 내 [원본 p.XX] 마커에서 페이지 번호 추출
      const pageMatches = r.segment.content.match(/\[원본 p\.(\d+)\]/g);
      let pageInfo = '';
      if (pageMatches && pageMatches.length > 0) {
        const pages = pageMatches
          .map(m => parseInt(m.match(/\d+/)![0], 10))
          .sort((a, b) => a - b);
        const unique = [...new Set(pages)];
        if (unique.length === 1) {
          pageInfo = `, 원본 페이지: p.${unique[0]}`;
        } else {
          const min = unique[0];
          const max = unique[unique.length - 1];
          // 연속 범위면 p.XX~YY, 아니면 나열
          if (max - min === unique.length - 1) {
            pageInfo = `, 원본 페이지: p.${min}~${max}`;
          } else {
            pageInfo = `, 원본 페이지: p.${unique.join(', p.')}`;
          }
        }
      }

      return `### 참조 ${i + 1} (${doc}, 유사도: ${score}%${pageInfo})\n${r.segment.content}`;
    })
    .join('\n\n');

  // 디버깅: 검색된 chunk의 페이지 정보 확인
  console.log('[RAG Debug] 검색된 참조 수:', records.length);
  records.forEach((r, i) => {
    const pages = r.segment.content.match(/\[원본 p\.(\d+)\]/g);
    console.log(`[RAG Debug] 참조 ${i + 1}: ${r.segment.document?.name || '?'}, 유사도: ${Math.round(r.score * 100)}%, 페이지 마커: ${pages ? pages.join(', ') : '없음'}, 내용 미리보기: ${r.segment.content.substring(0, 100)}...`);
  });

  return SYSTEM_PROMPT_TEMPLATE.replace('{context}', context);
}

/** 커스텀 SSE 이벤트 인코딩 */
function sseEncode(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { query, conversation_id } = body;

    if (!query) {
      return Response.json({ error: 'query is required' }, { status: 400 });
    }

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

          const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query },
          ];

          console.log(`[Chat] model=${MODEL}, envModel=${process.env.OPENAI_MODEL}, records=${records.length}, promptLen=${systemPrompt.length}`);
          const completion = await openai.chat.completions.create({
            model: MODEL,
            messages,
            stream: true,
          });

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
