/**
 * Tier tables for "Auto" model routing.
 *
 * Each routable provider maps the four cost tiers onto concrete model ids.
 * Tiers are ordered cheapest → most capable; the router starts as low as the
 * task allows and escalates one tier at a time.
 */

export type RoutingTier = "t0" | "t1" | "t2" | "t3"

export const ROUTING_TIER_ORDER: readonly RoutingTier[] = ["t0", "t1", "t2", "t3"]

export type RoutingReasoningEffort = "low" | "medium" | "high"

export interface RoutingTierModel {
	modelId: string
	/** Short label for the UI ("Haiku 5.5"). */
	label: string
	/** undefined = reasoning off. */
	reasoningEffort?: RoutingReasoningEffort
}

export interface ProviderTierTable {
	tiers: Record<RoutingTier, RoutingTierModel>
}

export const ROUTING_TIER_LABELS: Record<RoutingTier, string> = {
	t0: "trivial",
	t1: "standard",
	t2: "complex",
	t3: "critical",
}

/**
 * Starter tables. Prices (USD / 1M tokens, in/out) at time of writing:
 *   t0 GLM Flash 0.03/0.09 · t1 Haiku 5.5 0.10/0.50 · t2 Sonnet 5.5 2/10 · t3 Opus 5.5 4/20
 */
const ANTHROPIC_VIA_GATEWAY: ProviderTierTable = {
	tiers: {
		t0: { modelId: "~z-ai/glm-flash-latest", label: "GLM Flash" },
		t1: { modelId: "anthropic/claude-haiku-5.5", label: "Haiku 5.5", reasoningEffort: "low" },
		t2: { modelId: "anthropic/claude-sonnet-5.5", label: "Sonnet 5.5", reasoningEffort: "medium" },
		t3: { modelId: "anthropic/claude-opus-5.5", label: "Opus 5.5", reasoningEffort: "high" },
	},
}

export const PROVIDER_TIER_TABLES: Readonly<Record<string, ProviderTierTable>> = {
	cline: ANTHROPIC_VIA_GATEWAY,
	openrouter: ANTHROPIC_VIA_GATEWAY,
}

export function getTierTable(providerId: string | undefined): ProviderTierTable | undefined {
	return providerId ? PROVIDER_TIER_TABLES[providerId] : undefined
}

export function isAutoRoutingSupported(providerId: string | undefined): boolean {
	return getTierTable(providerId) !== undefined
}

export function tierIndex(tier: RoutingTier): number {
	return ROUTING_TIER_ORDER.indexOf(tier)
}

export function shiftTier(tier: RoutingTier, delta: number): RoutingTier {
	const i = Math.min(ROUTING_TIER_ORDER.length - 1, Math.max(0, tierIndex(tier) + delta))
	return ROUTING_TIER_ORDER[i]
}

export function maxTier(a: RoutingTier, b: RoutingTier): RoutingTier {
	return tierIndex(a) >= tierIndex(b) ? a : b
}
