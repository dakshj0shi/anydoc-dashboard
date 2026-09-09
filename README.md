# Document to Markdown

Internal web page that converts Word, PowerPoint, Excel, OpenDocument, RTF, EPUB,
CSV and PDFs to Markdown, including scanned ones.

Conversion runs in the user's browser via WebAssembly, so **normal documents are never
uploaded** — the server just hands out static files. The one exception is scanned PDFs: the
browser cannot read those, so they fall through to Docling on port 5001 and that file does
reach the server. Docling returns Markdown too — headings, GFM tables, lists — not a raw
text dump. Password-protected files are never uploaded, since Docling cannot open
them either. Nothing is stored or logged in either path.

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

**Expect one console warning, and ignore it.** `pm2 serve` sends the wasm as `text/plain`,
not `application/wasm`, so `WebAssembly.instantiateStreaming` refuses it and the loader
falls back to `WebAssembly.instantiate`. Confirmed on this deploy. The page works normally;
the only cost is that the 22 ms compile happens after the download instead of overlapping
it. Not a bug, and not fixable without nginx.

### Updating a live deploy

There is no build step, so a deploy is a pull. PM2 serves from disk, so it picks up the new
`index.html` immediately — the restart is only needed if the port or path changed:

```bash
cd ~/anydoc-dashboard && git pull
```

Users will keep the old `index.html` until they hard-refresh, but the 6.7 MB wasm is
unchanged so that costs nothing. If you update the library itself, tell people to reload.

## The server fallback: docling-serve on 5001

`index.html` asks Docling for `to_formats=md` and reads `document.md_content`, so both paths
produce Markdown; the response's `text_content` field (plain text) is never read. It also
pins `image_export_mode=placeholder`, because `embedded` would inline a base64 PNG of every
scanned page into the output.

It retries anything the browser rejected against
[docling-serve](https://github.com/docling-project/docling-serve) — the official REST wrapper
around Docling, so there is no backend of ours to maintain. The page builds the URL from its
own hostname, so nothing is hardcoded:

```js
const DOCLING = location.protocol + '//' + location.hostname + ':5001/v1/convert/file';
```

**The page works without it.** If 5001 is not listening, browser conversions are unaffected
and only scans fail, with a message saying the service is unreachable. Set it up second.

Check the port is free, then install. Ubuntu 24.04 blocks system-wide pip (PEP 668), so use
a venv — and install CPU-only torch **first**, or pip drags in gigabytes of CUDA libraries
that this GPU-less box can never use:

```bash
ss -ltn | grep 5001 || echo "5001 free"
```

```bash
python3 -m venv ~/docling-venv && ~/docling-venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu && ~/docling-venv/bin/pip install docling-serve
```

Pull the ~546 MB of model weights now rather than during someone's first upload:

```bash
~/docling-venv/bin/docling-tools models download
```

```bash
pm2 start ~/docling-venv/bin/docling-serve --name docling --interpreter none -- run && pm2 save
```

`docling-serve run` already binds `0.0.0.0:5001`, and `DOCLING_SERVE_CORS_ORIGINS` defaults
to `["*"]`, so the page on 3017 can call it with no extra config. That default is only safe
because this is a LAN-only box — do not expose 5001 to the internet without setting
`DOCLING_SERVE_CORS_ORIGINS` and `DOCLING_SERVE_API_KEY`.

Verify:

```bash
echo '<h1>Hello</h1><p>it works</p>' > /tmp/t.html && curl -sf -F 'files=@/tmp/t.html' -F to_formats=md http://localhost:5001/v1/convert/file
```

Budget 4–6 GB RAM for it. That box already runs four PM2 Node apps, so check headroom
before starting: `free -h`.

### As actually deployed (verified 2026-09-08)

The box has 14 Gi RAM (11 Gi free) and **4 cores**, hence `DOCLING_NUM_THREADS=2` — left at
its default of 4 it saturates the machine mid-conversion and `holistic-dashboard` crawls.
Docling runs as PM2 id 5, idles around 1.1 GB, and logs `Accelerator device: 'cpu'`.

`ufw` is **inactive** on this box, so no firewall rule is needed. A LAN-scoped rule is
stored for port 5001 if it is ever enabled — and if you do enable it, allow port 22 first
or you lose SSH.

`ss -ltn | grep 5001` prints nothing for the first ~5 s after a start: uvicorn binds the
port only after the models finish loading. Not a failure, just wait.

OCR runs through RapidOCR's **torch** engine, because `onnxruntime` is not installed —
the logs say so at startup. It works. `~/docling-venv/bin/pip install onnxruntime` would
likely speed up the OCR stage, but measure a real scan before bothering.

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

- **Scanned PDFs are uploaded to the server.** The browser cannot read them, so they fall
  through to Docling on `192.168.0.82:5001`, which returns Markdown the same way anydoc does. The page says so up front, and the file's row says "converted on the server"
  once it comes back. If Docling is down the user gets the
  original error plus "The server converter is not reachable."
- **Docling is slow on this hardware, and big files are refused.** No GPU on that box, so
  budget 3 s per page for plain scans and 5-15 s for image-heavy ones. The sync endpoint
  gives up after `DOCLING_SERVE_MAX_SYNC_WAIT` and returns **504**, so `index.html` refuses
  anything over `MAX_UPLOAD_MB` (**50 MB**) client-side.
  **These two numbers are coupled**: `MAX_SYNC_WAIT` must exceed the slowest file
  `MAX_UPLOAD_MB` still admits, or the wait ends in a 504 instead of a document. At 50 MB
  the service must run with `DOCLING_SERVE_MAX_SYNC_WAIT=3600`.
- **A 50 MB file occupies the server for most of an hour.** Measured on a real magazine:
  94 pages, each a single 2400x2900 px (7 MP, ~264 DPI) image, no text layer at all — so
  every page needs OCR. That is 10-30 s per page on this CPU-only box. The browser request
  has to stay open the whole time; closing the tab loses the work, since the sync endpoint
  has no way to hand back a job id.
- **Bulk work does not belong in the browser.** For an archive of magazines, skip the page
  and use the CLI, which takes a directory and cannot be killed by a closed tab:
  `nice -n 19 ~/docling-venv/bin/docling ~/mag-in --from pdf --to md --output ~/mag-out
  --device cpu --num-threads 2 --image-export-mode placeholder`.
  Doing that properly through the web page would mean the async
  `/v1/convert/file/async` API plus client-side polling, which is not wired up.
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
