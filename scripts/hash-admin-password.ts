#!/usr/bin/env node
/**
 * Generate or verify a Workers-compatible admin password hash.
 *
 * The Cloudflare API Worker accepts PBKDF2-SHA256 PHC strings of the form
 * `pbkdf2-sha256$<iterations>$<salt-b64url>$<hash-b64url>`; legacy Argon2id
 * hashes from PostgreSQL deployments cannot be verified by the Worker.
 *
 * Usage:
 *   scripts/hash-admin-password.ts                 # prompt for a password
 *   scripts/hash-admin-password.ts --check '<phc>' # verify a stored hash
 *
 * The password is read from the terminal without echo and is never passed as a
 * command-line argument, so it does not enter shell history or the process list.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

import { hashPassword, verifyPassword } from '../packages/cloudflare/src/crypto.ts';

const { values } = parseArgs({
  options: {
    check: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log('Usage: scripts/hash-admin-password.ts [--check <pbkdf2 phc>]');
  process.exit(0);
}

let pipedLines: string[] | null = null;

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (pipedLines === null) {
      let data = '';
      for await (const chunk of process.stdin) data += chunk;
      pipedLines = data.split(/\r?\n/);
      if (pipedLines.at(-1) === '') pipedLines.pop();
    }
    return pipedLines.shift() ?? '';
  }
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

if (values.check) {
  const password = await readPassword('Password to verify: ');
  if (password.length === 0) {
    console.error('hash-admin-password: password is empty');
    process.exit(1);
  }
  const matches = await verifyPassword(values.check, password);
  console.log(matches ? 'hash matches' : 'hash does NOT match');
  process.exit(matches ? 0 : 1);
}

const password = await readPassword('New admin password: ');
if (password.length < 8) {
  console.error('hash-admin-password: password must be at least 8 characters');
  process.exit(1);
}
const confirmation = await readPassword('Confirm password: ');
if (password !== confirmation) {
  console.error('hash-admin-password: passwords do not match');
  process.exit(1);
}
const hash = await hashPassword(password);
console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
console.log(
  'Set this with: wrangler secret put ADMIN_PASSWORD_HASH --config deploy/cloudflare/api/wrangler.toml',
);
