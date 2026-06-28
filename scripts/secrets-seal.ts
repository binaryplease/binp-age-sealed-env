#!/usr/bin/env bun
/**
 * scripts/secrets-seal.ts — encrypt a plaintext env file to the recipients.
 *
 * The standalone (non-Nix) counterpart to `agenix -e`: it runs `age` with
 * `-R secrets/recipients.txt` so every participant listed there can later
 * decrypt the result. No agenix CLI, no Nix dev shell.
 *
 *   bun run scripts/secrets-seal.ts                       # server.env -> server.env.age
 *   bun run scripts/secrets-seal.ts secrets/other.env     # explicit input
 *   bun run scripts/secrets-seal.ts --user                # YOUR personal override
 *   bun run scripts/secrets-seal.ts --user=alice          # a named user's override
 *   bun run scripts/secrets-seal.ts --keep                # don't delete the plaintext
 *
 * `--user[=<name>]` targets the personal override `secrets/user.<name>.env`,
 * where <name> defaults to the same login name the loader resolves at load time
 * ($VAULT_USER, else your OS login). It is shorthand for typing that path; an
 * explicit positional path still wins.
 *
 * Output path is the input with `.age` appended. On success the plaintext input
 * is deleted (no secret left on disk); pass --keep to retain it. Re-run after
 * editing either the plaintext or the recipients file (add/remove a peer).
 *
 * Recipients: a per-file `<input-without-.env>.recipients.txt` (e.g.
 * `secrets/user.alice.recipients.txt` for `secrets/user.alice.env`) wins when
 * present, so a personal override can be encrypted to one person only; otherwise
 * it falls back to the shared `secrets/recipients.txt`.
 */
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGE_CHILD_ENV, resolveAgeCommand, resolveUserName } from "../src/secrets";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SECRETS_DIR = join(PROJECT_ROOT, "secrets");
const RECIPIENTS = join(SECRETS_DIR, "recipients.txt");

function die(message: string): never {
  console.error(`secrets-seal: ${message}`);
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const keep = rawArgs.includes("--keep") || rawArgs.includes("-k");
const userFlag = rawArgs.find((arg) => arg === "--user" || arg.startsWith("--user="));
const positional = rawArgs.filter(
  (arg) => arg !== "--keep" && arg !== "-k" && arg !== userFlag,
);

/** `secrets/user.<name>.env` for --user[=name] (name defaults to the login the loader uses). */
function personalPlaintext(flag: string): string {
  const name = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1).trim() : resolveUserName();
  if (!name) die("--user given but no user name (set $VAULT_USER or pass --user=<name>)");
  return join(SECRETS_DIR, `user.${name}.env`);
}

const defaultInput = userFlag ? personalPlaintext(userFlag) : join(SECRETS_DIR, "server.env");
const input = resolve(positional[0] ?? defaultInput);
const output = `${input}.age`;

// Prefer a per-file recipients list (encrypt a personal override to one person)
// over the shared recipients.txt. `secrets/user.alice.env` -> look for
// `secrets/user.alice.recipients.txt` first.
const perFileRecipients = input.replace(/\.env$/, ".recipients.txt");
const recipients =
  perFileRecipients !== input && existsSync(perFileRecipients)
    ? perFileRecipients
    : RECIPIENTS;

if (!existsSync(recipients)) die(`recipients file not found: ${recipients}`);
if (!existsSync(input))
  die(
    `plaintext input not found: ${input}\n` +
      `  cp secrets/server.env.example secrets/server.env && $EDITOR secrets/server.env`,
  );

const ageCommand = resolveAgeCommand();
if (!ageCommand)
  die("no 'age'/'rage' binary and no 'nix' available. Install one, e.g. nix profile install nixpkgs#age");

// --armor: PEM/ASCII output so the sealed file is text, not binary — readable
// git diffs and no binary blobs in the tree. Decryption auto-detects armor.
const sealing = Bun.spawnSync(
  [...ageCommand, "--encrypt", "--armor", "-R", recipients, "-o", output, input],
  { stdout: "inherit", stderr: "inherit", env: AGE_CHILD_ENV },
);

if (sealing.exitCode !== 0) die(`age exited with code ${sealing.exitCode}`);

console.log(`sealed ${input} -> ${output} (recipients: ${recipients})`);

if (keep) {
  console.log(`kept plaintext ${input} (--keep); it stays gitignored.`);
} else {
  rmSync(input);
  console.log(`removed plaintext ${input}.`);
}
console.log("commit the .age file.");
