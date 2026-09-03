import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
const a = process.argv.slice(2),
  id = a[0],
  base = a[1],
  project = process.env.GSTACK_PACKET_PROJECT_DIR!,
  repo = process.env.GSTACK_PACKET_REPO_ROOT!,
  branch = process.env.GSTACK_PACKET_BRANCH!,
  stateBranch = process.env.GSTACK_PACKET_STATE_BRANCH || branch.replace(/\//g, '-');
const oi = a.indexOf('--acceptance'),
  acceptanceFile = oi >= 0 ? a[oi + 1] : null;
const die = (m: string) => {
  console.error(`gstack-review-packet: ${m}`);
  process.exit(1);
};
if (!id || !base) die('run id and base required');
let plan: any;
try {
  plan = JSON.parse(fs.readFileSync(path.join(project, 'budgets', `${id}.json`), 'utf8'));
} catch {
  die('budget plan not found');
}
let manifest: any;
try {
  manifest = JSON.parse(fs.readFileSync(plan.manifestPath, 'utf8'));
} catch {
  die('manifest not found');
}
const git = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
const sha = git(['rev-parse', 'HEAD']).stdout.trim();
let merge = git(['merge-base', `origin/${base}`, 'HEAD']).stdout.trim();
if (!merge) merge = git(['merge-base', base, 'HEAD']).stdout.trim();
if (!merge) die('unable to resolve merge base');
const diff = git(['diff', merge]).stdout;
const packets = path.join(project, 'packets');
fs.mkdirSync(packets, { recursive: true });
const diffPath = path.join(packets, `${id}.diff`);
fs.writeFileSync(diffPath, diff);
const extract = (text: string) => {
  const lines = text.split('\n');
  let start = lines.findIndex((x) => /^## Acceptance(?: criteria)?\s*$/i.test(x));
  if (start < 0) start = lines.findIndex((x) => /^## Ledger\s*$/i.test(x));
  if (start < 0) return 'none recorded';
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return (
    lines
      .slice(start + 1, end)
      .join('\n')
      .trim() || 'none recorded'
  );
};
let acceptance = 'none recorded';
if (acceptanceFile) {
  try {
    acceptance = fs.readFileSync(acceptanceFile, 'utf8').trim() || 'none recorded';
  } catch {}
} else {
  try {
    const candidates = fs
      .readdirSync(process.env.GSTACK_PLANS_DIR!)
      .filter((x) => x.endsWith('.md'))
      .map((x) => path.join(process.env.GSTACK_PLANS_DIR!, x))
      .filter((p) => fs.readFileSync(p, 'utf8').includes(branch))
      .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
    if (candidates[0]) acceptance = extract(fs.readFileSync(candidates[0], 'utf8'));
  } catch {}
}
const globToRe = (g: string) =>
  new RegExp(
    '^' +
      g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0001')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0001/g, '(.*/)?')
        .replace(/\u0000/g, '.*') +
      '$',
  );
const ruleRows: string[] = [];
const rulesDir = path.join(repo, '.claude', 'rules');
try {
  for (const name of fs
    .readdirSync(rulesDir)
    .filter((x) => x.endsWith('.md'))
    .sort()) {
    const text = fs.readFileSync(path.join(rulesDir, name), 'utf8');
    const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fm) continue;
    const pm = fm[1].match(/(?:^|\n)paths:\s*(?:\n((?:\s*-\s*.+\n?)+)|\[([^\]]*)\])/);
    if (!pm) continue;
    const globs = pm[1]
      ? pm[1]
          .split('\n')
          .map((x) =>
            x
              .replace(/^\s*-\s*/, '')
              .trim()
              .replace(/^['"]|['"]$/g, ''),
          )
          .filter(Boolean)
      : (pm[2] || '')
          .split(',')
          .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
    if (!(manifest.files || []).some((f: any) => globs.some((g) => globToRe(g).test(f.path))))
      continue;
    const first =
      fm[2]
        .split(/\n\s*\n/)
        .map((x) => x.trim())
        .find((x) => x && !x.startsWith('#')) || 'none';
    ruleRows.push(`- ${path.relative(repo, path.join(rulesDir, name))}: ${first.slice(0, 400)}`);
  }
} catch {}
let evidence = 'none';
try {
  const ep = path.join(project, `${stateBranch}-evidence.jsonl`);
  const cutoff = Date.now() - 86400000;
  const rows = fs
    .readFileSync(ep, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((r: any) => {
      const t = Date.parse(r.ts || r.timestamp || r.generated_at || '');
      return t >= cutoff;
    });
  if (rows.length) evidence = '```json\n' + JSON.stringify(rows.at(-1), null, 2) + '\n```';
} catch {}
let ci: 'true' | 'false' | 'unknown' = 'unknown';
let ciText = 'remote CI unavailable';
const remoteContains = git(['branch', '-r', '--contains', sha]).stdout.trim();
if (remoteContains && spawnSync('sh', ['-c', 'command -v gh >/dev/null 2>&1']).status === 0) {
  const gr = spawnSync(
    'gh',
    ['run', 'list', '--commit', sha, '--json', 'name,conclusion,status', '--limit', '10'],
    { cwd: repo, encoding: 'utf8', timeout: 10000 },
  );
  if (gr.status === 0)
    try {
      const runs = JSON.parse(gr.stdout);
      if (runs.length) {
        ci = runs.every((r: any) => r.status === 'completed' && r.conclusion === 'success')
          ? 'true'
          : 'false';
        ciText = '```json\n' + JSON.stringify(runs, null, 2) + '\n```';
      }
    } catch {}
}
let ledger: any[] = [];
try {
  ledger = fs
    .readFileSync(path.join(project, 'budgets', `${id}.ledger.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
} catch {}
const resolved = new Set(
  ledger.filter((r) => r.record_type === 'resolved').map((r) => r.fingerprint),
);
const unresolved = ledger.filter(
  (r) =>
    r.record_type === 'finding' &&
    (r.blocking === true || plan.blockingSeverities.includes(r.severity)) &&
    !resolved.has(r.fingerprint),
);
const tags = (f: any) => {
  const r = manifest.routing || {},
    xs: string[] = [];
  if ((r.auth_surface_matches || []).includes(f.path)) xs.push('auth');
  if ((r.d_surface_matches || []).includes(f.path)) xs.push('d-surface');
  if ((r.load_bearing_doc_matches || []).includes(f.path)) xs.push('load-bearing-doc');
  if ((r.doc_impact_matches || []).some((x: any) => (x.paths || []).includes(f.path)))
    xs.push('doc-impact');
  return xs.join(', ') || '-';
};
const risk = manifest.routing;
const outcome = risk.outcome;
const dirty = git(['status', '--porcelain']).stdout.trim() ? true : false;
const md = `# Review packet ${id}\n\n## Acceptance criteria\n\n${acceptance}\n\n## Risk\n\n- Tier: ${risk.risk_tier}\n- Rule: ${risk.tier_rule}\n- Source: ${risk.tier_source}\n- Auth surfaces: ${(risk.auth_surface_matches || []).join(', ') || 'none'}\n- D surfaces: ${(risk.d_surface_matches || []).join(', ') || 'none'}\n- Load-bearing docs: ${(risk.load_bearing_doc_matches || []).join(', ') || 'none'}\n- Outcome: ${outcome.present ? `${outcome.outcome_id} slice ${outcome.slice_number}${outcome.is_final_slice ? ' final' : ''}${outcome.is_flag_flip ? ' flag-flip' : ''}` : 'none'}\n\n## Changed files\n\n| Path | + | - | Tags |\n|---|---:|---:|---|\n${manifest.files.map((f: any) => `| ${f.path} | ${f.additions} | ${f.deletions} | ${tags(f)} |`).join('\n') || '| none | 0 | 0 | - |'}\n\n## Reviewed revision\n\n- SHA: ${sha}\n- Base: ${base}\n- Merge-base: ${merge}\n- Dirty: ${dirty}\n\n## Architecture constraints\n\n${ruleRows.join('\n') || 'none'}\n\n## CI / test evidence\n\n${evidence}\n\nCI status: ${ci}\n\n${ciText}\n\n## Unresolved blocking findings\n\n${unresolved.map((r) => `- [${r.severity}] ${r.fingerprint} (${r.gate}): ${r.summary}`).join('\n') || 'none'}\n\nReviewers: read this packet and the diff at ${diffPath} first. Do not re-derive the project. When CI_GREEN=true do not run the full build or test suite; run a build only to investigate a specific build-related finding.\n`;
const packetPath = path.join(packets, `${id}.md`);
fs.writeFileSync(packetPath, md);
console.log(`PACKET_PATH=${packetPath}`);
console.log(`DIFF_PATH=${diffPath}`);
console.log(`CI_GREEN=${ci}`);
console.log(`REVIEWED_SHA=${sha}`);
