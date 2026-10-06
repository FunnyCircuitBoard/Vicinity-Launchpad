// Types for pda.mjs (used by the TypeScript SDK modules; the JavaScript is the implementation).
type Address = string;
type Key = string | { toBase58(): string; toBuffer(): Buffer };
type Int = bigint | number | string;

export declare const PROGRAM_IDS: Readonly<{
  launchpad: Address; rewards: Address; dbc: Address; damm: Address; metaplex: Address;
  token: Address; token2022: Address; ata: Address; system: Address; upgradeableLoader: Address;
}>;
export declare const ADDRESSES: Readonly<{
  feeRecipient: Address; wsol: Address; dbcPoolAuthority: Address; dammPoolAuthority: Address; dammCustomizableConfig: Address;
}>;
export declare function pdas(programId?: Address): {
  launchpad(): Address;
  launchConfig(dbcConfig: Key): Address;
  approval(cityId: Int): Address;
  coin(cityId: Int): Address;
  coinWithBump(cityId: Int): [{ toBase58(): string }, number];
  holdersPot(coin: Key): Address;
  founderVault(coin: Key): Address;
  payoutOptIn(coin: Key): Address;
};
export declare function programDataAddress(programId: Key): Address;
export declare function ata(owner: Key, mint: Key, tokenProgram?: Address): Address;
export declare const dbc: {
  eventAuthority(): Address;
  pool(config: Key, baseMint: Key, quoteMint: Key): Address;
  tokenVault(mint: Key, pool: Key): Address;
  metadata(mint: Key): Address;
  partnerMetadata(feeClaimer: Key): Address;
};
export declare const damm: {
  eventAuthority(): Address;
  pool(config: Key, mintA: Key, mintB: Key): Address;
  tokenVault(mint: Key, pool: Key): Address;
  position(nftMint: Key): Address;
  positionNftAccount(nftMint: Key): Address;
};
export declare function rewardsPdas(programId?: Address): {
  registry(): Address;
  city(cityCoinMint: Key): Address;
  vault(config: Key): Address;
  epoch(config: Key, index: Int): Address;
  claim(epoch: Key, claimant: Key): Address;
};
