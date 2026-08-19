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

const doc = JSON.parse(fs.readFileSync(LISTINGS, 'utf8'));
const stampedAt = new Date().toISOString();
let changed = 0;

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

  if (!isDry) {
    listing.sample = { ...listing.sample, score, breakdown, scoredAt: stampedAt, source };
    changed += 1;
  }
}

if (isDry) {
  console.log('\n--dry 라서 저장하지 않았다.');
} else {
  fs.writeFileSync(LISTINGS, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nfixtures/listings.json 갱신 — ${changed}건`);
}
