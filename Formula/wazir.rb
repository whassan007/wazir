class Wazir < Formula
  desc "Model- and runtime-agnostic AI agent harness and control plane"
  homepage "https://github.com/whassan007/wazir"
  url "https://github.com/whassan007/wazir/archive/refs/tags/v0.1.18.tar.gz"
  sha256 "81fcb7ea43de04845d81dd2d532a35fcb54b5fd1f26b72424342c16622b83c72"
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
    assert_match "0.1.18", shell_output("#{bin}/wa --version")
    assert_match "Wazir CLI", shell_output("#{bin}/wa --help")
  end
end
