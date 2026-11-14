/** Print a new Ed25519 key pair for signing audit seals. Store the private key in your secret manager. */
import { generateEd25519KeyPair } from '@platform/audit';

const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
console.log('# AUDIT_SIGNING_KEY_PEM: keep this secret (store it in your secret manager)');
console.log(privateKeyPem);
console.log('# Public key: share it with auditors so they can verify seals independently');
console.log(publicKeyPem);
