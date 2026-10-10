/**
 * The instructions of the admin "City coins" tab (src/lpadmin.js), built in the Worker without anchor or web3.js: setup (the
 * rewards registry and the launchpad, the hand-over of both programs to the owner's Squads vault, the Meteora price curve, its
 * allow-list entry, the dev wallet's fee accounts, the speed table, Vicinity's name on Meteora), per city (approve, revoke, holder
 * rewards, collecting and forwarding fees, pausing launches) and the dev wallet's platform-fee claims. Every builder is async (PDAs
 * through WebCrypto) and returns { programAddress, accounts: [{ address, role }], data } with role 0 read-only, 1 writable,
 * 2 read-only signer, 3 writable signer, in the account order of the programs' IDLs. The discriminators are the IDLs' own
 * (sha256("global:<name>")[..8]); test/lpadmin.test.js checks them against the IDL files and solana/tests-launchpad/17 checks every
 * builder against the SDK's anchor-built instructions and runs it against the real programs in litesvm.
 * Our program ids come from the settings (src/cluster.js lpSetup), never from here.
 */
import { base58Decode } from "../solana.js";
import { concat, fromBase64, u16le, u32le, u64le } from "./bytes.js";
import { ADDRESSES, PROGRAM_IDS, ata, dbc, findProgramAddress, launchpad as launchpadPdas, programDataAddress } from "./pda.js";
import { CREATE_CONFIG_DATA } from "./dbc-config-data.js";

export const Role = Object.freeze({ R: 0, W: 1, RS: 2, WS: 3 });
const enc = new TextEncoder();
const b = (a) => base58Decode(a);
const addr = async (seeds, programId) => (await findProgramAddress(seeds, programId))[0];
const meta = (address, role) => ({ address, role });

/** sha256("global:<name>")[..8] of every instruction built here, as in the IDLs (test/lpadmin.test.js checks them). */
export const DISCRIMINATORS = Object.freeze({
  init_launchpad: [114, 181, 7, 128, 0, 24, 234, 119],
  add_launch_config: [178, 122, 32, 119, 221, 205, 141, 74],
  approve_launch: [170, 53, 90, 11, 30, 13, 94, 205],
  revoke_approval: [44, 51, 184, 108, 182, 202, 20, 53],
  set_pause: [63, 32, 154, 2, 56, 103, 79, 45],
  harvest_curve_fees: [118, 229, 208, 190, 86, 99, 210, 89],
  harvest_pool_fees: [220, 111, 249, 100, 4, 231, 179, 83],
  forward_holders_fees: [186, 118, 17, 159, 254, 15, 108, 10],
  init_registry: [131, 22, 4, 103, 24, 94, 163, 239],
  init_city: [178, 113, 156, 92, 100, 81, 140, 222],
  create_config: [201, 207, 243, 114, 75, 111, 47, 189],
  create_partner_metadata: [192, 168, 234, 191, 188, 226, 227, 255],
  claim_trading_fee: [8, 236, 89, 49, 152, 125, 177, 81],
  claim_partner_pool_creation_fee: [250, 238, 26, 4, 139, 10, 101, 248],
  partner_withdraw_surplus: [168, 173, 72, 100, 201, 98, 38, 92],
  claim_position_fee: [180, 38, 154, 17, 133, 33, 162, 211],
});
const disc = (name) => Uint8Array.from(DISCRIMINATORS[name]);
const str = (s) => { const x = enc.encode(s); return concat([u32le(x.length), x]); };
const i64le = (n) => u64le(BigInt.asUintN(64, BigInt(n)));
const U64_MAX = (1n << 64n) - 1n;

/** Vicinity's partner entry on Meteora (what Meteora's and Jupiter's pages show for our configs). */
export const VICINITY_PARTNER = Object.freeze({ name: "Vicinity", website: "https://vicinity.city", logo: "https://vicinity.city/brand/vicinity-512.png" });

