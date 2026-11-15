class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "0.3.2"
  license "AGPL-3.0-only"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.3.2/wazir-v0.3.2-darwin-arm64.tar.gz"
      sha256 "c999a618b9ccda1b939fe8ba2df4b1c0ffd82f98ddb3d1f17af6a239cfc55d86"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.3.2/wazir-v0.3.2-darwin-x64.tar.gz"
      sha256 "0fa41adcbc4ec613c2fa86a25e585f1f390aa195d2d2311771e76df6051244aa"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.3.2/wazir-v0.3.2-linux-arm64.tar.gz"
      sha256 "7c7dc41399bcbabaa1e05e41523018a65378d79b1f51911318a7867bf4cf86cd"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.3.2/wazir-v0.3.2-linux-x64.tar.gz"
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
    assert_match version.to_s, shell_output("#{bin}/wa --version "0.3.2"#{bin}/wazir --version "0.3.2"Wazir", shell_output("#{bin}/wa --help")
  end
end
