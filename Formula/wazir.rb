class Wazir < Formula
  desc "Model- and runtime-agnostic AI agent harness and control plane"
  homepage "https://github.com/whassan007/wazir"
  url "https://github.com/whassan007/wazir/archive/refs/tags/v0.1.39.tar.gz"
  sha256 "5ab6b4a9f58242fb4c8d8ea5032d2f66c7f5b8bc49c2c85e63c5adc0c821f489"
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
    assert_match "0.1.39", shell_output("#{bin}/wa --version")
    assert_match "Wazir CLI", shell_output("#{bin}/wa --help")
  end
end
