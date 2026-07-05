/**
 * src/secrets.ts — load age-encrypted env secrets into process.env.
 *
 * A standalone, non-Nix way to keep secrets in git: `secrets/server.env.age` is
 * a plain [`age`](https://github.com/FiloSottile/age) blob encrypted to the
 * public keys in `secrets/recipients.txt`. At startup we decrypt it with the
 * local SSH identity and inject each `KEY=value` line into `process.env`. It is
 * the same primitive agenix wraps, but in-process — no Nix evaluation, no dev
 * shell, no wrapper around your program.
 *
 * This deliberately does NOT validate or parse config: it only populates the
 * environment that the rest of your app later reads. Run it first, for side
 * effects, before anything touches `process.env`.
 *
 * Decryption is best-effort: a missing blob, missing age binary, or absent
 * identity logs a warning and leaves the environment untouched — the program
 * still starts, and whatever needs a secret can report its own clear "not
 * configured" state. That is what lets you scaffold and run before any real
 * credentials exist.
 */
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SECRETS_DIR = join(PROJECT_ROOT, "secrets");
const AGE_FILE = join(SECRETS_DIR, "server.env.age");

/**
 * Resolve the name identifying the local user, used to find a personal override
 * file (`secrets/user.<name>.env.age`). Defaults to the OS login name and is
 * overridable with $VAULT_USER, so the same checkout can load a different
 * person's overrides (e.g. in CI, or when one machine runs for several people).
 */
export function resolveUserName(): string {
  const override = process.env.VAULT_USER?.trim();
  if (override) return override;
  return userInfo().username;
}

/** Path to a user's personal, sealed override file: `secrets/user.<name>.env.age`. */
export function personalSecretsFile(userName: string): string {
  return join(SECRETS_DIR, `user.${userName}.env.age`);
}

/** SSH keys tried as age identities, mirroring agenix's defaults. */
const DEFAULT_IDENTITIES = [
  join(homedir(), ".ssh", "id_ed25519"),
  join(homedir(), ".ssh", "id_rsa"),
];

/** Flake ref for the `nix run` fallback; override with $AGE_NIX_REF. */
const NIX_AGE_REF = process.env.AGE_NIX_REF ?? "nixpkgs#age";

/**
 * Environment forced onto every age/rage child: a clean POSIX locale. `rage`'s
 * `locale_config` dependency can panic parsing the macOS NSLocale when Language
 * differs from Region (`AppleLocale = en_US@rg=…`); `LC_ALL=C` overrides that
 * read so the call can't crash before decrypting. Harmless for Go `age`, which
 * is locale-agnostic.
 */
export const AGE_CHILD_ENV = { ...process.env, LC_ALL: "C" };

/**
 * Resolve the argv prefix for an age-compatible tool, as an array so it can be
 * either a plain binary (`["age"]`) or a launcher (`["nix","run",ref,"--"]`).
 *
 * Order: $AGE_BIN, then `age`, then `rage` on PATH (Go `age` first — it has no
 * locale dependency; both implement the same age format and are interchangeable).
 * If none is installed but `nix` is available, fall back to `nix run nixpkgs#age`
 * so CI and fresh machines need nothing installed. Returns null only when there
 * is no tool and no nix at all.
 */
export function resolveAgeCommand(): string[] | null {
  const candidates = [process.env.AGE_BIN, "age", "rage"].filter(
    (candidate): candidate is string => !!candidate,
  );
  for (const binary of candidates) {
    if (Bun.which(binary)) return [binary];
  }
  // No binary on PATH — let nix provide one on demand (cached after first run).
  if (Bun.which("nix")) return ["nix", "run", NIX_AGE_REF, "--"];
  return null;
}

/** Readable identity files: $VAULT_AGE_IDENTITIES (comma/colon-sep) or defaults. */
export function resolveIdentities(): string[] {
  const override = process.env.VAULT_AGE_IDENTITIES;
  const list = override
    ? override.split(/[,:]/).map((entry) => entry.trim())
    : DEFAULT_IDENTITIES;
  return list.filter((path) => path && existsSync(path));
}

/** Parse a dotenv-style document into entries, skipping blanks/comments/empties. */
function parseDotenv(text: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = line.slice(0, equalsIndex).replace(/^export\s+/, "").trim();
    let value = line.slice(equalsIndex + 1).trim();
    // Strip a single layer of matching surrounding quotes.
    if (value.length >= 2 && /^(".*"|'.*')$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (!key || !value) continue; // empty values are intentionally not exported
    entries.push([key, value]);
  }
  return entries;
}

/**
 * Decrypt one sealed `.age` env file to its `KEY=value` entries, or null when
 * decryption failed (warning already logged to stderr). This is the single
 * source of "what does this layer define": {@link loadAgeFile} builds on it to
 * merge into `process.env`, {@link listAvailableSecrets} to enumerate names
 * without touching the environment.
 */
