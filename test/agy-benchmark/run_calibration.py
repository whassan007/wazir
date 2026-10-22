import sys, os, time, subprocess, json, datetime

models = [
    ('gemma', 'gemma-4-26b-a4b-it-qat', 'Fastest loaded lightweight'),
    ('nemotron', 'nvidia/nemotron-3-nano-omni', 'Fastest loaded coding-capable'),
    ('qwen', 'qwen/qwen3.8-27b', 'General-purpose loaded')
]

tasks = ['T01', 'T05', 'T09']

def log_msg(msg):
    ts = datetime.datetime.now().strftime("[%H:%M:%S]")
    line = f"{ts} {msg}"
    print(line, flush=True)
    with open('test/agy-benchmark/execution-log.txt', 'a') as f:
        f.write(line + '\n')

log_msg("PHASE A — SERIAL MODEL CALIBRATION START")

results = []

for m_key, m_id, m_desc in models:
    for t_id in tasks:
        log_msg(f"CALIBRATION TRIAL — MODEL: {m_id} ({m_key}) | TASK: {t_id}")
        t0 = time.time()
        # Direct CLI execution
        from run_task import run_task
        res = run_task(t_id, m_key)
        res['modelDesc'] = m_desc
        results.append(res)
        status = "PASS" if res['passed'] else "FAIL"
        log_msg(f"RESULT — TASK {t_id} | MODEL: {m_id} | VERIFICATION: {status} | TURNAROUND: {res['turnaroundSec']}s")

with open('test/agy-benchmark/calibration-results.json', 'w') as f:
    json.dump(results, f, indent=2)

log_msg("PHASE A — SERIAL MODEL CALIBRATION COMPLETED")
