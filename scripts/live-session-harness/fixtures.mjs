import fs from 'node:fs/promises';
import path from 'node:path';

export async function createFixture(root, kind) {
  const files = {
    'package.json': JSON.stringify({ name: 'session-fixture', private: true, scripts: {
      build: 'node build.cjs', [kind === 'stale-readme' ? 'verify' : 'test']: 'node test.cjs',
    } }, null, 2) + '\n',
    'README.md': kind === 'stale-readme'
      ? '# Statistics utility\nRun npm test to verify changes.\n'
      : '# Statistics utility\nArithmetic mean of nonempty integer samples, rounded toward zero.\nRun npm run build and npm test. Add regression cases under tests/*.cpp.\n',
    'src/average.hpp': '#pragma once\n#include <vector>\nint average(const std::vector<int>& values);\n',
    'src/average.cpp': '#include "average.hpp"\nint average(const std::vector<int>& values) {\n  int total = 0;\n  for (int v : values) total += v;\n' +
      (kind === 'compile' ? '  return totl / static_cast<int>(values.size());\n' : '  return total / static_cast<int>(values.size() - 1);\n') + '}\n',
    'src/main.cpp': '#include "average.hpp"\n' + (kind === 'compile' ? '' : '#include <iostream>\n') + 'int main() { std::cout << average({2, 4, 6}) << "\\n"; }\n',
    'tests/basic.cpp': '#include "average.hpp"\n#include <cassert>\nint main() { assert(average({2, 4, 6}) == 4); assert(average({-4, -2}) == -3); }\n',
    'build.cjs': `const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
fs.mkdirSync('out',{recursive:true});
function compile(args){const r=spawnSync('g++',args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
compile(['-std=c++17','-Isrc','-c','src/average.cpp','-o','out/average.o']);
compile(['-std=c++17','-Isrc','src/main.cpp','out/average.o','-o','out/mean']);
for(const f of fs.readdirSync('tests').filter(f=>f.endsWith('.cpp'))){compile(['-std=c++17','-Isrc','tests/'+f,'out/average.o','-o','out/'+f.slice(0,-4)]);}
`,
    'test.cjs': `const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
for(const f of fs.readdirSync('tests').filter(f=>f.endsWith('.cpp'))){const r=spawnSync('./out/'+f.slice(0,-4),[],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
`,
    '.gitignore': 'out/\ncore\ncore.*\n.wazir/\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  if (kind === 'large-file') {
    await fs.mkdir(path.join(root, 'generated'));
    await fs.writeFile(path.join(root, 'generated/bundle.map'), Buffer.alloc(20 * 1024 * 1024, 120));
  }
  return {
    protected: ['package.json', 'build.cjs', 'test.cjs', 'tests/basic.cpp'],
    testScript: kind === 'stale-readme' ? 'verify' : 'test',
    source: 'src/average.cpp',
  };
}

// Written outside the agent workspace, only after the live process has exited.
export const hiddenOracle = `#include "average.hpp"
#include <vector>
int main() {
  for (int n = 1; n <= 31; ++n) {
    std::vector<int> values; int sum = 0;
    for (int i = 0; i < n; ++i) { int v = ((i * 17 + n * 3) % 101) - 50; values.push_back(v); sum += v; }
    if (average(values) != sum / n) return 1;
  }
  return 0;
}
`;
