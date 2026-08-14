/**
 * A2AHouse MCP 서버 (콘티 v3 컷 0·2·7). 에이전트가 능력을 등록하고, 고르고, 사는 창구.
 *
 * **설계 핵심: 정책 판정이 도구 호출의 응답으로 그대로 돌아온다**(콘티 §8).
 * 5달러는 즉시 성공, 10달러는 유예 중, 20달러는 승인 대기가 클라이언트 화면에 찍히면
 * 별도 설명 없이 정책 엔진이 스스로를 증명한다. 그래서 이 서버는 판정을 요약하거나
 * 성공/실패로 접지 않고 티어 이름과 다음에 벌어질 일을 함께 돌려준다.
 *
 * 오케스트레이터(:4000) HTTP를 감싸는 얇은 층이다. 온체인·정책 로직은 전부 그쪽에 있고
 * 여기서 중복 구현하지 않는다 — 화면과 도구가 같은 상태를 봐야 데모가 어긋나지 않는다.
 *
 * **실행 주체가 둘이고, 그것이 이 데모의 구조다.** 에이전트에게 일을 시키는 것은 여기(MCP)이고,
 * 사람이 결정하는 것(지갑 연결·자금 위임·한도 조정·승인)은 웹이다. 웹은 그 사이에서 진행을
 * 지켜보는 자리다. 그래서 이 서버는 승인을 대행하지 않고 "웹에서 승인하라"고 돌려준다 —
 * 승인은 오너의 지갑 서명이라 도구가 대신할 수 있는 성질이 아니다.
 *
 * 실행: node mcp-server.js   (stdio 전송. Claude Desktop 등 MCP 클라이언트가 띄운다)
 * 환경:
 *   ORCHESTRATOR_URL  기본 http://127.0.0.1:4000
 *   A2A_TOKEN         웹에서 지갑을 연결하고 발급받은 토큰. **주면 내 에이전트 지갑으로 산다.**
 *                     없으면 공용 데모 지갑으로 도는 발표용 경로를 그대로 쓴다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.ORCHESTRATOR_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');

/**
 * 사용자 토큰. 있으면 `/api/u/*`(내 에이전트 지갑), 없으면 `/api/purchase/*`(공용 데모).
 * 두 경로를 하나의 도구 집합으로 덮는 이유는, 심사위원이 토큰만 넣으면 같은 도구가 자기
 * 지갑으로 도는 것이 이 서비스의 사용법 그 자체이기 때문이다.
 */
const TOKEN = (process.env.A2A_TOKEN || '').trim();
const IS_MINE = Boolean(TOKEN);

/** 도구 응답 공통 형식. 객체를 그대로 JSON으로 보여준다 — 요약하면 판정 근거가 사라진다. */
function toResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function toError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // 오케스트레이터가 안 떠 있는 것은 도구 사용자가 가장 자주 만나는 실패다. 원인을 그대로 말한다.
    throw new Error(`오케스트레이터에 연결할 수 없다 (${BASE}): ${e.message}`);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (res.status === 401) {
    throw new Error(
      `A2A_TOKEN이 만료됐거나 유효하지 않다. ${BASE}/#me 에서 지갑을 다시 연결하고 토큰을 새로 받아라.`,
    );
  }
  if (!res.ok) throw new Error(`${path} 실패 ${res.status}: ${json.message || json.error || text.slice(0, 200)}`);
  return json;
}

/** 티어별로 "그래서 지금 무슨 일이 벌어졌나"를 한 줄로. 도구 사용자는 티어 이름만으로는 모른다. */
const TIER_MEANING = {
  INSTANT: '한도 안이라 즉시 실행됐다.',
  NOTIFY: '오너에게 알림이 갔고 실행은 통과했다.',
  DELAY: '유예 대기에 걸렸다. 유예가 끝나면 자동 실행되고, 그 전에 취소할 수 있다.',
  APPROVAL: '오너 승인 대기다. 사람이 승인해야 실행된다.',
  DENY: '정책이 거부했다. 실행되지 않는다.',
};

