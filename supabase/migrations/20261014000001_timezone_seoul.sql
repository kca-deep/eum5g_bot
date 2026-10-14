-- 대시보드(Table Editor·SQL Editor)와 API 응답의 시각을 서울 기준(+09)으로 표시한다.
-- 시각 칸은 모두 timestamptz(시점 자체)라 저장값은 바뀌지 않고, 표시와 날짜 경계(일별 집계)만 서울 기준이 된다.
-- 새로 맺는 접속부터 적용된다.
ALTER DATABASE postgres SET timezone TO 'Asia/Seoul';
