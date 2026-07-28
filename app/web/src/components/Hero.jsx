import HeaderBar from './HeaderBar.jsx';
import PriceBlock from './PriceBlock.jsx';
import BidTile from './BidTile.jsx';
import SpecTiles from './SpecTiles.jsx';
import { orderedBuyers, statusPill, phaseLabel } from '../lib/derive.js';

/** hero 글래스 카드: featured "지금 라이브" 경매 = 실제 3-way policy 경매. */
export default function Hero({ state, onStart, starting, onOpenReceipt }) {
  const buyers = orderedBuyers(state.buyers);
  const sp = statusPill(state.phase);
  const item = state.item;

  return (
    <div className="hero glass">
      <HeaderBar onOpenReceipt={onOpenReceipt} />

      <div className="htop">
        <div>
          <div className="status">
            <span className={`pill ${sp.cls}`}><span className="d" />{sp.label}</span>
            <span className="meta">
              Auction {state.auctionId != null ? `#${state.auctionId}` : '—'} · on-chain · localnet · {phaseLabel(state.phase)}
            </span>
          </div>
          <h1 className="title">{item?.title || 'Premium Research Slot: Crypto Market Briefing'}</h1>
          <div className="subid">
            {state.auctionId != null ? `#${state.auctionId} · ` : ''}위임 태스크: {item?.task || 'x402 생태계 채택 현황 브리핑'}
          </div>
        </div>
        <div className="desc">
          출품 · 🔬 {item?.seller || 'Research Specialist Agent'}. 낙찰 에이전트가 온체인 정산 증명으로 결과물을 unlock 합니다. 최고가가 아니라 권한 있는 bid만 실행됩니다. <span className="more">Read more →</span>
        </div>
      </div>

      <div className="hmid">
        <PriceBlock state={state} onStart={onStart} starting={starting} onOpenReceipt={onOpenReceipt} />
        <div className="bids">
          {buyers.length
            ? buyers.map((b) => <BidTile key={b.role} buyer={b} />)
            : <div className="feed-empty">Start Round을 눌러 3자 정책 경매를 시작하세요.</div>}
        </div>
      </div>

      <SpecTiles state={state} />
    </div>
  );
}
