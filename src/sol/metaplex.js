/**
 * Metaplex Token Metadata, read-only: the address of a mint's metadata account and the fields wallets and explorers show (the
 * same decoding as the SDK's decodeMetaplexMetadata, solana/sdk/launchpad/accounts.mts; checked against a real launch in
 * solana/tests-launchpad/16-coin-meta.test.mjs). Our program writes each city coin's metadata once, at launch, immutable: name
 * (the founder's coin name), symbol (the city ticker), uri = METADATA_URI_PREFIX + mint + ".json" (src/sol/layout.js constants).
 */
import { base58Decode, base58Encode } from "../solana.js";
import { findProgramAddress } from "./pda.js";
import { readU16, readU32 } from "./bytes.js";
import { accountBytes } from "./dbc.js";

export const METAPLEX_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const KEY_METADATA_V1 = 4;
const enc = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: false });

/** The metadata account of a mint: PDA ["metadata", Metaplex program, mint] under Metaplex. */
export const metadataAddress = async (mint) => (await findProgramAddress([enc.encode("metadata"), base58Decode(METAPLEX_PROGRAM), base58Decode(mint)], METAPLEX_PROGRAM))[0];

/**
 * { updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, creators, isMutable } with the NUL padding stripped, or null
 * when the account is not a Metaplex MetadataV1 account (wrong owner, wrong key byte, truncated).
 */
export function decodeMetadata(account) {
  const a = accountBytes(account);
  if (!a || (a.owner && a.owner !== METAPLEX_PROGRAM)) return null;
  const b = a.bytes;
  try {
    if (b.length < 65 + 12 || b[0] !== KEY_METADATA_V1) return null;
    let o = 1;
    const updateAuthority = base58Encode(b.subarray(o, o + 32)); o += 32;
    const mint = base58Encode(b.subarray(o, o + 32)); o += 32;
    const str = (max) => {
      const n = readU32(b, o); o += 4;
      if (n > max || o + n > b.length) throw new Error("bad_string");
      const s = utf8.decode(b.subarray(o, o + n)).replace(/\0+$/, ""); o += n;
      return s;
    };
    const name = str(64), symbol = str(32), uri = str(400);
    const sellerFeeBasisPoints = readU16(b, o); o += 2;
    let creators = 0;
    if (b[o++] === 1) { creators = readU32(b, o); o += 4 + creators * 34; }
    o += 1; // primary sale happened
    if (o >= b.length) return null;
    return { updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, creators, isMutable: b[o] === 1 };
  } catch { return null; }
}
