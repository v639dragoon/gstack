/** Governor accounting follows the upstream verbatim send/collect callbacks, including compact passes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BriefError } from './review-brief';
import { appendEvent, readLedger, type MergedLine } from './review-ledger';
import { loadGovernorPlan, type GovernorMetadata } from './review-governor-packet';
import { runScriptSync } from './script-invocation';

function context(ledger: string, reader: string, binDir: string) {
  const events = readLedger(ledger);
  const index = events.findLastIndex(e => e.event === 'rendered' && e.reader === reader);
  const render = events[index];
  if (!render?.governor) return null;
  const g = render.governor as GovernorMetadata;
  const repo = String(render.workdir ?? process.cwd());
  const loaded = loadGovernorPlan(repo, binDir, g.run_id, g.cycle);
  const gates = [...new Set([String(render.governor_gate ?? (reader === 'codex-structured' ? reader : '')), ...((render.governor_gates as string[]) ?? [])])].filter(Boolean);
  if (!gates.length) throw new BriefError(`governor gate missing for ${reader}`);
  const records = () => {
    const file = path.join(loaded.project, 'budgets', `${g.run_id}.ledger.jsonl`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  };
  const run = (args: string[]) => {
    const r = runScriptSync(path.join(binDir, 'gstack-review-budget'), [...args, '--cycle', String(g.cycle)], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new BriefError(`governor ${reader}: ${r.stdout.trim()} ${r.stderr.trim()}`);
  };
  const stamp = (phase: string, extra: Record<string, unknown>) => appendEvent(ledger, { event: 'program', kind: `governor-${phase}`, reader, render_index: index, ...extra });
  const episode = events.slice(index + 1).filter(e => e.reader === reader && e.render_index === index);
  return { g, gates, records, run, stamp, episode };
}

export function governorSent(ledger: string, reader: string, binDir: string): void {
  const c = context(ledger, reader, binDir);
  if (!c) return;
  for (const gate of c.gates) {
    const rows = c.records().filter(r => r.gate === gate && Number(r.cycle ?? 0) === c.g.cycle);
    const dispatches = rows.filter(r => r.record_type === 'dispatch' && r.allowed && !r.verify_of);
    const verdicts = rows.filter(r => r.record_type === 'verdict');
    // A parent may have reserved the strict slot before consent. Consume that reservation once;
    // otherwise the callback reserves it. Re-sending a still-pending prompt is idempotent, not a new launch.
    if (dispatches.length <= verdicts.length) {
      if (gate === 'native-adversarial' || gate.startsWith('upstream-')) c.run(['register-upstream', c.g.run_id, gate, '--model', reader === 'outside-voice' ? 'unknown' : 'sonnet']);
      c.run(['dispatch', c.g.run_id, gate]);
    }
    c.stamp('sent', { gate, attempt: Math.max(dispatches.length, verdicts.length + 1) });
  }
}

export function governorCollected(ledger: string, reader: string, binDir: string, result: { sha: string; review: boolean; lines: MergedLine[] }): void {
  const c = context(ledger, reader, binDir);
  if (!c) return;
  for (const gate of c.gates) {
    const sent = c.episode.filter(e => e.kind === 'governor-sent' && e.gate === gate).at(-1);
    if (!sent) throw new BriefError(`governor ${reader}: collect requires its accounted verbatim sent callback`);
    const prior = c.episode.find(e => e.kind === 'governor-collected' && e.gate === gate && e.attempt === sent.attempt);
    if (prior) {
      if (prior.output_sha256 !== result.sha) throw new BriefError(`governor ${reader}: changed output requires a fresh accounted attempt`);
      continue;
    }
    const critical = result.lines.filter(l => /^(CRITICAL|Critical|High|HIGH|P[01]|FIXABLE)$/.test(l.label)).length;
    const verdict = !result.review ? 'error' : result.lines.length ? 'issues_found' : 'clean';
    c.run(['verdict', c.g.run_id, gate, verdict, '--critical', String(critical), '--informational', String(result.lines.length - critical)]);
    c.stamp('collected', { gate, attempt: sent.attempt, output_sha256: result.sha, verdict });
  }
}
