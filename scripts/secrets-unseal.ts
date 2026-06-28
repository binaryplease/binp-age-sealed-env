#!/usr/bin/env bun
/**
 * scripts/secrets-unseal.ts — decrypt a sealed .age file back to plaintext.
 *
 * The inverse of secrets-seal.ts and the "decrypt half" of agenix's `-e` edit
 * flow: it writes the cleartext to a gitignored `*.env` you can edit, then you
 * re-seal. Uses the same tool resolution (age/rage, else `nix run`) and SSH
 * identities as the runtime loader.
 *
 *   bun run scripts/secrets-unseal.ts                     # server.env.age -> server.env
 *   bun run scripts/secrets-unseal.ts secrets/other.env.age
 *   bun run scripts/secrets-unseal.ts --user              # YOUR personal override
 *   bun run scripts/secrets-unseal.ts --user=alice        # a named user's override
 *
 * Then: edit the plaintext, re-seal (bun run scripts/secrets-seal.ts), delete it.
 * Refuses to clobber an existing plaintext file unless you pass --force.
 *
 * `--user[=<name>]` targets `secrets/user.<name>.env.age`, where <name> defaults
 * to the same login name the loader resolves at load time ($VAULT_USER, else
 * your OS login). An explicit positional path still wins.
 */
import { chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AGE_CHILD_ENV,
  resolveAgeCommand,
  resolveIdentities,
  resolveUserName,
} from "../src/secrets";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SECRETS_DIR = join(PROJECT_ROOT, "secrets");

function die(message: string): never {
  console.error(`secrets-unseal: ${message}`);
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const force = rawArgs.includes("--force") || rawArgs.includes("-f");
const userFlag = rawArgs.find((arg) => arg === "--user" || arg.startsWith("--user="));
const positional = rawArgs.filter(
  (arg) => arg !== "--force" && arg !== "-f" && arg !== userFlag,
);

/** `secrets/user.<name>.env.age` for --user[=name] (name defaults to the login the loader uses). */
function personalSealed(flag: string): string {
  const name = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1).trim() : resolveUserName();
  if (!name) die("--user given but no user name (set $VAULT_USER or pass --user=<name>)");
  return join(SECRETS_DIR, `user.${name}.env.age`);
}

const defaultInput = userFlag ? personalSealed(userFlag) : join(SECRETS_DIR, "server.env.age");
const input = resolve(positional[0] ?? defaultInput);
if (!input.endsWith(".age")) die(`input must be a .age file: ${input}`);
const output = input.slice(0, -".age".length); // drop the .age suffix

if (!existsSync(input)) die(`sealed file not found: ${input}`);
if (existsSync(output) && !force)
  die(`refusing to overwrite existing plaintext: ${output}\n  pass --force to overwrite`);

const ageCommand = resolveAgeCommand();
if (!ageCommand)
  die("no 'age'/'rage' binary and no 'nix' available. Install one, e.g. nix profile install nixpkgs#age");

const identities = resolveIdentities();
if (identities.length === 0)
  die("no readable SSH identity found (set $VAULT_AGE_IDENTITIES to override)");

const identityFlags = identities.flatMap((identity) => ["-i", identity]);
const unsealing = Bun.spawnSync(
  [...ageCommand, "--decrypt", ...identityFlags, "-o", output, input],
  { stdout: "inherit", stderr: "inherit", env: AGE_CHILD_ENV },
);

if (unsealing.exitCode !== 0)
  die(`decrypt failed (no matching identity for the recipients?) — exit ${unsealing.exitCode}`);

chmodSync(output, 0o600); // plaintext secret — owner-only
console.log(`unsealed ${input} -> ${output}`);
const resealHint = userFlag
  ? "bun run scripts/secrets-seal.ts --user"
  : "bun run scripts/secrets-seal.ts";
console.log(`edit it, then: ${resealHint} (it re-encrypts and deletes the plaintext).`);
