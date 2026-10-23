/**
 * SVG to PNG for the city-coin picture (src/coinart.js) with resvg-wasm, given its pieces: the module's initWasm and Resvg, the
 * compiled wasm (or its bytes) and the two coin fonts. Nothing here imports a .wasm or a font file, so Node (the tests) and the
 * Worker (src/coinart-wasm.js, which imports them as modules) share this code and get byte-identical PNGs.
 *
 *   const render = makeRenderer({ initWasm, Resvg, wasm, fonts: [bold, medium] });
 *   const png = await render(svg);   // Uint8Array, 512 x 512, deterministic
 *
 * The wasm is instantiated once, on the first render only (one promise per renderer; a failed start is forgotten so the next
 * call tries again): an ordinary request never pays for it. System fonts are never loaded: only the two committed fonts draw.
 */
import { ART_SIZE } from "./coinart.js";

export function makeRenderer({ initWasm, Resvg, wasm, fonts }) {
  if (typeof initWasm !== "function" || typeof Resvg !== "function" || !wasm || !Array.isArray(fonts) || fonts.length !== 2) throw new Error("renderer pieces missing");
  const fontBuffers = fonts.map((f) => (f instanceof Uint8Array ? f : new Uint8Array(f)));
  let ready = null;
  const start = () => (ready ||= Promise.resolve().then(() => initWasm(wasm)).catch((e) => {
    // resvg-wasm refuses a second initWasm in the same isolate ("Already initialized"): the module is there, so carry on
    if (/already initiali[sz]ed/i.test(String((e && e.message) || e))) return;
    ready = null;
    throw e;
  }));
  return async function render(svg) {
    if (typeof svg !== "string" || !svg.startsWith("<svg")) throw new Error("not an SVG");
    await start();
    const r = new Resvg(svg, {
      fitTo: { mode: "width", value: ART_SIZE },
      font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Space Grotesk" },
    });
    let img = null;
    try {
      img = r.render();
      if (img.width !== ART_SIZE || img.height !== ART_SIZE) throw new Error(`rendered ${img.width}x${img.height}, not ${ART_SIZE}x${ART_SIZE}`);
      return img.asPng();
    } finally {
      try { if (img && typeof img.free === "function") img.free(); } catch { /* already freed */ }
      try { if (typeof r.free === "function") r.free(); } catch { /* already freed */ }
    }
  };
}
