#!/usr/bin/env node
/*
 * Turn the Unity WebGL export into a static site GitHub Pages can serve.
 *
 * Two things in the stock Unity template do not work in production:
 *
 * 1. Compression. Unity's default export Brotli-compresses the payload and
 *    expects the server to answer with `Content-Encoding: br`. GitHub Pages
 *    serves files as-is and lets you set no response headers, so a compressed
 *    export reaches the loader as raw Brotli bytes and the game dies before the
 *    first frame. This export already ships uncompressed files; if a future
 *    export is compressed, the payload is expanded here and index.html is
 *    pointed at the plain names.
 *
 * 2. Layout. The template pins the desktop player to a fixed window and lets
 *    phones stretch the canvas to the whole viewport, which would distort this
 *    landscape game on a portrait phone. The play area is instead scaled to fit
 *    the screen with its aspect ratio intact, and letterboxed.
 *
 *   node scripts/prepare-site.mjs
 *
 * `build/` is the untouched Unity export. `site/` is generated and not
 * committed; CI rebuilds it on every push.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { brotliDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'build/WebGL')
const site = join(root, 'site')
const play = join(site, 'play')

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/* The user-agent branch of the Unity template, replaced wholesale below. */
const UA_BLOCK = /if \(\/iPhone\|iPad\|iPod\|Android\/i\.test\(navigator\.userAgent\)\) \{[\s\S]*?\n      \}\n/

const LANDING = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Cannon Clash 3D</title>
    <meta http-equiv="refresh" content="0;url=./play/">
    <style>
      html, body { margin: 0; height: 100%; }
      body {
        display: grid; place-items: center; background: #14122b; color: #eef0ff;
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { text-align: center; padding: 24px; }
      a { color: #ffd166; }
    </style>
  </head>
  <body>
    <main>
      <h1>Cannon Clash 3D</h1>
      <p><a href="./play/">Play</a></p>
    </main>
  </body>
</html>
`

async function main() {
  const buildInfo = await stat(source).catch(() => null)
  if (!buildInfo?.isDirectory()) throw new Error(`missing Unity export at ${source}`)

  await rm(site, { recursive: true, force: true })
  await mkdir(site, { recursive: true })
  await cp(source, play, { recursive: true })

  // 1. Brotli payload -> plain files the browser can read without a header.
  const buildDir = join(play, 'Build')
  const entries = await readdir(buildDir)
  const packedFiles = entries.filter((entry) => entry.endsWith('.br'))
  let compressed = 0
  let expanded = 0
  for (const entry of packedFiles) {
    const packed = join(buildDir, entry)
    const bytes = await readFile(packed)
    const plain = brotliDecompressSync(bytes)
    compressed += bytes.byteLength
    expanded += plain.byteLength
    await writeFile(plainPath(packed), plain)
    await rm(packed)
  }
  if (packedFiles.length === 0) {
    console.log('payload is already uncompressed: nothing to expand')
  } else {
    console.log(`decompressed ${packedFiles.length} files, ${mb(compressed)} -> ${mb(expanded)}`)
  }

  const indexPath = join(play, 'index.html')
  let html = await readFile(indexPath, 'utf8')

  // 2. Point the loader at the uncompressed names.
  const brRefs = (html.match(/\.br"/g) ?? []).length
  if (brRefs !== packedFiles.length) {
    throw new Error(`index.html references ${brRefs} .br files but the build has ${packedFiles.length}`)
  }
  html = html.replaceAll('.br"', '"')
  if (/\.(unityweb|gz)"/.test(html)) throw new Error('unsupported payload format: only plain and Brotli exports are handled')

  // 3. Fit the landscape play area to any screen, portrait phones included.
  const canvas = html.match(/<canvas id="unity-canvas" width="(\d+)" height="(\d+)"/)
  if (!canvas) throw new Error('Unity template changed: could not read the canvas size')
  const aspect = `${canvas[1]} / ${canvas[2]}`

  const fitBlock = `      // The template pins the play area to a fixed window on desktop and stretches
      // it to the whole viewport on phones, which would distort a landscape game
      // on a portrait phone. Scale the play area to fit the screen instead,
      // keeping the canvas aspect ratio, and letterbox the rest.
      // Injected by scripts/prepare-site.mjs.
      var playAspect = ${canvas[1]} / ${canvas[2]};
      var unityContainer = document.querySelector("#unity-container");
      var meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, height=device-height, initial-scale=1.0, user-scalable=no, shrink-to-fit=yes';
      document.getElementsByTagName('head')[0].appendChild(meta);
      document.body.style.background = '#231F20';
      document.body.style.overflow = 'hidden';
      unityContainer.className = "unity-desktop";
      var fitToWindow = function () {
        var width = Math.min(window.innerWidth, window.innerHeight * playAspect);
        var height = width / playAspect;
        fullscreenContainer.style.width = Math.floor(width) + "px";
        fullscreenContainer.style.height = Math.floor(height) + "px";
      };
      fitToWindow();
      window.addEventListener("resize", fitToWindow);
`
  if (!UA_BLOCK.test(html)) throw new Error('Unity template changed: could not find the user-agent branch')
  html = html.replace(UA_BLOCK, fitBlock)
  if (!html.includes('fitToWindow')) throw new Error('canvas fit patch did not apply')
  // The template's fixed desktop size is gone with that branch; make sure of it.
  if (/fullscreenContainer\.style\.width = "\d+px"/.test(html)) throw new Error('a fixed canvas size is still present')

  await writeFile(indexPath, html)
  await writeFile(join(site, 'index.html'), LANDING)

  // 4. Fail loudly here rather than in a player's console.
  const required = [
    'Build/WebGL.loader.js',
    'Build/WebGL.data',
    'Build/WebGL.wasm',
    'Build/WebGL.framework.js',
    'TemplateData/style.css',
  ]
  for (const file of required) {
    const info = await stat(join(play, file)).catch(() => null)
    if (!info?.isFile()) throw new Error(`site/play/${file} is missing from the build`)
  }
  const wasm = await readFile(join(play, 'Build/WebGL.wasm'))
  if (wasm.subarray(0, 4).toString('latin1') !== '\0asm') throw new Error('WebGL.wasm is not an uncompressed wasm module')
  const data = await readFile(join(play, 'Build/WebGL.data'))
  if (data.subarray(0, 8).toString('latin1') !== 'UnityWeb') throw new Error('WebGL.data is not an uncompressed Unity data file')
  const loader = await readFile(indexPath, 'utf8')
  if (loader.includes('.br"')) throw new Error('index.html still references compressed payload')

  let total = 0
  for (const entry of await readdir(play, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    total += (await stat(join(entry.parentPath ?? play, entry.name))).size
  }
  console.log(`site/ is ready: ${mb(total)} under site/play/ (aspect ${aspect})`)
}

/** `WebGL.data.br` -> `WebGL.data` (the compression extension comes off). */
function plainPath(path) {
  return path.slice(0, -'.br'.length)
}

main().catch((error) => {
  console.error(`prepare-site failed: ${error.message}`)
  process.exit(1)
})

export { plainPath }