/* ---------------------------------------------------------------- addresses */
/** vicinity_rewards addresses (its constants.rs). */
export function rewards(programId) {
  return {
    registry: () => addr([enc.encode("registry")], programId),
    city: (mint) => addr([enc.encode("city"), b(mint)], programId),
    vault: (config) => addr([enc.encode("vault"), b(config)], programId),
  };
}
/** Meteora DAMM v2 addresses. */
export const damm = {
  eventAuthority: () => addr([enc.encode("__event_authority")], PROGRAM_IDS.damm),
  pool(config, mintA, mintB) {
    const x = b(mintA), y = b(mintB);
    let cmp = 0;
    for (let i = 0; i < 32 && cmp === 0; i++) cmp = x[i] - y[i];
    const [hi, lo] = cmp > 0 ? [x, y] : [y, x];
    return addr([enc.encode("pool"), b(config), hi, lo], PROGRAM_IDS.damm);
  },
  tokenVault: (mint, pool) => addr([enc.encode("token_vault"), b(mint), b(pool)], PROGRAM_IDS.damm),
  position: (nftMint) => addr([enc.encode("position"), b(nftMint)], PROGRAM_IDS.damm),
  positionNftAccount: (nftMint) => addr([enc.encode("position_nft_account"), b(nftMint)], PROGRAM_IDS.damm),
};
/** The graduated pool of a coin: DBC migrates into the DAMM v2 pool of (customizable config, coin, quote token). */
export const canonicalPool = (mint, quoteMint) => damm.pool(ADDRESSES.dammCustomizableConfig, mint, quoteMint);
/** Meteora's partner metadata account of a fee claimer. */
export const partnerMetadataAddress = (feeClaimer = ADDRESSES.feeRecipient) => addr([enc.encode("partner_metadata"), b(feeClaimer)], PROGRAM_IDS.dbc);
/** An address lookup table: [authority, recent slot (u64 LE)] under the lookup-table program. [address, bump]. */
export const lookupTableAddress = (authority, recentSlot) => findProgramAddress([b(authority), u64le(recentSlot)], PROGRAM_IDS.lookupTable);
/**
 * The city tag of a city's rewards config: the program takes printable ASCII padded with zero bytes (validate_city_tag), so it is
 * "vicinity:city:<city id>" (at most 32 bytes; "city:<id>" for an id too long for that), zero padded to 32 bytes.
 */
export function cityTag(cityId) {
  const id = BigInt(cityId).toString();
  const text = `vicinity:city:${id}`.length <= 32 ? `vicinity:city:${id}` : `city:${id}`;
  const out = new Uint8Array(32);
  out.set(enc.encode(text));
  return out;
}

/* ---------------------------------------------------------------- setup */
/** vicinity_rewards init_registry: payer, upgrade authority and admin sign (one wallet on the website). */
export async function initRegistry({ rewardsProgramId, payer, upgradeAuthority, admin }) {
  return {
    programAddress: rewardsProgramId,
    accounts: [
      meta(payer, Role.WS), meta(upgradeAuthority, Role.RS), meta(admin, Role.RS), meta(rewardsProgramId, Role.R),
      meta(await programDataAddress(rewardsProgramId), Role.R), meta(await rewards(rewardsProgramId).registry(), Role.W), meta(PROGRAM_IDS.system, Role.R),
    ],
    data: Uint8Array.from(DISCRIMINATORS.init_registry),
  };
}
/** vicinity_launchpad init_launchpad: payer, admin and the program's upgrade authority sign; records the rewards program. */
export async function initLaunchpad({ programId, rewardsProgramId, payer, admin, upgradeAuthority }) {
  return {
    programAddress: programId,
    accounts: [
      meta(payer, Role.WS), meta(admin, Role.RS), meta(upgradeAuthority, Role.RS), meta(await programDataAddress(programId), Role.R),
      meta(rewardsProgramId, Role.R), meta(await launchpadPdas(programId).launchpad(), Role.W), meta(PROGRAM_IDS.system, Role.R),
    ],
    data: Uint8Array.from(DISCRIMINATORS.init_launchpad),
  };
}
/**
 * The upgradeable loader's SetAuthority (instruction 4, the unchecked kind: the new authority, a Squads vault, cannot co-sign
 * SetAuthorityChecked): ProgramData writable, the current authority signs, the new authority read-only.
 */