/** 사람이 해야 하는 일은 웹으로 넘긴다. 도구가 대신할 수 없는 것을 안내 없이 막으면 막다른 길이 된다. */
const CONSOLE_URL = `${BASE}/#me`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 구매를 걸고 **판정이 날 때까지 기다린다.**
 *
 * 서버는 오래 걸리는 작업이라 202로 끊고 진행을 상태에 싣는다. 그대로 돌려주면 도구 응답이
 * "접수했다"로 끝나는데, 그러면 **정책 판정이 도구 호출의 응답으로 돌아온다**는 이 설계의
 * 핵심(콘티 §8)이 사라진다. 그래서 여기서 폴링해 판정을 응답에 담는다.
 */
async function buyAndWait(body, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const { requestId } = await call('POST', '/api/u/purchase', body);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const s = await call('GET', '/api/u/purchase/state');
    const p = s.purchases.find((x) => x.requestId === requestId);
    if (s.error && !p) throw new Error(s.error);
    // 판정(ui)이 찍히면 티어가 정해진 것이다. 정산·결과물은 그 뒤에 이어진다.
    if (p?.ui) {
      return verdictPayload({
        requestId: p.requestId,
        listingId: p.listing.id,
        listingTitle: p.listing.title,
        amountUsdc: p.amountUsdc,
        tier: p.tier,
        ui: p.ui,
        auctionId: p.auctionId,
        txId: p.txId,
        // 무엇을 왜 골랐는지는 자율성의 증거라 판정과 함께 싣는다.
        chosenBy: p.decision?.source === 'live' ? 'agent' : p.decision?.source ?? null,
        reason: p.decision?.reason ?? null,
        rejectedCandidate: p.decision?.rejected ?? null,
      });
    }
    if (!s.running && s.error) throw new Error(s.error);
  }
  throw new Error(`판정이 시간 안에 나오지 않았다. ${CONSOLE_URL} 에서 진행 상태를 확인하라.`);
}

/** 판정 응답 공통 형태. 티어 이름만으로는 무슨 일이 벌어졌는지 알 수 없어 뜻과 다음 단계를 붙인다. */
function verdictPayload(p) {
  const verdict = p.ui;
  return {
    purchased: true,
    requestId: p.requestId,
    listingId: p.listingId,
    listingTitle: p.listingTitle,
    amountUsdc: p.amountUsdc,
    chosenBy: p.chosenBy,
    reason: p.reason,
    rejectedCandidate: p.rejectedCandidate,
    // 판정을 접지 않고 그대로 노출한다. 이 세 줄이 컷 4가 증명하려는 것 자체다.
    policyTier: p.tier,
    verdict,
    meaning: TIER_MEANING[verdict] ?? TIER_MEANING[p.tier] ?? '판정을 확인할 수 없다.',
    executed: ['INSTANT', 'NOTIFY'].includes(verdict),
    auctionId: p.auctionId,
    transactionId: p.txId,
    nextStep:
      verdict === 'APPROVAL'
        ? `오너의 지갑 서명이 필요하다. 도구로는 승인할 수 없다 — ${CONSOLE_URL} 에서 승인하거나 거부하라.`
        : verdict === 'DELAY'
          ? '유예가 끝나면 자동 실행된다. get_status로 확인하라.'
          : '정산과 결과물 열람으로 이어진다. get_status로 확인하라.',
  };
}

const server = new McpServer({ name: 'a2ahouse', version: '0.1.0' });

