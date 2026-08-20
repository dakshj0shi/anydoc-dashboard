// Conversion worker. Keeps the 6.7 MB wasm init and every conversion off the main
// thread, so the page stays responsive even while a large spreadsheet is parsing.
import init, { toMarkdownBytes, formatFromBytes, formatFromPath } from './vendor/anydoc_wasm.js';

const ready = init({ module_or_path: './vendor/anydoc_wasm_bg.wasm' })
  .then(() => self.postMessage({ ready: true }))
  .catch(e => { self.postMessage({ ready: false, message: e.message }); throw e; });

self.onmessage = async ({ data: { id, name, bytes } }) => {
  try {
    await ready;
    // Content markers first; the extension only names formats that lack one (CSV).
    const format = formatFromBytes(bytes) ?? formatFromPath(name) ?? null;
    const t = performance.now();
    const markdown = toMarkdownBytes(bytes, format);
    self.postMessage({ id, markdown, ms: Math.max(1, Math.round(performance.now() - t)) });
  } catch (e) {
    self.postMessage({ id, code: e.code, message: e.message });
  }
};
