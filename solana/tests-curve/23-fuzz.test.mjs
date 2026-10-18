// F01 and F02 at full scale (VICINITY-CURVE-DESIGN.md 12.5): seeded random
// sequences over all 26 instructions, valid and invalid, with the invariant
// checker after every transaction, a model of every coin run side by side
// (each Coin and LaunchBatch byte-equal to the model after every transaction), every
// prediction of success, failure and error checked, and the I22 probe every 50
// steps. See fuzz.mjs.
//
// CI runs a few hundred steps on two seeds. A long run:
//   VCURVE_FUZZ_STEPS=100000 VCURVE_FUZZ_SEEDS=7 node --test tests-curve/23-fuzz.test.mjs
// VCURVE_FUZZ_LOG=1 prints progress every 1,000 steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Fuzz } from './fuzz.mjs';

const steps = Number(process.env.VCURVE_FUZZ_STEPS ?? 300);
const seeds = (process.env.VCURVE_FUZZ_SEEDS ?? '1,2').split(',').map((x) => Number(x.trim()));

for (const seed of seeds) {
  test(`F01/F02 fuzz, seed ${seed}, ${steps} steps: every instruction, valid and invalid; the checker, the model and the I22 probe agree throughout`, async () => {
    const f = await Fuzz.create({ seed, log: process.env.VCURVE_FUZZ_LOG === '1' });
    const t0 = Date.now();
    const s = await f.run(steps);
    console.log(`fuzz seed ${seed}: ${JSON.stringify(s)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    assert.equal(s.steps, steps);
    assert.ok(s.ok > 0 && s.failed > 0, 'both outcomes were exercised');
    if (steps >= 300) assert.ok(s.invalid > 10 && s.invalidRefused > 0, 'invalid variants were tried and refused');
  });
}
