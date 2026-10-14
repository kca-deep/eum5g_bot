import { NextRequest } from 'next/server';
import { supabaseHeaders } from '@/lib/telemetry';

/**
 * 매일 1회(Vercel Cron, vercel.json) 외부 서비스가 '사용 중'으로 남도록 가볍게 호출한다.
 *
 * - Dify Cloud는 검색·문서 수정이 없는 지식베이스를 무료 7일·유료 30일 뒤 자동 정리한다
 *   (검색 인덱스 삭제 + 문서 비활성화 → 검색 시 "Collection not found", 답변이 근거 없이 나감).
 *   질문이 없는 날에도 검색 1건을 남기고, 결과가 0건이면 오류 로그로 알린다.
 * - Supabase 무료 프로젝트는 요청이 없으면 일시 중지되므로, 연동돼 있으면 함께 조회한다.
 *
 * Vercel Cron은 CRON_SECRET을 Authorization 헤더로 보낸다. 미설정이면 호출을 받지 않는다.
 */
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 20_000;
const KEEPALIVE_QUERY = '5G 특화망 주파수 할당 절차';

type Ping = { ok: boolean; status?: number; records?: number; skipped?: string; error?: string };

async function pingDify(): Promise<Ping> {
  const key = process.env.DIFY_DATASET_API_KEY;
  const datasetId = process.env.DIFY_DATASET_ID;
  const base = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
  if (!key || !datasetId) return { ok: false, skipped: 'not_configured' };

  try {
    const res = await fetch(`${base}/datasets/${datasetId}/retrieve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: KEEPALIVE_QUERY,
        retrieval_model: {
          search_method: 'semantic_search',
          reranking_enable: false,
          top_k: 1,
          score_threshold_enabled: false,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
    const data = (await res.json()) as { records?: unknown[] };
    const records = data.records?.length ?? 0;
    // 검색은 됐는데 0건이면 문서가 비활성화됐거나 인덱스가 비었다는 신호
    return { ok: records > 0, status: res.status, records };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pingSupabase(): Promise<Ping> {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: true, skipped: 'not_configured' };

  try {
    const res = await fetch(`${url}/rest/v1/chat_turn?select=id&limit=1`, {
      headers: supabaseHeaders(key),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [dify, supabase] = await Promise.all([pingDify(), pingSupabase()]);
  const ok = dify.ok && supabase.ok;
  const summary = JSON.stringify({ dify, supabase });
  if (ok) console.log(`[Keepalive] 정상 ${summary}`);
  else console.error(`[Keepalive] 실패 — Dify 문서 활성 상태·Supabase 연결 확인 필요 ${summary}`);

  return Response.json({ ok, dify, supabase }, { status: ok ? 200 : 502 });
}
