/** Governor additions and D3 filters on upstream's plan, before any packet is built. */
import type { Dispatch as UpstreamDispatch, ReviewPlan } from './review-depth';
import { policyFlags } from './review-policy';
import type { GovernorMetadata } from './review-governor-packet';
export type Dispatch = UpstreamDispatch & { governor?: GovernorMetadata; governor_gate?: string; governor_gates?: string[]; governor_floor?: boolean };
export type GovernorReviewPlan = Omit<ReviewPlan, 'dispatches'> & { dispatches: Dispatch[]; governor?: GovernorMetadata; risky_full_review?: boolean };


export function governorPlan(plan: ReviewPlan, policy: unknown, governor?: { run_id: string; cycle: number; plan: any; bug_class?: string[] }, requiredRedTeam = false): GovernorReviewPlan {
  const flags = policyFlags(policy);
  const g = governor?.plan;
  const metadata: GovernorMetadata | undefined = governor ? { run_id: governor.run_id, cycle: governor.cycle, tier: g.tier,
    routed_effort: g.codexEffort ?? (g.tier === 'D' ? 'high' : 'medium'), specialist_reasons: [g.tierSource ?? 'governor-tier'], bug_class: governor.bug_class ?? [] } : undefined;
  const reviewing = plan.next.step === 'full' || plan.next.step === 'scoped';
  const floors = reviewing && g ? new Set<string>([
    ...g.reviewers.map((r: { gate: string }) => r.gate), 'codex-structured', ...(g.tier === 'D' ? ['red-team'] : []),
  ]) : new Set<string>();
  const gateFor = (d: Dispatch) => d.name === 'codex-structured' ? 'codex-structured' : d.role === 'red-team' ? 'red-team'
    : d.role === 'specialist' ? `specialist:${d.name}` : d.role === 'adversarial-native' ? 'native-adversarial' : d.role === 'outside-voice' ? 'upstream-outside:challenge' : 'fix-check';
  const skipped = [...plan.skipped];
  let dispatches: Dispatch[] = plan.dispatches.filter(d => {
    if (floors.has(gateFor(d)) || d.role === 'fix-check' || d.role === 'targeted') return true;
    const enabled = d.role === 'specialist' ? flags.upstreamSpecialists
      : d.role === 'red-team' ? flags.redTeamLocTrigger || plan.class === 'gate' || plan.next.step === 'scoped' || requiredRedTeam
      : d.role === 'adversarial-native' ? flags.adversarialClaude : flags.codexChallenge;
    if (!enabled) skipped.push(`${d.name} (D3 policy disabled before build)`);
    return enabled;
  }).map(d => ({ ...d }));
  const specialistFloors = [...floors].filter(g => g.startsWith('specialist:'));
  if (specialistFloors.length) {
    let batch = dispatches.find(d => d.role === 'specialist' && d.name === 'batched');
    if (!batch) {
      batch = { role: 'specialist', name: 'batched', effort: 'full', exclude: [], checklists: [], reason: `governor tier ${g.tier} specialist floor` };
      dispatches.push(batch);
    }
    batch.checklists = [...new Set([...(batch.checklists ?? []), ...specialistFloors.map(g => g.slice(11))])];
    batch.governor_gates = specialistFloors;
    batch.governor_floor = true;
  }
  for (const gate of floors) {
    if (gate.startsWith('specialist:') || dispatches.some(d => gateFor(d) === gate)) continue;
    const role = gate === 'codex-structured' ? 'outside-voice' : 'red-team';
    dispatches.push({ role, name: gate, effort: 'full', exclude: [], reason: `governor tier ${g.tier} floor` });
  }
  if (metadata) for (const d of dispatches) {
    const gate = gateFor(d);
    d.governor = { ...metadata, specialist_reasons: [d.reason ?? (floors.has(gate) ? 'governor-tier-floor' : 'upstream-selection')] };
    d.governor_gate = floors.has(gate) || gate === 'native-adversarial' || gate === 'upstream-outside:challenge' || gate === 'fix-check' ? gate : `upstream-specialist:${d.name}`;
    d.governor_floor = !!d.governor_floor || floors.has(gate);
  }
  return { ...plan, dispatches, skipped, ...(metadata ? { governor: metadata } : {}) };
}
