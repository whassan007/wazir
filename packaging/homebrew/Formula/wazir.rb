class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "0.1.65"
  license "AGPL-3.0-or-later"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.1.65/wazir-v0.1.65-darwin-arm64.tar.gz"
      sha256 "072c552d54ff2e35f1ebb16fc1ca83ef6e6f901d2c0806924bac9c57384ab062"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.1.65/wazir-v0.1.65-darwin-x64.tar.gz"
      sha256 "f2c42a446ad826cf4566142f31fac8b0144d97345b2a080fac4879c8e3eff4f5"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.1.65/wazir-v0.1.65-linux-arm64.tar.gz"
      sha256 "6d3a5a678a558efe54a45c01e6b19e88922b88062304186e100fde5d3ea1f71b"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.1.65/wazir-v0.1.65-linux-x64.tar.gz"
      sha256 "cf7b3d6bbd0db0f42853c7e3e4be6ba6290d4b082ccb7cf74c93ae6f9f6d06e4"
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
