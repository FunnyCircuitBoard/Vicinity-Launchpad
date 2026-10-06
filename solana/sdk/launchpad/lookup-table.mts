// The Vicinity address lookup table (LAUNCHPAD-DESIGN.md 9.6, point 4).
//
// A v0 transaction can name up to 256 accounts through lookup tables, each
// costing one byte instead of 32. Launch-plus-first-buy, coin to coin and
// pay-with-anything (Jupiter route plus a curve buy) only fit Solana's
// 1,232-byte limit when the static accounts they share come from a table.
// This module lists those accounts and builds the instructions that create
// and fill the table. The table's authority can add addresses later (new
// configs) or freeze it; it can never move anyone's money.
import web3 from '@solana/web3.js';
import type { AddressLookupTableAccount as AltT } from '@solana/web3.js';
import { ADDRESSES, PROGRAM_IDS, dbc, damm, pdas, ata } from './pda.mjs';
import { COMPUTE_BUDGET_PROGRAM, fromWeb3Instruction } from './trade.mts';
import type { Ix } from './trade.mts';
import type { Address } from './accounts.mts';

const { AddressLookupTableProgram, AddressLookupTableAccount, PublicKey } = web3;

/** Addresses per extend instruction that keep one extend transaction under 1,232 bytes. */
export const EXTEND_CHUNK = 20;

/**
 * The static accounts Vicinity transactions share: programs, Meteora's fixed
 * accounts, our global account, the allowed DBC configs and their launch
 * entries, the quote mints and the dev wallet's referral accounts.
 */
export function launchpadLookupTableAddresses({ dbcConfigs = [], quoteMints = [ADDRESSES.wsol], launchpadProgram = PROGRAM_IDS.launchpad }: { dbcConfigs?: Address[]; quoteMints?: Address[]; launchpadProgram?: Address } = {}): Address[] {
  const P = pdas(launchpadProgram);
  const list = [
    PROGRAM_IDS.system, PROGRAM_IDS.token, PROGRAM_IDS.token2022, PROGRAM_IDS.ata, COMPUTE_BUDGET_PROGRAM, PROGRAM_IDS.metaplex,
    PROGRAM_IDS.dbc, dbc.eventAuthority(), ADDRESSES.dbcPoolAuthority,
    PROGRAM_IDS.damm, damm.eventAuthority(), ADDRESSES.dammPoolAuthority, ADDRESSES.dammCustomizableConfig,
    launchpadProgram, P.launchpad(), PROGRAM_IDS.rewards,
    ADDRESSES.feeRecipient,
    ...quoteMints, ...quoteMints.map((m) => ata(ADDRESSES.feeRecipient, m)),
    ...dbcConfigs, ...dbcConfigs.map((c) => P.launchConfig(c)),
  ];
  return [...new Set(list.map(String))];
}

/**
 * Instructions that create a lookup table and fill it with `addresses`.
 * `recentSlot` must be a recent finalized/confirmed slot (the table address
 * derives from it). A table can be used one slot after its last extension.
 */
export function buildCreateLookupTable({ authority, payer = authority, recentSlot, addresses }: { authority: Address; payer?: Address; recentSlot: number | bigint; addresses: Address[] }): { lookupTable: Address; create: Ix; extends: Ix[] } {
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: new PublicKey(authority), payer: new PublicKey(payer), recentSlot: BigInt(recentSlot) });
  const ext: Ix[] = [];
  for (let i = 0; i < addresses.length; i += EXTEND_CHUNK) {
    ext.push(fromWeb3Instruction(AddressLookupTableProgram.extendLookupTable({
      lookupTable: table, authority: new PublicKey(authority), payer: new PublicKey(payer),
      addresses: addresses.slice(i, i + EXTEND_CHUNK).map((a) => new PublicKey(a)),
    })));
  }
  return { lookupTable: table.toBase58(), create: fromWeb3Instruction(create), extends: ext };
}

/** A lookup table object from known contents (for measuring and compiling without an RPC call). */
export function lookupTableFrom(address: Address, addresses: Address[]): AltT {
  return new AddressLookupTableAccount({
    key: new PublicKey(address),
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addresses.map((a) => new PublicKey(a)) },
  });
}
