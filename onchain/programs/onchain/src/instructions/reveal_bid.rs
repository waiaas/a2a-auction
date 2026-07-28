use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use sha2::{Digest, Sha256};

use crate::{constants::BID_SEED, error::AuctionError, state::*};

#[derive(Accounts)]
pub struct RevealBid<'info> {
    pub bidder: Signer<'info>,

    #[account(mut, has_one = vault)]
    pub auction: Account<'info, Auction>,

    #[account(
        mut,
        seeds = [BID_SEED, auction.key().as_ref(), bidder.key().as_ref()],
        bump,
        has_one = bidder,
    )]
    pub bid: Account<'info, Bid>,

    /// auction.vault 와 일치해야 한다(has_one). 잔고만 읽는다.
    pub vault: Account<'info, TokenAccount>,
}

pub fn handle(ctx: Context<RevealBid>, amount: u64, salt: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.bid.revealed, AuctionError::AlreadyRevealed);
    require!(
        ctx.accounts.auction.status != AuctionStatus::Settled,
        AuctionError::AlreadySettled
    );

    // 커밋 해시 검증: sha256(amount_le(8) || salt(32)) == commit_hash
    let mut hasher = Sha256::new();
    hasher.update(amount.to_le_bytes());
    hasher.update(salt);
    let digest = hasher.finalize();
    require!(
        digest.as_slice() == ctx.accounts.bid.commit_hash.as_slice(),
        AuctionError::HashMismatch
    );

    // 예치 도착 검증(2-tx): vault 잔고가 (total_revealed + amount) 이상이어야 한다.
    let new_total = ctx
        .accounts
        .auction
        .total_revealed
        .checked_add(amount)
        .ok_or(AuctionError::Overflow)?;
    require!(
        ctx.accounts.vault.amount >= new_total,
        AuctionError::DepositNotFound
    );

    // 기록
    ctx.accounts.bid.revealed_amount = amount;
    ctx.accounts.bid.revealed = true;
    ctx.accounts.auction.total_revealed = new_total;
    if ctx.accounts.auction.status == AuctionStatus::Committing {
        ctx.accounts.auction.status = AuctionStatus::Revealing;
    }
    if amount > ctx.accounts.auction.highest_amount {
        ctx.accounts.auction.highest_amount = amount;
        ctx.accounts.auction.winner = Some(ctx.accounts.bidder.key());
    }

    msg!("Revealed {} by {}", amount, ctx.accounts.bidder.key());
    Ok(())
}
