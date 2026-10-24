import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Obligation, SolverAdapter, ToolAvailability, VerificationResult, Verdict, VerifyOptions } from '../contracts';

export interface Z3AdapterConfig {
  pythonPath?: string;
  toolsDir?: string;
  timeoutMs?: number;
  memoryLimitMb?: number;
  seed?: number;
  expectedVersion?: string;
}

// SMT artifacts contain declarations only. Assertions come from the independently
// supplied obligation: assumptions, metadata.precondition, metadata.implementation, guarantee.
const DRIVER = String.raw`
import sys, json, resource, runpy, io, contextlib
cfg=json.loads(sys.stdin.read())
limit=cfg['memory']*1024*1024
if sys.platform != 'darwin':
    resource.setrlimit(resource.RLIMIT_AS, (limit,limit))
import z3
z3.set_param('memory_max_size', cfg['memory'])
z3.set_param('smt.random_seed', cfg['seed'])
z3.set_param('sat.random_seed', cfg['seed'])
if cfg['python']:
    buf=io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            sys.argv=[cfg['path']]+cfg['obligation'].get('metadata',{}).get('args',[])
            exec(compile(cfg['content'],cfg['path'],'exec'),{'__name__':'__main__','__file__':cfg['path']})
        except SystemExit as exc:
            if exc.code not in (None,0,2): raise
    print(buf.getvalue(),end='')
else:
    o=cfg['obligation']; m=o.get('metadata') or {}
    base=cfg['content']
    # Reject commands/assertions in declarations: no hidden assumptions or checks.
    import re
    if re.search(r'\(\s*(assert|check-sat|get-model|push|pop|reset|exit|set-option)\b',base):
        raise ValueError('SMT artifact must contain declarations only; use obligation fields for assertions')
    def check(expressions):
        s=z3.Solver(); s.set(timeout=cfg['timeout'],random_seed=cfg['seed'])
        text=base+'\n'+'\n'.join('(assert '+e+')' for e in expressions)
        s.add(z3.parse_smt2_string(text)); r=s.check()
        return str(r), {str(d):str(s.model()[d]) for d in s.model().decls()} if r==z3.sat else None
    a=o['assumptions']; p=m.get('precondition','true')
    r,_=check(a); q,_=check(a+[p])
    probe={'passed':r=='sat' and q=='sat','details':{'assumptions':r,'precondition':q}}
    if 'unsat' in (r,q): out={'status':'INCONSISTENT_ASSUMPTIONS'}
    elif not probe['passed']: out={'status':'UNKNOWN'}
    else:
        impl=m.get('implementation', 'true')
        if isinstance(impl,str): impl=[impl]
        r,w=check(a+[p]+impl+['(not '+o['guarantee']+')'])
        out={'solver_result':r,'status':{'sat':'COUNTEREXAMPLE','unsat':'PROVED','unknown':'UNKNOWN'}[r],'witness':w}
    out['vacuityProbe']=probe
    print(json.dumps(out))
`;

export class Z3Adapter implements SolverAdapter {
  readonly tool = 'z3' as const;
  private readonly python: string;
  constructor(private readonly config: Z3AdapterConfig = {}) {
    this.python = config.pythonPath ?? join(config.toolsDir ?? '/Users/wael/Code/Wazir/tools', 'z3-venv/bin/python3');
  }

