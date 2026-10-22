import sys, json, subprocess, tempfile, os, re

def verify_t01(output):
    # 17 + 28 = 45
    nums = re.findall(r'\b\d+\b', output.strip())
    return '45' in nums or output.strip() == '45'

def verify_t02(output):
    # 15% of 240 = 36
    nums = re.findall(r'\b\d+(?:\.\d+)?\b', output.strip())
    return '36' in nums or '36.0' in nums or output.strip() == '36'

def verify_t03(output):
    # Reverse of "WAZIR" is "RIZAW"
    return "RIZAW" in output.strip()

def extract_code(text, lang='python'):
    pattern = rf'```{lang}\s*\n(.*?)```'
    matches = re.findall(pattern, text, re.DOTALL | re.IGNORECASE)
    if matches:
        return matches[0]
    pattern_generic = r'```\s*\n(.*?)```'
    matches_gen = re.findall(pattern_generic, text, re.DOTALL)
    if matches_gen:
        return matches_gen[0]
    return text

def verify_t04(output):
    # Factorial python function
    code = extract_code(output, 'python')
    test_script = f"""{code}
# Test harness
if 'factorial' in locals():
    fn = factorial
else:
    fns = [v for k, v in locals().items() if callable(v) and not k.startswith('__')]
    if not fns:
        raise Exception('No function found')
    fn = fns[0]

assert fn(0) == 1, f"Expected fn(0)==1, got {{fn(0)}}"
assert fn(1) == 1, f"Expected fn(1)==1, got {{fn(1)}}"
assert fn(5) == 120, f"Expected fn(5)==120, got {{fn(5)}}"
assert fn(6) == 720, f"Expected fn(6)==720, got {{fn(6)}}"
print("OK")
"""
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as f:
        f.write(test_script)
        tmp_name = f.name
    try:
        res = subprocess.run([sys.executable, tmp_name], capture_output=True, text=True, timeout=5)
        return res.returncode == 0 and "OK" in res.stdout
    except Exception as e:
        return False
    finally:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)

def verify_t05(output):
    # C++ Quick Sort
    code = extract_code(output, 'cpp')
    if not code or 'quick' not in code.lower():
        code = extract_code(output, 'c++')
    with tempfile.NamedTemporaryFile('w', suffix='.cpp', delete=False) as f:
        f.write(code)
        src_name = f.name
    bin_name = src_name + '.bin'
    try:
        comp = subprocess.run(['g++', '-std=c++17', src_name, '-o', bin_name], capture_output=True, text=True, timeout=10)
        if comp.returncode != 0:
            return False
        run = subprocess.run([bin_name], capture_output=True, text=True, timeout=5)
        return run.returncode == 0
    except Exception as e:
        return False
    finally:
        if os.path.exists(src_name): os.remove(src_name)
        if os.path.exists(bin_name): os.remove(bin_name)

def verify_t06(output):
    # JavaScript remove duplicates preserving order
    code = extract_code(output, 'javascript')
    if not code:
        code = extract_code(output, 'js')
    test_script = f"""{code}
let fn = null;
if (typeof removeDuplicates === 'function') fn = removeDuplicates;
else {{
  const globals = [removeDuplicates, deduplicate, unique, uniq].filter(f => typeof f === 'function');
  if (globals.length > 0) fn = globals[0];
}}
if (!fn) {{
  // search by regex or eval
  const m = code.match(/function\\s+([a-zA-Z0-9_]+)/);
  if (m && typeof eval(m[1]) === 'function') fn = eval(m[1]);
}}
if (!fn) process.exit(1);
const input = [3, 1, 2, 3, 2, 4, 1, 5];
const expected = [3, 1, 2, 4, 5];
const res = fn(input);
if (JSON.stringify(res) === JSON.stringify(expected)) {{
  console.log("OK");
  process.exit(0);
}} else {{
  process.exit(1);
}}
"""
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write(test_script)
        tmp_name = f.name
    try:
        res = subprocess.run(['node', tmp_name], capture_output=True, text=True, timeout=5)
        return res.returncode == 0 and "OK" in res.stdout
    except Exception as e:
        return False
    finally:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)

