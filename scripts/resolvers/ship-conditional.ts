/** Ship-only conditional bodies; shared resolvers keep their default bytes. */
import type { TemplateContext } from './types';
import { generateTestBootstrap } from './testing';
import { generateGovernorReview } from './governor-review';
import { generateGovernorStructuredBody } from './governor-structured';
import { SECTION } from './sections';

function splitAt(text: string, marker: string): [string, string] {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`Ship conditional boundary missing: ${marker}`);
  return [text.slice(0, at), text.slice(at)];
}

export function shipBootstrapLead(ctx: TemplateContext): string {
  const [lead] = splitAt(generateTestBootstrap(ctx), '### B2. Research best practices');
  return lead + 'When (and only when) the bootstrap condition above holds:\n\n' + SECTION(ctx, ['test-bootstrap-body']);
}

export function shipBootstrapBody(ctx: TemplateContext): string {
  return splitAt(generateTestBootstrap(ctx), '### B2. Research best practices')[1];
}

function structuredParts(ctx: TemplateContext): [string, string] {
  const text = generateGovernorStructuredBody(ctx);
  const [heading, paragraph] = splitAt(text, 'Run this additional slot only when');
  const [trigger, execution] = splitAt(paragraph, ' In /ship, use the GOVERNOR_STRUCTURED handoff');
  const [beforeExemption, exemptionAndRest] = splitAt(execution, ' A successful NON_CODE_DELTA carry-forward');
  const [exemption, rest] = splitAt(exemptionAndRest, '\nIt does not replace');
  return [heading + trigger + exemption + '\n', beforeExemption.slice(1) + rest];
}

export function shipGovernorLead(ctx: TemplateContext): string {
  const [lead] = structuredParts(ctx);
  return generateGovernorReview(ctx).replace(generateGovernorStructuredBody(ctx),
    lead + 'When (and only when) this slot is required under the conditions above:\n\n' + SECTION(ctx, ['governor-structured-slot']));
}

export function shipGovernorStructuredBody(ctx: TemplateContext): string {
  return structuredParts(ctx)[1];
}
