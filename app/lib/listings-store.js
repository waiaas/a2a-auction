/**
 * 카탈로그 리스팅 저장소 (콘티 v3 컷 0·1).
 *
 * fixtures의 기본 리스팅 3종을 바탕으로 하고, MCP `register_skill`로 등록된 것을 위에 얹는다.
 * **등록이 카탈로그에 실제로 반영되어야 컷 0 → 컷 1이 이어진다** — 등록 명령만 보여주고
 * 화면은 정적 목록이면 "누구나 능력을 올릴 수 있다"가 연출로 보인다.
 *
 * 등록분은 파일로 남긴다. 재기동해도 유지되고, 리허설 사이에 지우기도 쉽다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';

const REGISTERED_PATH = path.join(PATHS.fixtures, '..', 'registered-listings.json');

/** fixtures 기본 리스팅. 데모의 5/10/20 3종이 여기 있다. */
function baseListings() {
  return JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, 'listings.json'), 'utf8')).listings;
}

/** 등록분. 파일이 없거나 깨졌으면 빈 배열로 본다(시스템 경계). */
function registeredListings() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTERED_PATH, 'utf8'));
    return Array.isArray(raw.listings) ? raw.listings : [];
  } catch {
    return [];
  }
}

/**
 * 카탈로그 전체. 같은 id면 등록분이 기본을 덮는다 — 데모 중 기본 리스팅 하나를
 * 새 조건으로 다시 올리는 장면도 가능해야 한다.
 */
export function loadCatalog() {
  const base = baseListings();
  const registered = registeredListings();
  const byId = new Map(base.map((l) => [l.id, l]));
  for (const l of registered) byId.set(l.id, l);
  return [...byId.values()].sort((a, b) => a.priceUsdc - b.priceUsdc);
}

/**
 * 리스팅 등록. 최소 필드만 받고 나머지는 기본값으로 채운다 — 데모에서 셀러가 긴 JSON을
 * 치는 장면은 설득력이 없다.
 *
 * @returns {{listing:object, replaced:boolean}}
 */
export function registerListing(input) {
  const id = String(input.id ?? '').trim();
  if (!id) throw new Error('id는 필수다');
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id는 소문자·숫자·하이픈만 쓸 수 있다: ${id}`);

  const priceUsdc = Number(input.priceUsdc);
  if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) throw new Error('priceUsdc는 0보다 큰 수여야 한다');

  const listing = {
    id,
    priceUsdc,
    depth: input.depth ?? 'standard',
    seller: {
      name: input.sellerName ?? 'Unnamed Agent',
      emoji: input.sellerEmoji ?? '🤖',
      persona: input.persona ?? '',
    },
    title: input.title ?? id,
    summary: input.summary ?? '',
    deliverable: {
      format: input.format ?? '마크다운',
      approxWords: Number(input.approxWords ?? 800),
      sourceCount: Number(input.sourceCount ?? 5),
      includes: input.includes ?? [],
    },
    // 신규 등록은 이력이 없다. 0을 그대로 노출한다 — 없는 실적을 지어내면 카탈로그가 거짓이 된다.
    track: { completed: 0, repeatRate: 0, avgMinutes: Number(input.avgMinutes ?? 10) },
    registeredAt: new Date().toISOString(),
  };

  const existing = registeredListings();
  const replaced = existing.some((l) => l.id === id) || baseListings().some((l) => l.id === id);
  const next = [...existing.filter((l) => l.id !== id), listing];

  fs.mkdirSync(path.dirname(REGISTERED_PATH), { recursive: true });
  const tmp = `${REGISTERED_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ listings: next }, null, 2));
  fs.renameSync(tmp, REGISTERED_PATH);

  return { listing, replaced };
}

/** 등록분 전체 삭제(리허설 초기화용). 기본 3종은 fixtures라 영향받지 않는다. */
export function clearRegistered() {
  const count = registeredListings().length;
  fs.rmSync(REGISTERED_PATH, { force: true });
  return count;
}
