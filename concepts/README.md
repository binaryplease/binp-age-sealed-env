# concepts/

Each secrets-management approach this repo compares lives in its own folder here,
so a concept can be read (and later extended) on its own:

- [`age-sealed-env/`](age-sealed-env/README.md) — **the current method**: the
  pattern this repo implements. Bun files that decrypt an `age` vault into
  `process.env` at app startup, no Nix at runtime.
- [`agenix/`](agenix/README.md) — **agenix**: the Nix-native approach this
  pattern is modeled on. A NixOS module that decrypts `age` secrets to files at
  system activation.

New approaches get a new folder next to these; the comparison below grows a
column per concept. For now it starts with just these two.

## Comparison

Both encrypt secrets to SSH public keys and commit the ciphertext to git; both
let you add/remove readers by editing a recipient list and re-sealing. The
difference is what sits *around* `age`: the current method is a handful of Bun
files that inject into `process.env`, while agenix is a Nix module that decrypts
to files at system activation.

| Dimension | This method (age-sealed-env) | agenix |
|---|---|---|
| Where secrets live | In your repo, `age`-encrypted (versioned, reviewable, one source of truth) | In your repo, `age`-encrypted — same |
| Recipients declared in | `secrets/recipients.txt` — a plain list of SSH public keys | `secrets.nix` — a Nix expression mapping each `*.age` to its `publicKeys` |
| Identity used to decrypt | The developer's **personal** SSH key (`~/.ssh/id_ed25519`) | The **host** SSH key on the NixOS machine |
| Where decrypted values land | `process.env`, in-process, at app startup | Files under `/run/agenix/<name>`, at NixOS/home-manager activation |
| Runtime dependency | Bun + one `age`-compatible binary (or `nix` as an automatic fallback) | Nix + a NixOS/home-manager activation |
| Editing workflow | `unseal` → edit plaintext → `seal` (plaintext deleted on seal) | `agenix -e secret.age` (decrypt, edit, re-encrypt in one step) |
| Coupling | None — drop the files into any Bun project | Requires Nix and the agenix module wired into your system config |
| Diffs | Readable text (ASCII-armored), so rotations show up in code review | Readable text (ASCII-armored) — same |
| Best for | App-level env vars, non-Nix teams and CI | NixOS system-service secrets, declarative hosts |

The current method is the convenience of agenix (encrypt to SSH keys,
edit-and-reseal) without requiring Nix to be in the loop at runtime.
