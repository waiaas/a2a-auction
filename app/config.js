/**
 * a2a-auction 데모 백엔드 설정 (단일 상수 소스).
 *
 * 값의 출처는 D-6 스파이크(`scripts/spike-3way/run.cjs`)에서 온체인으로 검증된 것들이다.
 * 시크릿(마스터 패스워드·세션 토큰·owner 키)은 여기 두지 않는다 — 런타임에 infra/.env·demo-state.json에서 읽는다.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** a2a-auction/ 레포 루트 (app/의 부모). */
export const ROOT = path.resolve(__dirname, '..');

/**
 * localnet RPC (호스트에서 도는 앱 기준).
 *
 * 밸리데이터를 `--bind-address <호스트 LAN IP>`로 띄웠다면 **그 IP를 RPC_URL로 지정해야 한다**
 * — 그 경우 루프백은 listen하지 않는다. 기본값을 특정 LAN IP로 두면 다른 환경에서 조용히
 * 실패하므로(작성자 IP 하드코딩 문제) 루프백을 기본값으로 둔다.
 * 데몬(컨테이너)이 보는 주소는 별개다 — infra/.env의 LOCALNET_RPC(host.docker.internal).
 */
export const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';

/**
 * 화면에 표시할 체인 이름. **RPC 주소에서 판정한다.**
 * 프론트에 문자열을 박아 두면 어느 체인에 배포하든 같은 값이 찍혀 화면이 거짓을 말한다
 * (devnet 배포본이 "localnet"이라고 표기하던 문제). 표시용이므로 판정에는 쓰지 않는다.
 */
function networkLabelFrom(rpcUrl) {
  if (/127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]/.test(rpcUrl)) return 'localnet';
  if (/devnet/.test(rpcUrl)) return 'devnet';
  if (/testnet/.test(rpcUrl)) return 'testnet';
  if (/mainnet/.test(rpcUrl)) return 'mainnet';
  return 'custom';
}
export const NETWORK_LABEL = networkLabelFrom(RPC_URL);

/** 배포된 경매 프로그램 (D-6 게이트 ②). */
export const PROGRAM_ID = '9nUhQbyNxmeZWpfxTmfP3U3fQ9GYtVnyP5WW1CVCYctV';

/** solana-devnet의 CAIP-2 (데몬이 이 네트워크로 매핑). token_limits/assetId 키 구성에 사용. */
export const CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const NETWORK = 'solana-devnet';

export const USDC_DECIMALS = 6;

/**
 * x402 결과물 unlock 접점 (플랜 B). 미설정이면 정산 후 무료 unlock 경로 그대로 — 킬 스위치다.
 * 켜면 seller가 정산 게이트 통과 후 402를 내고, A의 데몬이 마이크로페이먼트를 서명해 다시 요청한다.
 */
export const X402_UNLOCK = process.env.X402_UNLOCK === '1';

/**
 * unlock 1회 결제액. 데몬이 `accepts.amount`를 `BigInt()`로 읽으므로
 * **최소 단위 정수 문자열**이어야 한다(소수점 문자열이면 즉시 예외).
 */
export const X402_AMOUNT_BASE = '50000'; // 0.05 USDC (6dec)

/** 402 제시의 결제 유효시간. @x402/core v2에서 필수 필드다. */
export const X402_MAX_TIMEOUT_SECONDS = 60;

/**
 * seller의 공개 HTTPS URL (cloudflared quick tunnel). 데몬의 SSRF 가드가 사설 IP와 HTTP를
 * 전부 막으므로 터널 없이는 데몬이 seller를 호출조차 못 한다.
 *   cloudflared tunnel --url http://localhost:4100
 */
export const SELLER_PUBLIC_URL = (process.env.SELLER_PUBLIC_URL || '').replace(/\/$/, '');

/**
 * 데몬이 x402 결제를 허용할 도메인(default-deny 정책의 유일한 항목).
 * quick tunnel은 기동마다 서브도메인이 바뀌지만 데몬은 hostname만 비교하고 `*.` 와일드카드를
 * 지원하므로, 와일드카드 1건을 시드에 등록해 두면 터널 재기동마다 갱신할 필요가 없다.
 */
export const X402_ALLOWED_DOMAIN = process.env.X402_ALLOWED_DOMAIN || '*.trycloudflare.com';

/** buyer별 입찰·예치 금액 (base units, 6dec). 스펙 2.3절 고정값. */
export const AMOUNTS = {
  'buyer-a': 2_800_000n, // 2.80 USDC
  'buyer-b': 6_500_000n, // 6.50 USDC
  'buyer-c': 2_200_000n, // 2.20 USDC
};

/**
 * 시드가 각 buyer ATA를 채워 두는 목표 잔고 (여러 라운드분). 부족분만 mint.
 *
 * buyer-b가 새 시나리오(콘티 v3)의 주인공 바이어다. 한 라운드에 5+10+20 = 35 USDC를
 * 쓰므로(20은 승인 후 실행) 여러 라운드분을 확보한다.
 */
export const FUND_TARGET = {
  'buyer-a': 200_000_000n, // 200 USDC (라운드당 35 → ≈5라운드)
  'buyer-b': 30_000_000n, // 30 USDC (구 시나리오용)
  'buyer-c': 10_000_000n, // 10 USDC (C도 거부라 소모 없음)
};

