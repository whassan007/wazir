class Wazir < Formula
  desc "Model- and runtime-agnostic AI agent harness and control plane"
  homepage "https://github.com/whassan007/wazir"
  url "https://github.com/whassan007/wazir/archive/refs/tags/v0.1.30.tar.gz"
  sha256 "681b21a88862560eed16b0441de507a4ebb0b761d817c041b662503d53b6d66d"
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
    assert_match "0.1.30", shell_output("#{bin}/wa --version")
    assert_match "Wazir CLI", shell_output("#{bin}/wa --help")
  end
end
