class Wazir < Formula
  desc "Model- and runtime-agnostic AI agent harness and control plane"
  homepage "https://github.com/whassan007/wazir"
  url "https://github.com/whassan007/wazir/archive/refs/tags/v0.1.8.tar.gz"
  sha256 "7777e5c02a325a46f76c765f54c2edfb48cd4aa0c842fe4c82d3ee5c6e382ac5"
  head "https://github.com/whassan007/wazir.git", branch: "main"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install"
    system "npm", "run", "build"
    system "node", "scripts/setup-env.mjs"
    bin.install "bin/wa.js" => "wa"
  end

  test do
    assert_match "0.1.8", shell_output("#{bin}/wa --version")
    assert_match "Wazir CLI", shell_output("#{bin}/wa --help")
  end
end