export async function setUpgradeAuthority({ programId, currentAuthority, newAuthority }) {
  return {
    programAddress: PROGRAM_IDS.upgradeableLoader,
    accounts: [meta(await programDataAddress(programId), Role.W), meta(currentAuthority, Role.RS), meta(newAuthority, Role.R)],
    data: u32le(4),
  };
}
/** Meteora DBC create_config of the Vicinity defaults (src/sol/dbc-config-data.js); `config` is a one-time browser key. */
export async function createConfig({ config, payer, quoteMint = ADDRESSES.wsol }) {
  return {
    programAddress: PROGRAM_IDS.dbc,
    accounts: [
      meta(config, Role.WS), meta(ADDRESSES.feeRecipient, Role.R), meta(ADDRESSES.feeRecipient, Role.R), meta(quoteMint, Role.R),
      meta(payer, Role.WS), meta(PROGRAM_IDS.system, Role.R), meta(await dbc.eventAuthority(), Role.R), meta(PROGRAM_IDS.dbc, Role.R),
    ],
    data: fromBase64(CREATE_CONFIG_DATA),
  };
}
/** vicinity_launchpad add_launch_config: the admin allow-lists a DBC config (the program checks every Vicinity rule). */
export async function addLaunchConfig({ programId, admin, payer = admin, dbcConfig, quoteMint = ADDRESSES.wsol }) {
  const L = launchpadPdas(programId);
  return {
    programAddress: programId,
    accounts: [
      meta(admin, Role.RS), meta(payer, Role.WS), meta(await L.launchpad(), Role.R), meta(dbcConfig, Role.R), meta(quoteMint, Role.R),
      meta(await L.launchConfig(dbcConfig), Role.W), meta(PROGRAM_IDS.system, Role.R),
    ],
    data: Uint8Array.from(DISCRIMINATORS.add_launch_config),
  };
}
/** Meteora DBC create_partner_metadata: the fee claimer (the dev wallet) signs; about 0.002 SOL of rent, once. */
export async function createPartnerMetadata({ payer, feeClaimer = ADDRESSES.feeRecipient, partner = VICINITY_PARTNER }) {
  return {
    programAddress: PROGRAM_IDS.dbc,
    accounts: [
      meta(await partnerMetadataAddress(feeClaimer), Role.W), meta(payer, Role.WS), meta(feeClaimer, Role.RS), meta(PROGRAM_IDS.system, Role.R),
      meta(await dbc.eventAuthority(), Role.R), meta(PROGRAM_IDS.dbc, Role.R),
    ],
    data: concat([disc("create_partner_metadata"), new Uint8Array(96), str(partner.name), str(partner.website), str(partner.logo)]),
  };
}
/** Address lookup table: create (the address derives from authority + recent slot; the bump goes in the data). */
export async function createLookupTable({ authority, payer = authority, recentSlot }) {
  const [table, bump] = await lookupTableAddress(authority, recentSlot);
  return {
    table,
    ix: {
      programAddress: PROGRAM_IDS.lookupTable,
      accounts: [meta(table, Role.W), meta(authority, Role.RS), meta(payer, Role.WS), meta(PROGRAM_IDS.system, Role.R)],
      data: concat([u32le(0), u64le(recentSlot), Uint8Array.of(bump)]),
    },
  };
}
/** Addresses per extend instruction (each extend instruction stays well inside one transaction). */
export const EXTEND_CHUNK = 20;
/** Address lookup table: extend with up to EXTEND_CHUNK addresses. */
export function extendLookupTable({ table, authority, payer = authority, addresses }) {
  if (!addresses.length || addresses.length > EXTEND_CHUNK) throw new Error("bad_extend");
  return {
    programAddress: PROGRAM_IDS.lookupTable,
    accounts: [meta(table, Role.W), meta(authority, Role.RS), meta(payer, Role.WS), meta(PROGRAM_IDS.system, Role.R)],
    data: concat([u32le(2), u64le(addresses.length), ...addresses.map(b)]),
  };
}
/**
 * The static accounts Vicinity transactions share (solana/sdk/launchpad/lookup-table.mts launchpadLookupTableAddresses, for this
 * site's programs): programs, Meteora's fixed accounts, our global account, the rewards program, the dev wallet, the quote mints
 * and its referral accounts, the allowed DBC configs and their allow-list entries.
 */
