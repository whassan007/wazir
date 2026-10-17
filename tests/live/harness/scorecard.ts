import fs from 'node:fs/promises';
import path from 'node:path';
import type { UserJourneyReport, Verdict } from './e2eHarness.js';

export class AcceptanceScorecard {
  private reports: UserJourneyReport[] = [];

  record(report: UserJourneyReport) {
    this.reports.push(report);
  }

  summary(): {
    total: number;
    realLivePass: number;
    deterministicIntegrationPass: number;
    failed: number;
    blocked: number;
    notRun: number;
  } {
    return {
      total: this.reports.length,
      realLivePass: this.reports.filter((r) => r.verdict === 'REAL_LIVE_PASS').length,
      deterministicIntegrationPass: this.reports.filter((r) => r.verdict === 'DETERMINISTIC_INTEGRATION_PASS').length,
      failed: this.reports.filter((r) => r.verdict === 'FAILED').length,
      blocked: this.reports.filter((r) => r.verdict === 'BLOCKED').length,
      notRun: this.reports.filter((r) => r.verdict === 'NOT_RUN').length,
    };
  }

  getReports(): UserJourneyReport[] {
    return [...this.reports];
  }

  async save(outputPath: string): Promise<void> {
    const data = {
      timestamp: new Date().toISOString(),
      summary: this.summary(),
      journeys: this.reports,
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(data, null, 2), 'utf8');
  }
}
