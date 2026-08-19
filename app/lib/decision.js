/**
 * 의사결정 레이어 (콘티 v3 컷 3). 요청 하나를 받아 카탈로그 리스팅 중 하나를 고른다.
 *
 * **이 데모의 자율성 승부처다.** 입찰가를 산정하는 것이 아니라 **공급자를 선택**하므로
 * 심사 문항의 "도구 선택"에 정면으로 대응한다. 그래서 고른 결과뿐 아니라 **왜 골랐는지**를
 * 함께 반환해 화면에 노출한다.
 *
 * 라이브(Gemini function calling) 우선, 실패하면 요청에 적힌 폴백 리스팅으로 완주한다.
 * 폴백은 "목업"이 아니라 라이브가 못 돌 때도 데모가 멈추지 않게 하는 안전장치다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { generateFunctionCall } from './gemini.js';
import { loadCatalog } from './listings-store.js';
import { loadCriteria } from './scoring.js';

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, name), 'utf8'));
}

/**
 * 카탈로그 리스팅 (컷 1에서 화면에 깔리는 것과 같은 소스).
 * MCP로 등록된 리스팅까지 포함한다 — 등록(컷 0)이 선택(컷 3)의 후보에 실제로 들어가야 한다.
 */
export function loadListings() {
  return loadCatalog();
}

/** 바이어가 맡기는 일 3건. */
export function loadRequests() {
  return loadFixture('requests.json').requests;
}

/** 모델에게 넘기는 함수 정의. 고른 이유를 필수로 받아 화면에 그대로 쓴다. */
const CHOOSE_LISTING_FN = {
  name: 'choose_listing',
  description:
    '요청 하나를 처리할 카탈로그 리스팅을 하나 고른다. 일의 크기에 맞는 깊이를 골라야 하며, ' +
    '과하게 비싼 것도 과하게 싼 것도 잘못된 선택이다.',
  parameters: {
    type: 'object',
    properties: {
      listingId: {
        type: 'string',
        description: '고른 리스팅의 id',
      },
      reason: {
        type: 'string',
        description:
          '이 리스팅을 고른 이유를 한국어 한두 문장으로. 요청의 크기와 리스팅의 분량·출처 수를 ' +
          '근거로 들 것. 가격만 이유로 들지 말 것.',
      },
      rejected: {
        type: 'string',
        description: '고르지 않은 후보 중 가장 아까웠던 것과 그 이유를 한국어 한 문장으로.',
      },
    },
    required: ['listingId', 'reason'],
  },
};

function buildPrompt(request, listings) {
  const table = listings
    .map(
      (l) =>
        `- id=${l.id} | ${l.priceUsdc} USDC | ${l.title} | ${l.summary} | ` +
        `산출물 ${l.deliverable.format}(약 ${l.deliverable.approxWords}자, 출처 ${l.deliverable.sourceCount}건) | ` +
        `수행 ${l.track.completed}건, 재구매율 ${Math.round(l.track.repeatRate * 100)}%, 평균 ${l.track.avgMinutes}분`,
    )
    .join('\n');

  return (
    '너는 사용자를 대신해 리서치를 구매하는 에이전트다. 아래 요청 하나를 처리할 리스팅을 골라라.\n\n' +
    `[요청]\n제목: ${request.title}\n내용: ${request.prompt}\n용도: ${request.need}\n\n` +
    `[카탈로그]\n${table}\n\n` +
    '판단 기준: 용도에 필요한 깊이를 먼저 보고, 그 다음 가격을 본다. ' +
    '회의 전에 훑을 자료에 심층 리포트를 사는 것도, 투자 검토 문서에 한 장짜리 요약을 사는 것도 잘못이다.'
  );
}

/** 라이브가 못 돌 때 쓰는 폴백 근거. 규칙이 무엇이었는지 화면에 그대로 밝힌다. */
function fallbackReason(request, listing) {
  return (
    `요청 크기가 '${request.size}'라 같은 깊이의 ${listing.title}(${listing.priceUsdc} USDC)를 골랐다. ` +
    `산출물 ${listing.deliverable.format}, 출처 ${listing.deliverable.sourceCount}건이 용도에 맞는다.`
  );
}

/**
 * 요청 하나에 대해 리스팅을 고른다.
 *
 * @param {object} request - requests.json 항목
 * @param {object[]} listings - listings.json 항목들
 * @returns {Promise<{listing:object, reason:string, rejected:string|null, source:'live'|'fallback'}>}
 */
export async function chooseListing(request, listings) {
  // 심층 요청일수록 응답이 길어 12초·20초 모두 끊겼다(실측: deep 요청만 2회 연속 폴백).
  // 라이브 판단 근거가 컷 3의 알맹이라 여유를 크게 준다 — 화면에서는 에이전트가 더 오래
  // 고민하는 것으로 보이므로 대기 자체가 손해는 아니다.
  const args = await generateFunctionCall(buildPrompt(request, listings), CHOOSE_LISTING_FN, {
    timeoutMs: 35000,
  });
  const picked = args?.listingId ? listings.find((l) => l.id === args.listingId) : null;

  // 모델이 없는 id를 지어내면 폴백으로 내린다. 라이브 실패와 구분해 로그를 남긴다.
  if (args?.listingId && !picked) {
    console.error(`[decision] 모델이 없는 listingId를 골랐다: ${args.listingId} — 폴백`);
  }

  if (picked) {
    return {
      listing: picked,
      reason: args.reason || fallbackReason(request, picked),
      rejected: args.rejected || null,
      source: 'live',
    };
  }

  const fallback =
    listings.find((l) => l.id === request.expectedListingId) ??
    listings.find((l) => l.depth === request.size) ??
    listings[0];
  return {
    listing: fallback,
    reason: fallbackReason(request, fallback),
    rejected: null,
    source: 'fallback',
  };
}

