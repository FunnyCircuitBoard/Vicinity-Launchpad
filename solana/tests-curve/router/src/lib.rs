//! Test-only mock router for the `vicinity_curve` litesvm suites
//! (VICINITY-CURVE-DESIGN.md 12.5: G02, G03, R02b). Never deployed.
//!
//! Instructions (first byte):
//!
//! * `0` forward: CPI to the program in account 0 with the instruction data
//!   that follows and accounts 1.. passed with their own signer and writable
//!   flags (a router calling `buy` or `sell` for the signing user).
//! * `1 bump` forward as the router's PDA `["router", user_tag]`: the same,
//!   signed with `invoke_signed`, the PDA (one of accounts 1..) marked signer.
//!   `user_tag` is the 8 bytes after the bump; the inner data follows them.
//! * `2 flag amount` R02b: move `amount` lamports directly from account 0
//!   (owned by this program) to account 1 (a WSOL token account), then CPI SPL
//!   Token `SyncNative(account 1)` (token program in account 2), listing only
//!   the vault, as `forward_holders_fees` would have. With flag 1 a CPI that
//!   lists both accounts (a no-op call of this program, account 3) comes first.
//! * `3 amount min_out` a swap that delivers SOL (G03): moves `amount`
//!   lamports from account 1 (a pool owned by this program) to account 2 and
//!   fails when `amount < min_out`, like a swap below its minimum output.
//! * `9` does nothing (the no-op of instruction 2's flag 1).
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process);

fn u64_at(d: &[u8], at: usize) -> Result<u64, ProgramError> {
    let b: [u8; 8] = d
        .get(at..at + 8)
        .ok_or(ProgramError::InvalidInstructionData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(b))
}

fn forward(
    accounts: &[AccountInfo],
    data: &[u8],
    pda: Option<(&Pubkey, &[&[u8]])>,
) -> ProgramResult {
    let (program, rest) = accounts
        .split_first()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let metas = rest
        .iter()
        .map(|a| {
            let signer = a.is_signer || pda.map(|(k, _)| k == a.key).unwrap_or(false);
            if a.is_writable {
                AccountMeta::new(*a.key, signer)
            } else {
                AccountMeta::new_readonly(*a.key, signer)
            }
        })
        .collect();
    let ix = Instruction {
        program_id: *program.key,
        accounts: metas,
        data: data.to_vec(),
    };
    match pda {
        None => invoke(&ix, rest),
        Some((_, seeds)) => invoke_signed(&ix, rest, &[seeds]),
    }
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    let left = from
        .lamports()
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    let credited = to
        .lamports()
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    **from.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = credited;
    Ok(())
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => forward(accounts, &data[1..], None),
        Some(1) => {
            let bump = *data.get(1).ok_or(ProgramError::InvalidInstructionData)?;
            let tag = data
                .get(2..10)
                .ok_or(ProgramError::InvalidInstructionData)?;
            let seeds: &[&[u8]] = &[b"router", tag, &[bump]];
            let pda = Pubkey::create_program_address(seeds, program_id)?;
            forward(accounts, &data[10..], Some((&pda, seeds)))
        }
        Some(2) => {
            let flag = *data.get(1).ok_or(ProgramError::InvalidInstructionData)?;
            let amount = u64_at(data, 2)?;
            let [source, vault, token_program, rest @ ..] = accounts else {
                return Err(ProgramError::NotEnoughAccountKeys);
            };
            if source.owner != program_id {
                return Err(ProgramError::IllegalOwner);
            }
            move_lamports(source, vault, amount)?;
            if flag == 1 {
                let me = rest.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
                let ix = Instruction {
                    program_id: *program_id,
                    accounts: vec![
                        AccountMeta::new(*source.key, false),
                        AccountMeta::new(*vault.key, false),
                    ],
                    data: vec![9],
                };
                invoke(&ix, &[source.clone(), vault.clone(), me.clone()])?;
            }
            let ix = Instruction {
                program_id: *token_program.key,
                accounts: vec![AccountMeta::new(*vault.key, false)],
                data: vec![17],
            };
            invoke(&ix, &[vault.clone(), token_program.clone()])
        }
        Some(3) => {
            let amount = u64_at(data, 1)?;
            let min_out = u64_at(data, 9)?;
            let [pool, to, ..] = accounts else {
                return Err(ProgramError::NotEnoughAccountKeys);
            };
            if pool.owner != program_id {
                return Err(ProgramError::IllegalOwner);
            }
            if amount < min_out {
                return Err(ProgramError::Custom(1)); // below the swap's minimum output
            }
            move_lamports(pool, to, amount)
        }
        Some(9) => Ok(()),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
