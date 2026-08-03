/**
 * Gemini 연동 (스펙 3.4). make-vs-buy 견적 · bid rationale · specialist 결과.
 *
 * 라이브 우선, 실패/키 없음이면 fixtures 캐시로 폴백(스펙 7.3, 11장 리스크).
 * "목업"이 아니라 "실제 생성물의 캐시"다 — 키가 주어지면 재생성해 fixtures를 갱신할 수 있다.
 * GEMINI_API_KEY 미설정 시(현재 기본) 캐시 경로로 완주한다.
 *
 * 백엔드는 둘이고 `VERTEX_PROJECT`로 갈린다.
 * - 미설정: AI Studio(`generativelanguage`) + API 키. 로컬 개발·촬영 경로.
 * - 설정: Vertex AI + OAuth Bearer. GCP 프로젝트 크레딧으로 과금된다.
 * 요청·응답 스키마는 거의 같지만 **Vertex는 `contents[].role`이 필수**라 양쪽에 함께 보낸다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from '../config.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY = process.env.GEMINI_API_KEY || '';
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || '';
// `global`은 모델 별칭(gemini-flash-latest)까지 받아준다. 리전 엔드포인트는 정확한 버전 ID를 요구한다.
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';
const SA_KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const VERTEX_ENDPOINT = (model) => {
  const host =
    VERTEX_LOCATION === 'global'
      ? 'aiplatform.googleapis.com'
      : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  return (
    `https://${host}/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}` +
    `/publishers/google/models/${model}:generateContent`
  );
};

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, name), 'utf8'));
}
function fixtureText(name) {
  return fs.readFileSync(path.join(PATHS.fixtures, name), 'utf8');
}
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Vertex 액세스 토큰 캐시. 라운드당 4회 호출인데 매번 발급받을 이유가 없다.
let tokenCache = { token: '', expiresAt: 0 };
const TOKEN_MARGIN_MS = 5 * 60 * 1000; // 만료 5분 전에 갱신
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** GCE 메타데이터 서버에서 인스턴스 기본 서비스 계정 토큰을 받는다(VM 위에서만 동작). */
async function tokenFromMetadata() {
  const res = await fetch(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`메타데이터 서버 HTTP ${res.status}`);
  const json = await res.json();
  return { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
}

/**
 * 서비스 계정 키(JSON)로 JWT를 서명해 액세스 토큰으로 교환한다(OAuth2 jwt-bearer).
 * 메타데이터 경로와 달리 **인스턴스 scope에 묶이지 않아** VM 재생성 없이 Vertex를 쓸 수 있고,
 * 로컬에서도 같은 코드 경로를 검증할 수 있다. 표준 crypto만 쓰므로 새 의존성이 없다.
 */
async function tokenFromServiceAccount() {
  const key = JSON.parse(fs.readFileSync(SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(key.private_key)
    .toString('base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`토큰 교환 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
}

/** 캐시된 Vertex 토큰. 실패하면 null(호출부가 캐시 폴백). 인증은 시스템 경계라 여기서 잡는다. */
async function vertexAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - TOKEN_MARGIN_MS) {
    return tokenCache.token;
  }
  try {
    tokenCache = SA_KEY_FILE ? await tokenFromServiceAccount() : await tokenFromMetadata();
    return tokenCache.token;
  } catch (e) {
    // 조용한 실패를 남기지 않는다 — 폴백은 정상 동작처럼 보이므로 원인을 로그로 남겨야 한다.
    console.error(`[gemini] Vertex 토큰 획득 실패(${SA_KEY_FILE ? 'SA 키' : '메타데이터'}): ${e.message}`);
    return null;
  }
}

/** 라이브 Gemini 1회 호출. 키 없거나 실패면 null(호출부가 캐시로 폴백). */
async function generate(prompt, { timeoutMs = 12000 } = {}) {
  const isVertex = Boolean(VERTEX_PROJECT);
  if (!isVertex && !API_KEY) return null;

  let url = `${ENDPOINT(MODEL)}?key=${API_KEY}`;
  const headers = { 'Content-Type': 'application/json' };
  if (isVertex) {
    const token = await vertexAccessToken();
    if (!token) return null;
    url = VERTEX_ENDPOINT(MODEL);
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const ctl = AbortController ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      signal: ctl?.signal,
    });
    if (timer) clearTimeout(timer);
    if (!res.ok) {
      console.error(
        `[gemini] ${isVertex ? 'Vertex' : 'AI Studio'} 호출 실패 HTTP ${res.status} (model=${MODEL}) — 캐시로 폴백`,
      );
      return null;
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    return text.trim() || null;
  } catch (e) {
    console.error(`[gemini] ${isVertex ? 'Vertex' : 'AI Studio'} 호출 예외: ${e.message} — 캐시로 폴백`);
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
 * 정산 후 unlock되는 specialist 결과 브리핑. 라이브 성공 시 그 텍스트, 실패 시 캐시.
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
