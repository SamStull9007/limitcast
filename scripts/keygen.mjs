// One-time: create the Ed25519 license-signing key pair.
// The private key goes into the macOS Keychain only; the public key is printed for src/license.mjs.
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SERVICE = 'limitcast-license-signing';
try {
  execFileSync('security', ['find-generic-password', '-s', SERVICE], { stdio: 'ignore' });
  console.error(`Keychain item "${SERVICE}" already exists. Refusing to overwrite: existing licenses depend on it.`);
  process.exit(1);
} catch {
  /* not found: create it */
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
execFileSync('security', ['add-generic-password', '-a', 'limitcast', '-s', SERVICE, '-w', pem]);
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