  private run(args: string[], input: string, cwd: string, timeout: number, memoryMb?: number) {
    return new Promise<{ stdout: string; stderr: string; code: number | null; missing: boolean; timedOut: boolean }>((done) => {
      let stdout = '', stderr = '', timedOut = false, missing = false;
      const sandboxed = process.platform === 'darwin' && memoryMb !== undefined;
      const executable = sandboxed ? '/usr/bin/sandbox-exec' : this.python;
      const commandArgs = sandboxed ? ['-p', `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(cwd)}))`, this.python, ...args] : args;
      const child = spawn(executable, commandArgs, { cwd, detached: true, env: { ...process.env, PYTHONHASHSEED: '0', PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
      const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const memoryTimer = memoryMb ? setInterval(() => {
        execFile('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], (error, output) => {
          if (!error && Number(output.trim()) > memoryMb * 1024) { stderr += 'Memory limit exceeded'; kill(); }
        });
      }, 25) : undefined;
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
      child.stdout.on('data', (b) => { stdout += b; if (stdout.length > 4_000_000) kill(); });
      child.stderr.on('data', (b) => { stderr += b; if (stderr.length > 4_000_000) kill(); });
      child.on('error', (e: NodeJS.ErrnoException) => { missing = e.code === 'ENOENT'; stderr += e.message; });
      child.on('close', (code) => { clearTimeout(timer); if (memoryTimer) clearInterval(memoryTimer); done({ stdout, stderr, code, missing, timedOut }); });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async checkAvailability(): Promise<ToolAvailability> {
    const r = await this.run(['-I', '-c', 'import z3; print(z3.get_version_string())'], '', tmpdir(), 5000);
    const version = r.stdout.trim();
    return { available: r.code === 0 && version === (this.config.expectedVersion ?? '5.3.1'), version, path: this.python };
  }

  async verify(obligation: Obligation, workspaceRev: string, options: VerifyOptions = {}): Promise<VerificationResult> {
    const start = Date.now();
    const seed = obligation.seed ?? this.config.seed ?? 0;
    let content = '', readError = '';
    const path = resolve(options.workspaceDir ?? process.cwd(), obligation.artifactPath || '.');
    try { content = typeof obligation.metadata?.smtLib === 'string' ? obligation.metadata.smtLib : await readFile(path, 'utf8'); }
    catch (e) { readError = String(e); }
    const inputHash = createHash('sha256').update(JSON.stringify({ obligation, content, workspaceRev })).digest('hex');
    const availability = await this.checkAvailability();
    const result: VerificationResult = { verdict: Verdict.ERROR, tool: this.tool, toolVersion: availability.version, scope: obligation.scope, assumptions: obligation.assumptions, seed, elapsedMs: 0, inputHash, stdout: '', stderr: readError };
    const finish = () => { result.elapsedMs = Date.now() - start; return result; };
    if (!availability.available) { result.verdict = Verdict.NOT_RUN; return finish(); }
    if (readError) return finish();
    const timeout = options.timeoutMs ?? obligation.timeoutMs ?? this.config.timeoutMs ?? 10_000;
    const memory = obligation.memoryLimitMb ?? this.config.memoryLimitMb ?? 512;
    if (!(timeout > 0 && memory > 0)) { result.stderr = 'Resource limits must be positive'; return finish(); }
    const sandbox = await mkdtemp(join(tmpdir(), 'wazir-z3-'));
    try {
      const r = await this.run(['-I', '-c', DRIVER], JSON.stringify({ obligation, content, path, python: path.endsWith('.py'), seed, timeout, memory }), sandbox, timeout, memory);
      result.stdout = r.stdout; result.stderr = r.stderr;
      if (r.missing) result.verdict = Verdict.NOT_RUN;
      else if (r.timedOut) result.verdict = Verdict.UNKNOWN;
      else if (r.code !== 0) result.verdict = Verdict.ERROR;
      else {
        let data: Record<string, any>;
        try { data = JSON.parse(r.stdout.trim()); }
        catch { const status = /STATUS:\s*(\w+)/.exec(r.stdout)?.[1]; data = { status }; }
        const allowed = ['COUNTEREXAMPLE', 'PROVED', 'BOUNDED_PASS', 'INCONSISTENT_ASSUMPTIONS', 'UNKNOWN', 'ERROR'];
        result.verdict = allowed.includes(data.status) ? data.status as Verdict : Verdict.ERROR;
        result.witness = data.witness ?? data.model;
        result.vacuityProbe = data.vacuityProbe;
        // Raw solver polarity takes precedence over a script's claimed status.
        if (data.solver_result === 'sat') result.verdict = Verdict.COUNTEREXAMPLE;
        if (data.solver_result === 'unknown') result.verdict = Verdict.UNKNOWN;
        if (data.vacuityProbe?.details && Object.values(data.vacuityProbe.details).includes('unsat')) result.verdict = Verdict.INCONSISTENT_ASSUMPTIONS;
        if ([Verdict.PROVED, Verdict.BOUNDED_PASS].includes(result.verdict)) {
          if (result.vacuityProbe?.passed !== true) result.verdict = Verdict.UNKNOWN;
          else if (obligation.bounded || obligation.scope || data.scope) result.verdict = Verdict.BOUNDED_PASS;
        }
      }
      return finish();
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  }
}