// ---- 컷 0: 능력 등록 ----
server.registerTool(
  'register_skill',
  {
    description:
      '에이전트의 능력을 A2AHouse 카탈로그에 등록한다. 등록 즉시 구매 후보로 노출된다.',
    inputSchema: {
    id: z.string().describe('리스팅 식별자. 소문자·숫자·하이픈만 (예: "quick-scan")'),
    title: z.string().describe('능력 이름 (예: "시황 스냅샷")'),
    priceUsdc: z.number().positive().describe('가격 (USDC)'),
    summary: z.string().optional().describe('무엇을 해주는지 한 문장'),
    sellerName: z.string().optional().describe('제공하는 에이전트 이름'),
    sellerEmoji: z.string().optional().describe('카탈로그에 표시할 이모지'),
    depth: z.enum(['light', 'standard', 'deep']).optional().describe('작업 깊이. 구매자가 일의 크기에 맞춰 고르는 기준이 된다'),
    format: z.string().optional().describe('산출물 형식 (예: "마크다운 3~4장")'),
    approxWords: z.number().optional().describe('산출물 대략 분량(자)'),
    sourceCount: z.number().optional().describe('참조 출처 수'),
    avgMinutes: z.number().optional().describe('평균 소요 시간(분)'),
    },
  },
  async (args) => {
    try {
      const { listing, replaced } = await call('POST', '/api/purchase/listings', args);
      return toResult({
        registered: true,
        replaced,
        listing: { id: listing.id, title: listing.title, priceUsdc: listing.priceUsdc, seller: listing.seller.name },
        note: replaced ? '같은 id가 있어 덮어썼다.' : '카탈로그에 새로 올라갔다.',
      });
    } catch (e) {
      return toError(e.message);
    }
  },
);

// ---- 컷 3의 재료: 후보 조회 ----
server.registerTool(
  'list_skills',
  {
    description:
      'A2AHouse 카탈로그의 능력 목록을 조회한다. 가격·분량·출처 수·수행 이력이 함께 나오므로 일의 크기에 맞는 것을 고를 수 있다.',
    inputSchema: {
    maxPriceUsdc: z.number().optional().describe('이 가격 이하만 조회'),
    depth: z.enum(['light', 'standard', 'deep']).optional().describe('작업 깊이로 거르기'),
    },
  },
  async (args) => {
    try {
      // 카탈로그는 전역이라 토큰 유무와 무관하다. 인증 경로를 타면 로그인 여부까지 함께 검증된다.
      const { listings } = await call('GET', IS_MINE ? '/api/u/catalog' : '/api/purchase/catalog');
      const filtered = listings.filter(
        (l) =>
          (args.maxPriceUsdc == null || l.priceUsdc <= args.maxPriceUsdc) &&
          (args.depth == null || l.depth === args.depth),
      );
      return toResult({
        count: filtered.length,
        skills: filtered.map((l) => ({
          id: l.id,
          title: l.title,
          priceUsdc: l.priceUsdc,
          depth: l.depth,
          seller: l.seller.name,
          summary: l.summary,
          deliverable: `${l.deliverable.format} · 약 ${l.deliverable.approxWords}자 · 출처 ${l.deliverable.sourceCount}건`,
          track: `수행 ${l.track.completed}건 · 재구매율 ${Math.round(l.track.repeatRate * 100)}% · 평균 ${l.track.avgMinutes}분`,
        })),
      });
    } catch (e) {
      return toError(e.message);
    }
  },
);

// ---- 컷 2·4: 구매. 여기서 정책 티어가 갈린다 ----
server.registerTool(
  'purchase_skill',
  {
    description:
      '카탈로그의 능력을 구매한다. 지갑 정책이 금액에 따라 즉시 실행·알림·유예·승인 대기로 갈리며, 그 판정이 이 도구의 응답으로 그대로 돌아온다.',
    inputSchema: {
    listingId: z.string().describe('구매할 리스팅 id (list_skills로 조회)'),
    title: z.string().optional().describe('이 구매로 처리할 일의 제목'),
    need: z.string().optional().describe('무엇에 쓸 것인지. 결과물 생성의 과업 설명으로 쓰인다'),
    },
  },
  async (args) => {
    try {
      if (!IS_MINE) {
        const r = await call('POST', '/api/purchase/buy', args);
        return toResult(verdictPayload({
          requestId: r.requestId,
          listingId: r.listingId,
          amountUsdc: r.amountUsdc,
          tier: r.tier,
          ui: r.verdict,
          auctionId: r.auctionId,
          txId: r.txId,
        }));
      }
      return toResult(await buyAndWait({ listingId: args.listingId, title: args.title, need: args.need }));
    } catch (e) {
      return toError(e.message);
    }
  },
);

