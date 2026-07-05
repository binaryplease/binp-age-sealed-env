# secrets/

Standalone, **non-Nix** secret handling built directly on
[`age`](https://github.com/FiloSottile/age) — the same primitive agenix wraps,
minus the Nix evaluation and dev shell.

Sealed blobs are **ASCII-armored** (PEM `-----BEGIN AGE ENCRYPTED FILE-----`),
so `secrets/*.age` are plain text — readable git diffs, no binary files. age/rage
auto-detect armor on decrypt, so nothing extra is needed to read them.

| File | Committed? | What it is |
|---|---|---|
| `recipients.txt` | yes | Participant **public** keys (agenix `publicKeys`). Passed to `-R` at seal time. |
| `server.env.example` | yes | Documented template of the shared secret env vars. |
| `server.env.age` | yes (once created) | The real **shared** secrets, ASCII-armored, encrypted to every key in `recipients.txt`. |
| `server.env` | **no** (gitignored) | Decrypted/working plaintext you seal from. |
| `user.env.example` | yes | Documented template for a **personal override** file. |
| `user.<name>.recipients.txt` | yes | Per-file recipients for one person's override (usually just their key). |
| `user.<name>.env.age` | yes (once created) | One person's **personal override** secrets, encrypted to their key. |
| `user.<name>.env` | **no** (gitignored) | Decrypted/working plaintext of a personal override. |

> A fresh checkout ships **without** any `*.age` blob — there are no credentials
> yet. Programs boot fine in that state (every secret reports "not configured").
> Create the blob with the workflow below.

## Prerequisite

**Nothing, if you have `nix`.** When neither `age` nor `rage` is on `PATH`, both
the seal script and the runtime loader fall back to `nix run nixpkgs#age --`
(cached after first use). Install a binary once to skip the per-call overhead:

```fish
nix profile install nixpkgs#age      # or: rage, or your distro's package
```

Resolution order (seal + load): `$AGE_BIN` → `age` → `rage` on PATH → `nix run`.
Go [`age`](https://github.com/FiloSottile/age) is preferred over `rage` because
it has no locale dependency; both speak the same format and are interchangeable.

## First, add yourself as a recipient

```fish
cat ~/.ssh/id_ed25519.pub               # your public key
$EDITOR secrets/recipients.txt          # paste it in (replace the placeholder)
```

## Provision a secret (first time)

```fish
cp secrets/server.env.example secrets/server.env
$EDITOR secrets/server.env              # set EXAMPLE_API_KEY, DATABASE_URL, …
bun run scripts/secrets-seal.ts         # -> server.env.age, then deletes the plaintext
git add secrets/server.env.age          # commit the encrypted blob
```

## Edit an existing secret (the agenix `-e` flow)

```fish
bun run scripts/secrets-unseal.ts       # server.env.age -> server.env (0600)
$EDITOR secrets/server.env              # change a value
bun run scripts/secrets-seal.ts         # re-encrypt + delete the plaintext
```

`secrets-unseal` refuses to overwrite an existing plaintext unless you pass
`--force`; `secrets-seal` removes the plaintext on success unless you pass
`--keep`.

## Add / remove a participant

Edit `recipients.txt` (append or delete an `ssh-ed25519 …` line), then unseal +
re-seal so the blob is re-encrypted to the new set:

```fish
bun run scripts/secrets-unseal.ts
bun run scripts/secrets-seal.ts
```

> `age` encryption is non-deterministic, so every seal produces a different
> `*.age` even when the plaintext is unchanged — that's expected.

## Personal overrides (per-user env)

On top of the shared `server.env.age`, each developer can keep a **personal
override** that only loads on their own machine — handy for pointing at your own
credentials without touching the shared vault.

- File: `secrets/user.<name>.env.age`, where `<name>` is your OS login name
  (override with `$VAULT_USER`).
- At startup `applyAgeSecrets()` loads the **personal layer first**, then the
  shared vault, and each layer skips keys already set. So precedence, highest
  first, is: **shell env > personal override > shared vault**.
- Put **only the vars you override** in the personal file — everything else keeps
  coming from the shared vault.
- A personal file is normally encrypted to **you alone**: drop a
  `secrets/user.<name>.recipients.txt` next to it (just your key) and
  `secrets-seal` uses it automatically; without one it falls back to the shared
  `recipients.txt`.

The `--user` flag (and the `*-user` scripts) target **your** override — `--user`
resolves your login name the same way the loader does (`$VAULT_USER`, else your
OS login):

```fish
bun run scripts/secrets-unseal.ts --user   # decrypt YOUR user.<you>.env.age (0600)
$EDITOR secrets/user.$USER.env             # set EXAMPLE_API_KEY=…
bun run scripts/secrets-seal.ts --user     # re-encrypt (to you alone) + delete the plaintext
```

First time (no override yet), start from the template instead of unsealing:

```fish
cp secrets/user.env.example secrets/user.$USER.env
$EDITOR secrets/user.$USER.env
# optional: secrets/user.$USER.recipients.txt (just your key)
bun run scripts/secrets-seal.ts --user
git add secrets/user.$USER.env.age secrets/user.$USER.recipients.txt
```

All four scripts also take an explicit path or `--user=<name>` for another
person's file (e.g. `bun run scripts/secrets-unseal.ts --user=alice`).

## How it loads at runtime

`src/secrets.ts` (`applyAgeSecrets()`, called before your app reads any config)
decrypts your personal override (`user.<name>.env.age`, if present) and then the
shared `server.env.age` with your SSH identity (`~/.ssh/id_ed25519`, then
`id_rsa`; override with `$VAULT_AGE_IDENTITIES`) and injects each `KEY=value`
into `process.env` **before your program reads it**. Empty values are skipped; an
already-set var wins, so precedence is **shell env > personal override > shared
vault**. Missing blob / missing `age` / wrong key → a warning, and your program
still starts (each feature reports its own "not configured" status).

For a secret a feature genuinely can't run without, call `ensureEnv(...names)`
from `src/secrets.ts` at that feature's edge instead: it applies the vault the
same way, then guarantees each named var is set and non-empty — exiting non-zero
with an actionable "seal these keys" message if any is missing, rather than
degrading to "not configured". It honours the same precedence, so a shell-exported
value satisfies it too.

> Note that auto-loading and `secrets-unseal` both yield *plaintext* secrets to
> any local process — including AI coding agents with shell access — that holds
> your SSH key. The encryption protects the blob at rest, not the decrypted
> values from local code. See the [Security model](../README.md#security-model--what-this-protects-and-what-it-doesnt)
> section in the top-level README.
