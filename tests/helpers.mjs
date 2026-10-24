import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Ładuje plik UMD z public/assets w bieżącym kontekście (module.exports), tak jak w przeglądarce. */
export function loadUmd(rel) {
  const code = readFileSync(join(root, rel), 'utf8');
  const module = { exports: {} };
  vm.runInThisContext('(function (module) {' + code + '\n})', { filename: rel })(module);
  return module.exports;
}
