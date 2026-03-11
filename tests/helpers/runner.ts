// ---------------------------------------------------------------------------
// Shared Test Runner — assertion helpers and suite orchestration
//
// Provides a lightweight, framework-free test runner used by both unit and
// integration test suites. Each suite creates its own Runner instance.
//
// Usage:
//   import { Runner } from "../helpers/runner";
//   const runner = new Runner();
//   await runner.test("description", async () => { runner.assert(...) });
//   runner.summary();
// ---------------------------------------------------------------------------

export class Runner {
  passed = 0;
  failed = 0;
  total = 0;

  async test(description: string, fn: () => Promise<void>): Promise<void> {
    this.total++;
    try {
      await fn();
      this.passed++;
      console.log(`  PASS  ${description}`);
    } catch (err: any) {
      this.failed++;
      const msg = err.message || String(err);
      console.error(`  FAIL  ${description} — ${msg}`);
    }
  }

  assert(condition: boolean, message: string): void {
    if (!condition) {
      throw new Error(message);
    }
  }

  section(label: string): void {
    console.log(`\n=== ${label} ===`);
  }

  summary(label = "Test"): void {
    console.log(
      `\n${this.passed}/${this.total} ${label} tests passed, ${this.failed} failed\n`
    );
  }

  get ok(): boolean {
    return this.failed === 0;
  }
}
