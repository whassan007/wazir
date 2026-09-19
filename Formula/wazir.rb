class Wazir < Formula
  desc "Model- and runtime-agnostic AI agent harness and control plane"
  homepage "https://github.com/whassan007/wazir"
  url "https://github.com/whassan007/wazir/archive/refs/tags/v0.1.4.tar.gz"
  sha256 "24d38489e36d136308d826b643dfd24547257c2c20eed6f2a7123eaba13ec013"
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
    assert_match "0.1.4", shell_output("#{bin}/wa --version")
    assert_match "Wazir CLI", shell_output("#{bin}/wa --help")
  end
end
