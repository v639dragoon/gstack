import { describe, expect, test } from 'bun:test';
import { isSolProfileModel, resolveModel } from '../scripts/models';
import { generateModelOverlay, readOverlay } from '../scripts/resolvers/model-overlay';
import { generateCompletenessSection } from '../scripts/resolvers/preamble/generate-completeness-section';
import { generateSetupCommand } from '../scripts/resolvers/utility';
import type { TemplateContext } from '../scripts/resolvers/types';

function ctx(model: TemplateContext['model']): TemplateContext {
  return {
    skillName: 'investigate',
    tmplPath: 'investigate/SKILL.md.tmpl',
    host: 'codex',
    paths: {
      skillRoot: '$GSTACK_ROOT',
      localSkillRoot: '.agents/skills/gstack',
      binDir: '$GSTACK_BIN',
      browseDir: '$GSTACK_BROWSE',
      designDir: '$GSTACK_DESIGN',
      makePdfDir: '$GSTACK_MAKE_PDF',
    },
    preambleTier: 3,
    model,
  };
}

describe('GPT-5.6 Sol model profile', () => {
  test('only the exact Sol ID selects the Sol profile', () => {
    expect(resolveModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveModel('gpt-6-sol')).toBe('gpt-6-sol');
    expect(isSolProfileModel('gpt-5.6-sol')).toBe(true);
    expect(isSolProfileModel('gpt-6-sol')).toBe(true);
    expect(resolveModel('gpt-5.6-terra')).toBe('gpt');
    expect(resolveModel('gpt-5.6-luna')).toBe('gpt');
    expect(resolveModel('gpt-5.6-sol-preview')).toBe('gpt');
    expect(resolveModel('gpt-6-sol-2026-09-01')).toBe('gpt');
    expect(resolveModel('gpt-6-luna')).toBe('gpt');
    expect(resolveModel('gpt-6-terra')).toBe('gpt');
    expect(resolveModel('gpt-6-astra')).toBe('gpt-6-astra');
    expect(isSolProfileModel('gpt-6-sol-2026-09-01')).toBe(false);
    expect(isSolProfileModel('gpt-6-luna')).toBe(false);
    expect(isSolProfileModel(undefined)).toBe(false);
    expect(resolveModel('gpt-5.7')).toBe('gpt');
  });

  test('standalone overlay does not inherit generic GPT completion bias', () => {
    const raw = readOverlay('gpt-5.6-sol');
    expect(raw).toContain('The explicit task is the lake');
    expect(raw).toContain('one clean relevant verification pass');
    expect(raw).toContain('report-only');
    expect(raw).not.toContain('{{INHERIT:gpt}}');
    expect(raw).not.toContain('make your best judgment and proceed');
  });

  test('wrapper gives scope interpretation precedence but preserves concrete gates', () => {
    const out = generateModelOverlay(ctx('gpt-5.6-sol'));
    expect(out).toContain('disambiguate scope');
    expect(out).toContain('Concrete skill workflow steps');
    expect(out).toContain('Never use this patch to skip a concrete requirement');
  });

  test('GPT-6 Sol uses the shared Sol overlay with its own model heading', () => {
    const out = generateModelOverlay(ctx('gpt-6-sol'));
    expect(out).toStartWith('## Model-Specific Behavioral Patch (gpt-6-sol)');
    expect(out).toContain('The explicit task is the lake');
    expect(out).toContain('one clean relevant verification pass');
    expect(out).toContain('The following instructions disambiguate scope for the gpt-6-sol model.');
    expect(out).toContain('Never use this patch to skip a concrete requirement');
    expect(out).not.toContain('make your best judgment and proceed');
  });

  // The lake intro moved from a per-model render-time generator into
  // bin/gstack-skill-start's one-time emission layer (token-reduction Phase 2).
  // Sol's scope discipline is carried by the model overlay + completeness
  // section (both still model-conditional and pinned here); the intro itself
  // is a single display-once blurb emitted by the script.
  test('completeness copy stays inside the explicit task boundary', () => {
    const completeness = generateCompletenessSection(ctx('gpt-5.6-sol'));
    expect(completeness).toContain("inside the user's explicit task boundary");
    expect(completeness).toContain('report them, do not implement them');
    expect(completeness).toContain('all relevant in-scope edge cases');
  });

  test('GPT-6 Sol gets the Sol completeness section', () => {
    expect(generateCompletenessSection(ctx('gpt-6-sol'))).toBe(generateCompletenessSection(ctx('gpt-5.6-sol')));
    expect(generateCompletenessSection(ctx('gpt-6-sol'))).toContain('Boil the Ocean Within Scope');
  });

  test('generic GPT copy remains unchanged', () => {
    const generic = generateModelOverlay(ctx('gpt'));
    const completeness = generateCompletenessSection(ctx('gpt'));
    expect(generic).toContain('make your best judgment and proceed');
    // Fork (harness pass 2026-09-15): the generic preamble is Bounded Completion.
    expect(completeness).toContain('Bounded Completion');
    expect(completeness).not.toContain('completeness cheap');
    for (const model of ['gpt-6-luna', 'gpt-6-sol-2026-09-01']) {
      expect(generateCompletenessSection(ctx(resolveModel(model)!))).toBe(completeness);
      expect(generateModelOverlay(ctx(resolveModel(model)!))).toBe(generic);
    }
  });

  test('terse mode still suppresses the completeness section for Sol', () => {
    // Terse short-circuits before the Sol branch — a check-order flip would
    // ship Sol completeness prose to terse users (a token regression).
    expect(generateCompletenessSection({ ...ctx('gpt-5.6-sol'), explainLevel: 'terse' })).toBe('');
    expect(generateCompletenessSection({ ...ctx('gpt-6-sol'), explainLevel: 'terse' })).toBe('');
  });
});

describe('SETUP_COMMAND resolver', () => {
  test('claude keeps bare ./setup; every other host reinstalls itself', () => {
    expect(generateSetupCommand({ ...ctx('claude'), host: 'claude' })).toBe('./setup');
    expect(generateSetupCommand({ ...ctx('gpt'), host: 'codex' })).toBe('./setup --host codex');
    expect(generateSetupCommand({ ...ctx('claude'), host: 'kiro' })).toBe('./setup --host kiro');
    expect(generateSetupCommand({ ...ctx('claude'), host: 'factory' })).toBe('./setup --host factory');
  });
});
