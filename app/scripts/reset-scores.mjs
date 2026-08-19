/**
 * 채점 이력을 지워 카탈로그 평점을 fixtures 씨앗값으로 되돌린다.
 *
 * **리허설을 돌릴수록 평점이 한 방향으로 내려간다.** 결과물 채점이 씨앗값보다 낮게 나오기
 * 때문이고, 그대로 두면 발표 당일 카탈로그 숫자가 계획한 값과 달라진다. 슬라이더에서 순위가
 * 뒤집히는 지점도 함께 옮겨간다.
 *
 * 서버를 띄우지 않고도 돌아간다(파일만 지운다). 서버가 떠 있으면 다음 카탈로그 조회부터
 * 바뀐 값이 나간다 — `loadCatalog`가 매번 이력을 다시 읽기 때문이다.
 *
 * 실행: node scripts/reset-scores.mjs
 */
import { clearScores } from '../lib/scoring.js';
import { loadCatalog } from '../lib/listings-store.js';

const removed = clearScores();
console.log(removed ? `채점 이력 ${removed}건을 지웠다.` : '지울 채점 이력이 없었다.');
console.log('\n카탈로그 평점 (fixtures 씨앗값):');
for (const listing of loadCatalog()) {
  if (!listing.sample) continue;
  console.log(`  ${listing.id.padEnd(15)} 평점 ${listing.rating}  · 샘플 채점 ${listing.sample.score}`);
}
