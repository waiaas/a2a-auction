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
