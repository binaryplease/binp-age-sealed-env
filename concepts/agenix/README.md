# The agenix method

[agenix](https://github.com/ryantm/agenix) is the Nix-native approach the
[current method](../age-sealed-env/README.md) is modeled on. Secrets are
`age`-encrypted files committed to git; a NixOS (or home-manager) module decrypts
them to files at **system activation**, using the target machine's **host** SSH
key rather than a developer's personal key.

- Recipients are declared as a Nix expression in `secrets.nix`, mapping each
  `*.age` file to the `publicKeys` allowed to decrypt it.
- Decryption uses the **host** SSH key on the NixOS machine.
- Decrypted plaintext lands in files under `/run/agenix/<name>`, at activation.
- Runtime dependency is Nix + a NixOS/home-manager activation; the agenix module
  must be wired into your system config.

## Example

Recipients are a Nix expression, and the plaintext lands in a file that a NixOS
service reads at activation — decrypted with the **host** key, not yours:

```nix
# secrets.nix — declare which public keys may decrypt each secret.
let
  alice  = "ssh-ed25519 AAAA…alice";      # a developer's key
  webhost = "ssh-ed25519 AAAA…webhost";   # the target machine's host key
in {
  "example-api-key.age".publicKeys = [ alice webhost ];
}
```

```fish
# Edit a secret: agenix decrypts, opens $EDITOR, re-encrypts on save.
agenix -e example-api-key.age
```

```nix
# configuration.nix — wire the secret into the system; decrypted at activation.
age.secrets.example-api-key.file = ./secrets/example-api-key.age;

# A service reads the decrypted plaintext from a file path, not process.env:
systemd.services.myapp.serviceConfig.EnvironmentFile =
  config.age.secrets.example-api-key.path;   # e.g. /run/agenix/example-api-key
```

For how this repo's non-Nix take differs dimension by dimension, see the
[concepts comparison](../README.md#comparison).
