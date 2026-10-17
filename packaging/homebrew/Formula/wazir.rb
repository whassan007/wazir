class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "0.2.3"
  license "AGPL-3.0-or-later"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.2.3/wazir-v0.2.3-darwin-arm64.tar.gz"
      sha256 "e391c8b4192a3c22b03208128e537568e3a5341f6986f0cc82680ce76ead390e"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.2.3/wazir-v0.2.3-darwin-x64.tar.gz"
      sha256 "5e8febe278553cf1a5de4407fec946578bf42c060d2a7c518507bc248e62e2a5"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v0.2.3/wazir-v0.2.3-linux-arm64.tar.gz"
      sha256 "524f15fee627c43570599dcdc6dab12d06185d9e0b390d99a066ba899e3bdd68"
    else
      url "https://github.com/whassan007/wazir/releases/download/v0.2.3/wazir-v0.2.3-linux-x64.tar.gz"
      sha256 "e223ed00d2456eff110b8bd34cdd75ccfb6d4abf6418c5172eed900929009f35"
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
