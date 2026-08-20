# Document to Markdown

Internal web page that converts Word, PowerPoint, Excel, OpenDocument, RTF, EPUB,
CSV and text-based PDFs to Markdown.

Conversion runs in the user's browser via WebAssembly. **No document is ever uploaded** —
the server only hands out static files. There is no backend, no database, and nothing to log.

## What gets deployed

Everything the repo tracks, which is everything the server needs:

```
index.html
worker.js                  conversion worker — required, not optional
vendor/
  anydoc_wasm.js
  anydoc_wasm_bg.wasm      6.7 MB  — cached by the browser after first load
```

`worker.js` loads the wasm and runs every conversion, so the page never freezes while a
large file parses. It is a **module worker** (`type: 'module'`), which needs Chrome/Edge 80+,
Firefox 114+ or Safari 15+. If the worker fails to start the page says so explicitly rather
than silently doing nothing.

`package.json` and `package-lock.json` are tracked only to pin which version of
`@firecrawl/anydoc-wasm` the `vendor/` files came from. `node_modules/` is gitignored; the
server never needs it, and there is no `npm install` step in the deploy.

## Deploy to the Ubuntu box (192.168.0.82)

Internal LAN, plain HTTP, port **3017**. The same box runs `holistic-dashboard` (3001) and
`jaipurrugs-foundation` (3002) — different projects, don't touch either.

Deployed by git pull, same as the other apps on the box. First time:

```bash
git clone https://github.com/dakshj0shi/anydoc-dashboard.git ~/anydoc-dashboard
```

```bash
pm2 serve ~/anydoc-dashboard 3017 --name anydoc && pm2 save
```

Verify, then open `http://192.168.0.82:3017`:

```bash
ss -ltnp | grep 3017
```

### Updating a live deploy

There is no build step, so a deploy is a pull. PM2 serves from disk, so it picks up the new
`index.html` immediately — the restart is only needed if the port or path changed:

```bash
cd ~/anydoc-dashboard && git pull
```

Users will keep the old `index.html` until they hard-refresh, but the 6.7 MB wasm is
unchanged so that costs nothing. If you update the library itself, tell people to reload.

### Optional: nginx in front

`pm2 serve` sends no `Cache-Control` and cannot serve the pre-compressed `.br`/`.gz`, so
every cold load transfers the full 6.6 MB. On a wired LAN that is ~85 ms and not worth
fixing. Over WiFi it is ~1.8 s, and nginx cuts it to ~490 ms:

```nginx
server {
    listen 3017;
    root /var/www/anydoc-dashboard;
    index index.html;

    brotli_static on;                   # serves anydoc_wasm_bg.wasm.br  (1.8 MB)
    gzip_static  on;                    # falls back to .gz              (2.9 MB)

    location ~* \.wasm$ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

If you go this route: stop the PM2 process first (`pm2 delete anydoc`), clone to
`/var/www/anydoc-dashboard` and `chown -R www-data:www-data` it — nginx runs as `www-data`
and Ubuntu home directories are `750`, so it cannot serve out of `~`. `brotli_static` needs
`apt install libnginx-mod-brotli`; without it drop that line and `gzip_static` alone still
halves the transfer.

## The compressed files are not in git

`.br` and `.gz` are gitignored — they are 4.7 MB of regenerable binary and only nginx can
use them. Generate them on the server if you add nginx:

```bash
cd vendor && brotli -q 11 -k -f anydoc_wasm_bg.wasm && gzip -9 -k -f anydoc_wasm_bg.wasm
```

## Updating the library

```bash
npm update @firecrawl/anydoc-wasm
cp node_modules/@firecrawl/anydoc-wasm/anydoc_wasm.js node_modules/@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm vendor/
```

Then redeploy. Check the format list in `anydoc_wasm.d.ts` afterwards — if new formats
appear, widen the `accept` attribute on the file input in `index.html`.

## Known limits

- **Scanned / image-only PDFs fail.** They hold no text to extract; they need OCR, which
  this build does not include. Users see "Not a supported format, or a scanned PDF that
  needs OCR." Adding OCR means a real backend with PDFium and ONNX Runtime — see
  `@firecrawl/pdf-inspector`'s `processPdfWithOcr`.
- **Images become alt text.** Markdown output references image filenames; the raw bytes are
  not embedded. Fine for feeding an LLM, not a substitute for the original file.
- **One file at a time.** The worker converts sequentially. A second worker would halve
  wall-clock on large batches, but at ~20 ms per document it has never been worth it.
- **Password-protected files fail** by design; the password has to be removed first.

## Local development

```bash
python -m http.server 4173 -d .
```

Must be over HTTP — `file://` blocks both ES module imports and wasm instantiation.
