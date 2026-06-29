# AGENTS.md

Guidance for AI agents working in **binp-age-sealed-env**.

> **This is a reference, not a rulebook.** This repo is a self-contained
> *showcase* of the age-sealed-env pattern, meant to be copied into other
> projects. Treat the notes below as a menu: adopt only what fits the project,
> platform, and user you're actually working for. When this file disagrees with
> the repo in front of you, the repo wins.

## What this project is

Keep secrets **in git**, `age`-encrypted, and have them appear in `process.env`
at startup — decrypted with the SSH key the user already has. A standalone,
non-Nix take on the [agenix](https://github.com/ryantm/agenix) pattern, built
directly on [`age`](https://github.com/FiloSottile/age). No vault server, no
secret-manager SaaS, no wrapper process.

The whole system is three short files plus a `secrets/` dir:

- `src/secrets.ts` — the loader: `applyAgeSecrets()` + tool/identity resolution.
- `src/demo.ts` — tiny example: loads the vault, reports which vars are set.
- `scripts/secrets-seal.ts` — encrypt `secrets/server.env` → `server.env.age`.
- `scripts/secrets-unseal.ts` — decrypt `server.env.age` → `server.env` for editing.

`README.md` and `secrets/README.md` are the canonical, up-to-date docs — read
them before changing behavior.

## Stack & commands

- **Runtime:** [Bun](https://bun.sh) + TypeScript, ESM (`"type": "module"`),
  `strict` on. No build step (`noEmit`); files run directly via Bun.
- **No test suite or linter is configured.** Don't invent a `bun test` run in
  your reporting — there are no tests to pass yet. If you add tests, say so.

```fish
bun install

bun run src/demo.ts                  # run the demo
bun run scripts/secrets-seal.ts      # seal shared vault   (also: --user, --keep)
bun run scripts/secrets-unseal.ts    # unseal for editing  (also: --user, --force)
```

`mise.toml` and `package.json` scripts mirror these (`mise run demo`,
`bun run secrets-seal`, …); a `flake.nix` exposes `nix run .#{demo,seal,unseal}`
and `nix develop`. They're conveniences — plain `bun run …` always works.

## A note for AI agents working here

On a checkout where the user's SSH key is present, you (like any local process)
*can* decrypt this vault — unseal it, run `age --decrypt`, or read the values out
of `process.env` after `applyAgeSecrets()`. That's inside the trust boundary, but
treat the decrypted values as the user's secrets: never echo, log, paste, or
otherwise exfiltrate them, and don't decrypt the vault unless the task actually
needs it. See the **Security model** section in `README.md` for the full picture.

## Invariants — do not break these

- **Never commit decrypted plaintext.** Only `*.env.age` blobs and `*.example`
  templates belong in git. `.gitignore` enforces `secrets/*.env`; keep it that
  way. If you create a `secrets/*.env`, it must stay local.
- **Never print or log a secret value.** Mirror `demo.ts`: prove presence
  (e.g. char count), never the contents. The loader logs key *names* only.
- **The loader is best-effort and never throws.** A missing blob, missing `age`
  binary, or absent identity must `console.warn` and leave `process.env`
  untouched so the program still starts. Don't add throwing paths to
  `applyAgeSecrets()` or its helpers.
- **Seal deletes the plaintext by default.** On a successful seal,
  `secrets-seal.ts` removes the plaintext `*.env` input (unless `--keep`) so no
  decrypted secret is left on disk. It's a deliberate safety default — preserve
  it, and keep `--keep` as the only opt-out.
- **Precedence is shell env > personal override > shared vault.** It's enforced
  by "already-set wins" merging, applying the personal layer before the shared
  one (see `applyAgeSecrets`). Preserve that ordering.
- **`age` output stays ASCII-armored** (`--armor`) so `*.age` files are text
  with readable git diffs — not binary blobs.
- **Tool resolution order is deliberate:** `$AGE_BIN` → `age` → `rage` →
  `nix run nixpkgs#age`. Go `age` is preferred over `rage` (no locale
  dependency). Keep `AGE_CHILD_ENV` (`LC_ALL=C`) on every `age`/`rage` child —
  it stops `rage`'s locale crash on macOS.

## Conventions

- Match the existing style: descriptive names, full sentences in comments, and a
  module-level doc comment explaining *why*. These files are teaching material —
  clarity over cleverness.
- Keep the loader free of config *validation/parsing*: it only populates
  `process.env`; the consuming app reads and validates later.
- `scripts/*.ts` import shared helpers (`resolveAgeCommand`, `resolveIdentities`,
  `resolveUserName`, `AGE_CHILD_ENV`) from `src/secrets.ts` — reuse them rather
  than re-implementing tool/identity resolution.
- Knobs are env vars, documented in `README.md` → Configuration: `VAULT_USER`,
  `VAULT_AGE_IDENTITIES`, `AGE_BIN`, `AGE_NIX_REF`. If you add one, document it
  there too.

## Before you finish

- Keep `README.md`, `secrets/README.md`, `mise.toml`, and `package.json` scripts
  in sync if you change file names, flags, or behavior.
- Verify by running `bun run src/demo.ts` (it works with or without a vault).
- Double-check `git status` for any stray `secrets/*.env` plaintext before
  considering the work done.
</content>
</invoke>
