/**
 * 샘플 채점을 한 번 실행해 fixtures에 저장한다.
 *
 * **구매 전 화면이 보여주는 샘플 점수는 이 스크립트의 출력이다.** 샘플도 채점 기준도 고정이라
 * 매 라운드 다시 돌리면 같은 값이 나오고 시간과 토큰만 쓴다. 그래서 한 번 채점해 저장하고,
 * 샘플을 고치거나 기준을 바꿀 때만 다시 돌린다.
 *
 * 결과물 채점(`purchase-flow.js`의 `gradeOne`)과 **같은 채점기**를 쓴다. 두 점수를 화면에
 * 나란히 놓기 때문에 다른 자로 재면 비교가 성립하지 않는다.
 *
 * 실행: node scripts/score-samples.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeResult } from '../lib/grading.js';
import { readSampleMarkdown } from '../lib/listings-store.js';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LISTINGS = path.join(APP_DIR, 'fixtures', 'listings.json');
const isDry = process.argv.includes('--dry');

// 라이브 채점이 안 될 때 조용히 규칙 채점으로 내려앉으면, fixtures가 429 한 번에 바뀌고
// 그 사실이 아무 데도 남지 않는다. 이 파일은 git 추적 대상이라 워킹트리도 함께 더러워진다.
// 그래서 폴백 저장은 명시적으로 요구할 때만 허용한다.
const allowFallback = process.argv.includes('--allow-fallback');

const doc = JSON.parse(fs.readFileSync(LISTINGS, 'utf8'));
const stampedAt = new Date().toISOString();
const pending = [];
let sawFallback = false;

for (const listing of doc.listings) {
  const file = listing.sample?.file;
  if (!file) {
    console.log(`${listing.id.padEnd(15)} 샘플 없음 — 건너뜀`);
    continue;
  }

  const markdown = readSampleMarkdown(file);
  if (!markdown) {
    console.log(`${listing.id.padEnd(15)} ${file} 을 읽지 못했다 — 건너뜀`);
    continue;
  }

  const { score, breakdown, source } = await gradeResult(markdown, {
    task: `${listing.title} 수준을 보여주는 포트폴리오`,
  });
  const before = listing.sample.score;

  console.log(
    `${listing.id.padEnd(15)} ${String(before).padStart(3)} → ${String(score).padStart(3)}점 ` +
      `(${source})  ${breakdown.map((b) => `${b.id.slice(0, 4)}:${b.score}`).join(' ')}`,
  );

  if (source !== 'live') sawFallback = true;
  pending.push({ listing, next: { ...listing.sample, score, breakdown, scoredAt: stampedAt, source } });
}

if (isDry) {
  console.log('\n--dry 라서 저장하지 않았다.');
} else if (sawFallback && !allowFallback) {
  console.log(
    '\n채점 모델을 쓰지 못해 규칙 채점으로 떨어졌다. **저장하지 않았다.**\n' +
      '  모델이 살아난 뒤 다시 돌리거나, 규칙 채점 결과를 그대로 쓰려면 --allow-fallback 을 붙여라.',
  );
  process.exit(1);
} else {
  for (const { listing, next } of pending) listing.sample = next;
  fs.writeFileSync(LISTINGS, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nfixtures/listings.json 갱신 — ${pending.length}건${sawFallback ? ' (규칙 채점, --allow-fallback)' : ''}`);
}
