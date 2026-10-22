import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tradeCalls = [/createTrader\s*\(/, /placePerpOrder\s*\(/, /placeOrderFor\s*\(/];
const secrets = [/privateKey\s*:/, /mnemonic\s*:/, /BEGIN (?:EC |RSA )?PRIVATE KEY/];

async function filesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full)));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const hits = [];
for (const file of await filesUnder(path.join(root, "src"))) {
  const text = await readFile(file, "utf8");
  const relative = path.relative(root, file);
  for (const pattern of tradeCalls) {
    if (pattern.test(text)) hits.push(`${relative} matches ${pattern}`);
  }
  if (relative.startsWith("src/lib/guardian/")) {
    for (const pattern of secrets) {
      if (pattern.test(text)) hits.push(`${relative} matches ${pattern}`);
    }
  }
}

if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}

console.log("unsigned: src has no order placement, and guardian code has no private key");
