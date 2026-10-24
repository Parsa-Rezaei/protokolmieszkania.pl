// Lokalny serwer podglądu: serwuje public/ z nagłówkami z public/_headers (jak Cloudflare Pages)
// i obsługuje /api/pieczec funkcją z functions/api/pieczec.js.
// Użycie: npm run serve  ->  http://localhost:8788
// Zmienne funkcji można podać w pliku .dev.vars (KLUCZ=wartość w każdej linii; plik jest w .gitignore).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = '^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      cur = { re: new RegExp(pattern), headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = line.indexOf(':');
      cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

function loadDevVars() {
  const file = join(root, '.dev.vars');
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return env;
}

/**
 * @param {{port?:number, env?:object, configJs?:string}} options
 */
export async function startServer(options = {}) {
  const rules = parseHeaders(await readFile(join(pub, '_headers'), 'utf8'));
  const fn = await import(pathToFileURL(join(root, 'functions', 'api', 'pieczec.js')).href);
  const env = Object.assign(loadDevVars(), options.env || {});

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/pieczec') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const request = new Request('http://localhost' + req.url, {
          method: req.method,
          headers: req.headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
        });
        const response = await fn.onRequest({ request, env });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(pub, path));
      if (!file.startsWith(pub + sep)) {
        res.writeHead(403).end();
        return;
      }
      let body;
      let status = 200;
      let servedPath = path;
      if (options.configJs && path === '/assets/config.js') {
        body = Buffer.from(options.configJs);
      } else {
        try {
          if (!(await stat(file)).isFile()) throw new Error('not file');
          body = await readFile(file);
        } catch (e) {
          status = 404;
          servedPath = '/404.html';
          body = await readFile(join(pub, '404.html'));
        }
      }
      const headers = { 'content-type': TYPES[extname(servedPath)] || 'application/octet-stream' };
      for (const r of rules) if (r.re.test(url.pathname)) for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      res.writeHead(500).end('server error');
    }
  });
  await new Promise((resolve) => server.listen(options.port ?? 8788, '127.0.0.1', resolve));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer({ port: Number(process.env.PORT) || 8788 });
  console.log('Podgląd: http://localhost:' + server.address().port);
}
