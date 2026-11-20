# NixOS module: Spencer message relay + self-hosted croc relay (+ optional nginx vhost).
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.spencer-relay;
  hardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectHostname = true;
    ProtectClock = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectProc = "invisible";
    RestrictAddressFamilies = [
      "AF_INET"
      "AF_INET6"
      "AF_UNIX"
    ];
    RestrictNamespaces = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    RemoveIPC = true;
    CapabilityBoundingSet = "";
    SystemCallArchitectures = "native";
    SystemCallFilter = [
      "@system-service"
      "~@privileged"
    ];
    SystemCallErrorNumber = "EPERM";
    UMask = "0077";
    DynamicUser = true;
    Restart = "on-failure";
    RestartSec = "2s";
  };
in
{
  options.services.spencer-relay = {
    enable = lib.mkEnableOption "the Spencer message relay";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.spencer-relay;
      defaultText = lib.literalExpression "spencer.packages.\${system}.spencer-relay";
    };
    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 8820;
    };
    ttlDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 14;
      description = "Messages not acked by every member are dropped after this many days.";
    };
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        File with secrets, read by both services:
        `SPENCER_CROC_PASS=…` and `CROC_PASS=…` (same value). Keep it out of the Nix store.
      '';
    };
    memoryMax = lib.mkOption {
      type = lib.types.str;
      default = "192M";
    };
    croc = {
      enable = lib.mkEnableOption "a self-hosted croc relay for Spencer file transfers";
      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.croc;
        defaultText = lib.literalExpression "spencer.packages.\${system}.croc (pinned v10.3.1)";
      };
      publicAddress = lib.mkOption {
        type = lib.types.str;
        default = "${cfg.nginx.domain}:${toString cfg.croc.basePort}";
        defaultText = lib.literalExpression ''"''${nginx.domain}:''${basePort}"'';
        description = "host:port of the croc relay as clients should dial it (sent to channel members).";
      };
      basePort = lib.mkOption {
        type = lib.types.port;
        default = 9009;
        description = "First of five consecutive TCP ports.";
      };
      openFirewall = lib.mkOption {
        type = lib.types.bool;
        default = true;
      };
    };
    nginx = {
      enable = lib.mkEnableOption "an nginx vhost with ACME TLS in front of the relay";
      domain = lib.mkOption {
        type = lib.types.str;
        default = "spencer.example.com";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.spencer-relay = {
      description = "Spencer message relay";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        SPENCER_RELAY_HOST = cfg.host;
        SPENCER_RELAY_PORT = toString cfg.port;
        SPENCER_RELAY_TTL_DAYS = toString cfg.ttlDays;
        SPENCER_CROC_RELAY = if cfg.croc.enable then cfg.croc.publicAddress else "";
        NODE_OPTIONS = "--max-old-space-size=128";
      };
      serviceConfig = hardening // {
        ExecStart = lib.getExe cfg.package;
        StateDirectory = "spencer-relay";
        StateDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/spencer-relay";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        MemoryMax = cfg.memoryMax;
        MemoryDenyWriteExecute = false; # V8 JIT
      };
    };

    systemd.services.spencer-croc-relay = lib.mkIf cfg.croc.enable {
      description = "croc relay for Spencer file transfers";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = hardening // {
        ExecStart =
          let
            ports = lib.concatMapStringsSep "," (i: toString (cfg.croc.basePort + i)) (lib.range 0 4);
          in
          "${lib.getExe cfg.croc.package} relay --ports ${ports}";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        MemoryMax = "128M";
        MemoryDenyWriteExecute = true;
      };
    };

    networking.firewall.allowedTCPPortRanges = lib.mkIf (cfg.croc.enable && cfg.croc.openFirewall) [
      {
        from = cfg.croc.basePort;
        to = cfg.croc.basePort + 4;
      }
    ];

    services.nginx = lib.mkIf cfg.nginx.enable {
      enable = true;
      virtualHosts.${cfg.nginx.domain} = {
        enableACME = true;
        forceSSL = true;
        locations."/" = {
          proxyPass = "http://${cfg.host}:${toString cfg.port}";
          proxyWebsockets = true;
          extraConfig = ''
            proxy_read_timeout 3600s;
            client_max_body_size 1m;
          '';
        };
      };
    };
  };
}
