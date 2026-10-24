// Zmienia domenę i nazwę marki we wszystkich plikach strony.
// Użycie: npm run domain -- mojadomena.pl "MojaMarka.pl"
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [domain, brandArg] = process.argv.slice(2);
if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
  console.error('Podaj domenę małymi literami, np.: npm run domain -- mojadomena.pl "MojaMarka.pl"');
  process.exit(1);
}
const brand = brandArg || domain;
const OLD_DOMAIN = 'protokolzdawczy.pl';
const OLD_BRAND = 'ProtokolZdawczy.pl';
const exts = new Set(['.html', '.js', '.txt', '.xml', '.webmanifest', '.mjs']);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'vendor' ? [] : walk(p);
    return exts.has(extname(p)) ? [p] : [];
  });
}

let changed = 0;
for (const file of [...walk(join(root, 'public')), join(root, 'scripts', 'make-images.mjs')]) {
  const before = readFileSync(file, 'utf8');
  const after = before.split(OLD_BRAND).join(brand).split(OLD_DOMAIN).join(domain);
  if (after !== before) {
    writeFileSync(file, after);
    changed++;
    console.log('zmieniono:', file.replace(root + '/', ''));
  }
}
console.log(`Gotowe: ${changed} plików. Nowa domena: ${domain}, marka: ${brand}.`);
console.log('Opcjonalnie wygeneruj nowy obrazek og-image.png: node scripts/make-images.mjs');
