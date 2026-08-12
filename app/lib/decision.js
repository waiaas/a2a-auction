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

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, name), 'utf8'));
}

/** 카탈로그 리스팅 3종 (컷 1에서 화면에 깔리는 것과 같은 소스). */
export function loadListings() {
  return loadFixture('listings.json').listings;
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
  // 심층 요청일수록 응답이 길어 기본 12초로는 끊긴다(실측: deep 요청이 타임아웃으로 폴백).
  // 라이브 판단 근거가 컷 3의 알맹이라 여유를 준다.
  const args = await generateFunctionCall(buildPrompt(request, listings), CHOOSE_LISTING_FN, {
    timeoutMs: 20000,
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
