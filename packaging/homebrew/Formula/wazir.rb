class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "0.3.0"
  license "AGPL-3.0-only"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.3.0/wazir-v0.3.0-darwin-arm64.tar.gz"
      sha256 "53b4edb1c6fa11807209bb83182c59b7dea31161f9280512c35d01e18e4099de"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.3.0/wazir-v0.3.0-darwin-x64.tar.gz"
      sha256 "0fa41adcbc4ec613c2fa86a25e585f1f390aa195d2d2311771e76df6051244aa"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.3.0/wazir-v0.3.0-linux-arm64.tar.gz"
      sha256 "bba917919f3418fa3a08d01a8e46600f4a56b6df5b7ad06e25b43ac56ce71ec1"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.3.0/wazir-v0.3.0-linux-x64.tar.gz"
      sha256 "8e6d0db14605bd1c7e46e7f9f7feaac8255a0dec042165b70b9664a9f2324450"
    end
  end

  def install
    bin.install "wa"
    if File.exist?("wazir")
      bin.install "wazir"
    else
      bin.install_symlink "wa" => "wazir"
    end
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
    assert_match version.to_s, shell_output("#{bin}/wazir --version")
    assert_match "Wazir", shell_output("#{bin}/wa --help")
  end
end
