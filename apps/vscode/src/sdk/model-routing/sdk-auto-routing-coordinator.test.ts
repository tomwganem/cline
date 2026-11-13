import { describe, expect, it, vi } from "vitest"
import type { SdkSessionHost } from "../session-host"
import {
	AUTO_ROUTING_CONTINUE_PROMPT,
	buildRoutingConnectionUpdate,
	SdkAutoRoutingCoordinator,
} from "./sdk-auto-routing-coordinator"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Settings = { mode?: "plan" | "act"; actModeAutoModelRouting?: boolean; planModeAutoModelRouting?: boolean }

function makeCoordinator(settings: Settings, provider = "cline") {
	const notices: string[] = []
	const stateManager = {
		getGlobalSettingsKey: (key: string) => (settings as Record<string, unknown>)[key],
		getApiConfiguration: () => ({ actModeApiProvider: provider, planModeApiProvider: provider }),
	}
	const coordinator = new SdkAutoRoutingCoordinator({
		stateManager: stateManager as never,
		emitNotice: (text) => notices.push(text),
	})
	return { coordinator, notices }
}

function makeHost() {
	const updateSessionConnection = vi.fn().mockResolvedValue(undefined)
	return { host: { updateSessionConnection } as unknown as SdkSessionHost, updateSessionConnection }
}

describe("SdkAutoRoutingCoordinator", () => {
	it("is a no-op when Auto is off for the mode", async () => {
		const { coordinator, notices } = makeCoordinator({ mode: "act", actModeAutoModelRouting: false })
		const { host, updateSessionConnection } = makeHost()
		expect(await coordinator.beforeSend(host, "s1", "summarize", {})).toBeUndefined()
		expect(updateSessionConnection).not.toHaveBeenCalled()
		expect(notices).toHaveLength(0)
	})

	it("is a no-op for providers without a tier table", async () => {
		const { coordinator } = makeCoordinator({ mode: "act", actModeAutoModelRouting: true }, "anthropic")
		const { host, updateSessionConnection } = makeHost()
		expect(await coordinator.beforeSend(host, "s1", "summarize", {})).toBeUndefined()
		expect(updateSessionConnection).not.toHaveBeenCalled()
	})

	it("routes the first turn, applies model + reasoning, and posts a notice", async () => {
		const { coordinator, notices } = makeCoordinator({ mode: "act", actModeAutoModelRouting: true })
		const { host, updateSessionConnection } = makeHost()
		const decision = await coordinator.beforeSend(host, "s1", "add a unit test for foo", {})
		expect(decision?.tier).toBe("t1")
		expect(updateSessionConnection).toHaveBeenCalledWith("s1", {
			modelId: "anthropic/claude-haiku-5.5",
			thinking: true,
			reasoningEffort: "low",
		})
		expect(notices[0]).toContain("Haiku 5.5")
		expect(coordinator.getRoutedModel("s1")).toMatchObject({ label: "Haiku 5.5", tier: "standard" })
	})

	it("does not touch the session for a sticky same-tier follow-up", async () => {
		const { coordinator, notices } = makeCoordinator({ mode: "act", actModeAutoModelRouting: true })
		const { host, updateSessionConnection } = makeHost()
		const session = {}
		await coordinator.beforeSend(host, "s1", "add a unit test for foo", session)
		await coordinator.beforeSend(host, "s1", "and one for bar", session)
		expect(updateSessionConnection).toHaveBeenCalledTimes(1)
		expect(notices).toHaveLength(1)
	})

	it("silently re-applies the model after a session rebuild", async () => {
		const { coordinator, notices } = makeCoordinator({ mode: "act", actModeAutoModelRouting: true })
		const { host, updateSessionConnection } = makeHost()
		await coordinator.beforeSend(host, "s1", "add a unit test for foo", {})
		await coordinator.beforeSend(host, "s1", "and one for bar", {}) // new session object = rebuilt
		expect(updateSessionConnection).toHaveBeenCalledTimes(2)
		expect(notices).toHaveLength(1)
	})

	it("escalates on mistake limit and turns reasoning off for t0", async () => {
		const { coordinator } = makeCoordinator({ mode: "act", actModeAutoModelRouting: true })
		const { host, updateSessionConnection } = makeHost()
		const session = {}
		await coordinator.beforeSend(host, "s1", "fix the typo", session)
		expect(updateSessionConnection).toHaveBeenLastCalledWith("s1", { modelId: "~z-ai/glm-flash-latest", thinking: false })
		const escalated = await coordinator.onMistakeLimit(host, "s1", "3 errors", session)
		expect(escalated?.tier).toBe("t1")
		expect(updateSessionConnection).toHaveBeenLastCalledWith(
			"s1",
			expect.objectContaining({ modelId: "anthropic/claude-haiku-5.5" }),
		)
		// Re-sending the continuation prompt must not re-classify or emit a second notice.
		expect(await coordinator.beforeSend(host, "s1", AUTO_ROUTING_CONTINUE_PROMPT, session)).toBeUndefined()
	})

	it("does not escalate when Auto is off", async () => {
		const { coordinator } = makeCoordinator({ mode: "act", actModeAutoModelRouting: false })
		const { host } = makeHost()
		expect(await coordinator.onMistakeLimit(host, "s1", "x")).toBeUndefined()
	})

	it("never throws when the host fails", async () => {
		const { coordinator } = makeCoordinator({ mode: "act", actModeAutoModelRouting: true })
		const host = { updateSessionConnection: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as SdkSessionHost
		await expect(coordinator.beforeSend(host, "s1", "summarize", {})).resolves.toBeUndefined()
	})

	it("uses the plan-mode setting and t2 floor in plan mode", async () => {
		const { coordinator } = makeCoordinator({ mode: "plan", planModeAutoModelRouting: true, actModeAutoModelRouting: false })
		const { host } = makeHost()
		expect((await coordinator.beforeSend(host, "s1", "summarize", {}))?.tier).toBe("t2")
	})

	it("builds connection updates", () => {
		expect(buildRoutingConnectionUpdate({ modelId: "m", label: "M" })).toEqual({ modelId: "m", thinking: false })
		expect(buildRoutingConnectionUpdate({ modelId: "m", label: "M", reasoningEffort: "high" })).toEqual({
			modelId: "m",
			thinking: true,
			reasoningEffort: "high",
		})
	})
})
