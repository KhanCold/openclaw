// Public Vitest 5 reporter hooks; runs only inside the isolated test container.
import { writeFileSync } from 'node:fs';

const errors = (items) => items.map((error) => ({
  name: String(error.name ?? ''), message: String(error.message ?? ''), stack: String(error.stack ?? ''),
}));
export default class IntegrityReporter {
  queued = new Set();
  ended = new Set();
  timedOut = false;
  receipt;
  onTestModuleQueued(module) { this.queued.add(module.moduleId); }
  onTestModuleEnd(module) { this.ended.add(module.moduleId); }
  onProcessTimeout() { this.timedOut = true; this.save(); }
  save() {
    if (this.receipt) writeFileSync(process.env.OPENCLAW_PROOF_INTEGRITY_REPORT,
      JSON.stringify({ ...this.receipt, timedOut: this.timedOut }));
  }
  onTestRunEnd(modules, unhandledErrors, reason) {
    this.receipt = {
      reason, unhandledErrors: errors(unhandledErrors),
      queued: [...this.queued], ended: [...this.ended],
      modules: modules.map((module) => ({
        path: module.moduleId, state: module.state(), errors: errors(module.errors()),
        suites: [...module.children.allSuites()].map((suite) => ({
          name: suite.fullName, state: suite.state(), errors: errors(suite.errors()),
        })),
        tests: [...module.children.allTests()].map((test) => ({
          name: test.fullName, state: test.result().state,
        })),
      })),
    };
    this.save();
  }
}
