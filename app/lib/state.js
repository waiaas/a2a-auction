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
