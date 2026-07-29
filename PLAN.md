# Policy-Bound A2A Auction — 개발 체크리스트

> 팀 트래커 (Jira 미사용). 정본 스펙: `ai-agent-hackathon/2026-07-27-a2a-auction-spec-team-review.md` (v3).
> 결정 이력: `docs/DECISIONS.md`. **제출 마감: 8/3(일) 23:59 KST.**
> 빌드 순서 원칙: 코어 루프(3분기 + 정산 + receipt)가 돌기 전에는 주변 장치에 손대지 않는다.

## 게이트 (D-6 스파이크, 7/28)
- [x] **게이트 ①** 오라클 devnet USDC USD 환산 → 실패 확인 → **USDC 유지 + 예치 2-tx 분리 + token_limits**로 전환 (DECISIONS·스펙 기록)
- [x] **게이트 ②** Anchor 최소 프로그램(create/commit/reveal/settle) build + 로컬 e2e(litesvm) + **localnet 배포** (에스크로 폴백 불필요)
- [x] **3분기 온체인 실측** (A 실행 / B QUEUED / C POLICY_DENIED) — localnet 완주·독립 검증 ✅ (seller +2.8 USDC, vault 0, auction Settled·winner=A)

## 스파이크 마무리 (즉시)
- [x] a2a-auction 작업 브랜치 커밋(`feat/d6-risk-spike`) → **draft PR** 생성
- [x] 세션 노트 작성 (`docs/sessions/2026-07-28-hackathon-d6-spike.md`)
- [ ] 팀 채널에 스파이크 결과 공유 (게이트 2개 판정 + 3분기 tx) ← 사용자 몫

## D-5 (7/29 화) 컨트랙트·백엔드 ✅ (`feat/d5-contract-orchestrator`, curl 완주)
- [x] 경매 프로그램 데모 경로 완성 (`app/demo-path.js` — create→commit→예치→reveal→settle 통합 실행)
- [x] 경매 오케스트레이터 상태 머신 (`app/orchestrator.js` :4000 — start/state/receipt/reset)
- [x] seller 서비스 (`app/seller.js` :4100 — 온체인 Settled·winner 확인 후 200, 미정산 403)
- [x] Gemini 연동 (`app/lib/gemini.js` — 견적·rationale·result, 라이브 REST + `fixtures/` 폴백 캐시)
- [x] 시드 스크립트·픽스처 (`app/seed.js` 멱등, **B owner verify 포함** — 이미 verified면 스킵)
- [x] 완료 판정: **curl로 전 플로우 완주** (`app/verify-e2e.sh` PASS — A ALLOW / B APPROVAL / C DENY, settle·unlock)
- 메모: 라운드별 auction_id 증가 + A·B WHITELIST에 auction_pda `PUT` 갱신(정책 엔진이 tx마다 DB 재조회 → 즉시 반영). deployer 키는 시드 전용(오케스트레이터/seller는 데몬 API+읽기 전용).

