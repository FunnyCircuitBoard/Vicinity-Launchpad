// PDA derivation for vicinity_rewards (PROGRAM-SPEC.md section 2). Seeds are exact:
//   Registry    ["registry"]                   (one per program: who may create cities)
//   CityConfig  ["city",  city_coin_mint]
//   vault       ["vault", config]              (SPL token account owned by config)
//   Epoch       ["epoch", config, index u64 LE]
//   ClaimStatus ["claim", epoch, claimant]
//
// The program id comes from the IDL (`idl.address`). Call setProgramId() once at
// start-up, or pass programId explicitly as the last argument.

import { PublicKey } from "@solana/web3.js";

export const SEED_REGISTRY = Buffer.from("registry");
export const SEED_CITY = Buffer.from("city");
export const SEED_VAULT = Buffer.from("vault");
export const SEED_EPOCH = Buffer.from("epoch");
export const SEED_CLAIM = Buffer.from("claim");

// Placeholder until the program keypair exists; tests/client call setProgramId(idl.address).
export let PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

export function setProgramId(id) {
  PROGRAM_ID = new PublicKey(id);
  return PROGRAM_ID;
}

export function u64le(value) {
  const v = BigInt(value);
  if (v < 0n || v > (1n << 64n) - 1n) throw new Error("u64le: out of range");
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

const pk = (x) => (x instanceof PublicKey ? x : new PublicKey(x));

// The BPF upgradeable loader; a program's ProgramData account is the PDA
// [program_id] under it. `init_registry` reads the upgrade authority from it.
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export function deriveRegistry(programId = PROGRAM_ID) {
  const [address, bump] = PublicKey.findProgramAddressSync([SEED_REGISTRY], pk(programId));
  return { address, bump };
}

export function deriveProgramData(programId = PROGRAM_ID) {
  const [address, bump] = PublicKey.findProgramAddressSync([pk(programId).toBuffer()], BPF_LOADER_UPGRADEABLE_ID);
  return { address, bump };
}

export function deriveConfig(cityCoinMint, programId = PROGRAM_ID) {
  const [address, bump] = PublicKey.findProgramAddressSync([SEED_CITY, pk(cityCoinMint).toBuffer()], pk(programId));
  return { address, bump };
}

export function deriveVault(config, programId = PROGRAM_ID) {
  const [address, bump] = PublicKey.findProgramAddressSync([SEED_VAULT, pk(config).toBuffer()], pk(programId));
  return { address, bump };
}

export function deriveEpoch(config, index, programId = PROGRAM_ID) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEED_EPOCH, pk(config).toBuffer(), u64le(index)],
    pk(programId)
  );
  return { address, bump };
}

export function deriveClaim(epoch, claimant, programId = PROGRAM_ID) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [SEED_CLAIM, pk(epoch).toBuffer(), pk(claimant).toBuffer()],
    pk(programId)
  );
  return { address, bump };
}

// All addresses of one city in one call.
export function deriveCity(cityCoinMint, programId = PROGRAM_ID) {
  const config = deriveConfig(cityCoinMint, programId);
  const vault = deriveVault(config.address, programId);
  return { config: config.address, configBump: config.bump, vault: vault.address, vaultBump: vault.bump };
}
