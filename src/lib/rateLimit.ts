/** IP별 슬라이딩 윈도우 요청 제한.
 * Fluid Compute 인스턴스 단위 메모리라 완전한 차단은 아니지만,
 * 스크립트성 남용으로 OpenAI 크레딧이 소진되거나 로그가 오염되는 것을 막는 1차 방어선이다. */
export function createRateLimiter(maxRequests: number, windowMs: number) {
  const hits = new Map<string, number[]>();

  return function isRateLimited(key: string): boolean {
    const now = Date.now();
    if (hits.size > 5000) {
      for (const [k, times] of hits) {
        if (times.every((t) => now - t >= windowMs)) hits.delete(k);
      }
    }
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= maxRequests) {
      hits.set(key, recent);
      return true;
    }
    recent.push(now);
    hits.set(key, recent);
    return false;
  };
}

export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}
