// Every address the launchpad uses, derived exactly as the programs derive them.
import web3 from '@solana/web3.js';

const { PublicKey } = web3;

export const PROGRAM_IDS = Object.freeze({
  launchpad: 'Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7',
  rewards: 'Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi',
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  damm: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  metaplex: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  system: '11111111111111111111111111111111',
  upgradeableLoader: 'BPFLoaderUpgradeab1e11111111111111111111111',
});

export const ADDRESSES = Object.freeze({
  /** The dev wallet: program constant FEE_RECIPIENT. */
  feeRecipient: '13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN',
  wsol: 'So11111111111111111111111111111111111111112',
  dbcPoolAuthority: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
  dammPoolAuthority: 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC',
  /** DAMM v2 customizable config used by DBC migration option 6. */
  dammCustomizableConfig: 'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck',
});

const pk = (a) => (a instanceof PublicKey ? a : new PublicKey(a));
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
function find(seeds, program) {
  return PublicKey.findProgramAddressSync(seeds, pk(program));
}
const addr = (seeds, program) => find(seeds, program)[0].toBase58();

export function pdas(programId = PROGRAM_IDS.launchpad) {
  const P = programId;
  return {
    launchpad: () => addr([Buffer.from('launchpad')], P),
    launchConfig: (dbcConfig) => addr([Buffer.from('launch_config'), pk(dbcConfig).toBuffer()], P),
    approval: (cityId) => addr([Buffer.from('approval'), u64le(cityId)], P),
    coin: (cityId) => addr([Buffer.from('coin'), u64le(cityId)], P),
    coinWithBump: (cityId) => find([Buffer.from('coin'), u64le(cityId)], P),
    holdersPot: (coin) => addr([Buffer.from('holders_pot'), pk(coin).toBuffer()], P),
    founderVault: (coin) => addr([Buffer.from('founder_vault'), pk(coin).toBuffer()], P),
    payoutOptIn: (coin) => addr([Buffer.from('payout_opt_in'), pk(coin).toBuffer()], P),
  };
}

export function programDataAddress(programId) {
  return addr([pk(programId).toBuffer()], PROGRAM_IDS.upgradeableLoader);
}

export function ata(owner, mint, tokenProgram = PROGRAM_IDS.token) {
  return addr([pk(owner).toBuffer(), pk(tokenProgram).toBuffer(), pk(mint).toBuffer()], PROGRAM_IDS.ata);
}

/** Meteora DBC addresses (programs/dynamic-bonding-curve const_pda and seeds). */
export const dbc = {
  eventAuthority: () => addr([Buffer.from('__event_authority')], PROGRAM_IDS.dbc),
  pool: (config, baseMint, quoteMint) => {
    const [a, b] = [pk(baseMint), pk(quoteMint)];
    const [hi, lo] = Buffer.compare(a.toBuffer(), b.toBuffer()) > 0 ? [a, b] : [b, a];
    return addr([Buffer.from('pool'), pk(config).toBuffer(), hi.toBuffer(), lo.toBuffer()], PROGRAM_IDS.dbc);
  },
  tokenVault: (mint, pool) => addr([Buffer.from('token_vault'), pk(mint).toBuffer(), pk(pool).toBuffer()], PROGRAM_IDS.dbc),
  metadata: (mint) => addr([Buffer.from('metadata'), pk(PROGRAM_IDS.metaplex).toBuffer(), pk(mint).toBuffer()], PROGRAM_IDS.metaplex),
  partnerMetadata: (feeClaimer) => addr([Buffer.from('partner_metadata'), pk(feeClaimer).toBuffer()], PROGRAM_IDS.dbc),
};

/** Meteora DAMM v2 addresses. */
export const damm = {
  eventAuthority: () => addr([Buffer.from('__event_authority')], PROGRAM_IDS.damm),
  pool: (config, mintA, mintB) => {
    const [a, b] = [pk(mintA), pk(mintB)];
    const [hi, lo] = Buffer.compare(a.toBuffer(), b.toBuffer()) > 0 ? [a, b] : [b, a];
    return addr([Buffer.from('pool'), pk(config).toBuffer(), hi.toBuffer(), lo.toBuffer()], PROGRAM_IDS.damm);
  },
  tokenVault: (mint, pool) => addr([Buffer.from('token_vault'), pk(mint).toBuffer(), pk(pool).toBuffer()], PROGRAM_IDS.damm),
  position: (nftMint) => addr([Buffer.from('position'), pk(nftMint).toBuffer()], PROGRAM_IDS.damm),
  positionNftAccount: (nftMint) => addr([Buffer.from('position_nft_account'), pk(nftMint).toBuffer()], PROGRAM_IDS.damm),
};

/** vicinity_rewards addresses (its constants.rs). */
export function rewardsPdas(programId = PROGRAM_IDS.rewards) {
  return {
    registry: () => addr([Buffer.from('registry')], programId),
    city: (cityCoinMint) => addr([Buffer.from('city'), pk(cityCoinMint).toBuffer()], programId),
    vault: (config) => addr([Buffer.from('vault'), pk(config).toBuffer()], programId),
    epoch: (config, index) => addr([Buffer.from('epoch'), pk(config).toBuffer(), u64le(index)], programId),
    claim: (epoch, claimant) => addr([Buffer.from('claim'), pk(epoch).toBuffer(), pk(claimant).toBuffer()], programId),
  };
}
