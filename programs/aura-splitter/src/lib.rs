//! Aurelia immutable release splitter (UNUSED - do not deploy).
//!
//! Production lock path is Squads v4 + one Streamflow stream to the vault PDA
//! (`src/vesting/createSquads.ts`, `createStreamflowToSquads.ts`,
//! `splitSquadsVault.ts`). Deploying this ~105 KB program costs ~0.7 SOL rent
//! and cancels the SOL savings of consolidating to a single Streamflow create.
//! Leave the crate in-tree for reference; ignore `target/deploy/aura_splitter.so`.
//!
//! Original design (not used on mainnet):
//! 1. `initialize` creates a config PDA + ATA vault owned by that PDA.
//! 2. Streamflow streams locked AURA to the config PDA (automaticWithdrawal).
//! 3. Anyone cranks `split` to pay recipients by immutable share weights.
//!
//! After initialize, recipients and shares cannot change (no update ix).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use spl_token::{instruction::transfer, state::Account as TokenAccount};

pub const MAX_RECIPIENTS: usize = 5;
pub const CONFIG_SEED: &[u8] = b"aura_splitter";

entrypoint!(process_instruction);

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum SplitterInstruction {
    /// Accounts:
    /// 0. `[signer, writable]` payer
    /// 1. `[writable]` config PDA
    /// 2. `[]` mint
    /// 3. `[writable]` vault ATA (PDA owner)
    /// 4. `[]` system program
    /// 5. `[]` token program
    /// 6. `[]` associated token program
    /// 7. `[]` rent sysvar
    Initialize {
        recipients: [Pubkey; MAX_RECIPIENTS],
        shares: [u64; MAX_RECIPIENTS],
    },
    /// Accounts:
    /// 0. `[writable]` config PDA
    /// 1. `[writable]` vault ATA
    /// 2. `[]` token program
    /// 3.. ` [writable]` recipient ATAs (same order as config.recipients)
    ///     + each recipient wallet (for ATA validation owner check via token account)
    Split,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct SplitterConfig {
    pub mint: Pubkey,
    pub bump: u8,
    pub recipient_count: u8,
    pub recipients: [Pubkey; MAX_RECIPIENTS],
    pub shares: [u64; MAX_RECIPIENTS],
    pub share_total: u64,
}

impl SplitterConfig {
    pub const LEN: usize = 32 + 1 + 1 + (32 * MAX_RECIPIENTS) + (8 * MAX_RECIPIENTS) + 8;

    pub fn space() -> usize {
        Self::LEN
    }
}

pub fn config_pda(program_id: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED, mint.as_ref()], program_id)
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let ix = SplitterInstruction::try_from_slice(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        SplitterInstruction::Initialize { recipients, shares } => {
            process_initialize(program_id, accounts, recipients, shares)
        }
        SplitterInstruction::Split => process_split(program_id, accounts),
    }
}

fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    recipients: [Pubkey; MAX_RECIPIENTS],
    shares: [u64; MAX_RECIPIENTS],
) -> ProgramResult {
    let acc = &mut accounts.iter();
    let payer = next_account_info(acc)?;
    let config_ai = next_account_info(acc)?;
    let mint = next_account_info(acc)?;
    let vault = next_account_info(acc)?;
    let system_program = next_account_info(acc)?;
    let token_program = next_account_info(acc)?;
    let ata_program = next_account_info(acc)?;
    let _rent_ai = next_account_info(acc)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut share_total: u64 = 0;
    let mut recipient_count: u8 = 0;
    for i in 0..MAX_RECIPIENTS {
        if shares[i] == 0 {
            // allow trailing unused slots only after first zero
            if recipients[i] != Pubkey::default() {
                return Err(ProgramError::InvalidArgument);
            }
            continue;
        }
        if recipients[i] == Pubkey::default() {
            return Err(ProgramError::InvalidArgument);
        }
        share_total = share_total
            .checked_add(shares[i])
            .ok_or(ProgramError::InvalidArgument)?;
        recipient_count = recipient_count
            .checked_add(1)
            .ok_or(ProgramError::InvalidArgument)?;
    }
    if recipient_count == 0 || share_total == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    // Must be packed: non-zero shares occupy the prefix
    for i in 0..(recipient_count as usize) {
        if shares[i] == 0 || recipients[i] == Pubkey::default() {
            return Err(ProgramError::InvalidArgument);
        }
    }

    let (pda, bump) = config_pda(program_id, mint.key);
    if pda != *config_ai.key {
        msg!("config PDA mismatch");
        return Err(ProgramError::InvalidSeeds);
    }
    if config_ai.lamports() > 0 || !config_ai.data_is_empty() {
        msg!("config already initialized");
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let rent = Rent::get()?;
    let space = SplitterConfig::space();
    let lamports = rent.minimum_balance(space);
    let seeds: &[&[u8]] = &[CONFIG_SEED, mint.key.as_ref(), &[bump]];

    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            config_ai.key,
            lamports,
            space as u64,
            program_id,
        ),
        &[payer.clone(), config_ai.clone(), system_program.clone()],
        &[seeds],
    )?;

    // Create vault ATA owned by config PDA
    invoke(
        &create_associated_token_account_idempotent(
            payer.key,
            config_ai.key,
            mint.key,
            token_program.key,
        ),
        &[
            payer.clone(),
            vault.clone(),
            config_ai.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
            ata_program.clone(),
        ],
    )?;

    let cfg = SplitterConfig {
        mint: *mint.key,
        bump,
        recipient_count,
        recipients,
        shares,
        share_total,
    };
    cfg.serialize(&mut *config_ai.try_borrow_mut_data()?)?;

    msg!(
        "aura_splitter initialized: {} recipients, share_total={}",
        recipient_count,
        share_total
    );
    Ok(())
}

