import { describe, expect, it } from "vitest"
import { classifyTask, stripInjectedContext } from "./classifier"
import { AutoModelRouter, DOWNSHIFT_AFTER_TURNS, formatRoutingNotice } from "./router"
import { getTierTable, isAutoRoutingSupported } from "./tiers"

describe("classifyTask", () => {
	it.each([
		["write a commit message for the staged changes", "t0"],
		["add a unit test for parse_date in utils.py", "t1"],
		["refactor the payment module across several files", "t2"],
		["review the oauth token refresh flow for security issues", "t3"],
	])("%s -> %s", (prompt, tier) => {
		expect(classifyTask(prompt).tier).toBe(tier)
	})

	it("bumps one tier for risk words", () => {
		const result = classifyTask("fix the typo in the production billing README")
		expect(result.tier).toBe("t1")
		expect(result.reasons.join(" ")).toContain("risk words")
	})

	it("matches at word starts only (cve must not hit 'curve')", () => {
		expect(classifyTask("plot a curve of latency").tier).toBe("t1")
		expect(classifyTask("optimize the query").tier).toBe("t2")
	})

	it("ignores injected file contents when classifying", () => {
		const prompt =
			'summarize @/a.ts\n\n<file_content path="a.ts">\n// security architecture concurrency oauth\n</file_content>'
		expect(stripInjectedContext(prompt)).not.toContain("oauth")
		expect(classifyTask(prompt).tier).toBe("t0")
	})

	it("treats very long requests as at least complex", () => {
		expect(classifyTask("please do this ".repeat(150)).tier).toBe("t2")
	})
})

describe("tiers", () => {
	it("supports cline and openrouter only", () => {
		expect(isAutoRoutingSupported("cline")).toBe(true)
		expect(isAutoRoutingSupported("openrouter")).toBe(true)
		expect(isAutoRoutingSupported("anthropic")).toBe(false)
		expect(isAutoRoutingSupported(undefined)).toBe(false)
	})
})

describe("AutoModelRouter", () => {
	const base = { taskId: "task-1", providerId: "cline", mode: "act" as const }
	const table = getTierTable("cline")!

	it("returns undefined for unsupported providers", () => {
		expect(new AutoModelRouter().routeTurn({ ...base, providerId: "anthropic", prompt: "hi" })).toBeUndefined()
	})

	it("routes the first turn by classification and marks it changed", () => {
		const decision = new AutoModelRouter().routeTurn({ ...base, prompt: "summarize this file" })
		expect(decision).toMatchObject({ tier: "t0", changed: true })
		expect(decision?.model.modelId).toBe(table.tiers.t0.modelId)
	})

	it("never starts plan mode below t2", () => {
		const decision = new AutoModelRouter().routeTurn({ ...base, mode: "plan", prompt: "summarize this file" })
		expect(decision?.tier).toBe("t2")
	})

	it("is sticky: same-tier follow-ups do not change the model", () => {
		const router = new AutoModelRouter()
		router.routeTurn({ ...base, prompt: "add a unit test for foo" })
		const next = router.routeTurn({ ...base, prompt: "also add one for bar" })
		expect(next).toMatchObject({ tier: "t1", changed: false })
	})

	it("raises immediately when a follow-up is harder", () => {
		const router = new AutoModelRouter()
		router.routeTurn({ ...base, prompt: "add a unit test for foo" })
		expect(router.routeTurn({ ...base, prompt: "now debug why it is flaky" })).toMatchObject({ tier: "t2", changed: true })
	})

	it(`only lowers after ${DOWNSHIFT_AFTER_TURNS} consecutive simpler follow-ups`, () => {
		const router = new AutoModelRouter()
		router.routeTurn({ ...base, prompt: "refactor the auth-free module across several files" })
		for (let i = 1; i < DOWNSHIFT_AFTER_TURNS; i++) {
			expect(router.routeTurn({ ...base, prompt: "fix the typo" })).toMatchObject({ tier: "t2", changed: false })
		}
		expect(router.routeTurn({ ...base, prompt: "fix the typo" })).toMatchObject({ tier: "t1", changed: true })
	})

	it("escalates one tier and never drops below the escalation floor", () => {
		const router = new AutoModelRouter()
		router.routeTurn({ ...base, prompt: "fix the typo" })
		expect(router.escalate({ ...base, reason: "3 errors" })).toMatchObject({ tier: "t1", changed: true })
		for (let i = 0; i < DOWNSHIFT_AFTER_TURNS * 2; i++) {
			expect(router.routeTurn({ ...base, prompt: "fix the typo" })?.tier).toBe("t1")
		}
	})

	it("stops escalating at t3", () => {
		const router = new AutoModelRouter()
		router.routeTurn({ ...base, prompt: "review the security architecture" })
		expect(router.escalate({ ...base, reason: "x" })).toBeUndefined()
	})

	it("tracks tasks independently and can reset", () => {
		const router = new AutoModelRouter()
		router.routeTurn({ ...base, prompt: "refactor everything across several files" })
		expect(router.routeTurn({ ...base, taskId: "task-2", prompt: "fix the typo" })?.tier).toBe("t0")
		router.reset("task-1")
		expect(router.getCurrent("task-1", "cline")).toBeUndefined()
		expect(router.getCurrent("task-2", "cline")?.tier).toBe("t0")
	})

	it("formats a readable notice", () => {
		const decision = new AutoModelRouter().routeTurn({ ...base, prompt: "summarize" })!
		expect(formatRoutingNotice(decision)).toContain("GLM Flash")
	})
})