export async function lookupTableAddresses({ programId, rewardsProgramId, dbcConfigs = [], quoteMints = [ADDRESSES.wsol] }) {
  const L = launchpadPdas(programId);
  const list = [
    PROGRAM_IDS.system, PROGRAM_IDS.token, PROGRAM_IDS.token2022, PROGRAM_IDS.ata, PROGRAM_IDS.computeBudget, "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    PROGRAM_IDS.dbc, await dbc.eventAuthority(), ADDRESSES.dbcPoolAuthority,
    PROGRAM_IDS.damm, await damm.eventAuthority(), ADDRESSES.dammPoolAuthority, ADDRESSES.dammCustomizableConfig,
    programId, await L.launchpad(), rewardsProgramId,
    ADDRESSES.feeRecipient,
    ...quoteMints, ...(await Promise.all(quoteMints.map((m) => ata(ADDRESSES.feeRecipient, m)))),
    ...dbcConfigs, ...(await Promise.all(dbcConfigs.map((c) => L.launchConfig(c)))),
  ];
  return [...new Set(list)];
}

/* ---------------------------------------------------------------- per city */
/** vicinity_launchpad approve_launch: the admin pays the approval's rent (refunded at launch or revoke). */
export async function approveLaunch({ programId, admin, cityId, founder, name, symbol, expiresAt, dbcConfig }) {
  const L = launchpadPdas(programId);
  return {
    programAddress: programId,
    accounts: [
      meta(admin, Role.WS), meta(await L.launchpad(), Role.R), meta(await L.launchConfig(dbcConfig), Role.R), meta(await L.approval(cityId), Role.W),
      meta(await L.coin(cityId), Role.R), meta(PROGRAM_IDS.system, Role.R),
    ],
    data: concat([disc("approve_launch"), u64le(cityId), b(founder), str(name), str(symbol), i64le(expiresAt)]),
  };
}
/** vicinity_launchpad revoke_approval: the rent goes back to whoever paid it (the approval's rent_payer). */
export async function revokeApproval({ programId, admin, cityId, rentPayer }) {
  const L = launchpadPdas(programId);
  return {
    programAddress: programId,
    accounts: [meta(admin, Role.RS), meta(await L.launchpad(), Role.R), meta(await L.approval(cityId), Role.W), meta(rentPayer, Role.W)],
    data: concat([disc("revoke_approval"), u64le(cityId)]),
  };
}
/** vicinity_launchpad set_pause(launches, payouts): each Option<bool> (null = leave as it is). */
export async function setPause({ programId, authority, launches = null, payouts = null }) {
  const opt = (v) => (v === null || v === undefined ? Uint8Array.of(0) : Uint8Array.of(1, v ? 1 : 0));
  return {
    programAddress: programId,
    accounts: [meta(authority, Role.RS), meta(await launchpadPdas(programId).launchpad(), Role.W)],
    data: concat([disc("set_pause"), opt(launches), opt(payouts)]),
  };
}
/** RewardModel (vicinity_rewards): the order of the enum. */
export const RewardModel = Object.freeze({ Creator: 0, Holders: 1, Split: 2 });
/**
 * vicinity_rewards init_city for a launched coin, the only way forward_holders_fees accepts it: model Holders, founder share 0,
 * reward token = the coin's quote token; the registry admin and the city's authority sign (the same wallet on the website).
 */
