class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "0.1.63"
  license "AGPL-3.0-or-later"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.1.63/wazir-v0.1.63-darwin-arm64.tar.gz"
      sha256 "f358a8a59d360c548a6de699d1879a5c9b5763cabf9fe8f3d11d85a0bb45b182"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.1.63/wazir-v0.1.63-darwin-x64.tar.gz"
      sha256 "47d3e55d7649cd8de3bc60afbd3ec0c3dfb1dabda9b29d808fa8bf47e22afd6f"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.1.63/wazir-v0.1.63-linux-arm64.tar.gz"
      sha256 "31bb02a337c085c1116d33d9bbed65f0886988da8d493140b99e9f20f262df6f"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.1.63/wazir-v0.1.63-linux-x64.tar.gz"
      sha256 "d07958616bcf40b903a1c3dabe8afcab6fd2bd0939a33460315a91155fdc3492"
    end
  end

  def install
    bin.install "wa"
  end

  def caveats
    <<~EOS
      Wazir stores persistent state, databases, and logs in ~/.wazir:
        - Resource ledger: ~/.wazir/resources.db
        - Configuration:   ~/.wazir/config.json
        - Environment:     ~/.wazir/.env

      Upgrades will replace the CLI binary without modifying your state or configuration.
      To inspect system and agent status, run:
        wa doctor
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/wa --version")
    assert_match "Wazir", shell_output("#{bin}/wa --help")
  end
end
