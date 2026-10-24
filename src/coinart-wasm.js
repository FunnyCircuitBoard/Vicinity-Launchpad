/**
 * The Worker's city-coin renderer: resvg-wasm 2.6.2 (index_bg.wasm, a CompiledWasm module) and the two coin fonts as Data modules
 * (wrangler.jsonc "rules"). The bundler hoists these module imports to the top of the Worker, so the wasm MODULE is compiled when the
 * isolate starts (measured at about 5 ms for its 2.5 MB; a much larger wasm would cost startup time). Only its instantiation (initWasm)
 * and the first drawing are lazy: src/coinready.js reaches this file with a dynamic import(), the first time a coin picture has to be
 * made (once per coin version, src/coinready.js ensureArt), so ordinary requests never instantiate the wasm.
 * Node never imports this file: the tests build the same renderer from the same files (src/coinart-render.js).
 */
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import bold from "./assets/fonts/SpaceGrotesk-Bold.ttf";
import medium from "./assets/fonts/SpaceGrotesk-Medium.ttf";
import { makeRenderer } from "./coinart-render.js";

export const render = makeRenderer({ initWasm, Resvg, wasm, fonts: [bold, medium] });