/** 이미 정해진 선택의 근거를 받는 함수 정의. 고르는 것이 아니라 쓰는 것이다. */
const EXPLAIN_PICK_FN = {
  name: 'explain_pick',
  description:
    '사용자가 정한 가중치로 이미 1위가 정해졌다. 그 선택이 왜 이 요청에 맞는지 근거를 쓴다. ' +
    '다른 리스팅을 고르라는 것이 아니다.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          '이 리스팅이 요청에 맞는 이유를 한국어 한두 문장으로. 요청의 성격과 샘플 채점 항목을 ' +
          '근거로 들 것. 가격만 이유로 들지 말 것.',
      },
      rejected: {
        type: 'string',
        description: '2위를 고르지 않은 이유를 한국어 한 문장으로. 무엇이 부족했는지 항목으로 말할 것.',
      },
    },
    required: ['reason'],
  },
};

/** 라이브가 못 돌 때 쓰는 근거. 점수를 그대로 읽어 준다 — 실제로 그렇게 골랐기 때문이다. */
function fallbackPickReason(picked, priceWeight) {
  const w = Math.round(priceWeight * 100);
  const best = [...(picked.sample?.breakdown ?? [])].sort((a, b) => b.score - a.score)[0];
  // 항목 id를 그대로 쓰면 화면에 `scenario`가 뜬다. 사람이 읽는 자리라 라벨로 바꾼다.
  const label = best ? (loadCriteria().items.find((c) => c.id === best.id)?.label ?? best.id) : null;
  const detail = best ? `, 특히 ${label} 항목이 ${best.score}점 만점이었다` : '';
  return (
    `가격 ${w}% · 품질 ${100 - w}% 기준으로 종합 ${picked.scores.total}점을 받아 1위다. ` +
    `샘플 채점 ${picked.sample?.score}점${detail}.`
  );
}

function fallbackRejected(runnerUp) {
  if (!runnerUp) return null;
  return (
    `${runnerUp.title}(${runnerUp.priceUsdc} USDC)은 종합 ${runnerUp.scores.total}점으로 ` +
    `샘플 채점이 ${runnerUp.sample?.score}점에 그쳤다.`
  );
}

/**
 * 가중치로 정해진 1위의 근거를 쓴다.
 *
 * **모델에게 고르게 하지 않는다.** 화면이 이미 순위를 보여준 뒤라 모델이 다른 것을 고르면
 * 1위와 실제 구매가 어긋난다. 선택은 사용자가 정한 가중치가 하고, 모델은 그 선택이 이
 * 요청에 왜 맞는지를 쓴다 — 자율성은 "무엇을 샀는가"가 아니라 "왜 그것이 맞는가"에 있다.
 *
 * @param {object} request - 사용자 요청
 * @param {object[]} ranked - `rankCandidates` 결과 (rank·scores 포함)
 * @param {number} priceWeight - 사용자가 정한 가격 비중 0~1
 */
export async function explainPick(request, ranked, priceWeight) {
  const picked = ranked[0];
  const runnerUp = ranked[1] ?? null;

  const table = ranked
    .map(
      (l) =>
        `- ${l.rank}위 ${l.title}(${l.priceUsdc} USDC) | 종합 ${l.scores.total} | ` +
        `샘플 채점 ${l.sample?.score} | 평점 ${l.rating} | ` +
        `산출물 ${l.deliverable.format}, 출처 ${l.deliverable.sourceCount}건 | ` +
        `채점 상세 ${(l.sample?.breakdown ?? []).map((b) => `${b.id} ${b.score}`).join(', ')}`,
    )
    .join('\n');

  const prompt =
    '너는 사용자를 대신해 리서치를 구매하는 에이전트다. 사용자가 정한 가중치로 순위가 이미 정해졌다.\n\n' +
    `[요청]\n${request.prompt}\n\n` +
    `[사용자가 정한 가중치]\n가격 ${Math.round(priceWeight * 100)}% · 품질 ${Math.round((1 - priceWeight) * 100)}%\n\n` +
    `[후보와 점수]\n${table}\n\n` +
    `1위인 "${picked.title}"을 산다. 이 선택이 요청에 맞는 근거와, 2위를 고르지 않은 이유를 써라.`;

  const args = await generateFunctionCall(prompt, EXPLAIN_PICK_FN, { timeoutMs: 20000 });

  if (args?.reason) {
    return {
      listing: picked,
      reason: args.reason,
      rejected: args.rejected || fallbackRejected(runnerUp),
      source: 'live',
    };
  }
  return {
    listing: picked,
    reason: fallbackPickReason(picked, priceWeight),
    rejected: fallbackRejected(runnerUp),
    source: 'fallback',
  };
}