fn process_split(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let acc = &mut accounts.iter();
    let config_ai = next_account_info(acc)?;
    let vault = next_account_info(acc)?;
    let token_program = next_account_info(acc)?;

    if config_ai.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let cfg = SplitterConfig::try_from_slice(&config_ai.try_borrow_data()?)?;
    let (pda, bump) = config_pda(program_id, &cfg.mint);
    if pda != *config_ai.key || bump != cfg.bump {
        return Err(ProgramError::InvalidSeeds);
    }

    let vault_data = TokenAccount::unpack(&vault.try_borrow_data()?)?;
    if vault_data.mint != cfg.mint {
        return Err(ProgramError::InvalidAccountData);
    }
    if vault_data.owner != *config_ai.key {
        return Err(ProgramError::IllegalOwner);
    }

    let balance = vault_data.amount;
    if balance == 0 {
        msg!("vault empty");
        return Ok(());
    }

    let n = cfg.recipient_count as usize;
    let seeds: &[&[u8]] = &[CONFIG_SEED, cfg.mint.as_ref(), &[cfg.bump]];

    // Remaining accounts: for each recipient i: [recipient_ata]
    let rest: Vec<AccountInfo> = acc.cloned().collect();
    if rest.len() != n {
        msg!("expected {} recipient ATAs, got {}", n, rest.len());
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let mut distributed: u64 = 0;
    for i in 0..n {
        let dest = &rest[i];
        let dest_data = TokenAccount::unpack(&dest.try_borrow_data()?)?;
        if dest_data.mint != cfg.mint {
            return Err(ProgramError::InvalidAccountData);
        }
        if dest_data.owner != cfg.recipients[i] {
            msg!("recipient ATA owner mismatch at index {}", i);
            return Err(ProgramError::InvalidAccountData);
        }

        let amount = if i + 1 == n {
            // last bucket gets dust remainder so nothing is stuck
            balance.saturating_sub(distributed)
        } else {
            balance
                .checked_mul(cfg.shares[i])
                .ok_or(ProgramError::InvalidArgument)?
                .checked_div(cfg.share_total)
                .ok_or(ProgramError::InvalidArgument)?
        };

        if amount == 0 {
            continue;
        }

        invoke_signed(
            &transfer(
                token_program.key,
                vault.key,
                dest.key,
                config_ai.key,
                &[],
                amount,
            )?,
            &[
                vault.clone(),
                dest.clone(),
                config_ai.clone(),
                token_program.clone(),
            ],
            &[seeds],
        )?;
        distributed = distributed
            .checked_add(amount)
            .ok_or(ProgramError::InvalidArgument)?;
        msg!("split[{}] => {}", i, amount);
    }

    msg!("split complete, distributed={}", distributed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_math_800m_ratios() {
        let shares = [250u64, 200, 150, 100, 100];
        let total: u64 = shares.iter().sum();
        assert_eq!(total, 800);
        let balance = 33_333_331u64; // ~one monthly unlock in UI units (example)
        let mut parts = [0u64; 5];
        let mut distributed = 0u64;
        for i in 0..4 {
            parts[i] = balance * shares[i] / total;
            distributed += parts[i];
        }
        parts[4] = balance - distributed;
        assert_eq!(parts.iter().sum::<u64>(), balance);
        assert_eq!(parts[0], balance * 250 / 800);
        assert_eq!(parts[1], balance * 200 / 800);
    }
}
