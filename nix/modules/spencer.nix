# NixOS module: run a Spencer daemon as a given user (UI on 127.0.0.1).
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.spencer;
  home = config.users.users.${cfg.user}.home;
in
{
  options.services.spencer = {
    enable = lib.mkEnableOption "the Spencer daemon";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.spencer;
      defaultText = lib.literalExpression "spencer.packages.\${system}.spencer";
    };
    user = lib.mkOption {
      type = lib.types.str;
      description = "User that owns the Spencer identity and data dir.";
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${home}/.local/share/spencer";
      defaultText = lib.literalExpression ''"''${home}/.local/share/spencer"'';
      description = "Holds identity.json, config.json, SQLite stores and the file quarantine.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 7420;
      description = "Local web UI / API port (always bound to 127.0.0.1).";
    };
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional file with model API keys, e.g. ANTHROPIC_API_KEY=… (referenced by apiKeyEnv in config.json).";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.spencer = {
      description = "Spencer agent daemon (${cfg.user})";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        SPENCER_DATA_DIR = cfg.dataDir;
        SPENCER_PORT = toString cfg.port;
      };
      serviceConfig = {
        User = cfg.user;
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = "5s";
        TimeoutStopSec = "20s";
        NoNewPrivileges = true;
        PrivateTmp = true;
        UMask = "0077";
      };
    };
  };
}