## D-4 (7/30 수) 웹 UI ✅ (`feat/d4-web-ui`, PR #6 draft)
- [x] 경매 스테이지 화면 (commit·예치 배지, DIY vs BUY 칩, RAW vs EXECUTABLE 배너) — v4 글래스 경매하우스로 구현
- [x] B 승인대기 연출 (owner 알림 장면)
- 완료 판정: **브라우저에서 3분기 시연** ✅ (`:4000` 정적서빙, Start 버튼 1개로 라운드 #6 완주: A ALLOW / B APPROVAL / C DENY)
- 메모: UI 톤 v1→v5 반복 후 팀이 **v4(글래스모피즘 경매하우스)** 확정. 오케스트레이터 `express.static` + dev `vite proxy`. 확정 디자인 에셋 `app/web/design/`. seller unlock 내용·Receipt 뷰는 D-3.

## D-3 (7/31 목) Receipt·통합 ✅ (`feat/d3-receipt`)
- [x] Receipt/Audit 뷰 (증거 체인 + 데몬별 감사 로그 원본) — v4 글래스 톤, App `view` 전환
- [x] result unlock (온체인 정산 확인 후 공개) — seller `/slot` relay, hash ✓ receipt 일치. **요청자 신원 검증은 미구현**(게이트는 온체인 `Settled`·`winner`뿐 = 시간 게이트). 정산 후에는 요청자를 가리지 않음 → README 실물/연출 표에 명시, 낙찰자 서명 요구는 하드닝 로드맵
- [x] e2e 통합 (브라우저 `:4000` 정산 후 Receipt 완주) — 컨트랙트 환불→마감→유찰은 미착수(스트레치)
- 완료 판정: **스펙 6장 완성 기준 충족** ✅
- 메모: 백엔드 기존 완비 → 프론트 중심. seller `/slot` 프록시 2곳(dev vite / prod 오케스트레이터 relay). receipt에 `budget`(A 위임 한도 대비 지출) 추가.
- 후속 정리 ✅ (7/29): **PR #7**(Receipt 뷰) → **PR #8**(M2 결과물 hash 일관성 = auctionId별 파일 캐시로 orchestrator 확정본을 seller가 재사용 + C 거부 사유 축약) → **PR #9**(M2 잔여 = `seed.js`에서 결과물 캐시 자동 무효화). 전부 main 머지.
- DIY 칩 줄바꿈 백로그 ✅ **종결** — 코드에 DIY 칩 없음(`mandateChip`만), 1280/390/320px 실측 결과 전 폭에서 넘침·클리핑 없음.

## D-2 (8/1 금) 배포·리허설 — **자원 대기로 보류**
- [ ] **devnet 공개 배포** (explorer 링크용): deployer `BtsvpHpPP3CFvTZR8T6C1ru6TCmGp4xS56gSAzuYrM2q`에 devnet SOL + Circle devnet USDC mint 확정
- [ ] Cloud Run (웹+오케스트레이터+seller) + Secret Manager
- [ ] 리허설 2회
- 완료 판정: **라이브 URL에서 데모 완주**
- **차단 사유(7/29)**: devnet SOL·Circle mint·GCP 계정 모두 미확보(사용자 입력 필요). SOL은 요청 시 제공 가능하나 정확한 소요량 산정 후 요청 예정.
- 메모: 제출물 5종 중 **SOL이 실제로 막는 것은 "devnet tx·explorer 링크" 1종뿐**. README·피치덱·원페이저·데모영상(localnet 촬영)은 자원 없이 진행 가능 → D-1을 먼저 착수.

## D-1 (8/2 토) 제출물 — **선행 착수 중**
- [ ] 데모 영상 3분 (촬영본) ← localnet으로 촬영 가능(자원 불요)
- [x] **README** ✅ (7/29, draft PR [#10](https://github.com/waiaas/a2a-auction/pull/10), 352줄) — 문제정의→아키텍처→WAIaaS control plane 확장→실행법→실물/연출→하드닝. **tx 증거 링크는 devnet 배포 후 채울 TODO로 자리만 확보**
- [ ] 원페이저 + 피치덱 (스펙 8장 스크립트 기반)
- 메모: README 교차검증에서 스펙·PLAN 서술 오류 2건 적발 → 아래 "후속 이슈" 항목에 정정 반영함.

## D-0 (8/3 일) 제출
- [ ] 버퍼 + 최종 제출 (23:59 KST 전)

---

## 스파이크에서 나온 후속 이슈 (놓치면 데모가 깨짐)

> D-5에서 전부 코드에 반영 완료. 아래는 **재현·이관 시 반드시 지켜야 할 제약** 목록이다.
> ⚠️ 표시는 2026-07-29 README 교차검증에서 **기존 서술이 틀린 것으로 밝혀져 정정한 항목**.

- [x] 시드에 B owner **verify까지** 포함
  - ⚠️ **정정**: "등록만 하면 강등됨"은 **틀림**. 강등 조건은 owner가 **아예 없을 때(`NONE`)** 뿐이다(`WAIaaS/packages/daemon/src/workflow/owner-state.ts:225`). 등록했지만 미verify인 `GRACE`는 강등되지 않는다. 다만 데모는 `LOCKED`로 고정하는 것이 결정론적이라 verify까지 수행하고, `LOCKED`가 아니면 시드가 중단된다.
- [x] 예치는 반드시 **단독 TOKEN_TRANSFER (2-tx)**. batch는 token_limits를 무시함
- [x] 예치 TOKEN_TRANSFER의 `to`는 vault ATA가 아니라 **auction_pda(=vault owner)** (WAIaaS가 owner→ATA 유도). **WHITELIST 대상도 auction_pda**
- [x] **commit_bid(CONTRACT_CALL)도 WHITELIST 평가를 거침** → C는 WHITELIST에 programId만 넣고 auction_pda 제외해야 "commit 통과 + deposit 거부"가 성립
  - ⚠️ **정정**: "WHITELIST 아예 없으면 deposit이 그냥 실행됨"은 **절반만 맞다**. 정확히는 **WHITELIST 정책 자체를 등록하지 않으면** 심사가 생략되어 실행된다(`evaluators/allowed-tokens.ts:25` `if (!whitelist) return null`). 반면 **빈 배열로 두면 스키마 위반(`policy.schema.ts:179` `min(1)`)이라 트랜잭션이 실패**한다. 둘은 다른 결과다.
- [x] TOKEN_TRANSFER 요청에 `token.assetId`(CAIP-19)를 실어야 token_limits 수량 티어가 걸림
- [x] token_limits 키(CAIP-19 assetId)가 TOKEN_TRANSFER의 assetId와 **정확히 일치**해야 수량 티어가 걸림
- [x] A는 INSTANT가 아니라 **NOTIFY로 통과**(devnet/local USDC는 notListed→NOTIFY 격상). 자동 실행은 동일 → UI는 "ALLOW"로 표기, 서사 영향 없음
- [ ] devnet↔localnet 전환
  - ⚠️ **정정**: "데몬 env 하나만 바꾸면 됨"은 **틀림**. 데몬은 `LOCALNET_RPC`(→`WAIAAS_RPC_SOLANA_DEVNET`), **앱(시드·오케스트레이터·seller)은 별도로 `RPC_URL`** 을 읽는다(`app/config.js:15-16`). **두 값이 같은 체인을 가리켜야** 하며, 어긋나면 데몬이 보낸 tx를 앱이 조회하지 못해 라운드가 멈춘다. devnet 이관 시 프로그램 재배포·USDC mint 재생성도 필요.
- [ ] (제품 로드맵, 스펙 부록 A) dApp 어댑터 / 승인 타임아웃 vs 경매 마감 정합

## 알려진 이슈 (데모 후 처리, GitHub 이슈로 트래킹)
- [ ] [#4](https://github.com/waiaas/a2a-auction/issues/4) [High] **예치금 도용** — 예치가 프로그램 밖 전송(2-tx)이라 `Bid`에 per-bidder 예치 기록이 없고 `reveal_bid`가 vault **전역 잔고**만 검증. 데모는 A만 성공하는 순서라 재현 안 됨.
- [ ] [#5](https://github.com/waiaas/a2a-auction/issues/5) [Med] **환불 없음** — settle이 winner highest만 지급, 패자·초과 예치는 vault에 잠김.
- 두 이슈 모두 **데모 전 근본 수정하지 않기로 결정**(2026-07-28). 근본 해소(per-bidder 예치 추적)는 2-tx 분리·token_limits 정책 설계와 얽혀 마감 전 회귀 위험이 큼. README "Production hardening"에 의도적 후순위로 명시함.

## 제출 직전 체크리스트 (D-0)
- [ ] **레포 PRIVATE → public 전환** (제출 요건). 커밋된 시크릿 0건 확인 완료(`deployer.json`은 `onchain/.gitignore:11`로 제외). **사용자가 "준비되면" 전환 지시 예정**
- [ ] README 온체인 증거 표에 devnet tx signature·explorer 링크 채우기
- [ ] `onchain/Anchor.toml`의 `wallet` 절대경로(작성자 로컬) 정리 검토

## 로컬 개발 메모
- **localnet 밸리데이터**: `solana-test-validator --bind-address <호스트 LAN IP> --rpc-port 8899 --reset` (0.0.0.0은 gossip 패닉으로 불가). 컨테이너는 그 LAN IP로 접근.
- **프로그램 재배포**(같은 ID 유지): `solana program deploy target/deploy/onchain.so --program-id target/deploy/onchain-keypair.json --keypair deployer.json --url http://<LAN IP>:8899`. `onchain-keypair.json`이 없으면 새 ID가 생겨 `declare_id!`·`Anchor.toml`·`app/config.js` 3곳을 함께 갱신해야 함(`onchain/target/`은 gitignore).
- **onchain 테스트**: `anchor build` **선행 필수** 후 `cargo test`. `tests/happy_path.rs`가 컴파일 타임에 `.so`를 `include_bytes!`로 읽음.
- 데몬 API(127.0.0.1:3100~3104)·localnet 호출은 **샌드박스 해제** 필요(루프백 차단).
- **밸리데이터는 Claude가 직접 백그라운드 기동 가능**(scratchpad ledger, `run_in_background`+`dangerouslyDisableSandbox`) — 사용자 `!` 불필요. 단 세션 종료 시 함께 죽음.
- **리부팅 후 복구 순서**: `open -a Docker` → `cd infra && docker compose --env-file .env up -d`(지갑·정책·owner는 volume에 persist) → 밸리데이터 기동 → deployer airdrop → 프로그램 재배포 → `node seed.js` → 오케스트레이터·seller 기동.
- devnet 공용 faucet airdrop 차단됨 → localnet 무제한 airdrop 또는 보유 devnet SOL 분배.
- 시크릿은 `.gitignore`로 제외: `infra/.env`, `demo-state.json`, `onchain/deployer.json`(후자는 `onchain/.gitignore:11`).
- `settlement.sellerUsdc`는 seller ATA **누적값**(라운드 반복 시 증가). 라운드별 실제 정산액은 `bidAmountUsdc`.
