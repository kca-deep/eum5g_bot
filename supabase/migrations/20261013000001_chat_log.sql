-- ==============================================================================
-- 이음5G AI 챗봇 처리 기록 + AI 성과측정 표준 로그(10열) 뷰
-- 규격: 「AI 도입 전후 효과 분석 체계 개선(안)」 붙임2 표준 로그 출력 컬럼
--  - chat_turn   : 질문 1건 = 1행. 서버가 처리 직후 한 번 기록하고 이후 수정하지 않는다.
--  - chat_event  : 처리 뒤에 생기는 신호(브라우저 실측, 피드백, 대화 종료 카드). 추가만 한다.
--  - chat_review : 월 표본 검수 결과. 담당자가 입력한다.
--  - ai_performance_log : 위 셋을 표준 10열 + 원시_ 열로 보여주는 뷰 (ict-portal과 같은 컬럼명)
-- 접근: 세 테이블 모두 RLS를 켜고 정책을 두지 않는다 → 서버의 service_role 키만 읽고 쓴다.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.chat_turn (
  id                    uuid PRIMARY KEY,                -- 처리ID (서버가 접수 즉시 생성)
  session_id            uuid,                            -- 브라우저가 만든 무작위 대화 ID (IP 미저장)
  turn_index            integer,                         -- 대화 안에서 몇 번째 질문인지 (0부터)
  history_count         integer,                         -- 함께 보낸 직전 대화 메시지 수

  -- 시각: 처리 중 단계마다 기록 (처리 후 한 번만 남기면 접수·AI·완료 시각이 같아지는 문제 방지)
  received_at           timestamptz NOT NULL,            -- 서버가 요청을 받은 시각
  rewrite_started_at    timestamptz,                     -- 후속 질문 검색어 재작성 시작
  rewrite_ended_at      timestamptz,
  retrieval_started_at  timestamptz,                     -- Dify 지식베이스 검색 시작
  retrieval_ended_at    timestamptz,
  llm_started_at        timestamptz,                     -- 생성 모델 호출 시작
  first_token_at        timestamptz,                     -- 첫 글자 수신
  llm_ended_at          timestamptz,                     -- 마지막 글자 수신
  completed_at          timestamptz,                     -- 스트림 종료(답변 전달 완료) 또는 중지·오류 시각

  -- 처리 결과 (기술 상태값: 표준 로그의 결과코드에는 쓰지 않는다)
  status                text NOT NULL CHECK (status IN ('completed', 'stopped', 'error', 'rejected')),
  error_code            text,

  -- 모델·사용량
  model                 text,
  rewrite_model         text,
  reasoning_effort      text,
  prompt_tokens         integer,
  completion_tokens     integer,
  reasoning_tokens      integer,

  -- 검색 근거
  retrieval_ok          boolean,                         -- Dify 호출 성공 여부 (실패와 '결과 없음' 구분)
  records_count         integer,
  top_score             real,
  doc_categories        text[],                          -- 가이드라인 / 구축사례 DB / 문의응답 사례

  -- 원문 (정확도 표본 검수용, 이메일·전화번호 마스킹 후 저장, 표준 로그 CSV에는 넣지 않는다)
  query_text            text,
  rewritten_query       text,
  answer_text           text,
  has_support_phrase    boolean,                         -- 답변에 지원센터 문의 안내가 들어갔는지

  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_turn_received_at_idx ON public.chat_turn (received_at DESC);
CREATE INDEX IF NOT EXISTS chat_turn_session_idx     ON public.chat_turn (session_id);
CREATE INDEX IF NOT EXISTS chat_turn_status_idx      ON public.chat_turn (status);

CREATE TABLE IF NOT EXISTS public.chat_event (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid,
  turn_id     uuid,                                      -- 브라우저 신호가 서버 기록보다 먼저 올 수 있어 FK를 두지 않는다
  type        text NOT NULL CHECK (type IN (
                'client_timing',                         -- 브라우저 실측 {first_char_ms, done_ms, outcome}
                'feedback',                              -- 답변별 평가 {score: 1|-1, reason}
                'end_card_shown', 'resolved_yes', 'resolved_no', 'support_click', 'new_conversation'
              )),
  trigger     text,                                      -- idle / closing_phrase / new_button / repeated_unresolved
  value       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_event_turn_idx    ON public.chat_event (turn_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_event_session_idx ON public.chat_event (session_id, type);

CREATE TABLE IF NOT EXISTS public.chat_review (
  turn_id              uuid PRIMARY KEY REFERENCES public.chat_turn (id) ON DELETE CASCADE,
  review_started_at    timestamptz,
  review_completed_at  timestamptz,
  reviewer             text,
  verdict              text CHECK (verdict IN ('정확', '부분', '부정확')),  -- 표준 로그 '정답값'
  result_code          text CHECK (result_code ~ '^R[1-5]$'),             -- 공식 코드표(R1~R5)에 따라 입력
  comparison_value     text,                                              -- 기준선 행에만 입력
  note                 text                                               -- 검수 메모 (CSV 제외)
);

ALTER TABLE public.chat_turn   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_event  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_review ENABLE ROW LEVEL SECURITY;

-- 표준 로그 뷰: 앞 10열은 붙임2 순서 고정, 그 뒤는 raw_ 보조 증빙 열
CREATE OR REPLACE VIEW public.ai_performance_log
WITH (security_invoker = true) AS
WITH feedback AS (
  SELECT DISTINCT ON (turn_id)
         turn_id,
         (value ->> 'score')::smallint AS score,
         value ->> 'reason'            AS reason
    FROM public.chat_event
   WHERE type = 'feedback' AND turn_id IS NOT NULL
   ORDER BY turn_id, created_at DESC
),
client_timing AS (
  SELECT DISTINCT ON (turn_id)
         turn_id,
         (value ->> 'first_char_ms')::integer AS first_char_ms,
         (value ->> 'done_ms')::integer       AS done_ms
    FROM public.chat_event
   WHERE type = 'client_timing' AND turn_id IS NOT NULL
   ORDER BY turn_id, created_at DESC
),
session_signal AS (
  SELECT session_id,
         bool_or(type = 'resolved_yes')  AS resolved_yes,
         bool_or(type = 'resolved_no')   AS resolved_no,
         bool_or(type = 'support_click') AS support_click
    FROM public.chat_event
   WHERE session_id IS NOT NULL
   GROUP BY session_id
)
SELECT
  -- [표준 10열]
  t.id::text                                                   AS process_id,         -- 1. 처리ID
  t.received_at                                                AS accepted_at,        -- 2. 접수시각
  COALESCE(t.rewrite_started_at, t.retrieval_started_at)       AS ai_started_at,      -- 3. AI시작시각 (첫 AI 호출)
  t.llm_ended_at                                               AS ai_ended_at,        -- 4. AI종료시각
  r.review_started_at,                                                                -- 5. 검수시작시각
  t.completed_at,                                                                     -- 6. 완료시각 (답변 전달 완료)
  r.result_code,                                                                      -- 7. 결과코드
  CASE WHEN t.records_count IS NULL   THEN NULL                -- 검색 전 거부·중지
       WHEN t.retrieval_ok IS FALSE  THEN 'RETRIEVAL_FAILED'    -- 지식베이스 호출 실패
       WHEN t.records_count > 0      THEN 'KB:' || array_to_string(t.doc_categories, '|')
       ELSE 'NO_CONTEXT' END                                   AS ai_decision_value,  -- 8. AI판정값 (근거 유형 코드)
  r.verdict                                                    AS ground_truth,       -- 9. 정답값 (표본 검수 판정)
  r.comparison_value,                                                                 -- 10. 비교값

  -- [원시_ 보조 증빙 열]
  round(extract(epoch FROM t.completed_at - t.received_at) * 1000)::integer         AS raw_total_ms,
  round(extract(epoch FROM t.first_token_at - t.received_at) * 1000)::integer       AS raw_first_response_ms,
  round(extract(epoch FROM t.rewrite_ended_at - t.rewrite_started_at) * 1000)::integer     AS raw_rewrite_ms,
  round(extract(epoch FROM t.retrieval_ended_at - t.retrieval_started_at) * 1000)::integer AS raw_retrieval_ms,
  round(extract(epoch FROM t.first_token_at - t.llm_started_at) * 1000)::integer    AS raw_llm_wait_ms,
  round(extract(epoch FROM t.llm_ended_at - t.llm_started_at) * 1000)::integer      AS raw_llm_ms,
  ct.first_char_ms                                             AS raw_client_first_char_ms,
  ct.done_ms                                                   AS raw_client_done_ms,
  t.status                                                     AS raw_status,
  t.error_code                                                 AS raw_error_code,
  t.retrieval_ok                                               AS raw_retrieval_ok,
  t.records_count                                              AS raw_records_count,
  t.top_score                                                  AS raw_top_score,
  t.model                                                      AS raw_model,
  t.reasoning_effort                                           AS raw_reasoning_effort,
  t.prompt_tokens                                              AS raw_prompt_tokens,
  t.completion_tokens                                          AS raw_completion_tokens,
  t.reasoning_tokens                                           AS raw_reasoning_tokens,
  t.turn_index                                                 AS raw_turn_index,
  t.has_support_phrase                                         AS raw_has_support_phrase,
  fb.score                                                     AS raw_feedback,
  fb.reason                                                    AS raw_feedback_reason,
  CASE WHEN ss.resolved_yes THEN true
       WHEN ss.resolved_no  THEN false END                     AS raw_session_resolved,
  COALESCE(ss.support_click, false)                            AS raw_support_click,
  r.review_completed_at                                        AS raw_review_completed_at
FROM public.chat_turn t
LEFT JOIN public.chat_review   r  ON r.turn_id  = t.id
LEFT JOIN feedback             fb ON fb.turn_id = t.id
LEFT JOIN client_timing        ct ON ct.turn_id = t.id
LEFT JOIN session_signal       ss ON ss.session_id = t.session_id;

COMMENT ON VIEW public.ai_performance_log IS 'AI 성과측정 표준 로그 (붙임2 10열 + raw_ 보조열). 원문·세션ID는 포함하지 않는다.';

-- 보존 기간 1년: 매월 산출 직후 실행 (pg_cron을 쓰면 월 1회 예약)
CREATE OR REPLACE FUNCTION public.purge_chat_log(retention interval DEFAULT interval '1 year')
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  DELETE FROM public.chat_event WHERE created_at  < now() - retention;
  DELETE FROM public.chat_turn  WHERE received_at < now() - retention;
$$;

-- 권한: 기록은 서버 키(service_role = Secret key)로만 읽고 쓴다.
-- RLS(정책 없음)로 이미 막혀 있지만, 공개 키(anon·authenticated)에는 테이블·뷰·함수 권한 자체를 주지 않는다.
-- 프로젝트에서 'Data API 자동 노출'을 꺼 두었어도 서버 키가 동작하도록 service_role 권한은 명시한다.
REVOKE ALL ON public.chat_turn, public.chat_event, public.chat_review, public.ai_performance_log FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_chat_log(interval) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_turn, public.chat_event, public.chat_review TO service_role;
GRANT SELECT ON public.ai_performance_log TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_chat_log(interval) TO service_role;
