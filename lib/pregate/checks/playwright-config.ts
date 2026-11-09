/** Ask Playwright which config collects each selected file; never interpret configs. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkScratch } from '../run-scratch';
import { readRange, supervise } from '../supervise';
import type { PregateContext } from '../types';
import type { RunGroup, RunPlan } from './lanes';

export const shellQuote = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;
export const playwrightFileArgs = (files: readonly string[]) => files.map(f => `(?:^|/)${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const CONFIG = /^playwright(?:\..*)?\.config\.(?:ts|js|mjs|cjs|mts|cts)$/;
const DEFAULT_CONFIG = /^playwright\.config\./;

/** JSON's rootDir resolves spec locations even when testDir differs from the package root. */
function collectedFiles(output: string): Set<string> | null {
  // Configs may log before the reporter prints its JSON document.
  for (const m of output.matchAll(/^\s*\{/gm)) {
    try {
      const report = JSON.parse(output.slice(m.index));
      if (typeof report.config?.rootDir !== 'string' || !Array.isArray(report.suites)) continue;
      if (report.errors?.length) return null;
      const found = new Set<string>();
      const visit = (suites: any[]) => {
        for (const suite of suites) {
          for (const spec of suite.specs ?? []) {
            if (typeof spec.file === 'string' && spec.tests?.length) found.add(path.resolve(report.config.rootDir, spec.file));
          }
          visit(suite.suites ?? []);
        }
      };
      visit(report.suites);
      return found;
    } catch { /* not a complete reporter document */ }
  }
  return null;
}

/** Called only after permission and runtime admission; the guard also protects direct callers. */
export async function selectPlaywrightConfigs(ctx: PregateContext, env: NodeJS.ProcessEnv, plan: RunPlan): Promise<RunPlan> {
  if (!ctx.allowRepoCommands || ctx.config.runner) return plan;
  const groups: RunGroup[] = [];
  const unclaimed = [...plan.unclaimed];
  const collectionDetails: string[] = [];
  let log: string | undefined;
  for (const group of plan.groups) {
    if (!group.runner.endsWith(' playwright test --reporter=list {files}')) { groups.push(group); continue; }
    const cwd = path.join(ctx.repoRoot, group.cwd);
    const configs = fs.readdirSync(cwd, { withFileTypes: true }).filter(f => (f.isFile() || f.isSymbolicLink()) && CONFIG.test(f.name)).map(f => f.name)
      .sort((a, b) => Number(DEFAULT_CONFIG.test(b)) - Number(DEFAULT_CONFIG.test(a)) || (a < b ? -1 : a > b ? 1 : 0));
    if (configs.length <= 1) { groups.push(group); continue; }
    if (!log) { log = path.join(checkScratch(ctx.scratch, 'lanes'), 'playwright-collection.log'); fs.writeFileSync(log, ''); }
    let remaining = [...group.files];
    const tried: string[] = [];
    let error: string | undefined;
    const runner = group.runner.replace(' --reporter=list {files}', '');
    for (const config of configs) {
      if (!remaining.length) break;
      tried.push(config);
      // Empty collection is a valid answer; actual config/load errors still exit nonzero.
      const command = `${runner} --list -c ${shellQuote(config)} --reporter=json --pass-with-no-tests ${playwrightFileArgs(remaining).map(shellQuote).join(' ')}`;
      const result = await supervise({ command, cwd, env: { ...env, CI: env.CI ?? '1', PLAYWRIGHT_JSON_OUTPUT_FILE: undefined, PLAYWRIGHT_JSON_OUTPUT_DIR: undefined, PLAYWRIGHT_JSON_OUTPUT_NAME: undefined }, log,
        deadline: Date.now() + ctx.timeoutMs, stallMs: ctx.stallTimeoutMs, label: `Playwright collection (${config})`, progress: ctx.progress });
      const output = readRange(log, result.start, result.end, result.end - result.start);
      const found = result.outcome === 'exited' && result.exit === 0 ? collectedFiles(output) : null;
      if (!found) {
        const reason = result.outcome !== 'exited' ? result.outcome : result.exit !== 0 ? `exit ${result.exit}` : 'no parseable list';
        error = `--list ${config} ${reason} (timeout ${ctx.timeoutMs} ms): ${(output || result.error || 'no parseable list').slice(0, 200)}`;
        break;
      }
      const claimed = remaining.filter(f => found.has(path.resolve(fs.realpathSync(cwd), f)));
      if (claimed.length) groups.push({ ...group, runner: `${runner} -c ${shellQuote(config)} --reporter=list {files}`, files: claimed });
      remaining = remaining.filter(f => !claimed.includes(f));
    }
    if (remaining.length) {
      const names = remaining.map(f => group.cwd ? `${group.cwd}/${f}` : f);
      unclaimed.push(...names);
      collectionDetails.push(`${names.join(' ')}: ${error ?? 'no config collected a test'}; configs tried: ${tried.join(', ')}; collection log: ${log}`);
    }
  }
  return { ...plan, groups, unclaimed, ...(collectionDetails.length ? { collectionDetails } : {}) };
}
