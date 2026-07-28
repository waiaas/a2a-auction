use anchor_lang::prelude::*;

#[error_code]
pub enum AuctionError {
    #[msg("Auction is not in the Committing phase")]
    NotCommitting,
    #[msg("Auction is already settled")]
    AlreadySettled,
    #[msg("Reveal hash does not match the committed hash")]
    HashMismatch,
    #[msg("Bid has already been revealed")]
    AlreadyRevealed,
    #[msg("Vault balance is insufficient: deposit has not arrived")]
    DepositNotFound,
    #[msg("Arithmetic overflow")]
    Overflow,
}
