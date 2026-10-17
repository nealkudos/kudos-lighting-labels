// Builds the single-file index.html (core.js inlined) from src/index.src.html.
// Usage: node build.mjs [--artifact path]   (--artifact also writes a body-only copy for claude.ai)
import fs from 'fs';
const here = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(here + 'src/index.src.html', 'utf8');
const core = fs.readFileSync(here + 'core.js', 'utf8');
const body = src.replace('/*@@CORE@@*/', () => core);
const html = '<!doctype html>\n<html lang="en-GB">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  body.replace('<div class="wrap">', '</head>\n<body>\n<div class="wrap">') + '\n</body>\n</html>\n';
fs.writeFileSync(here + 'index.html', html);
const i = process.argv.indexOf('--artifact');
if (i > 0) fs.writeFileSync(process.argv[i + 1], body);
console.log('index.html', html.length, 'bytes');