// ---- 컷 2: 자연어로 일을 맡긴다. 고르는 것은 A2AHouse 에이전트다 ----
server.registerTool(
  'request_work',
  {
    description:
      '필요한 일을 자연어로 맡긴다. A2AHouse 에이전트가 카탈로그에서 일의 크기에 맞는 공급자를 스스로 고르고, ' +
      '지갑 정책이 금액에 따라 판정한다. 어떤 것을 골랐는지와 그 이유, 정책 판정이 함께 돌아온다. ' +
      '어떤 능력을 살지 이미 정했다면 purchase_skill을 쓴다.',
    inputSchema: {
      prompt: z.string().describe('필요한 것을 그대로 서술한다 (예: "다음 주 회의 전에 훑어볼 스테이블코인 시장 요약")'),
      title: z.string().optional().describe('이 일의 짧은 제목'),
    },
  },
  async (args) => {
    try {
      if (!IS_MINE) {
        return toError(
          'A2A_TOKEN이 없다. 이 도구는 내 에이전트 지갑으로 도는 경로라 토큰이 필요하다. ' +
          `${CONSOLE_URL} 에서 지갑을 연결하고 토큰을 받아 MCP 설정의 A2A_TOKEN에 넣어라.`,
        );
      }
      return toResult(await buyAndWait({ prompt: args.prompt, title: args.title }));
    } catch (e) {
      return toError(e.message);
    }
  },
);

// ---- 컷 4·5: 상태 조회 ----
server.registerTool(
  'get_status',
  {
    description:
      '진행 중인 구매의 상태를 조회한다. 각 건의 정책 판정, 대기 여부, 정산·결과물·결제 진행을 함께 돌려준다.',
    inputSchema: {
    requestId: z.string().optional().describe('특정 구매만 조회. 생략하면 전체'),
    },
  },
  async (args) => {
    try {
      const s = await call('GET', IS_MINE ? '/api/u/purchase/state' : '/api/purchase/state');
      const rows = s.purchases
        .filter((p) => !args.requestId || p.requestId === args.requestId)
        .map((p) => ({
          requestId: p.requestId,
          listingId: p.listing.id,
          amountUsdc: p.amountUsdc,
          policyTier: p.tier,
          verdict: p.ui,
          meaning: TIER_MEANING[p.ui] ?? TIER_MEANING[p.tier] ?? null,
          waitingForHuman: p.ui === 'APPROVAL',
          settled: Boolean(p.steps?.settle),
          resultHash: p.resultMeta?.hash ?? null,
          x402PaidUsdc: p.x402?.amountUsdc ?? null,
          auctionId: p.auctionId,
        }));
      const waiting = rows.filter((r) => r.waitingForHuman);
      return toResult({
        wallet: IS_MINE ? 'mine' : 'shared-demo',
        phase: s.phase,
        running: s.running,
        policy: s.buyer?.policy ?? null,
        count: rows.length,
        purchases: rows,
        // 도구가 할 수 없는 일이 남아 있으면 어디서 해야 하는지 말한다.
        actionRequired: waiting.length
          ? `${waiting.length}건이 오너 승인을 기다린다. 승인은 지갑 서명이라 ${CONSOLE_URL} 에서만 할 수 있다.`
          : null,
      });
    } catch (e) {
      return toError(e.message);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout은 MCP 프로토콜 전용이라 로그는 stderr로만 낸다.
console.error(
  `[a2ahouse-mcp] ready (orchestrator=${BASE}, wallet=${IS_MINE ? 'mine (A2A_TOKEN)' : 'shared demo — A2A_TOKEN 없음'})`,
);
