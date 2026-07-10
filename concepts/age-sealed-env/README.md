# The current method — age-sealed-env

The pattern this repo implements: keep secrets `age`-encrypted in git and have
them appear in `process.env` at startup, decrypted with the developer's own SSH
key. A standalone, **non-Nix** take on the [agenix](../agenix/README.md) pattern,
built directly on [`age`](https://github.com/FiloSottile/age) — no vault server,
no Nix evaluation, no wrapper process.

- Recipients are a plain list of SSH public keys in `secrets/recipients.txt`.
- Decryption uses the **developer's personal** SSH key (`~/.ssh/id_ed25519`).
- Decrypted values land in `process.env`, in-process, at app startup.
- Runtime dependency is just Bun + one `age`-compatible binary (or `nix` as an
  automatic fallback).

## Example

Add your public key, seal a vault, and read it from `process.env`:

```fish
# 1. Declare who can decrypt (a plain list of SSH public keys).
cat ~/.ssh/id_ed25519.pub >> secrets/recipients.txt

# 2. Create + seal the shared vault (plaintext is deleted on success).
cp secrets/server.env.example secrets/server.env
$EDITOR secrets/server.env              # EXAMPLE_API_KEY=…, DATABASE_URL=…
bun run scripts/secrets-seal.ts         # -> secrets/server.env.age

# 3. Edit later with the unseal → edit → seal loop.
bun run scripts/secrets-unseal.ts       # server.env.age -> server.env (0600)
```

```ts
// In your app — decrypted with YOUR personal SSH key, into process.env:
import { applyAgeSecrets } from "./secrets";

applyAgeSecrets();                       // vault -> process.env, before config is read
console.log(process.env.EXAMPLE_API_KEY); // now populated from the sealed vault
```

The working implementation lives at the repo root — `src/secrets.ts`,
`scripts/`, and `secrets/`. See the [top-level README](../../README.md) for the
full mechanism, security model, and configuration.
