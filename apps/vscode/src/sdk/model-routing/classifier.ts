/**
 * Heuristic task classifier for Auto model routing.
 *
 * Deliberately cheap and deterministic (no model call): keyword signals pick a
 * starting tier, risk words bump it, and escalation in the router is the
 * safety net for under-estimates. Ported from the `model-router` Cline skill.
 */

import { type RoutingTier, shiftTier } from "./tiers"

export interface ClassificationResult {
	tier: RoutingTier
	reasons: string[]
}

export const DEFAULT_TIER: RoutingTier = "t1"

const SIGNALS: Record<"t3" | "t2" | "t0" | "bump", readonly string[]> = {
	t3: [
		"architecture",
		"architect",
		"system design",
		"security",
		"vulnerab",
		"exploit",
		"cve",
		"crypto",
		"encryption",
		"authentication",
		"authorization",
		"oauth",
		"permission model",
		"concurren",
		"race condition",
		"deadlock",
		"thread-safe",
		"data migration",
		"schema migration",
		"production incident",
		"outage",
		"postmortem",
		"distributed",
		"consensus",
		"threat model",
	],
	t2: [
		"refactor",
		"multi-file",
		"across the codebase",
		"across files",
		"several files",
		"debug",
		"investigate",
		"root cause",
		"intermittent",
		"flaky",
		"why does",
		"why is",
		"performance",
		"optimi",
		"implement feature",
		"new feature",
		"integrate",
		"integration",
		"redesign",
		"migrate",
		"upgrade",
		"memory leak",
		"failing tests",
		"end-to-end",
		"api design",
	],
	t0: [
		"summarize",
		"summary",
		"tl;dr",
		"commit message",
		"rename",
		"typo",
		"spelling",
		"format",
		"reformat",
		"docstring",
		"add comments",
		"translate",
		"convert",
		"list the",
		"changelog",
		"release notes",
		"boilerplate",
		"lint fix",
		"sort imports",
		"readme",
	],
	bump: [
		"critical",
		"careful",
		"production",
		"prod",
		"customer data",
		"money",
		"billing",
		"payments",
		"irreversible",
		"can't break",
		"must not break",
	],
}

/** Strip blocks the extension injects (file mentions, mode notices) so pasted code doesn't drive routing. */
export function stripInjectedContext(text: string): string {
	return text
		.replace(/<file_content[\s\S]*?<\/file_content>/g, " ")
		.replace(/<mode_notice>[\s\S]*?<\/mode_notice>/g, " ")
		.replace(/<[a-z_]+_content[\s\S]*?<\/[a-z_]+_content>/g, " ")
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const MATCHERS = Object.fromEntries(
	Object.entries(SIGNALS).map(([group, words]) => [
		group,
		words.map((word) => ({ word, re: new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}`) })),
	]),
) as Record<keyof typeof SIGNALS, { word: string; re: RegExp }[]>

function hits(text: string, group: keyof typeof SIGNALS): string[] {
	return MATCHERS[group].filter(({ re }) => re.test(text)).map(({ word }) => word)
}

export function classifyTask(rawPrompt: string): ClassificationResult {
	const prompt = stripInjectedContext(rawPrompt)
	const text = prompt.toLowerCase().replace(/\s+/g, " ")
	const reasons: string[] = []
	let tier: RoutingTier

	const hi = hits(text, "t3")
	const mid = hits(text, "t2")
	const low = hits(text, "t0")

	if (hi.length > 0) {
		tier = "t3"
		reasons.push(`critical signals: ${hi.slice(0, 3).join(", ")}`)
	} else if (mid.length > 0) {
		tier = "t2"
		reasons.push(`complexity signals: ${mid.slice(0, 3).join(", ")}`)
	} else if (low.length > 0) {
		tier = "t0"
		reasons.push(`trivial signals: ${low.slice(0, 3).join(", ")}`)
	} else {
		tier = DEFAULT_TIER
		reasons.push("no strong signals")
	}

	const words = text.split(" ").filter(Boolean).length
	if (tier === "t0" && words > 120) {
		tier = "t1"
		reasons.push("long request")
	}
	if ((tier === "t0" || tier === "t1") && words > 400) {
		tier = "t2"
		reasons.push("very long request")
	}

	const bump = hits(text, "bump")
	if (bump.length > 0 && tier !== "t3") {
		tier = shiftTier(tier, 1)
		reasons.push(`risk words: ${bump.slice(0, 2).join(", ")}`)
	}

	return { tier, reasons }
}
