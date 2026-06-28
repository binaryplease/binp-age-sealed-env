#!/usr/bin/env bun
/**
 * src/demo.ts — a tiny program that shows the loader in action.
 *
 * It calls applyAgeSecrets() first (so the sealed vault populates process.env),
 * then reads a couple of example variables exactly the way a real app would.
 * Run it before and after sealing a vault to see the difference:
 *
 *   bun run src/demo.ts                 # phase 1: no vault -> "not configured"
 *   # ...seal a vault (see README)...
 *   bun run src/demo.ts                 # phase 2: values come from the sealed vault
 *
 *   EXAMPLE_API_KEY=from-shell bun run src/demo.ts   # shell env beats the vault
 */
import { applyAgeSecrets } from "./secrets";

// Decrypt + inject sealed secrets into process.env before anything reads it.
const loaded = applyAgeSecrets();

function report(name: string): void {
  const value = process.env[name];
  if (value) {
    // Never print the secret itself — just prove it is present.
    console.log(`  ${name}: configured (${value.length} chars)`);
  } else {
    console.log(`  ${name}: not configured`);
  }
}

console.log(`\nloaded ${loaded.length} secret(s) from the vault: [${loaded.join(", ")}]`);
console.log("example variables this app cares about:");
report("EXAMPLE_API_KEY");
report("DATABASE_URL");