/**
 * token_limits (human-readable, SPENDING_LIMIT).
 *
 * **세 값을 벌리는 것이 콘티 v3 컷 4의 전부다.** 값이 같으면 중간 티어가 구조적으로
 * 발생할 수 없어(`spending-limit.ts` 티어 판정이 `amount <= instant_max` → INSTANT,
 * `<= notify_max` → NOTIFY, `<= delay_max` → DELAY, 초과 → APPROVAL) WAIaaS 4단계 중
 * 2단계만 쓰게 된다.
 *
 * **INSTANT는 이 데모에서 쓸 수 없다(2026-08-12 실측).** 자체 발행 mint는 Pyth 피드에
 * 없어 가격 조회가 notListed로 끝나고, 데몬이 이를 **최소 NOTIFY로 강제 격상**한다
 * (`stage3-policy.ts:181-205`, "unknown price != price of 0"). 5/10/10으로 두면 5달러가
 * INSTANT가 아니라 NOTIFY로 나와 5와 10이 같은 티어로 접힌다. 그래서 instant_max를 0으로
 * 두어 INSTANT 구간을 비우고, 격상이 건드리지 못하는 위쪽 세 구간으로 3단계를 만든다.
 *
 * buyer-a(주인공 바이어): 5 → NOTIFY(알림만, 실행은 통과) / 10 → DELAY(유예 대기, 그 사이
 *   취소 가능) / 20 → APPROVAL(owner 승인). 셋 다 실행으로 확인했다.
 * buyer-b: 구 시나리오(3자 경매) 값 유지.
 *
 * **주인공이 buyer-b가 아니라 buyer-a인 이유**: 승인(컷 5)은 owner 서명이 유일한 경로인데
 * buyer-b는 이미 LOCKED이고 그 owner 키가 폐기돼(과거 시드 정책) 교체조차 막힌다
 * (`OWNER_ALREADY_CONNECTED`). buyer-a는 owner가 NONE이라 우리가 키를 쥔 채 등록할 수 있고,
 * x402 도메인 정책도 이미 갖고 있어 컷 7까지 그대로 이어진다.
 */
export const TOKEN_LIMITS = {
  'buyer-a': { instant_max: '0', notify_max: '5', delay_max: '10' },
  'buyer-b': { instant_max: '5', notify_max: '5', delay_max: '5' },
};

/**
 * 콘티 v3 시나리오의 주인공 바이어. 시드·구매 흐름·검증이 같은 값을 봐야 하므로 여기서 고정한다.
 * 선정 근거는 위 TOKEN_LIMITS 주석 참조(owner 등록 가능 + x402 정책 보유).
 */
export const MAIN_BUYER = 'buyer-a';

/**
 * DELAY 티어 유예 시간(초). 스키마 최소값이 60이라 더 줄일 수 없다
 * (`policy.schema.ts:108`, `z.number().int().min(60)`). 발표에서는 이 60초를 컷 5(승인)
 * 진행 중 백그라운드로 흘려 흡수한다.
 */
export const DELAY_SECONDS = 60;

/** Anchor instruction discriminator (sha256("global:<name>")[..8]). 스파이크 검증값. */
export const DISC = {
  create_auction: [234, 6, 201, 246, 47, 219, 176, 107],
  commit_bid: [149, 237, 198, 113, 53, 66, 70, 76],
  reveal_bid: [48, 73, 28, 255, 202, 126, 236, 196],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
};

/** 서비스 포트. */
export const ORCHESTRATOR_PORT = Number(process.env.ORCHESTRATOR_PORT || 4000);
export const SELLER_PORT = Number(process.env.SELLER_PORT || 4100);

/** 상태·시크릿 파일 경로. */
export const PATHS = {
  demoState: path.join(ROOT, 'demo-state.json'), // provision-wallets.sh 산출 (지갑·세션)
  infraEnv: path.join(ROOT, 'infra/.env'), // 마스터 패스워드
  deployer: path.join(ROOT, 'onchain/deployer.json'), // mint authority + 온체인 셋업 payer
  demoConfig: path.join(ROOT, 'app/demo-config.json'), // 시드 산출 (mint·assetId·policyIds·nextAuctionId)
  fixtures: path.join(__dirname, 'fixtures'),
  resultCache: path.join(ROOT, 'app/result-cache'), // 라운드별 낙찰 결과물 확정 캐시(orchestrator↔seller hash 일관성)
  facilitator: path.join(ROOT, 'app/facilitator-keypair.json'), // x402 feePayer 대납 키 (에이전트 지갑이 아님)
  // 지갑 owner(사람) 서명 키. **승인(컷 5)이 owner 서명을 유일한 경로로 요구해서** 보존한다
  // — 어드민 우회가 없다. 익스텐션 승인 경로가 준비되면 서명 주체가 이 키에서 지갑으로
  // 옮겨가고 이 파일은 사라진다. 그때까지의 임시 보관이다(0600, gitignore).
  owner: path.join(ROOT, 'app/owner-keypair.json'),
};

/** hero 경매 카탈로그 (무대 소품, 스펙 7.1). */
export const AUCTION_ITEM = {
  title: 'Premium Research Slot: Crypto Market Briefing',
  task: 'x402 생태계 채택 현황 브리핑',
  seller: 'Research Specialist Agent',
  /** 판매자 콘솔이 "제공 가능한 능력"으로 노출한다. */
  capabilities: [
    '온체인·오프체인 소스 수집과 정규화',
    '프로토콜 채택 지표 비교 분석',
    '요약 브리핑 마크다운 산출 (해시 고정)',
  ],
  /**
   * 온체인 Auction 계정에는 마감 시각 필드가 없다(state.rs). 가짜 카운트다운을 띄우면
   * 심사위원이 온체인 마감으로 오해하므로, 실제 진행 방식을 그대로 적는다.
   */
  biddingWindow: '운영자 진행 · commit-reveal 1라운드',
};
