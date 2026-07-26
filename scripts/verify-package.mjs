#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve("package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const requiredEntries = [
  ["main", manifest.main],
  ["types", manifest.types],
];
const missing = [];

for (const [field, relativePath] of requiredEntries) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    missing.push(`${field}: missing manifest value`);
    continue;
  }

  try {
    await access(path.resolve(relativePath));
  } catch {
    missing.push(`${field}: ${relativePath}`);
  }
}

if (missing.length > 0) {
  console.error("Package entry-point verification failed:");
  for (const item of missing) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(
  `Package entry points verified: ${requiredEntries
    .map(([field, value]) => `${field}=${value}`)
    .join(", ")}`,
);
