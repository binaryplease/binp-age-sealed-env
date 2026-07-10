# binp-age-sealed-env

Keep your secrets **in git**, encrypted, and have them appear in `process.env`
at startup — decrypted with the SSH key you already have. A small, standalone,
**non-Nix** take on the [agenix](https://github.com/ryantm/agenix) pattern, built
directly on [`age`](https://github.com/FiloSottile/age).

No vault server, no secret-manager SaaS, no Nix evaluation, no wrapper process.
Three short Bun/TypeScript files you can copy into any project.

## The idea

- Secrets live as `age`-encrypted env files in `secrets/` — committed to git.
- They're encrypted to a list of **public** SSH keys (`secrets/recipients.txt`),
  so every listed teammate can decrypt with their **private** key, and nobody
  else can.
- Blobs are **ASCII-armored**, so `secrets/*.age` are plain text with readable
  git diffs — not opaque binary.
- At startup, `applyAgeSecrets()` decrypts and injects each `KEY=value` into
  `process.env` **before** your app reads its config. In-process: no wrapper, no
  dev shell.
- It's **best-effort**: with no blob, no `age`, or the wrong key, your program
  still starts and each feature reports its own "not configured" state. So you
  can scaffold and run before any real credentials exist.

## Why — this method vs. agenix

Both encrypt secrets to SSH public keys and commit the ciphertext to git; both
let you add/remove readers by editing a recipient list and re-sealing. The
difference is what sits *around* `age`: this pattern is a handful of Bun files
that inject into `process.env`, while agenix is a Nix module that decrypts to
files at system activation. It is the convenience of agenix (encrypt to SSH keys,
edit-and-reseal) without requiring Nix to be in the loop at runtime.

Each approach gets its own write-up, with a worked example, under
[`concepts/`](concepts/README.md):

- [`concepts/age-sealed-env/`](concepts/age-sealed-env/README.md) — **the
  current method**, the pattern this repo implements.
- [`concepts/agenix/`](concepts/agenix/README.md) — **agenix**, the Nix-native
  approach it's modeled on.

See [`concepts/README.md`](concepts/README.md#comparison) for the full
dimension-by-dimension comparison table.

## Layout

```
src/
  secrets.ts          # the loader: applyAgeSecrets() (best-effort) + ensureEnv() (fail-loud)
  demo.ts             # tiny example that loads the vault and reads two vars
scripts/
  secrets-seal.ts     # encrypt  secrets/server.env  -> server.env.age   (agenix's "seal")
  secrets-unseal.ts   # decrypt  secrets/server.env.age -> server.env    (agenix's "-e" half)
  ensure-env.ts       # shell-facing CLI: guarantee named secrets, emit export/dotenv lines
secrets/
  recipients.txt      # the public keys allowed to decrypt (committed)
  server.env.example  # template for the shared vault (committed)
  user.env.example    # template for a personal override (committed)
  README.md           # full seal/unseal/participant/override workflow
  *.env.age           # the encrypted secrets you create (committed)
  *.env               # decrypted plaintext (gitignored, never committed)
```

## Quick start

Requires [Bun](https://bun.sh). For encryption you need an `age`-compatible
binary on `PATH` (`age` or `rage`) — or just `nix`, which the scripts fall back
to automatically (`nix run nixpkgs#age`).

```fish
bun install

# 1. Run the demo with no vault yet — it boots and reports "not configured".
bun run src/demo.ts

# 2. Add your public key as a recipient.
cat ~/.ssh/id_ed25519.pub
$EDITOR secrets/recipients.txt          # paste it in, replacing the placeholder

# 3. Create and seal a shared vault.
cp secrets/server.env.example secrets/server.env
$EDITOR secrets/server.env              # set EXAMPLE_API_KEY, DATABASE_URL, …
bun run scripts/secrets-seal.ts         # -> secrets/server.env.age (plaintext deleted)

# 4. Run the demo again — now the values come from the sealed vault.
bun run src/demo.ts

# Shell env still wins over the vault:
EXAMPLE_API_KEY=from-shell bun run src/demo.ts
```

`git add secrets/server.env.age` and commit — the encrypted blob is safe to push.

## Run via Nix

A `flake.nix` is included so you need nothing on your machine but Nix — `bun`
and `age` come from the flake. The apps run against your current checkout (the
project root is found from the working directory), so seal/unseal still read and
write the working tree's `secrets/`:

```fish
nix run .#seal           # encrypt secrets/server.env -> server.env.age
nix run .#unseal         # decrypt secrets/server.env.age -> server.env
nix run .#demo           # run the demo program

# Flags pass straight through after `--`:
nix run .#seal -- --user                 # seal your personal override
nix run .#unseal -- secrets/other.env.age

nix develop              # drop into a shell with bun + age + ssh on PATH
```

## Using it in your own project

Copy `src/secrets.ts`, `scripts/secrets-seal.ts`, `scripts/secrets-unseal.ts`,
`scripts/ensure-env.ts`, and the `secrets/` directory into your project, then
call the loader once, first, before anything reads config:

```ts
import { applyAgeSecrets } from "./secrets";

applyAgeSecrets();          // decrypt the vault into process.env

// ...now the rest of your app can read process.env.EXAMPLE_API_KEY etc.
```

The loader logs to the console and never throws — a missing or undecryptable
vault degrades to "nothing loaded", not a crash.

When a feature genuinely *cannot* run without a given secret, guard its edge with
`ensureEnv` — the loud counterpart to the best-effort loader. It applies the
vault, then guarantees the named vars are present, exiting with an actionable
message (which keys are missing + how to seal them) if any is not:

```ts
import { ensureEnv } from "./secrets";

// Loads the vault, then guarantees these are set — or exits non-zero, loudly.
const { EXAMPLE_API_KEY, DATABASE_URL } = ensureEnv("EXAMPLE_API_KEY", "DATABASE_URL");
```

`ensureEnv` still honours precedence (**shell env > personal override > shared
vault**), so a value exported in your shell satisfies it just as a sealed one
does. Use `applyAgeSecrets()` for the scaffold-and-run path where a missing
secret should degrade gracefully; reach for `ensureEnv` only where you'd rather
fail fast than hit an opaque 401 later.

### From a shell — the `ensure-env` CLI

`ensureEnv` is in-process, for Bun code. For **shell** scripts (or any consumer
that just wants the values in its environment) there's `scripts/ensure-env.ts`:
it loads the vault, guarantees the named keys, and prints them as `export` lines
to `eval`. Capture first so a missing key aborts before `eval`:

```sh
secrets="$(bun run --no-env-file scripts/ensure-env.ts EXAMPLE_API_KEY DATABASE_URL)" || exit 1
eval "$secrets"
# $EXAMPLE_API_KEY and $DATABASE_URL are now set
```

| Invocation | What it does |
|---|---|
| `ensure-env KEY…` | verify + print `export KEY='value'` lines (stdout) |
| `ensure-env --dotenv KEY…` | print `KEY="value"` dotenv lines for a parser that reads stdout directly |
| `ensure-env --all` | expand to every key sealed in the vault (no need to name them) |
| `ensure-env --list` | list available secret names + their source layer — **no values** |
| `ensure-env --check KEY…` | verify only; print nothing on success |

All vault logging goes to stderr, so stdout stays safe to `eval` or parse.
Missing keys print an actionable message to stderr and exit non-zero. Run it
with `--no-env-file` (the shebang, the `ensure-env` package script, and
`mise run ensure-env` all do) so a stray project-root `.env` can't quietly
satisfy a `--check`.

> **Adopt the seal script's delete-on-seal behaviour, don't strip it.** On a
> successful seal, `secrets-seal.ts` removes the plaintext `*.env` input by
> default (pass `--keep` to retain it) so no decrypted secret is left lying on
> disk. This is a deliberate safety default, not an accident — keep it when you
> copy the script into your project, and pair it with a `.gitignore` rule for
> `secrets/*.env` so a plaintext (kept or mid-edit) can never be committed.

## Security model — what this protects, and what it doesn't

This pattern moves the trust boundary; it doesn't remove it. Be clear about
which side of the line each thing sits on.

**What it protects.** Encryption gates *who can decrypt* — only the SSH keys
listed in `secrets/recipients.txt` — and it protects the blob *at rest in git*.
That's what makes the committed `secrets/*.age` safe to push: without a listed
private key it's just ciphertext, so a leaked repo, a public mirror, or a
teammate who isn't a recipient learns nothing.

**What it does NOT protect.** Encryption does not sandbox the *decrypted* values
from local code. Anything holding both an authorized SSH private key and a
checkout of the repo can decrypt the whole vault — and that trust boundary is
**any process running as you on a key-holding machine**, not just you at the
keyboard. Such a process can run `scripts/secrets-unseal.ts`, call
`age --decrypt` directly, or simply read `process.env` after `applyAgeSecrets()`
auto-loads the vault at app startup. **AI coding agents** (Claude Code, Cursor,
and the like) with shell access sit squarely inside that boundary and can do all
three.

So the SSH private key — not the `*.age` blob — is the real asset: be
deliberate about running untrusted tooling (AI agents included) on a machine
that holds a recipient key, and remember that old blobs persist in git history,
so a leaked secret must be rotated at its source rather than merely re-sealed.

## Configuration

| Variable | Purpose |
|---|---|
| `VAULT_USER` | Override the OS login name used to find a personal override file. |
| `VAULT_AGE_IDENTITIES` | Comma/colon-separated SSH key paths to try for decryption (default `~/.ssh/id_ed25519`, `~/.ssh/id_rsa`). |
| `AGE_BIN` | Force a specific `age`-compatible binary. |
| `AGE_NIX_REF` | Flake ref for the `nix run` fallback (default `nixpkgs#age`). |

See [`secrets/README.md`](secrets/README.md) for the full seal/unseal,
add-a-participant, and personal-override workflows.

## How it works (the whole mechanism)

**Seal** runs `age --encrypt --armor -R recipients.txt -o server.env.age
server.env`. Armor makes the output text; `-R` encrypts to every public key, so
each holder of a matching private key can decrypt.

**Load** (`applyAgeSecrets()`) resolves an `age` command (`$AGE_BIN` → `age` →
`rage` → `nix run`) and your SSH identities, then for each layer — personal
override first, shared vault second — runs `age --decrypt -i <key> file.age`,
parses the dotenv output, and merges it into `process.env` where the key isn't
already set. "Already set wins" gives the precedence **shell env > personal
override > shared vault**.

**Unseal** is the inverse of seal: `age --decrypt -i <key> -o server.env
server.env.age`, writing a `0600` plaintext you edit and then re-seal.

That's the entire system: `age` for crypto, SSH keys for identity, a dotenv
parser, and a `process.env` merge.

## License

MIT — see [LICENSE](LICENSE).
