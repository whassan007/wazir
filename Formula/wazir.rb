class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "0.2.15"
  license "AGPL-3.0-only"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.2.15/wazir-v0.2.15-darwin-arm64.tar.gz"
      sha256 "0ea9ffc1172a08958efc6957dbaf82aa3f69a4ed9c72b293b84b23705a55c5f8"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.2.15/wazir-v0.2.15-darwin-x64.tar.gz"
      sha256 "0fa41adcbc4ec613c2fa86a25e585f1f390aa195d2d2311771e76df6051244aa"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.2.15/wazir-v0.2.15-linux-arm64.tar.gz"
      sha256 "b8c11d44aaced920d2c21c4f9a4b7cea405c1590301531a4ebd6ce8f0757663e"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.2.15/wazir-v0.2.15-linux-x64.tar.gz"
      sha256 "8e6d0db14605bd1c7e46e7f9f7feaac8255a0dec042165b70b9664a9f2324450"
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