export async function initCity({ rewardsProgramId, payer, admin, authority, founder, mint, rewardMint, cityId, tokenProgram = PROGRAM_IDS.token }) {
  const R = rewards(rewardsProgramId);
  const config = await R.city(mint);
  return {
    programAddress: rewardsProgramId,
    accounts: [
      meta(payer, Role.WS), meta(admin, Role.RS), meta(await R.registry(), Role.R), meta(authority, Role.RS), meta(founder, Role.R),
      meta(mint, Role.R), meta(rewardMint, Role.R), meta(config, Role.W), meta(await R.vault(config), Role.W), meta(tokenProgram, Role.R), meta(PROGRAM_IDS.system, Role.R),
    ],
    data: concat([disc("init_city"), Uint8Array.of(RewardModel.Holders), u16le(0), cityTag(cityId)]),
  };
}
/** `coin` = { cityId, mint, quoteMint, dbcPool, dbcConfig } (a decoded Coin record). Anyone may pay. */
export async function harvestCurveFees({ programId, payer, coin }) {
  const L = launchpadPdas(programId);
  const c = await L.coin(coin.cityId);
  return {
    programAddress: programId,
    accounts: [
      meta(payer, Role.WS), meta(c, Role.W), meta(ADDRESSES.dbcPoolAuthority, Role.R), meta(coin.dbcPool, Role.W), meta(coin.dbcConfig, Role.R),
      meta(await dbc.tokenVault(coin.mint, coin.dbcPool), Role.W), meta(await dbc.tokenVault(coin.quoteMint, coin.dbcPool), Role.W),
      meta(coin.mint, Role.R), meta(coin.quoteMint, Role.R), meta(await ata(c, coin.mint), Role.W), meta(await L.holdersPot(c), Role.W),
      meta(await L.founderVault(c), Role.W), meta(PROGRAM_IDS.token, Role.R), meta(PROGRAM_IDS.ata, Role.R), meta(PROGRAM_IDS.system, Role.R),
      meta(await dbc.eventAuthority(), Role.R), meta(PROGRAM_IDS.dbc, Role.R),
    ],
    data: concat([disc("harvest_curve_fees"), u64le(coin.cityId)]),
  };
}
/** The city's share of its graduated pool's fees, for one position NFT the Coin record owns. Anyone may pay. */
export async function harvestPoolFees({ programId, payer, coin, dammPool, positionNftMint }) {
  const L = launchpadPdas(programId);
  const c = await L.coin(coin.cityId);
  return {
    programAddress: programId,
    accounts: [
      meta(payer, Role.WS), meta(c, Role.W), meta(dammPool, Role.R), meta(await damm.position(positionNftMint), Role.W),
      meta(await damm.positionNftAccount(positionNftMint), Role.R), meta(ADDRESSES.dammPoolAuthority, Role.R),
      meta(await damm.tokenVault(coin.mint, dammPool), Role.W), meta(await damm.tokenVault(coin.quoteMint, dammPool), Role.W),
      meta(coin.mint, Role.R), meta(coin.quoteMint, Role.R), meta(await ata(c, coin.mint), Role.W), meta(await L.holdersPot(c), Role.W),
      meta(await L.founderVault(c), Role.W), meta(PROGRAM_IDS.token, Role.R), meta(PROGRAM_IDS.ata, Role.R), meta(PROGRAM_IDS.system, Role.R),
      meta(await damm.eventAuthority(), Role.R), meta(PROGRAM_IDS.damm, Role.R),
    ],
    data: concat([disc("harvest_pool_fees"), u64le(coin.cityId)]),
  };
}
/** The holders' share from the city's pot into its rewards vault (needs init_city). Nobody signs but the fee payer. */
export async function forwardHoldersFees({ programId, rewardsProgramId, coin }) {
  const L = launchpadPdas(programId), R = rewards(rewardsProgramId);
  const c = await L.coin(coin.cityId), cfg = await R.city(coin.mint);
  return {
    programAddress: programId,
    accounts: [
      meta(await L.launchpad(), Role.R), meta(c, Role.W), meta(await L.holdersPot(c), Role.W), meta(coin.quoteMint, Role.R),
      meta(cfg, Role.R), meta(await R.vault(cfg), Role.W), meta(PROGRAM_IDS.token, Role.R),
    ],
    data: concat([disc("forward_holders_fees"), u64le(coin.cityId)]),
  };
}

