import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import type { Mode } from "@shared/storage/types"
import { useCallback } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import FeaturedModelCard from "./FeaturedModelCard"

/**
 * Display copy for the Auto router's tiers. Mirrors
 * src/sdk/model-routing/tiers.ts (the webview cannot import extension code).
 */
export const AUTO_ROUTING_TIER_SUMMARY = "GLM Flash → Haiku 5.5 → Sonnet 5.5 → Opus 5.5"

/** Returns whether Auto routing is enabled for `mode`, and a setter that persists it. */
export function useAutoModelRouting(mode: Mode): { enabled: boolean; setEnabled: (enabled: boolean) => Promise<void> } {
	const { planModeAutoModelRouting, actModeAutoModelRouting, planActSeparateModelsSetting } = useExtensionState()
	const enabled = (mode === "plan" ? planModeAutoModelRouting : actModeAutoModelRouting) === true

	const setEnabled = useCallback(
		async (next: boolean) => {
			// Mirror model-selection semantics: without separate Plan/Act models,
			// one choice applies to both modes.
			const request = planActSeparateModelsSetting
				? mode === "plan"
					? { planModeAutoModelRouting: next }
					: { actModeAutoModelRouting: next }
				: { planModeAutoModelRouting: next, actModeAutoModelRouting: next }
			try {
				await StateServiceClient.updateSettings(UpdateSettingsRequest.create(request))
			} catch (error) {
				console.error("Failed to update Auto model routing:", error)
			}
		},
		[mode, planActSeparateModelsSetting],
	)

	return { enabled, setEnabled }
}

interface AutoModelRoutingOptionProps {
	currentMode: Mode
}

/** "Auto" card shown above a provider's model list. */
export function AutoModelRoutingOption({ currentMode }: AutoModelRoutingOptionProps) {
	const { enabled, setEnabled } = useAutoModelRouting(currentMode)
	return (
		<div data-testid="auto-model-routing-option" style={{ marginBottom: 6 }}>
			<FeaturedModelCard
				description={`Picks the cheapest capable model per task and escalates on errors (${AUTO_ROUTING_TIER_SUMMARY}). The model below is the fallback.`}
				displayName="Auto (cost-optimised)"
				isSelected={enabled}
				label={enabled ? "ON" : "AUTO"}
				onClick={() => void setEnabled(!enabled)}
			/>
		</div>
	)
}
