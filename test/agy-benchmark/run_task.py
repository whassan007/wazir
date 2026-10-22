import sys, os, time, subprocess, json, urllib.request

MODELS = {
    'gemma': 'gemma-4-26b-a4b-it-qat',
    'nemotron': 'nvidia/nemotron-3-nano-omni',
    'qwen': 'qwen/qwen3.8-27b'
}

TASKS = {
    'T01': 'What is 17 + 28? Respond with the number only.',
    'T02': 'Calculate 15% of 240. Respond with the number only.',
    'T03': 'Reverse the string "WAZIR". Return only the reversed string.',
    'T04': 'Write a Python function that returns the factorial of a nonnegative integer.',
    'T05': 'Write a correct Quick Sort implementation in C++17, including a minimal main function demonstrating sorting.',
    'T06': 'Write a JavaScript function that removes duplicate values from an array while preserving their original order.',
    'T07': 'Find and fix the bug in this Python function: def add(a,b): return a-b.',
    'T08': 'Explain the difference between a stack and a queue in no more than 50 words.',
    'T09': 'Return valid JSON with keys name, version, and status, using values "Wazir", "1.0", and "ready".',
    'T10': 'Write a Python binary search function for a sorted list, returning the index of the target or -1 if absent.'
}

def run_task(task_id, model_key='gemma', mode='cli'):
    model_name = MODELS.get(model_key, model_key)
    prompt = TASKS[task_id]
    
    t0 = time.time()
    output = ""
    error = ""
    ttft = 0.0
    inference_time = 0.0
    tokens_in = 0
    tokens_out = 0
    
    if mode == 'cli':
        # Execute via wa ask
        cmd = ['wa', 'ask', '--model', model_name, prompt]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            raw_out = res.stdout + res.stderr
            # Strip model header [model_name]
            lines = raw_out.splitlines()
            cleaned = []
            for l in lines:
                if l.strip().startswith(f"[{model_name}]"):
                    continue
                cleaned.append(l)
            output = "\n".join(cleaned).strip()
            if res.returncode != 0:
                error = f"wa ask exited with code {res.returncode}"
        except Exception as e:
            error = str(e)
            
    t1 = time.time()
    turnaround = t1 - t0
    
    # Run independent verification
    v_proc = subprocess.run(
        [sys.executable, 'test/agy-benchmark/verify.py', task_id],
        input=output,
        capture_output=True,
        text=True
    )
    passed = (v_proc.returncode == 0) and not bool(error)
    
    result = {
        'taskId': task_id,
        'modelKey': model_key,
        'modelId': model_name,
        'mode': mode,
        'turnaroundSec': round(turnaround, 4),
        'passed': passed,
        'output': output[:400],
        'error': error
    }
    return result

if __name__ == '__main__':
    tid = sys.argv[1]
    mkey = sys.argv[2] if len(sys.argv) > 2 else 'gemma'
    res = run_task(tid, mkey)
    print(json.dumps(res, indent=2))