function decryptAgeFile(
  ageFile: string,
  ageCommand: string[],
  identityFlags: string[],
): Array<[string, string]> | null {
  const decryption = Bun.spawnSync(
    [...ageCommand, "--decrypt", ...identityFlags, ageFile],
    { stdout: "pipe", stderr: "pipe", env: AGE_CHILD_ENV },
  );

  if (decryption.exitCode !== 0) {
    const errorText = new TextDecoder().decode(decryption.stderr).trim();
    console.warn(
      `[secrets] failed to decrypt ${ageFile} (no matching identity?): ${errorText}`,
    );
    return null;
  }

  return parseDotenv(new TextDecoder().decode(decryption.stdout));
}

/**
 * Decrypt one sealed `.age` env file and merge it into `process.env`. Existing
 * non-empty env vars win, so anything already set — a shell-exported override,
 * or a higher-precedence layer applied earlier in this run — beats the sealed
 * value. Returns the names of the keys it set. `layerLabel` only colours the log
 * line so the personal vs. shared layers are distinguishable.
 *
 * All logging goes to stderr (`console.warn`), not stdout: the `ensure-env` CLI
 * emits eval-able `export`/dotenv lines on stdout, so a stray log line there
 * would corrupt what a shell `eval`s or a dotenv parser reads.
 */
