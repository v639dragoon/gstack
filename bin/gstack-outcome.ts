import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
const cmd = args.shift() || 'show';
const projectDir = process.env.GSTACK_OUTCOME_PROJECT_DIR!;
const branch = process.env.GSTACK_OUTCOME_BRANCH || '';
const key = (suffix: string) => `branch.${branch}.${suffix}`;
const git = (a: string[]) => spawnSync('git', a, { encoding: 'utf8' });
const get = (suffix: string): string | null => {
  const r = git(['config', '--get', key(suffix)]);
  return r.status === 0 ? r.stdout.trim() : null;
};
const fail = (m: string) => {
  console.error(`gstack-outcome: ${m}`);
  process.exit(1);
};
const option = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const has = (name: string) => args.includes(name);
const validId = (id: string | null): id is string => !!id && /^[a-z0-9][a-z0-9-]{1,63}$/.test(id);
const atomicWrite = (p: string, value: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, p);
};

if (cmd === 'set') {
  const id = option('--id');
  const sliceRaw = option('--slice');
  const tier = option('--tier');
  if (!validId(id)) fail('invalid outcome id');
  if (!sliceRaw || !/^[1-9]\d*$/.test(sliceRaw)) fail('slice must be a positive integer');
  if (tier !== null && !/^[ABCD]$/.test(tier)) fail('tier must be A, B, C, or D');
  const values: [string, string][] = [
    ['gstackOutcomeId', id],
    ['gstackOutcomeSlice', sliceRaw],
    ['gstackOutcomeFinal', String(has('--final'))],
    ['gstackOutcomeFlagFlip', String(has('--flag-flip'))],
  ];
  if (tier) values.push(['gstackOutcomeTier', tier]);
  else git(['config', '--unset-all', key('gstackOutcomeTier')]);
  for (const [k, v] of values) {
    const r = git(['config', key(k), v]);
    if (r.status !== 0) fail('unable to write git config');
  }
  const outPath = path.join(projectDir, 'outcomes', `${id}.json`);
  let out: any = { outcome_id: id, created_at: new Date().toISOString(), slices: [], sessions: [] };
  try {
    out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch {}
  out.outcome_id = id;
  out.created_at ||= new Date().toISOString();
  const approved = option('--approved-at');
  const reviewed = option('--plan-reviewed-sha');
  if (approved) out.approved_at = approved;
  if (reviewed) out.plan_reviewed_sha = reviewed;
  out.slices = Array.isArray(out.slices) ? out.slices : [];
  const slice = {
    branch,
    slice_number: Number(sliceRaw),
    is_final_slice: has('--final'),
    is_flag_flip: has('--flag-flip'),
    set_at: new Date().toISOString(),
  };
  const index = out.slices.findIndex((s: any) => s.branch === branch);
  if (index >= 0) out.slices[index] = slice;
  else out.slices.push(slice);
  out.sessions = Array.isArray(out.sessions) ? out.sessions : [];
  atomicWrite(outPath, out);
  process.exit(0);
}

if (cmd === 'show') {
  const id = get('gstackOutcomeId');
  const slice = get('gstackOutcomeSlice');
  const present = validId(id) && !!slice && /^[1-9]\d*$/.test(slice);
  const obj = present
    ? {
        present: true,
        outcome_id: id,
        slice_number: Number(slice),
        is_final_slice: get('gstackOutcomeFinal') === 'true',
        is_flag_flip: get('gstackOutcomeFlagFlip') === 'true',
        risk_tier_override: /^[ABCD]$/.test(get('gstackOutcomeTier') || '')
          ? get('gstackOutcomeTier')
          : null,
      }
    : {
        present: false,
        outcome_id: null,
        slice_number: null,
        is_final_slice: false,
        is_flag_flip: false,
        risk_tier_override: null,
      };
  if (has('--json')) console.log(JSON.stringify(obj));
  else {
    console.log(`OUTCOME_PRESENT=${obj.present}`);
    console.log(`OUTCOME_ID=${obj.outcome_id ?? ''}`);
    console.log(`SLICE=${obj.slice_number ?? ''}`);
    console.log(`FINAL=${obj.is_final_slice}`);
    console.log(`FLAG_FLIP=${obj.is_flag_flip}`);
    console.log(`TIER_OVERRIDE=${obj.risk_tier_override ?? ''}`);
  }
  process.exit(0);
}

if (cmd === 'clear') {
  for (const k of [
    'gstackOutcomeId',
    'gstackOutcomeSlice',
    'gstackOutcomeFinal',
    'gstackOutcomeFlagFlip',
    'gstackOutcomeTier',
  ])
    git(['config', '--unset-all', key(k)]);
  process.exit(0);
}

if (cmd === 'record-session') {
  const id = option('--id');
  const session = option('--session');
  if (!validId(id)) fail('invalid outcome id');
  if (!session || !session.trim()) fail('session must be non-empty');
  const p = path.join(projectDir, 'outcomes', `${id}.json`);
  let out: any;
  try {
    out = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    fail('outcome not found');
  }
  out.sessions = Array.isArray(out.sessions) ? out.sessions : [];
  if (!out.sessions.includes(session)) out.sessions.push(session);
  atomicWrite(p, out);
  process.exit(0);
}

fail('usage: set|show|clear|record-session');
