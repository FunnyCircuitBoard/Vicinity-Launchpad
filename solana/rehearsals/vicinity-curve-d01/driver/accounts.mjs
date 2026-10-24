// The D01 account table: every address, its size, its lamports (rent) and owner; the coin's liability check (6.5, I9).
import { writeFileSync } from 'node:fs';
const L = await import('./lib.mjs');
const { S } = L;
const c = await L.devnet(L.RPC_A);
const st = L.loadState();
const P = S.curvePdas({ cluster: 'devnet' });
const city = { approved: 990_000_001n, batchOne: 990_000_002n, batchTwo: 990_000_003n };
const rows = [];
const add = async (what, addr) => {
  const a = await c.getAccountInfo(L.pk(addr), 'confirmed');
  rows.push({ what, addr: String(addr), bytes: a ? a.data.length : null, lamports: a ? a.lamports : 0, owner: a ? a.owner.toBase58() : '(none)' });
};
await add('vicinity_curve program (devnet build)', S.CURVE_PROGRAM_ID);
await add('its ProgramData', P.programData());
await add('Launchpad', P.launchpad());
await add('LaunchConfig #0', P.config(0));
await add('LaunchConfig #1', P.config(1));
await add('LaunchBatch', P.launchBatch());
await add('guardian Squads multisig', st.guardianMultisig);
await add('guardian (vault 0)', st.guardian);
await add('event authority', P.eventAuthority());
await add('the lookup table (11.3)', st.alt);
for (const [k, id] of Object.entries(city)) {
  const { coin, mint, vault } = P.coinAccounts(id);
  const ca = await c.getAccountInfo(L.pk(coin));
  await add(`${k} (${id}): Coin`, coin);
  if (!ca) { await add(`${k} (${id}): Approval`, P.approval(id)); continue; }
  const coinD = S.decodeCurveCoin(ca);
  await add(`${k}: mint`, mint); await add(`${k}: coin vault`, vault);
  await add(`${k}: TickerLock ${coinD.symbol}`, P.ticker(coinD.symbol)); await add(`${k}: Metaplex metadata`, S.metadataAddress(mint));
  await add(`${k}: PayoutOptIn`, P.payoutOptIn(coin)); await add(`${k}: Approval (closed at launch)`, P.approval(id));
  const r = P.rewardsAccounts(mint); await add(`${k}: vicinity_rewards CityConfig`, r.config); await add(`${k}: vicinity_rewards WSOL vault`, r.vault);
  const liab = S.liabilities(S.coinState(coinD));
  rows.push({ what: `${k}: liability check`, addr: '', note: `lamports ${ca.lamports} >= liabilities ${liab} + rent_reserve ${coinD.rentReserve}: ${BigInt(ca.lamports) >= liab + coinD.rentReserve}` });
}
const rent = await c.getMinimumBalanceForRentExemption(0);
const md = ['| account | address | bytes | lamports | owner |', '|---|---|---|---|---|', ...rows.map((r) => r.note ? `| ${r.what} | | | | ${r.note} |` : `| ${r.what} | \`${r.addr}\` | ${r.bytes ?? '-'} | ${r.lamports} | \`${r.owner}\` |`)];
md.push('', `rent-exempt minimum of an empty account on this cluster: ${rent} lamports`);
writeFileSync(`${L.TOOLS}/accounts-${L.TARGET}.md`, md.join('\n') + '\n');
console.log(md.join('\n'));
