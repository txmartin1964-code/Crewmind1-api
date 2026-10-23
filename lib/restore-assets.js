/**
 * lib/restore-assets.js
 *
 * The brand icon PNGs (favicons, CM mark, apple touch icon, PWA 512 icon)
 * ship in the repo as base64 text under public/assets-b64/ because the
 * deployment push route only carries UTF-8 text files. At boot, decode any
 * that are missing into public/assets/ so express.static can serve them.
 * Idempotent: existing files are never overwritten. Non-fatal on error —
 * the site runs fine without icons.
 */
const fs = require('fs');
const path = require('path');

function ensureBrandAssets(rootDir) {
  try {
    const b64Dir = path.join(rootDir, 'public', 'assets-b64');
    const outDir = path.join(rootDir, 'public', 'assets');
    if (!fs.existsSync(b64Dir)) return;
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of fs.readdirSync(b64Dir)) {
      if (!name.endsWith('.b64')) continue;
      const targetName = name.slice(0, -4);
      const target = path.join(outDir, targetName);
      if (fs.existsSync(target)) continue;
      const data = Buffer.from(
        fs.readFileSync(path.join(b64Dir, name), 'utf8').replace(/\s+/g, ''),
        'base64'
      );
      fs.writeFileSync(target, data);
      console.log(`[assets] restored ${targetName} (${data.length} bytes)`);
    }
  } catch (err) {
    console.error('[assets] brand asset restore failed (non-fatal):', err.message);
  }
}

module.exports = { ensureBrandAssets };
