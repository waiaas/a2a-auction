# a2a-auction 데모 백엔드 (D-5)

컨트랙트 데모 경로 + 오케스트레이터 상태 머신 + seller 서비스 + Gemini(폴백 캐시). WAIaaS 데몬 5개는 API로만 사용한다(무수정).

## 사전 조건

- 데몬 5개 기동 (`infra/docker-compose.yml`), `demo-state.json`·`infra/.env` 존재
- localnet 밸리데이터 기동 + 프로그램 배포 (`9nUhQbyNxmeZWpfxTmfP3U3fQ9GYtVnyP5WW1CVCYctV`)
  - 재기동: `solana-test-validator --bind-address <호스트 LAN IP> --rpc-port 8899 --reset` (0.0.0.0은 gossip 패닉)
  - 재배포: `solana program deploy target/deploy/onchain.so --program-id target/deploy/onchain-keypair.json --keypair deployer.json --url http://<LAN IP>:8899`
- `node install` (`npm install`) 완료
- 데몬/localnet 호출은 루프백·LAN 차단 때문에 **샌드박스 해제** 필요

## 실행 순서

```bash
node seed.js          # 멱등: mint·ATA·fund·정책·B owner verify → demo-config.json
node orchestrator.js  # :4000  /api/auction/{start,state,receipt,reset}
node seller.js        # :4100  /slot/:auctionId/result (미정산 403)
bash verify-e2e.sh    # curl 전 플로우 완주 판정 (D-5 완료 판정)
```

빠른 단발 실행(서버 없이 플로우 코어만):

```bash
node demo-path.js     # create→commit×3→deposit×3→reveal A→settle 한 번에
```

## 3분기 (스펙 2.3)

| buyer | bid | 예치 판정 | 근거 |
| --- | --- | --- | --- |
| A (Analyst) | 2.80 | ALLOW | tier NOTIFY 자동 실행 (오라클 notListed 격상, UI는 ALLOW) |
| B (Growth) | 6.50 | APPROVAL_REQUIRED | 한도(5) 초과 + owner verified → QUEUED |
| C (Experimental) | 2.20 | DENY | WHITELIST에 auction_pda 없음 (commit만 통과) |

## 환경 변수 (선택)

- `RPC_URL` (기본 `http://192.168.0.113:8899`)
- `GEMINI_API_KEY` — 설정 시 라이브 생성, 없으면 `fixtures/` 캐시로 폴백
- `ORCHESTRATOR_PORT`(4000) / `SELLER_PORT`(4100)
