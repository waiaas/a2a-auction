use anchor_lang::prelude::*;

use crate::{constants::BID_SEED, error::AuctionError, state::*};

#[derive(Accounts)]
pub struct CommitBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,

    #[account(
        constraint = auction.status == AuctionStatus::Committing @ AuctionError::NotCommitting
    )]
    pub auction: Account<'info, Auction>,

    #[account(
        init,
        payer = bidder,
        space = 8 + Bid::INIT_SPACE,
        seeds = [BID_SEED, auction.key().as_ref(), bidder.key().as_ref()],
        bump
    )]
    pub bid: Account<'info, Bid>,

    pub system_program: Program<'info, System>,
}

pub fn handle(ctx: Context<CommitBid>, commit_hash: [u8; 32]) -> Result<()> {
    let bid = &mut ctx.accounts.bid;
    bid.bidder = ctx.accounts.bidder.key();
    bid.commit_hash = commit_hash;
    bid.revealed_amount = 0;
    bid.revealed = false;

    msg!("Bid committed by {}", bid.bidder);
    Ok(())
}