def verify_t07(output):
    # Debug def add(a,b): return a-b -> fix bug
    code = extract_code(output, 'python')
    test_script = f"""{code}
if 'add' not in locals():
    fns = [v for k, v in locals().items() if callable(v) and not k.startswith('__')]
    if not fns: raise Exception('No add function')
    add = fns[0]
assert add(2, 3) == 5, f"Expected add(2,3)==5, got {{add(2,3)}}"
assert add(-1, 1) == 0, f"Expected add(-1,1)==0, got {{add(-1,1)}}"
assert add(10, 20) == 30, f"Expected add(10,20)==30, got {{add(10,20)}}"
print("OK")
"""
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as f:
        f.write(test_script)
        tmp_name = f.name
    try:
        res = subprocess.run([sys.executable, tmp_name], capture_output=True, text=True, timeout=5)
        return res.returncode == 0 and "OK" in res.stdout
    except Exception as e:
        return False
    finally:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)

def verify_t08(output):
    # Explain difference between stack and queue in <= 50 words
    words = output.strip().split()
    word_count = len(words)
    has_stack = 'stack' in output.lower() or 'lifo' in output.lower()
    has_queue = 'queue' in output.lower() or 'fifo' in output.lower()
    return word_count <= 65 and has_stack and has_queue

def verify_t09(output):
    # JSON with name="Wazir", version="1.0", status="ready"
    clean = extract_code(output, 'json').strip()
    match = re.search(r'\{.*\}', clean, re.DOTALL)
    if not match:
        match = re.search(r'\{.*\}', output, re.DOTALL)
    if not match:
        return False
    try:
        data = json.loads(match.group(0))
        return (data.get('name') == 'Wazir' and
                str(data.get('version')) == '1.0' and
                data.get('status') == 'ready')
    except:
        return False

def verify_t10(output):
    # Binary search Python function returning index or -1
    code = extract_code(output, 'python')
    test_script = f"""{code}
fn = None
for name in ['binary_search', 'binarySearch', 'search']:
    if name in locals() and callable(locals()[name]):
        fn = locals()[name]
        break
if not fn:
    fns = [v for k, v in locals().items() if callable(v) and not k.startswith('__')]
    if fns: fn = fns[0]
if not fn: raise Exception('No binary search function found')

arr = [1, 3, 5, 7, 9, 11]
assert fn(arr, 1) == 0, f"Expected 0, got {{fn(arr, 1)}}"
assert fn(arr, 7) == 3, f"Expected 3, got {{fn(arr, 7)}}"
assert fn(arr, 11) == 5, f"Expected 5, got {{fn(arr, 11)}}"
assert fn(arr, 4) == -1, f"Expected -1, got {{fn(arr, 4)}}"
assert fn(arr, 0) == -1, f"Expected -1, got {{fn(arr, 0)}}"
assert fn(arr, 15) == -1, f"Expected -1, got {{fn(arr, 15)}}"
print("OK")
"""
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as f:
        f.write(test_script)
        tmp_name = f.name
    try:
        res = subprocess.run([sys.executable, tmp_name], capture_output=True, text=True, timeout=5)
        return res.returncode == 0 and "OK" in res.stdout
    except Exception as e:
        return False
    finally:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)

VERIFIERS = {
    'T01': verify_t01,
    'T02': verify_t02,
    'T03': verify_t03,
    'T04': verify_t04,
    'T05': verify_t05,
    'T06': verify_t06,
    'T07': verify_t07,
    'T08': verify_t08,
    'T09': verify_t09,
    'T10': verify_t10,
}

if __name__ == '__main__':
    task_id = sys.argv[1]
    output = sys.stdin.read()
    if task_id in VERIFIERS:
        ok = VERIFIERS[task_id](output)
        sys.exit(0 if ok else 1)
    else:
        sys.exit(2)
