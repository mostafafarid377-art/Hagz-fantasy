import { appendFile } from 'node:fs/promises';

const esc = (value) => String(value ?? '').replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const markdown = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

export default class PlaywrightSummaryReporter {
  onBegin(_config, suite) {
    this.suite = suite;
  }

  async onEnd() {
    const tests = this.suite?.allTests() ?? [];
    const outcomes = tests.map((test) => ({ test, outcome: test.outcome() }));
    const counts = {
      total: tests.length,
      passed: outcomes.filter(({ outcome }) => outcome === 'expected').length,
      failed: outcomes.filter(({ outcome }) => outcome === 'unexpected').length,
      flaky: outcomes.filter(({ outcome }) => outcome === 'flaky').length,
      skipped: outcomes.filter(({ outcome }) => outcome === 'skipped').length,
    };

    const failures = outcomes.filter(({ outcome }) => outcome === 'unexpected' || outcome === 'flaky');
    const lines = [
      '## Playwright Chromium E2E summary',
      '',
      `- Total: **${counts.total}**`,
      `- Passed: **${counts.passed}**`,
      `- Failed: **${counts.failed}**`,
      `- Flaky: **${counts.flaky}**`,
      `- Skipped: **${counts.skipped}**`,
    ];

    if (failures.length) {
      lines.push('', '### Failed or flaky tests', '');
      for (const { test } of failures) {
        const result = test.results.at(-1);
        const location = `${test.location.file}:${test.location.line}`;
        const error = result?.errors?.map((entry) => entry.message ?? entry.value).filter(Boolean).join(' | ') ?? 'No error message recorded';
        const attachments = result?.attachments?.filter((attachment) => ['screenshot', 'video', 'trace'].includes(attachment.name)) ?? [];
        lines.push(`- **${markdown(test.titlePath().join(' › '))}** — \`${markdown(location)}\``);
        lines.push(`  - Error: ${markdown(error)}`);
        for (const attachment of attachments) lines.push(`  - ${attachment.name}: \`${markdown(attachment.path ?? attachment.name)}\``);

        // GitHub surfaces workflow-command annotations in the check summary and
        // the Checks API even when raw Actions log downloads are unavailable.
        const annotation = `${test.titlePath().join(' › ')} (${location}): ${error}${attachments.length ? `; artifacts: ${attachments.map((item) => `${item.name}=${item.path ?? item.name}`).join(', ')}` : ''}`;
        process.stdout.write(`::error title=Playwright E2E failure::${esc(annotation)}\n`);
      }
    }

    process.stdout.write(`::notice title=Playwright E2E summary::${counts.total} total; ${counts.passed} passed; ${counts.failed} failed; ${counts.flaky} flaky; ${counts.skipped} skipped\n`);

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) return appendFile(summaryPath, `${lines.join('\n')}\n`);
    return undefined;
  }
}
