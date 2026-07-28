/**
 * Gemini 연동 (스펙 3.4). make-vs-buy 견적 · bid rationale · specialist 결과.
 *
 * 라이브 우선, 실패/키 없음이면 fixtures 캐시로 폴백(스펙 7.3, 11장 리스크).
 * "목업"이 아니라 "실제 생성물의 캐시"다 — 키가 주어지면 재생성해 fixtures를 갱신할 수 있다.
 * GEMINI_API_KEY 미설정 시(현재 기본) 캐시 경로로 완주한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from '../config.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY = process.env.GEMINI_API_KEY || '';
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, name), 'utf8'));
}
function fixtureText(name) {
  return fs.readFileSync(path.join(PATHS.fixtures, name), 'utf8');
}
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 라이브 Gemini 1회 호출. 키 없거나 실패면 null(호출부가 캐시로 폴백). */
async function generate(prompt, { timeoutMs = 12000 } = {}) {
  if (!API_KEY) return null;
  try {
    const ctl = AbortController ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetch(`${ENDPOINT(MODEL)}?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: ctl?.signal,
    });
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * buyer별 make-vs-buy 견적 + rationale. 라이브 성공 시 rationale만 재생성하고
 * 정량 견적(diyTokens 등)은 캐시값 유지(금액 고정 원칙, 스펙 3.4).
 * @returns {Promise<{quote:object, rationale:string, source:'live'|'cache'}>}
 */
export async function getQuoteAndRationale(role, item) {
  const quotes = fixture('quotes.json');
  const rationales = fixture('rationales.json');
  const quote = quotes[role];
  const cachedRationale = rationales[role];

  const prompt =
    `너는 A2A 경매의 buyer 에이전트다. 아래 견적을 근거로 입찰 사유(rationale)를 한국어 2문장 이내로 써라.\n` +
    `- 태스크: ${item.task}\n- 직접 수행 원가: 약 ${quote.diyTokens} 토큰, ${quote.diyTimeMin}분\n` +
    `- 슬롯 구매가: ${quote.buyPriceUsdc} USDC\n금액은 바꾸지 말고 사유만 써라.`;
  const live = await generate(prompt);
  return {
    quote,
    rationale: live || cachedRationale,
    source: live ? 'live' : 'cache',
  };
}

/** 라운드별 결과물 확정 캐시 경로. */
function resultCachePath(auctionId) {
  return path.join(PATHS.resultCache, `result-${auctionId}.json`);
}

/**
 * 낙찰자에게 unlock되는 specialist 결과 브리핑. 라이브 성공 시 그 텍스트, 실패 시 캐시.
 * auctionId를 주면 라운드별 확정본을 캐시한다 — orchestrator가 정산 시 먼저 생성·저장하고
 * seller가 이를 재사용해 **동일한 contentMarkdown·hash**를 낸다(라이브 모드에서도 hash 일치).
 * 접근권 판정은 여전히 seller가 온체인 Settled·winner로 하고, 여기서 공유하는 건 콘텐츠뿐이다.
 * @returns {Promise<{contentMarkdown:string, hash:string, source:'live'|'cache'}>}
 */
export async function getResult(item, auctionId = null) {
  const cachePath = auctionId != null ? resultCachePath(auctionId) : null;
  // 캐시 히트: 파일 I/O는 시스템 경계 — 없거나 손상되면 미스로 보고 아래 생성 경로로 폴백한다.
  if (cachePath) {
    try {
      const { source, contentMarkdown } = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (typeof contentMarkdown === 'string') {
        return { contentMarkdown, hash: sha256Hex(contentMarkdown), source };
      }
    } catch { /* 캐시 없음/손상 → 재생성 */ }
  }

  const cached = fixtureText('result.md');
  const prompt =
    `"${item.task}"에 대한 전문 리서치 브리핑을 한국어 마크다운으로 작성하라. ` +
    `한 줄 요약, 채택 신호, 병목, 시사점, 방법론 주석 순으로. 수치는 대표값임을 명시하라.`;
  const live = await generate(prompt, { timeoutMs: 20000 });
  const contentMarkdown = live || cached;
  const source = live ? 'live' : 'cache';

  // 확정본 저장 → 같은 auctionId 후속 호출(seller)이 재사용. temp+rename으로 원자적 교체(부분·동시 쓰기 손상 방지).
  if (cachePath) {
    try {
      fs.mkdirSync(PATHS.resultCache, { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ source, contentMarkdown }));
      fs.renameSync(tmp, cachePath);
    } catch (e) {
      console.error(`[gemini] result 캐시 쓰기 실패 auction=${auctionId}: ${e.message}`);
    }
  }
  return { contentMarkdown, hash: sha256Hex(contentMarkdown), source };
}
