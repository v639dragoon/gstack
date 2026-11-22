import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchesAny } from '../../ship-policy';
import { readRange } from '../supervise';
import type { RunGroup } from './lanes';

/** Schedule serial jobs and, when configured, a separate runner track with exit-75 fallback. */
export async function runLaneJobs<Result extends { exit: number | null; log: string; header: number; end: number }>(
  groups: RunGroup[],
  serialPatterns: readonly string[],
  log: string,
  env: NodeJS.ProcessEnv,
  run: (group: RunGroup, files: string[], log: string, env: NodeJS.ProcessEnv) => Promise<Result>,
) {
  const runs: Result[] = [];
  const jobs: Array<{ group: RunGroup; files: string[] }> = [];
  let serialCount = 0;
  for (const g of groups) {
    const serial = g.files.filter(f => matchesAny(serialPatterns, g.cwd ? `${g.cwd}/${f}` : f));
    const unit = g.files.filter(f => !serial.includes(f));
    serialCount += serial.length;
    for (const files of [...(unit.length ? [unit] : []), ...serial.map(f => [f])]) jobs.push({ group: g, files });
  }
  const overlap = groups.some(g => g.overlap) && groups.some(g => !g.overlap);
  const overlapLines: string[] = [];
  if (!overlap) {
    for (const { group, files } of jobs) runs.push(await run(group, files, log, env));
  } else {
    const deferred = new Map<number, Result>();
    const track = async (concurrent: boolean) => {
      for (const [i, { group, files }] of jobs.entries()) {
        if (!!group.overlap !== concurrent) continue;
        const target = concurrent ? path.join(path.dirname(log), `lanes-overlap-${i + 1}.log`) : log;
        if (concurrent) fs.writeFileSync(target, '');
        runs[i] = await run(group, files, target, concurrent ? { ...env, GSTACK_PREGATE_OVERLAP: '1' } : env);
      }
    };
    // Calling the overlap track first starts its first process before the serial track.
    // Even an unexpected track error must wait for the other track to settle.
    const tracks = await Promise.allSettled([track(true), track(false)]);
    for (const result of tracks) if (result.status === 'rejected') throw result.reason;
    for (const [i, { group, files }] of jobs.entries()) {
      if (!group.overlap) continue;
      if (runs[i]!.exit === 75) {
        deferred.set(i, runs[i]!);
        const retryEnv = { ...env };
        delete retryEnv.GSTACK_PREGATE_OVERLAP;
        runs[i] = await run(group, files, log, retryEnv);
      }
    }
    for (const group of groups.filter(g => g.overlap)) {
      const retried = jobs.some((j, i) => j.group === group && deferred.has(i));
      overlapLines.push(`overlap: ${group.runner} ${retried ? 'exited 75 (nothing ran) and re-ran after the other groups' : 'ran beside the other groups'}`);
    }
    // Read all ranges before replacing lanes.log: serial and retry ranges share it.
    // The header offset includes supervise's $ line, unlike its output-only start.
    const segments = runs.flatMap((run, i) => deferred.has(i) ? [deferred.get(i)!, run] : [run])
      .map(run => readRange(run.log, run.header, run.end, run.end - run.header));
    fs.writeFileSync(log, segments.join(''));
  }
  return { runs, overlapLines, serialCount };
}
