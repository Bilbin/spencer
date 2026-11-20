# croc pinned to v10.3.1. Spencer's file-transfer protocol and the relay's
# self-hosted croc relay are tested against exactly this version, and nixpkgs
# has moved on to a newer major.
{
  lib,
  buildGoModule,
  fetchFromGitHub,
}:
buildGoModule rec {
  pname = "croc";
  version = "10.3.1";
  src = fetchFromGitHub {
    owner = "schollz";
    repo = "croc";
    rev = "v${version}";
    hash = "sha256-Ynyo4BvdRvgUE6JyX45XAhlrbxkdUTyIPN9m4t5vEOU=";
  };
  vendorHash = "sha256-xEF1vjYQaeDYxcC3FTgR0zCFqvziNIrJVpJJT4o1cVU=";
  subPackages = [ "." ];
  ldflags = [
    "-s"
    "-w"
  ];
  doCheck = false;
  meta = {
    description = "Easily and securely send things from one computer to another (pinned for Spencer)";
    homepage = "https://github.com/schollz/croc";
    license = lib.licenses.mit;
    mainProgram = "croc";
  };
}
