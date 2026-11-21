{
  description = "Spencer: an always-on agent that talks to other people's Spencers (relay, daemon, web UI)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Only what the build needs; keeps local node_modules/.bin/dist/.data out of the store.
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./package-lock.json
          ./tsconfig.json
          ./scripts/build-relay.mjs
          (lib.fileset.fileFilter (f: !(lib.hasInfix "node_modules" f.name)) ./packages)
        ];
      };

      spencerPackages = pkgs: import ./nix/packages.nix { inherit lib pkgs src; };
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          p = spencerPackages pkgs;
        in
        {
          inherit (p)
            spencer
            spencer-relay
            spencer-web
            croc
            ;
          default = p.spencer;
        }
      );

      apps = forAllSystems (pkgs: {
        spencer = {
          type = "app";
          program = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.spencer;
          meta.description = "Run the Spencer daemon (web UI on 127.0.0.1)";
        };
        spencer-relay = {
          type = "app";
          program = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.spencer-relay;
          meta.description = "Run the Spencer message relay";
        };
        default = self.apps.${pkgs.stdenv.hostPlatform.system}.spencer;
      });

      overlays.default = final: _prev: {
        inherit (spencerPackages final)
          spencer
          spencer-relay
          spencer-web
          ;
        croc-spencer = (spencerPackages final).croc;
      };

      nixosModules = {
        relay = import ./nix/modules/relay.nix self;
        spencer = import ./nix/modules/spencer.nix self;
        default = {
          imports = [
            self.nixosModules.relay
            self.nixosModules.spencer
          ];
        };
      };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            self.packages.${pkgs.stdenv.hostPlatform.system}.croc
            pkgs.nixfmt
          ];
          shellHook = ''
            echo "spencer dev shell: node $(node --version), croc $(croc --version | cut -d' ' -f3)"
            echo "  npm ci && npm test        # all tests"
            echo "  npm start -- --data-dir .data/a --port 7420"
          '';
        };
      });

      checks = forAllSystems (
        pkgs:
        let
          p = spencerPackages pkgs;
        in
        {
          inherit (p) spencer spencer-relay spencer-web;
          # Protocol + relay unit tests against the built workspace (fast, no network beyond loopback).
          unit = pkgs.runCommand "spencer-unit-tests" { nativeBuildInputs = [ pkgs.nodejs_22 ]; } ''
            cp -r ${p.workspace}/lib/spencer work && chmod -R u+w work && cd work
            cp -r ${src}/packages/protocol/test packages/protocol/test
            cp -r ${src}/packages/relay/test packages/relay/test
            HOME=$TMPDIR node --disable-warning=ExperimentalWarning --test \
              packages/protocol/test/*.test.ts packages/relay/test/*.test.ts
            touch $out
          '';
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # Evaluates both NixOS modules together and builds just their systemd unit files.
          modules =
            let
              sys = nixpkgs.lib.nixosSystem {
                system = pkgs.stdenv.hostPlatform.system;
                modules = [
                  self.nixosModules.default
                  {
                    boot.isContainer = true;
                    system.stateVersion = "25.05";
                    services.spencer-relay = {
                      enable = true;
                      environmentFile = "/run/secrets/spencer-relay.env";
                      croc.enable = true;
                      stun.enable = true;
                    };
                    services.spencer = {
                      enable = true;
                      user = "alice";
                    };
                    users.users.alice.isNormalUser = true;
                  }
                ];
              };
              units = sys.config.systemd.units;
            in
            pkgs.linkFarm "spencer-module-units" {
              "spencer-relay.service" = units."spencer-relay.service".unit;
              "spencer-croc-relay.service" = units."spencer-croc-relay.service".unit;
              "spencer.service" = units."spencer.service".unit;
            };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
