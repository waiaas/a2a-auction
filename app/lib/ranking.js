/**
 * 후보 순위 계산 (순수 함수).
 *
 * **서버와 브라우저가 같은 파일을 쓴다.** 슬라이더는 손을 움직이는 즉시 순위가 바뀌어야 해서
 * 브라우저에서 계산하고, 실제 구매는 서버가 같은 계산으로 1위를 확정한다. 두 곳에 같은 식을
 * 복제하면 화면의 1위와 실제로 산 것이 언젠가 어긋난다 — 그래서 파일 IO가 없는 순수 계산만
 * 여기 두고, 파일을 읽는 쪽(`scoring.js`)이 이것을 감싼다.
 */

/** 슬라이더 기본값. 가격과 품질을 반반으로 두면 첫 화면에서 최저가가 1위로 잡힌다. */
export const DEFAULT_PRICE_WEIGHT = 0.5;

/** 품질 점수에서 샘플 채점이 차지하는 비중. 나머지는 평점 몫이다. */
const SAMPLE_WEIGHT = 0.7;

/** 100점 만점 점수들 → 5점 만점 평점. 소수 둘째 자리까지 남겨야 한 건의 변화가 보인다. */
export function ratingOf(scores) {
  if (!scores?.length) return null;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.round((avg / 20) * 100) / 100;
}

/**
 * 후보를 가중치로 정렬한다.
 *
 * **가격은 절대 차이가 아니라 배수로 본다.** 5와 20을 선형으로 정규화하면 최고가가 0점이 되어
 * 슬라이더를 끝까지 밀어야만 순위가 뒤집힌다. 최저가 대비 배수로 보면 20짜리도 25점을 갖고,
 * 가격 비중 1/3 언저리에서 순위가 갈린다 — 슬라이더를 조금만 움직여도 결과가 바뀐다.
 *
 * @param {object[]} listings - `rating`과 `sample`이 얹힌 리스팅
 * @param {number} priceWeight - 0(품질만) ~ 1(가격만)
 */
export function rankCandidates(listings, priceWeight = DEFAULT_PRICE_WEIGHT) {
  const w = Math.min(1, Math.max(0, Number(priceWeight)));
  // 샘플이 없으면 품질을 잴 수 없어 비교가 성립하지 않는다. 품질 0점으로 목록에 남기면
  // "얘는 왜 항상 꼴찌인가"라는, 화면이 설명할 수 없는 줄이 생긴다.
  const eligible = listings.filter((l) => l.sample?.score != null);
  if (!eligible.length) return [];
  const minPrice = Math.min(...eligible.map((l) => l.priceUsdc));

  const scored = eligible.map((l) => {
    const priceScore = (minPrice / l.priceUsdc) * 100;
    const sampleScore = l.sample?.score ?? 0;
    const ratingScore = (l.rating ?? 0) * 20;
    const qualityScore = sampleScore * SAMPLE_WEIGHT + ratingScore * (1 - SAMPLE_WEIGHT);
    const total = priceScore * w + qualityScore * (1 - w);

    return {
      ...l,
      scores: {
        price: Math.round(priceScore * 10) / 10,
        quality: Math.round(qualityScore * 10) / 10,
        total: Math.round(total * 10) / 10,
      },
    };
  });

  // 동점이면 싼 쪽을 앞에 둔다. 같은 값에 더 비싼 것을 고르는 화면은 설명할 수 없다.
  scored.sort((a, b) => b.scores.total - a.scores.total || a.priceUsdc - b.priceUsdc);
  return scored.map((l, i) => ({ ...l, rank: i + 1 }));
}
