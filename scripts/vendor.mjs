// Kopiuje przypiętą wersję pdfmake z node_modules do public/assets/vendor
// i wypisuje skróty SRI (sha384), które muszą zgadzać się ze stałą VENDOR w public/assets/app.js.
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfmake', 'build');
const version = JSON.parse(readFileSync(join(root, 'node_modules', 'pdfmake', 'package.json'), 'utf8')).version;
// Katalog z numerem wersji: przeglądarka może bezpiecznie trzymać pliki w pamięci podręcznej (immutable).
const dst = join(root, 'public', 'assets', 'vendor', `pdfmake-${version}`);
mkdirSync(dst, { recursive: true });
console.log(`pdfmake ${version} -> ${dst}`);
for (const file of ['pdfmake.min.js', 'vfs_fonts.js']) {
  copyFileSync(join(src, file), join(dst, file));
  const sri = 'sha384-' + createHash('sha384').update(readFileSync(join(dst, file))).digest('base64');
  console.log(`${file}: ${sri}`);
}