function loadAgeFile(
  ageFile: string,
  ageCommand: string[],
  identityFlags: string[],
  layerLabel: string,
): string[] {
  const entries = decryptAgeFile(ageFile, ageCommand, identityFlags);
  if (entries === null) return [];

  const applied: string[] = [];
  const overridden: string[] = [];
  for (const [key, value] of entries) {
    if (process.env[key]) {
      overridden.push(key); // an explicit env / higher-precedence layer already won
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }

  if (applied.length > 0) {
    console.warn(
      `[secrets] loaded ${applied.length} ${layerLabel} secret(s): ${applied.join(", ")}`,
    );
  } else if (entries.length === 0) {
    console.warn(
      `[secrets] decrypted ${ageFile} (${layerLabel}) but it has no non-empty KEY=value lines — ` +
        `seal real values (bun run scripts/secrets-seal.ts).`,
    );
  } else {
    console.warn(
      `[secrets] decrypted ${ageFile} (${layerLabel}); all ${entries.length} var(s) already set ` +
        `(${overridden.join(", ")}), nothing applied.`,
    );
  }
  return applied;
}

/**
 * Decrypt the sealed env files and merge them into `process.env` in precedence
 * order, returning the names of every key set (for logging/tests).
 *
 * Two layers, highest precedence first:
 *   1. `secrets/user.<name>.env.age` — the local user's *personal* overrides
 *      (`<name>` from {@link resolveUserName}), present only on that person's
 *      checkout and typically encrypted to them alone.
 *   2. `secrets/server.env.age` — the *shared* vault every participant decrypts.
 *
 * Because each layer skips keys already present in the environment, applying
 * personal first means a personal value beats the shared one for the same key,
 * while an explicit shell-exported env var still beats both. Either layer may be
 * absent — a checkout with no personal file just loads the shared vault, and a
 * checkout with neither loads nothing and still starts.
 */
/**
 * Shared preamble for every vault operation: the sealed layer files that are
 * actually present (highest precedence first), an age-compatible command, and
 * the `-i` identity flags to decrypt with. Returns null — after warning to
 * stderr, exactly as {@link applyAgeSecrets} used to inline — when nothing is
 * sealed, or no age binary / identity is available. Extracting it lets
 * {@link applyAgeSecrets} and {@link listAvailableSecrets} share one definition
 * of "can we decrypt, and what layers exist" so they can't drift apart.
 */
function resolveVaultPrereqs(): {
  present: Array<{ file: string; label: string }>;
  ageCommand: string[];
  identityFlags: string[];
} | null {
  const userName = resolveUserName();
  // Highest precedence first; loadAgeFile's "already set wins" rule does the
  // layering, so the personal file must be applied before the shared one.
  const layers = [
    { file: personalSecretsFile(userName), label: `personal (${userName})` },
    { file: AGE_FILE, label: "shared" },
  ];
  const present = layers.filter((layer) => existsSync(layer.file));

  if (present.length === 0) {
    console.warn(`[secrets] no ${AGE_FILE} (or personal override); nothing to load.`);
    return null;
  }

  const ageCommand = resolveAgeCommand();
  if (!ageCommand) {
    console.warn(
      `[secrets] sealed env file(s) present but no 'age'/'rage' binary and no 'nix' found — ` +
        `secrets not loaded. Install one (e.g. nix profile install nixpkgs#age).`,
    );
    return null;
  }

  const identities = resolveIdentities();
  if (identities.length === 0) {
    console.warn(
      `[secrets] no readable SSH identity (tried ${DEFAULT_IDENTITIES.join(", ")}) — ` +
        `cannot decrypt the sealed env file(s).`,
    );
    return null;
  }

  const identityFlags = identities.flatMap((identity) => ["-i", identity]);
  return { present, ageCommand, identityFlags };
}

export function applyAgeSecrets(): string[] {
  const prereqs = resolveVaultPrereqs();
  if (!prereqs) return [];

  const applied: string[] = [];
  for (const layer of prereqs.present) {
    applied.push(
      ...loadAgeFile(layer.file, prereqs.ageCommand, prereqs.identityFlags, layer.label),
    );
  }
  return applied;
}

/**
 * Every secret the present vault layers define, each paired with the layer that
 * provides it (`source` — e.g. `"personal (enrico)"` or `"shared"`), WITHOUT
 * merging anything into `process.env`. Names only — no values — so the result is
 * always safe to print.
 *
 * This backs `ensure-env --list`: show *which* secrets are available to load,
 * without exposing a single value. Ordering follows layer precedence (personal
 * first) and is de-duplicated, so a key sealed in both layers is reported once,
 * attributed to the higher-precedence (personal) layer — matching where
 * {@link applyAgeSecrets} would resolve it from.
 *
 * Returns [] — warning first, like {@link applyAgeSecrets} — when nothing is
 * sealed or no age binary / identity is available.
 */
export function listAvailableSecrets(): Array<{ name: string; source: string }> {
  const prereqs = resolveVaultPrereqs();
  if (!prereqs) return [];

  const seen = new Set<string>();
  const secrets: Array<{ name: string; source: string }> = [];
  for (const layer of prereqs.present) {
    const entries = decryptAgeFile(layer.file, prereqs.ageCommand, prereqs.identityFlags);
    if (!entries) continue;
    for (const [key] of entries) {
      if (seen.has(key)) continue; // first layer wins — mirrors read-time precedence
      seen.add(key);
      secrets.push({ name: key, source: layer.label });
    }
  }
  return secrets;
}

/**
 * The de-duplicated union of every secret name defined across the present vault
 * layers (personal + shared), WITHOUT merging anything into `process.env`.
 *
 * This backs `ensure-env --all`: a consumer that wants every sealed secret
 * instead of enumerating each key by hand. It only reports which names exist;
 * read-time precedence (shell env > personal > shared) still applies when the
 * caller pairs these names with {@link ensureEnv}. A names-only projection of
 * {@link listAvailableSecrets} — same layers, same precedence-ordered
 * de-duplication — so the two views can't drift apart.
 */
export function vaultSecretNames(): string[] {
  return listAvailableSecrets().map((secret) => secret.name);
}

/**
 * Build the loud, actionable error shown when required secrets are absent after
 * the vault has been applied. Pure (no I/O) so the caller chooses where it goes
 * — {@link ensureEnv} writes it to stderr. Names the missing keys and the exact
 * seal-it-into-the-vault recipe so the user can fix it without hunting through
 * the docs.
 */
export function describeMissingSecrets(missingNames: string[]): string {
  const plural = missingNames.length === 1 ? "secret" : "secrets";
  return [
    `[ensure-env] Missing required ${plural}: ${missingNames.join(", ")}`,
    "",
    "Add them to the age vault:",
    "  bun run scripts/secrets-unseal.ts    # decrypt secrets/server.env",
    `  $EDITOR secrets/server.env           # set ${missingNames
      .map((name) => `${name}=…`)
      .join(", ")}`,
    "  bun run scripts/secrets-seal.ts      # re-encrypt + drop the plaintext",
    "",
    `…or export it in your shell:  export ${missingNames[0]}=…`,
  ].join("\n");
}

/**
 * The one-liner a consumer wants when a secret is *required*: apply the age
 * vault, then guarantee that each named env var is present and non-empty. On
 * success it returns a map of the resolved values, typed to the exact names
 * passed. On any missing key it writes {@link describeMissingSecrets} to stderr
 * and exits the process with a non-zero code — failing loudly so the user seals
 * the key, instead of letting a downstream API call fail later with an opaque
 * 401.
 *
 * This is the deliberate, opt-in *loud* counterpart to the best-effort
 * {@link applyAgeSecrets}: the loader itself never throws so a program can still
 * scaffold and boot without a vault, but a feature that genuinely cannot run
 * without a credential calls `ensureEnv` at its own edge to stop early with a
 * clear message. It fails via `process.exit`, not a thrown error, so it never
 * turns `applyAgeSecrets()` or its helpers into a throwing path.
 *
 *   const { EXAMPLE_API_KEY } = ensureEnv("EXAMPLE_API_KEY");
 *
 * Precedence still applies through {@link applyAgeSecrets}: a shell-exported
 * value beats the personal override, which beats the shared vault — so a key set
 * in any of those three satisfies the guarantee.
 */
export function ensureEnv<EnvVarName extends string>(
  ...requiredNames: EnvVarName[]
): Record<EnvVarName, string> {
  applyAgeSecrets();
  const missingNames = requiredNames.filter((name) => !process.env[name]);
  if (missingNames.length > 0) {
    console.error(describeMissingSecrets(missingNames));
    process.exit(1);
  }
  const resolved = {} as Record<EnvVarName, string>;
  for (const name of requiredNames) {
    resolved[name] = process.env[name] as string;
  }
  return resolved;
}
