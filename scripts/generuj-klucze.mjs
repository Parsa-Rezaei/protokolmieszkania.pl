// Generuje parę kluczy pieczęci (ECDSA P-256).
// Klucz PRYWATNY wklej w Cloudflare Pages jako sekret SEAL_PRIVATE_JWK (nigdy do repozytorium!).
// Klucz PUBLICZNY wklej do public/assets/config.js -> seal.publicKeyJwk.
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const priv = await crypto.subtle.exportKey('jwk', privateKey);
const pub = await crypto.subtle.exportKey('jwk', publicKey);
console.log('\n=== KLUCZ PRYWATNY (SEAL_PRIVATE_JWK – tylko do Cloudflare, NIKOMU nie pokazuj) ===\n');
console.log(JSON.stringify({ kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d }));
console.log('\n=== KLUCZ PUBLICZNY (do public/assets/config.js) ===\n');
console.log(`publicKeyJwk: { kty: '${pub.kty}', crv: '${pub.crv}', x: '${pub.x}', y: '${pub.y}' }\n`);
