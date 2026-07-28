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

/** localnet RPC. infra/.env의 LOCALNET_RPC와 동일해야 데몬과 같은 체인을 본다. */
export const RPC_URL = process.env.RPC_URL || 'http://192.168.0.113:8899';

/** 배포된 경매 프로그램 (D-6 게이트 ②). */
export const PROGRAM_ID = '9nUhQbyNxmeZWpfxTmfP3U3fQ9GYtVnyP5WW1CVCYctV';

/** solana-devnet의 CAIP-2 (데몬이 이 네트워크로 매핑). token_limits/assetId 키 구성에 사용. */
export const CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const NETWORK = 'solana-devnet';

export const USDC_DECIMALS = 6;

/** buyer별 입찰·예치 금액 (base units, 6dec). 스펙 2.3절 고정값. */
export const AMOUNTS = {
  'buyer-a': 2_800_000n, // 2.80 USDC
  'buyer-b': 6_500_000n, // 6.50 USDC
  'buyer-c': 2_200_000n, // 2.20 USDC
};

/** 시드가 각 buyer ATA를 채워 두는 목표 잔고 (여러 라운드분). 부족분만 mint. */
export const FUND_TARGET = {
  'buyer-a': 30_000_000n, // 30 USDC (≈10라운드)
  'buyer-b': 10_000_000n, // 10 USDC (B는 예치 불발이라 소모 없음)
  'buyer-c': 10_000_000n, // 10 USDC (C도 거부라 소모 없음)
};

/**
 * token_limits (human-readable, SPENDING_LIMIT). 스파이크 검증값.
 * A: 2.80 ≤ 3 → INSTANT 티어지만 오라클 notListed로 NOTIFY 격상(자동 실행).
 * B: 6.50 > 5(delay_max) → APPROVAL(owner verified 필수) → QUEUED.
 */
export const TOKEN_LIMITS = {
  'buyer-a': { instant_max: '3', notify_max: '3', delay_max: '3' },
  'buyer-b': { instant_max: '5', notify_max: '5', delay_max: '5' },
};

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
};

/** hero 경매 카탈로그 (무대 소품, 스펙 7.1). */
export const AUCTION_ITEM = {
  title: 'Premium Research Slot: Crypto Market Briefing',
  task: 'x402 생태계 채택 현황 브리핑',
  seller: 'Research Specialist Agent',
};
