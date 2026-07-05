#!/usr/bin/env -S bun --no-env-file
/**
 * scripts/ensure-env.ts — guarantee that named secrets are present, loading the
 * age vault under the hood, then emit them as `export` lines for a shell to eval.
 *
 * This is the shell-facing front door to src/secrets.ts's {@link ensureEnv}: it
 * applies the personal + shared age vaults (shell env > personal > shared) and
 * verifies every requested key resolved to a non-empty value. If any are missing
 * it prints an actionable message to stderr and exits non-zero — so a consumer
 * script fails loudly at startup instead of hitting an opaque 401 later.
 *
 * Usage:
 *   ensure-env KEY [KEY...]      verify + print `export KEY='value'` lines (stdout)
 *   ensure-env --dotenv KEY...   verify + print `KEY="value"` dotenv lines (stdout)
 *   ensure-env --all             every secret sealed in the vault (no need to name them)
 *   ensure-env --list            list available secret names + their source (no values)
 *   ensure-env --check KEY...    verify only; print nothing on success
 *   ensure-env -h | --help       show this help
 *
 * `--list` is the read-only discovery counterpart to `--all`: instead of loading
 * every vault secret's value, it prints just the *names* the vault defines (one
 * per line, with the source layer in a second column) so you can see which
 * secrets are available without exposing a single value. It ignores any
 * explicitly named keys and the format flags — names only, always safe to show.
 *
 * `--all` expands to every key the age vault defines (personal + shared layers),
 * unioned with any keys also named explicitly. It combines with --dotenv/--check
 * like any other key list — e.g. `ensure-env --dotenv --all` hands a dotenv
 * parser the whole vault without enumerating keys.
 *
 * Shell consumers eval the export lines (capture first so a missing key aborts):
 *   secrets="$(bun run scripts/ensure-env.ts EXAMPLE_API_KEY DATABASE_URL)" || exit 1
 *   eval "$secrets"
 *   # $EXAMPLE_API_KEY and $DATABASE_URL are now set
 *
 * Bun consumers editing THIS repo skip the subprocess and import ensureEnv from
 * src/secrets.ts directly:
 *   import { ensureEnv } from "../src/secrets.ts";
 *   const { EXAMPLE_API_KEY } = ensureEnv("EXAMPLE_API_KEY");
 * A program in another project that copied this repo in can either do the same
 * (import the copied loader) or shell out to this CLI and parse `--dotenv` lines.
 *
 * The default output is shell `export KEY='value'` lines, single-quote-escaped
 * for `eval`. That escaping is a *shell* idiom, not a dotenv one: a tool that
 * parses the output as dotenv (rather than running it through a shell) would
 * mangle any value containing a single quote or a real newline. So `--dotenv`
 * emits `KEY="value"` lines with C-style double-quote escaping (\\ \" \n \t \r)
 * for consumers that parse stdout directly as dotenv. That escaping is a strict
 * subset of JSON string escaping, so a Bun consumer can `JSON.parse` each line's
 * RHS to decode any value faithfully with no hand-rolled unescaping.
 *
 * All vault logging from the loader goes to stderr, so stdout carries only the
 * output lines and stays safe to eval / parse.
 *
 * The shebang passes `--no-env-file` so Bun does NOT auto-load a `.env` from the
 * cwd. That autoload is an undocumented, highest-priority side channel: it would
 * make `--check KEY` pass for a key that lives only in a local `.env` — neither
 * exported in the shell nor sealed in the vault — defeating the check. With it
 * off, presence reflects only the real env + the age vault. (When you invoke via
 * `bun run scripts/ensure-env.ts`, the shebang is bypassed, so the package.json
 * `ensure-env` script and the `mise run ensure-env` task pass the same flag.)
 */
import { resolve } from "node:path";

const HELP = `ensure-env — load the age vault and guarantee named secrets are set.

Usage:
  ensure-env KEY [KEY...]      verify + print 'export KEY=value' lines on stdout
  ensure-env --dotenv KEY...   verify + print 'KEY="value"' dotenv lines on stdout
  ensure-env --all             every secret sealed in the vault (no need to name them)
  ensure-env --list            list available secret names + their source (no values)
  ensure-env --check KEY...    verify only; print nothing on success
  ensure-env -h | --help       show this help

Shell (default export format, eval it):
  secrets="\$(bun run scripts/ensure-env.ts EXAMPLE_API_KEY)" || exit 1
  eval "\$secrets"
  # \$EXAMPLE_API_KEY is now set

Dotenv consumers that parse stdout directly (the --dotenv RHS is a JSON string
literal, so JSON.parse decodes it exactly):
  bun run scripts/ensure-env.ts --dotenv --all

Bun when editing this repo — in-process, no subprocess:
  import { ensureEnv } from "../src/secrets.ts";
  const { EXAMPLE_API_KEY } = ensureEnv("EXAMPLE_API_KEY");

Missing keys print an actionable message to stderr and exit non-zero, so the
caller fails loudly. Vault loader logs go to stderr; stdout stays eval-safe.`;

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

