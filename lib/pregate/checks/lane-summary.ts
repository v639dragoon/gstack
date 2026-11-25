/** Parses the reported test counts for a local pregate runner. */
export interface RunnerSummary { ran: number | null; failed: number | null }

/** bats: the pretty `N tests, M failures` line or the TAP plan `1..N`. */
function parseBats(output: string): RunnerSummary | null {
  let m: RegExpExecArray | null;
  if ((m = /^\s*(\d+)\s+tests?,\s+(\d+)\s+failures?/m.exec(output))) return { ran: Number(m[1]), failed: Number(m[2]) };
  if ((m = /^1\.\.(\d+)\s*$/m.exec(output))) return { ran: Number(m[1]), failed: (output.match(/^not ok\b/gm) ?? []).length };
  return null;
}

/** dart/flutter test: the last `+passed ~skipped -failed: …` verdict line (`All tests skipped.` is +0, so zero-run); progress lines carry no verdict. */
function parseDart(output: string): RunnerSummary | null {
  const d = [...output.matchAll(/\+(\d+)(?: ~\d+)?(?: -(\d+))?: (?:All tests passed!|All tests skipped\.|Some tests failed\.)/g)].pop();
  return d ? { ran: Number(d[1]) + Number(d[2] ?? 0), failed: Number(d[2] ?? 0) } : null;
}

/** cargo test: one `test result: ok|FAILED. N passed; M failed; …` line per test binary (unit tests, each integration test, doc-tests), summed; ignored and filtered-out tests did not run. */
function parseCargo(output: string): RunnerSummary | null {
  const lines = [...output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed;/gm)];
  if (!lines.length) return null;
  const failed = lines.reduce((n, m) => n + Number(m[2]), 0);
  return { ran: lines.reduce((n, m) => n + Number(m[1]), 0) + failed, failed };
}

/** playwright test: the last `N failed`, `N interrupted`, `N flaky`, `N passed` and `N skipped` lines (its closing summary, with test names between them; a test's own output earlier does not count); skipped tests did not run. */
function parsePlaywright(output: string): RunnerSummary | null {
  if (!/^\s*\d+ (?:passed|failed|flaky|interrupted|skipped)\b/m.test(output)) return null;
  const count = (word: string) => Number([...output.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\b`, 'gm'))].pop()?.[1] ?? 0);
  const failed = count('failed') + count('interrupted');
  return { ran: count('passed') + count('flaky') + failed, failed };
}

/** The runner's own summary line: bun, node --test, vitest, jest, pytest, bats, dart/flutter test, cargo test, playwright test. A bats, dart/flutter, playwright or cargo runner's summary is tried first (cargo's only there: its `N passed` lines would misread as another runner's); for any other runner the bats and dart formats are a last resort. `ran: null` when not recognised. Colour codes are dropped and a carriage return ends a line, so a coloured or redrawn verdict still reads. */
export function parseSummary(raw: string, runner = ''): RunnerSummary {
  const output = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
  if (/(?<![\w-])cargo\s+test(?![\w-])/.test(runner)) return parseCargo(output) ?? { ran: null, failed: null };
  if (/(?<![\w-])bats(?![\w-])/.test(runner)) { const b = parseBats(output); if (b) return b; }
  if (/(?<![\w-])playwright\s+test(?![\w-])/.test(runner)) { const p = parsePlaywright(output); if (p) return p; }
  const dartRun = /(?<![\w-])(?:dart|flutter)(?![\w-])/.test(runner);
  if (dartRun) { const d = parseDart(output); if (d) return d; }
  let m: RegExpExecArray | null;
  if ((m = /^\s*(?:#|ℹ)\s*tests\s+(\d+)/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(?:#|ℹ)\s*fail\s+(\d+)/m.exec(output)?.[1] ?? 0) };
  if ((m = /Ran\s+(\d+)\s+tests?\s+across/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(\d+)\s+fail\b/m.exec(output)?.[1] ?? 0) };
  if ((m = /^\s*(\d+)\s+pass\s*$/m.exec(output))) return { ran: Number(m[1]) + Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0), failed: Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0) };
  if ((m = /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/.exec(output))) return { ran: Number(m[3]), failed: Number(m[1] ?? 0) };
  if ((m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  if (/no tests ran/i.test(output) || /No tests found/i.test(output)) return { ran: 0, failed: 0 };
  if ((m = /(?:(\d+)\s+failed,?\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  return (dartRun ? null : parseDart(output)) ?? parseBats(output) ?? { ran: null, failed: null };
}
