class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "0.1.60"
  license "AGPL-3.0-or-later"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.1.60/wazir-v0.1.60-darwin-arm64.tar.gz"
      sha256 "ecb115d2a009da1e273d00d1d8cfd93bd90d9cb3721dfb7593622a64ff4f2eff"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.1.60/wazir-v0.1.60-darwin-x64.tar.gz"
      sha256 "3e38546f6a538aca84230550f291a0998f95e2c879b60a48bfa679278d50d3fa"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.1.60/wazir-v0.1.60-linux-arm64.tar.gz"
      sha256 "57830e1a2755a51f395e0698b0c618c61d4a8629f0734d12c5c17deec5686af9"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.1.60/wazir-v0.1.60-linux-x64.tar.gz"
      sha256 "a20924c2dd9d8bf241bc6ccfc0b0b26ed7585c8d9021656e66500459e1d63683"
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
