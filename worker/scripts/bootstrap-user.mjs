#!/usr/bin/env node
// Generates a new user + API key and prints the SQL to run against D1.
// There is no public signup endpoint by design (see plan §Auth) — this is the only
// way to create a user. Run it, then apply the printed SQL yourself, e.g.:
//   node scripts/bootstrap-user.mjs me@example.com | wrangler d1 execute eink-db --local --command "$(cat)"
// (drop --local to apply against the deployed remote database)
import { randomBytes, randomUUID, createHash } from "node:crypto";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/bootstrap-user.mjs <email>");
  process.exit(1);
}

function generateApiKey() {
  const bytes = randomBytes(32);
  const b64url = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `eink_${b64url}`;
}

const apiKey = generateApiKey();
const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
const id = randomUUID();
const createdAt = Math.floor(Date.now() / 1000);

console.error(`\nSave this API key now — it is not recoverable (only its hash is stored):\n\n  ${apiKey}\n`);
console.log(
  `INSERT INTO users (id, email, api_key_hash, created_at) VALUES ('${id}', '${email.replace(/'/g, "''")}', '${apiKeyHash}', ${createdAt});`
);
