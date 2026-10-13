class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "0.1.60"
  license "AGPL-3.0-or-later"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.1.60/wazir-v0.1.60-darwin-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.1.60/wazir-v0.1.60-darwin-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.1.60/wazir-v0.1.60-linux-arm64.tar.gz"
      sha256 "e6fd5d2b00a6fe375d6932ed1bcf5d143f318a44320e807cafa33e93b942d541"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.1.60/wazir-v0.1.60-linux-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
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
