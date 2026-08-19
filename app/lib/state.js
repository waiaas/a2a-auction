/**
 * 상태·시크릿 파일 로더. demo-state.json(지갑·세션), infra/.env(마스터 패스워드),
 * deployer.json(온체인 payer), demo-config.json(시드 산출)을 읽고 쓴다.
 *
 * 시크릿은 반환은 하되 화면/로그에 출력하지 않는 것은 호출부 책임이다.
 */
import fs from 'node:fs';
import { PATHS } from '../config.js';
import { Keypair } from './solana.js';

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

/** demo-state.json → { 'buyer-a': {...}, ... } (role 인덱스). */
export function loadStateByRole() {
  const state = readJson(PATHS.demoState);
  return Object.fromEntries(state.map((s) => [s.role, s]));
}

/** infra/.env 파싱 (KEY=VALUE, 따옴표 제거). */
export function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(PATHS.infraEnv, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** role → 마스터 패스워드 env 값 (buyer-a → BUYER_A_MASTER_PASSWORD). */
export function masterPasswordFor(env, role) {
  return env[`${role.toUpperCase().replace(/-/g, '_')}_MASTER_PASSWORD`];
}

/** deployer 키페어 (mint authority + 온체인 셋업 payer). */
export function loadDeployer() {
  return Keypair.fromSecretKey(Uint8Array.from(readJson(PATHS.deployer)));
}

/**
 * 지갑 owner(사람) 서명 키. 시드가 만들어 두고, 승인(컷 5)이 이 키로 서명한다.
 * 없으면 승인 자체가 불가능하므로 조용히 null을 돌려주지 않고 끊는다.
 */
export function loadOwnerKeypair() {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(readJson(PATHS.owner)));
  } catch {
    throw new Error(`owner 키가 없다(${PATHS.owner}) — node seed.js 를 먼저 실행하라`);
  }
}

/** demo-config.json (시드 산출). 없으면 null. */
export function loadConfig() {
  try {
    return readJson(PATHS.demoConfig);
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  writeJson(PATHS.demoConfig, cfg);
}

/**
 * 다음 라운드가 스캔을 시작할 auction_id만 갱신한다.
 *
 * **config 전체를 저장하면 안 되는 이유**: 사용자별 구매는 `buildUserDeps`가 config를 복사해
 * addresses·policies의 주인공 자리에 그 사용자의 에이전트 지갑을 끼운 사본으로 돈다. 그 사본을
 * `saveConfig`로 저장하면 demo-config.json의 buyer-a 항목이 방금 접속한 사용자 값으로 덮여
 * 시드·구 경매 경로가 조용히 남의 지갑을 가리키게 된다. 그래서 파일을 다시 읽어 이 필드만 쓴다.
 */
export function bumpNextAuctionId(next) {
  const cfg = loadConfig();
  if (!cfg) return;
  if (Number(cfg.nextAuctionId || 0) >= next) return; // 동시 라운드가 더 앞서 있으면 되돌리지 않는다
  cfg.nextAuctionId = next;
  writeJson(PATHS.demoConfig, cfg);
}