/* ---------------------------------------------------------------- the dev wallet's platform fees (it signs as fee_claimer) */
export async function claimTradingFee({ feeClaimer = ADDRESSES.feeRecipient, pool, config, baseMint, quoteMint, baseAccount, quoteAccount }) {
  return {
    programAddress: PROGRAM_IDS.dbc,
    accounts: [
      meta(ADDRESSES.dbcPoolAuthority, Role.R), meta(config, Role.R), meta(pool, Role.W), meta(baseAccount, Role.W), meta(quoteAccount, Role.W),
      meta(await dbc.tokenVault(baseMint, pool), Role.W), meta(await dbc.tokenVault(quoteMint, pool), Role.W), meta(baseMint, Role.R), meta(quoteMint, Role.R),
      meta(feeClaimer, Role.RS), meta(PROGRAM_IDS.token, Role.R), meta(PROGRAM_IDS.token, Role.R), meta(await dbc.eventAuthority(), Role.R), meta(PROGRAM_IDS.dbc, Role.R),
    ],
    data: concat([disc("claim_trading_fee"), u64le(U64_MAX), u64le(U64_MAX)]),
  };
}
export async function claimPartnerPoolCreationFee({ feeClaimer = ADDRESSES.feeRecipient, pool, config, feeReceiver = feeClaimer }) {
  return {
    programAddress: PROGRAM_IDS.dbc,
    accounts: [meta(config, Role.R), meta(pool, Role.W), meta(feeClaimer, Role.RS), meta(feeReceiver, Role.W), meta(await dbc.eventAuthority(), Role.R), meta(PROGRAM_IDS.dbc, Role.R)],
    data: disc("claim_partner_pool_creation_fee"),
  };
}
export async function partnerWithdrawSurplus({ feeClaimer = ADDRESSES.feeRecipient, pool, config, quoteMint, quoteAccount }) {
  return {
    programAddress: PROGRAM_IDS.dbc,
    accounts: [
      meta(ADDRESSES.dbcPoolAuthority, Role.R), meta(config, Role.R), meta(pool, Role.W), meta(quoteAccount, Role.W),
      meta(await dbc.tokenVault(quoteMint, pool), Role.W), meta(quoteMint, Role.R), meta(feeClaimer, Role.RS), meta(PROGRAM_IDS.token, Role.R),
      meta(await dbc.eventAuthority(), Role.R), meta(PROGRAM_IDS.dbc, Role.R),
    ],
    data: disc("partner_withdraw_surplus"),
  };
}
/** DAMM v2 claim_position_fee for a position the signer owns (the dev wallet's half of a graduated pool's locked liquidity). */
export async function dammClaimPositionFee({ owner, pool, nftMint, mintA, mintB, accountA, accountB }) {
  return {
    programAddress: PROGRAM_IDS.damm,
    accounts: [
      meta(ADDRESSES.dammPoolAuthority, Role.R), meta(pool, Role.R), meta(await damm.position(nftMint), Role.W), meta(accountA, Role.W), meta(accountB, Role.W),
      meta(await damm.tokenVault(mintA, pool), Role.W), meta(await damm.tokenVault(mintB, pool), Role.W), meta(mintA, Role.R), meta(mintB, Role.R),
      meta(await damm.positionNftAccount(nftMint), Role.R), meta(owner, Role.RS), meta(PROGRAM_IDS.token, Role.R), meta(PROGRAM_IDS.token, Role.R),
      meta(await damm.eventAuthority(), Role.R), meta(PROGRAM_IDS.damm, Role.R),
    ],
    data: disc("claim_position_fee"),
  };
}