let checkOnly = false;
let dotenvFormat = false;
let allFromVault = false;
let listOnly = false;
const requiredNames: string[] = [];
for (const arg of args) {
  if (arg === "--check") {
    checkOnly = true;
    continue;
  }
  if (arg === "--dotenv") {
    dotenvFormat = true;
    continue;
  }
  if (arg === "--all") {
    allFromVault = true;
    continue;
  }
  if (arg === "--list") {
    listOnly = true;
    continue;
  }
  if (arg.startsWith("-")) {
    console.error(`ensure-env: unknown flag '${arg}'. Run ensure-env --help.`);
    process.exit(2);
  }
  requiredNames.push(arg);
}

// With --all or --list the key list comes from the vault, so an empty explicit
// list is fine for those; otherwise there's nothing to guarantee.
if (requiredNames.length === 0 && !allFromVault && !listOnly) {
  console.error("ensure-env: no secret names given. Run ensure-env --help.");
  process.exit(2);
}

// Resolved against this script's own location (not the cwd) so a symlinked or
// copied-in invocation still finds the repo's loader (ADR-0011).
const { ensureEnv, vaultSecretNames, listAvailableSecrets } = await import(
  resolve(import.meta.dir, "../src/secrets.ts")
);

// --list is a read-only inspection of the vault: print the available secret
// names + their source layer (no values), then stop. It ignores any explicit
// keys and the format flags — nothing here decrypts a value onto stdout.
if (listOnly) {
  const secrets: Array<{ name: string; source: string }> = listAvailableSecrets();
  if (secrets.length === 0) {
    console.error(
      "ensure-env: --list found no vault secrets (nothing sealed, or no age " +
        "binary / identity — see the [secrets] warning above).",
    );
    process.exit(1);
  }
  const width = Math.max(...secrets.map((secret) => secret.name.length));
  for (const { name, source } of secrets) {
    process.stdout.write(`${name.padEnd(width)}  ${source}\n`);
  }
  process.exit(0);
}

// --all expands to every key the vault defines, unioned with any explicitly
// named keys. Names are resolved up front so the normal ensureEnv path below
// still verifies each is non-empty and emits it (with shell-env precedence).
if (allFromVault) {
  const vaultNames: string[] = vaultSecretNames();
  if (vaultNames.length === 0) {
    console.error(
      "ensure-env: --all found no vault secrets to load (nothing sealed, or no " +
        "age binary / identity — see the [secrets] warning above).",
    );
    process.exit(1);
  }
  for (const name of vaultNames) {
    if (!requiredNames.includes(name)) requiredNames.push(name);
  }
}

// ensureEnv loads the vault and, on any missing key, prints an actionable
// message to stderr and exits non-zero — nothing more to handle here.
const resolved: Record<string, string> = ensureEnv(...requiredNames);

if (checkOnly) process.exit(0);

if (dotenvFormat) {
  // Emit `KEY="value"` with C-style double-quote escaping. This mirrors the
  // escapes a dotenv parser resolves inside double quotes (\\ \" \n \t \r), so
  // the value round-trips faithfully through one — including single quotes and
  // real newlines, which the shell-export format below cannot carry to a
  // non-shell consumer. Order matters: escape backslashes first so the
  // backslashes we add for the other characters are not re-escaped.
  for (const name of requiredNames) {
    const escaped = String(resolved[name])
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n")
      .replaceAll("\t", "\\t")
      .replaceAll("\r", "\\r");
    process.stdout.write(`${name}="${escaped}"\n`);
  }
} else {
  // Emit `export KEY='value'` with single-quote escaping so arbitrary secret
  // bytes survive `eval` intact ('\'' is the standard close-escape-reopen idiom).
  for (const name of requiredNames) {
    const escaped = String(resolved[name]).replaceAll("'", "'\\''");
    process.stdout.write(`export ${name}='${escaped}'\n`);
  }
}
