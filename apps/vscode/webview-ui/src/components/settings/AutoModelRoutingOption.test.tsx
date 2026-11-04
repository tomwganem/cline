import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AutoModelRoutingOption } from "./AutoModelRoutingOption"

const mocks = vi.hoisted(() => ({
	updateSettings: vi.fn(async () => undefined),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: mocks.updateSettings },
}))

function mockState(state: Partial<ReturnType<typeof useExtensionState>>) {
	vi.mocked(useExtensionState).mockReturnValue(state as ReturnType<typeof useExtensionState>)
}

describe("AutoModelRoutingOption", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("turns Auto on for both modes when Plan/Act share a model", async () => {
		mockState({ planActSeparateModelsSetting: false, actModeAutoModelRouting: false })
		render(<AutoModelRoutingOption currentMode="act" />)
		expect(screen.getByText("AUTO")).toBeTruthy()
		fireEvent.click(screen.getByText("Auto (cost-optimised)"))
		await waitFor(() =>
			expect(mocks.updateSettings).toHaveBeenCalledWith(
				expect.objectContaining({ planModeAutoModelRouting: true, actModeAutoModelRouting: true }),
			),
		)
	})

	it("only toggles the current mode when Plan/Act models are separate", async () => {
		mockState({ planActSeparateModelsSetting: true, planModeAutoModelRouting: true })
		render(<AutoModelRoutingOption currentMode="plan" />)
		expect(screen.getByText("ON")).toBeTruthy()
		fireEvent.click(screen.getByText("Auto (cost-optimised)"))
		await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1))
		const request = (mocks.updateSettings.mock.calls[0] as unknown[])[0] as Record<string, unknown>
		expect(request.planModeAutoModelRouting).toBe(false)
		expect(request.actModeAutoModelRouting).toBeUndefined()
	})
})
