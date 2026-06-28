{
  description = "binp-age-sealed-env — age-encrypted env vault, sealed/unsealed with Bun + age";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Everything the seal/unseal/demo scripts need at runtime:
        #   - bun     runs the TypeScript entry points directly
        #   - age     the encryption tool the scripts shell out to
        #   - openssh provides the SSH keys used as age identities
        #   - git     used by the wrapper below to find the project root
        runtimeInputs = [
          pkgs.bun
          pkgs.age
          pkgs.openssh
          pkgs.git
        ];

        # The seal/unseal scripts read and write the working tree's secrets/
        # directory (they resolve paths relative to their own location, per
        # ADR-0011), so they must run against the developer's CHECKOUT — not the
        # read-only copy Nix would otherwise place in the store. The wrapper
        # locates the project root from the current directory (git toplevel,
        # falling back to $PWD) and runs the in-tree script there, with bun and
        # age put on PATH.
        mkVaultApp =
          { name, scriptRelativePath }:
          let
            program = pkgs.writeShellApplication {
              inherit name runtimeInputs;
              text = ''
                projectRoot="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
                scriptPath="$projectRoot/${scriptRelativePath}"
                if [ ! -f "$scriptPath" ]; then
                  echo "${name}: cannot find $scriptPath — run this from inside the binp-age-sealed-env checkout." >&2
                  exit 1
                fi
                exec bun run "$scriptPath" "$@"
              '';
            };
          in
          {
            type = "app";
            program = "${program}/bin/${name}";
          };
      in
      {
        apps = {
          seal = mkVaultApp {
            name = "seal";
            scriptRelativePath = "scripts/secrets-seal.ts";
          };
          unseal = mkVaultApp {
            name = "unseal";
            scriptRelativePath = "scripts/secrets-unseal.ts";
          };
          demo = mkVaultApp {
            name = "demo";
            scriptRelativePath = "src/demo.ts";
          };
          default = self.apps.${system}.seal;
        };

        devShells.default = pkgs.mkShell {
          packages = runtimeInputs;
        };
      }
    );
}
