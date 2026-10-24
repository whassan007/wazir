import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLedgerEntry,
  assertHumanReviewer,
  assureRecord,
  assureRun,
  assureSpecAdd,
  assureSpecApprove,
  assureSpecList,
  assureSpecShow,
  assureVerifyLedger,
  formatAssuranceRecord,
  formatDoctorReport,
  runAssureDoctor,
} from '../cli';
import { FORMAL_TOOLS, Verdict } from '../contracts';
import {
  assureDoctorCommand,
  assureRecordCommand,
  assureRunCommand,
  assureSpecAddCommand,
  assureSpecApproveCommand,
  assureSpecListCommand,
  assureSpecShowCommand,
  assureVerifyLedgerCommand,
  createAssureCommand,
} from '../../../../apps/cli/src/commands/assure';

describe('assure CLI — doctor, spec, verify-ledger, run, record', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wfa-cli-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('assure doctor', () => {
    it('probes the real host tools and reports versions + achievable verdicts', async () => {
      const report = await runAssureDoctor();

      expect(Object.keys(report.tools).sort()).toEqual([...FORMAL_TOOLS].sort());
      expect(report.achievableVerdicts).toContain(Verdict.NOT_RUN);

      // Verify each installed tool reports a non-empty version and valid achievable verdicts
      for (const tool of FORMAL_TOOLS) {
        const status = report.tools[tool];
        expect(status.tool).toBe(tool);
        expect(typeof status.available).toBe('boolean');
        expect(status.version.length).toBeGreaterThan(0);
        if (status.available) {
          expect(status.achievableVerdicts.length).toBeGreaterThan(0);
          for (const v of status.achievableVerdicts) {
            expect(report.achievableVerdicts).toContain(v);
          }
        } else {
          expect(status.achievableVerdicts).toEqual([Verdict.NOT_RUN]);
        }
      }

      // On this host, z3, alloy, dafny, scenic, verifai, gam are installed in tools/ and skills/formal/
      if (report.tools.z3.available) {
        expect(report.tools.z3.version).toMatch(/^\d+\.\d+/);
        expect(report.achievableVerdicts).toContain(Verdict.PROVED);
        expect(report.achievableVerdicts).toContain(Verdict.BOUNDED_PASS);
        expect(report.achievableVerdicts).toContain(Verdict.COUNTEREXAMPLE);
      }
      if (report.tools.verifai.available || report.tools.scenic.available) {
        expect(report.achievableVerdicts).toContain(Verdict.FALSIFIED);
        expect(report.achievableVerdicts).toContain(Verdict.NOT_FALSIFIED);
      }

      const formatted = formatDoctorReport(report, false);
      expect(formatted).toContain('Formal Assurance Doctor');
      expect(formatted).toContain('Achievable verdicts on this host:');

      const cmdRes = await assureDoctorCommand({ json: true });
      expect(cmdRes.code).toBe(0);
      const parsed = JSON.parse(cmdRes.output);
      expect(parsed.achievableVerdicts).toEqual(report.achievableVerdicts);
    });

    it('reports NOT_RUN only when all tools are missing', async () => {
      const missingRoot = path.join(tmpDir, 'empty-workspace');
      await fs.mkdir(missingRoot, { recursive: true });
      const report = await runAssureDoctor({
        workspaceRoot: missingRoot,
        toolPaths: {
          z3: path.join(missingRoot, 'no-z3'),
          alloy: path.join(missingRoot, 'no-alloy.jar'),
          dafny: path.join(missingRoot, 'no-dafny'),
          scenic: path.join(missingRoot, 'no-scenic'),
          verifai: path.join(missingRoot, 'no-verifai'),
          gam: path.join(missingRoot, 'no-gam'),
        },
      });

      for (const tool of FORMAL_TOOLS) {
        expect(report.tools[tool].available).toBe(false);
        expect(report.tools[tool].achievableVerdicts).toEqual([Verdict.NOT_RUN]);
      }
      expect(report.achievableVerdicts).toEqual([Verdict.NOT_RUN]);
      expect(report.unachievableVerdicts).toContain(Verdict.PROVED);
      expect(report.unachievableVerdicts).toContain(Verdict.FALSIFIED);
    });
  });

  describe('assure spec add | list | show | approve', () => {
    it('adds, lists, shows, and enforces human-only approval on specs', async () => {
      const specsDir = path.join(tmpDir, 'specs');

      const addRes = await assureSpecAddCommand('RED_SIGNAL_COMPLIANCE', {
        version: '2.1',
        guarantee: 'vehicle does not cross stop line while stop obligation active',
        assumption: ['signal_state_available', 'braking_limits_valid'],
        specsDir,
      });
      expect(addRes.code).toBe(0);
      expect(addRes.output).toContain('RED_SIGNAL_COMPLIANCE');

      const listRes = await assureSpecListCommand({ specsDir, json: true });
      expect(listRes.code).toBe(0);
      const list = JSON.parse(listRes.output);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('RED_SIGNAL_COMPLIANCE');
      expect(list[0].status).toBe('draft');
      expect(list[0].content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const showRes = await assureSpecShowCommand('RED_SIGNAL_COMPLIANCE', { specsDir });
      expect(showRes.code).toBe(0);
      expect(showRes.output).toContain('id: RED_SIGNAL_COMPLIANCE');
      expect(showRes.output).toContain('status: draft');

      // Reject missing reviewer
      const noHumanRes = await assureSpecApproveCommand('RED_SIGNAL_COMPLIANCE', { specsDir });
      expect(noHumanRes.code).toBe(1);
      expect(noHumanRes.output).toContain('requires a human reviewer');

      // Reject automated/bot reviewer identities
      for (const botName of ['bot', 'agent', 'ci', 'coding-agent', 'agent-01', 'bot-reviewer']) {
        const botRes = await assureSpecApproveCommand('RED_SIGNAL_COMPLIANCE', {
          reviewer: botName,
          specsDir,
        });
        expect(botRes.code).toBe(1);
        expect(botRes.output).toMatch(/rejected|human/i);
      }

      // Reject explicit --automated flag even with a name
      const autoFlagRes = await assureSpecApproveCommand('RED_SIGNAL_COMPLIANCE', {
        reviewer: 'wael',
        automated: true,
        specsDir,
      });
      expect(autoFlagRes.code).toBe(1);

      // Approve with a valid human reviewer
      const approveRes = await assureSpecApproveCommand('RED_SIGNAL_COMPLIANCE', {
        reviewer: 'wael',
        specsDir,
        json: true,
      });
      expect(approveRes.code).toBe(0);
      const approved = JSON.parse(approveRes.output);
      expect(approved.status).toBe('approved');
      expect(approved.reviewers).toEqual(['wael']);

      // Verify assertHumanReviewer directly
      expect(() => assertHumanReviewer(undefined)).toThrow(/human reviewer/);
      expect(() => assertHumanReviewer('spec-author')).toThrow(/automated/);
      expect(assertHumanReviewer('wael')).toBe('wael');
    });
  });

  describe('assure verify-ledger', () => {
    it('verifies a valid hash-chained ledger and fails on tampering', async () => {
      const ledgerPath = path.join(tmpDir, 'ledger.jsonl');

      const e0 = await appendLedgerEntry(ledgerPath, {
        timestamp: '2026-10-24T05:00:00.000Z',
        propertyId: 'RED_SIGNAL_COMPLIANCE',
        specHash: 'sha256:1111',
        sourceCommit: 'abc1234',
        workspaceRev: 'abc1234',
        tool: 'z3',
        toolVersion: '4.13.0',
        inputHash: 'sha256:2222',
        assumptions: ['braking_limits_valid'],
        verdict: Verdict.PROVED,
        elapsedMs: 42,
        artifactHashes: { 'stopping_envelope.py': 'sha256:3333' },
        fencingToken: 1,
      });
      expect(e0.index).toBe(0);
      expect(e0.prevHash).toBeNull();

      const e1 = await appendLedgerEntry(ledgerPath, {
        timestamp: '2026-10-24T05:01:00.000Z',
        propertyId: 'RED_SIGNAL_COMPLIANCE',
        specHash: 'sha256:1111',
        sourceCommit: 'abc1234',
        workspaceRev: 'abc1234',
        tool: 'alloy',
        toolVersion: '6.2.0',
        inputHash: 'sha256:4444',
        scope: 'for 5 but 8 steps',
        assumptions: ['signal_state_available'],
        verdict: Verdict.BOUNDED_PASS,
        elapsedMs: 120,
        artifactHashes: { 'red_signal.als': 'sha256:5555' },
        fencingToken: 2,
      });
      expect(e1.index).toBe(1);
      expect(e1.prevHash).toBe(e0.entryHash);

      const okReport = await assureVerifyLedger({ ledgerPath });
      expect(okReport.valid).toBe(true);
      expect(okReport.entryCount).toBe(2);
      expect(okReport.errors).toEqual([]);

      const cliOk = await assureVerifyLedgerCommand({ ledger: ledgerPath });
      expect(cliOk.code).toBe(0);

      // Tamper with the first entry's verdict without updating hashes
      const lines = (await fs.readFile(ledgerPath, 'utf8')).trim().split('\n');
      const tampered0 = JSON.parse(lines[0]);
      tampered0.verdict = Verdict.COUNTEREXAMPLE;
      await fs.writeFile(ledgerPath, [JSON.stringify(tampered0), lines[1]].join('\n') + '\n', 'utf8');

      const badReport = await assureVerifyLedger({ ledgerPath });
      expect(badReport.valid).toBe(false);
      expect(badReport.errors.some((e) => e.includes('tamper detected'))).toBe(true);

      const cliBad = await assureVerifyLedgerCommand({ ledger: ledgerPath });
      expect(cliBad.code).toBe(1);
      expect(cliBad.output).toContain('FAILED');
    });
  });

  describe('assure run & assure record', () => {
    it('runs obligations, appends ledger entries, and builds an assurance record with weakest-link gate', async () => {
      const specsDir = path.join(tmpDir, 'specs');
      const ledgerPath = path.join(tmpDir, 'ledger.jsonl');

      await assureSpecAdd({
        id: 'RED_SIGNAL_COMPLIANCE',
        version: '2.1',
        guarantee: 'vehicle never crosses on red',
        assumptions: ['signal_state_available', 'braking_limits_valid'],
        artifacts: [
          { tool: 'alloy', file: 'red_signal.als', scope: 'for 5 but 8 steps' },
          { tool: 'z3', file: 'stopping_envelope.py' },
          { tool: 'dafny', file: 'stop_command.dfy' },
        ],
        specsDir,
      });

      // Running before approval records NOT_RUN obligations and fails release gate because spec is draft
      const runSummary = await assureRun({
        component: 'intersection_behavior_planner',
        specsDir,
        ledgerPath,
      });
      expect(runSummary.results).toHaveLength(3);
      expect(runSummary.ledgerEntriesAppended).toBe(3);

      const unapprovedRecord = await assureRecord({
        component: 'intersection_behavior_planner',
        specsDir,
        ledgerPath,
      });
      expect(unapprovedRecord.release_gate.status).toBe('FAIL');
      expect(unapprovedRecord.release_gate.reason).toContain('spec not approved');

      // Approve the spec as a human and record passing formal evidence
      await assureSpecApprove({
        id: 'RED_SIGNAL_COMPLIANCE',
        reviewer: 'wael',
        specsDir,
      });
      const approvedSpec = await assureSpecShow('RED_SIGNAL_COMPLIANCE', { specsDir });
      const freshLedger = path.join(tmpDir, 'passing-ledger.jsonl');

      await appendLedgerEntry(freshLedger, {
        timestamp: '2026-10-24T05:02:00.000Z',
        propertyId: 'RED_SIGNAL_COMPLIANCE',
        specHash: approvedSpec.content_hash,
        sourceCommit: 'deadbeef',
        workspaceRev: 'deadbeef',
        tool: 'alloy',
        toolVersion: '6.2.0',
        inputHash: 'sha256:aaaa',
        scope: 'for 5 but 8 steps',
        assumptions: approvedSpec.assumptions,
        verdict: Verdict.BOUNDED_PASS,
        elapsedMs: 110,
        artifactHashes: {},
      });
      await appendLedgerEntry(freshLedger, {
        timestamp: '2026-10-24T05:02:01.000Z',
        propertyId: 'RED_SIGNAL_COMPLIANCE',
        specHash: approvedSpec.content_hash,
        sourceCommit: 'deadbeef',
        workspaceRev: 'deadbeef',
        tool: 'z3',
        toolVersion: '4.13.0',
        inputHash: 'sha256:bbbb',
        assumptions: approvedSpec.assumptions,
        verdict: Verdict.PROVED,
        elapsedMs: 25,
        artifactHashes: {},
      });
      await appendLedgerEntry(freshLedger, {
        timestamp: '2026-10-24T05:02:02.000Z',
        propertyId: 'RED_SIGNAL_COMPLIANCE',
        specHash: approvedSpec.content_hash,
        sourceCommit: 'deadbeef',
        workspaceRev: 'deadbeef',
        tool: 'dafny',
        toolVersion: '4.11.0',
        inputHash: 'sha256:cccc',
        assumptions: approvedSpec.assumptions,
        verdict: Verdict.PROVED,
        elapsedMs: 310,
        artifactHashes: {},
      });

      const outRecordPath = path.join(tmpDir, 'record.json');
      const passingRecord = await assureRecord({
        component: 'intersection_behavior_planner',
        version: '1.0.0',
        sourceCommit: 'deadbeef',
        specsDir,
        ledgerPath: freshLedger,
        outputPath: outRecordPath,
      });

      expect(passingRecord.release_gate.status).toBe('PASS');
      expect(passingRecord.properties.RED_SIGNAL_COMPLIANCE.specification_consistency).toBe(Verdict.BOUNDED_PASS);
      expect(passingRecord.properties.RED_SIGNAL_COMPLIANCE.decision_envelope).toBe(Verdict.PROVED);
      expect(passingRecord.properties.RED_SIGNAL_COMPLIANCE.implementation_contract).toBe(Verdict.PROVED);
      expect(passingRecord.properties.RED_SIGNAL_COMPLIANCE.overall).toBe(Verdict.BOUNDED_PASS);
      expect(passingRecord.coverage_limits.length).toBeGreaterThan(0);

      const formatted = formatAssuranceRecord(passingRecord, false);
      expect(formatted).toContain('component: intersection_behavior_planner');
      expect(formatted).toContain('release_gate: PASS');

      const recordCmdRes = await assureRecordCommand('intersection_behavior_planner', {
        specsDir,
        ledger: freshLedger,
      });
      expect(recordCmdRes.code).toBe(0);

      const runCmdRes = await assureRunCommand('intersection_behavior_planner', {
        property: 'RED_SIGNAL_COMPLIANCE',
        tools: 'z3,alloy',
        specsDir,
        ledger: path.join(tmpDir, 'cmd-run-ledger.jsonl'),
      });
      expect(runCmdRes.code).toBe(0);
    });

    it('wires the Commander tree with all required subcommands', () => {
      const cmd = createAssureCommand();
      expect(cmd.name()).toBe('assure');
      const subNames = cmd.commands.map((c) => c.name());
      expect(subNames).toEqual(expect.arrayContaining(['spec', 'run', 'record', 'verify-ledger', 'doctor']));
      const specCmd = cmd.commands.find((c) => c.name() === 'spec')!;
      const specSubNames = specCmd.commands.map((c) => c.name());
      expect(specSubNames).toEqual(expect.arrayContaining(['add', 'list', 'show', 'approve']));
    });
  });
});
