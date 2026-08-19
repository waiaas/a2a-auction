/**
 * 채점과 평점 (8/19 퀵싱크 반영분).
 *
 * **평점은 저장된 숫자가 아니라 채점이 쌓여서 만들어지는 값이다.** 이 구분이 이 데모의
 * 방어선이다 — "평점은 어뷰징할 수 있지 않느냐"에 답하려면 그 숫자가 어디서 왔는지
 * 화면이 말할 수 있어야 한다. 여기서는 구매 후 결과물 채점이 곧 평점의 재료다.
 *
 * 채점이 도는 자리는 둘인데 성격이 다르다.
 *   - **구매 전**: 샘플 채점. 샘플도 프롬프트도 고정이라 매번 돌려도 같은 값이 나온다.
 *     그래서 `scripts/score-samples.mjs`로 한 번 채점해 fixtures에 저장하고 다시 돌리지 않는다.
 *   - **구매 후**: 결과물 채점. 매번 새로 만들어지므로 값이 고정될 수 없다. 여기가 라이브다.
 *
 * 채점 이력은 fixtures가 아니라 별도 파일에 쌓는다. 리허설마다 fixtures가 바뀌면 diff가
 * 오염되고, 초기화도 이 파일 하나만 지우면 끝난다(`registered-listings.json`과 같은 방식).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { ratingOf } from './ranking.js';

// 순위 계산은 브라우저도 쓰므로 파일 IO 없는 `ranking.js`에 두고 여기서 다시 내보낸다.
// 서버 코드가 import 경로를 둘로 나눠 외울 필요는 없다.
export { rankCandidates, ratingOf, DEFAULT_PRICE_WEIGHT } from './ranking.js';

const SCORES_PATH = path.join(PATHS.fixtures, '..', 'listing-scores.json');

/** 평점 이동평균 창. 전체 평균으로 하면 412건 위에 1건을 얹어도 소수점이 움직이지 않는다. */
export const RATING_WINDOW = 20;

/** 채점 기준. 요청 성격마다 다른 자를 쓴다 — 지금은 리서치 하나뿐이다. */
export function loadCriteria(kind = 'research') {
  const all = JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, 'criteria.json'), 'utf8'));
  const found = all[kind];
  if (!found) throw new Error(`채점 기준이 없다: ${kind}`);
  return found;
}

/** 채점 이력. 파일이 없거나 깨졌으면 이력이 없는 것으로 본다(시스템 경계). */
function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCORES_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveHistory(history) {
  const tmp = `${SCORES_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
  fs.renameSync(tmp, SCORES_PATH);
}

/**
 * 채점 결과 한 건을 리스팅에 반영한다. 창을 넘으면 오래된 것부터 밀어낸다.
 *
 * @returns {{before:number|null, after:number|null, scores:number[]}}
 */
export function recordScore(listingId, score, seedScores = []) {
  const history = loadHistory();
  const current = history[listingId] ?? [...seedScores];
  const before = ratingOf(current);

  const next = [...current, score].slice(-RATING_WINDOW);
  history[listingId] = next;
  saveHistory(history);

  return { before, after: ratingOf(next), scores: next };
}

/** 리스팅에 평점을 얹는다. 이력이 있으면 그것이 fixtures 초기값을 대체한다. */
export function withRatings(listings) {
  const history = loadHistory();
  return listings.map((l) => {
    const scores = history[l.id] ?? l.recentScores ?? [];
    return { ...l, recentScores: scores, rating: ratingOf(scores) };
  });
}

/** 채점 이력 전체 삭제(리허설 초기화용). fixtures 초기값으로 돌아간다. */
export function clearScores() {
  const count = Object.keys(loadHistory()).length;
  fs.rmSync(SCORES_PATH, { force: true });
  return count;
}
