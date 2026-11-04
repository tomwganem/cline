/**
 * Connects {@link AutoModelRouter} to the live SDK session.
 *
 * - `beforeSend` runs for every outbound user turn (via
 *   SdkSessionLifecycle.fireAndForgetSend). When Auto is on for the current
 *   mode and provider, it routes the turn and, if the tier changed, swaps the
 *   session's model/reasoning with `updateSessionConnection`. The conversation
 *   history is kept; the SDK picks up the new connection when the turn starts.
 * - `onMistakeLimit` escalates one tier; the caller re-sends a continuation.
 *
 * When Auto is off, or the provider has no tier table, everything is a no-op
 * and the session keeps the model the user picked.
 */

import type { Mode } from "@shared/storage/types"
import type { StateManager } from "@/core/storage/StateManager"
import { toLegacyApiProvider } from "@/shared/model-catalog/provider-helpers"
import { Logger } from "@/shared/services/Logger"
import type { SdkSessionConnectionUpdate, SdkSessionHost } from "../session-host"
import { AutoModelRouter, formatRoutingNotice, type RoutingDecision } from "./router"
import { isAutoRoutingSupported, ROUTING_TIER_LABELS, type RoutingTierModel } from "./tiers"

export const AUTO_ROUTING_CONTINUE_PROMPT =
	"The previous model ran into repeated errors, so this task was escalated to a stronger model. Review the conversation so far, including any partial changes, and continue the task."

export interface SdkAutoRoutingCoordinatorOptions {
	stateManager: Pick<StateManager, "getGlobalSettingsKey" | "getApiConfiguration">
	/** Posts an informational row to the chat transcript. */
	emitNotice: (text: string) => void
}

export interface AutoRoutedModelView {
	modelId: string
	label: string
	tier: string
}

export function buildRoutingConnectionUpdate(model: RoutingTierModel): SdkSessionConnectionUpdate {
	return model.reasoningEffort
		? { modelId: model.modelId, thinking: true, reasoningEffort: model.reasoningEffort }
		: { modelId: model.modelId, thinking: false }
}

export class SdkAutoRoutingCoordinator {
	private readonly router = new AutoModelRouter()
	/** Last applied decision per session id, for the chat-input display. */
	private readonly applied = new Map<string, AutoRoutedModelView>()
	/** Model actually applied to each live session object (cleared implicitly on rebuild). */
	private readonly appliedBySession = new WeakMap<object, string>()

	constructor(private readonly options: SdkAutoRoutingCoordinatorOptions) {}

	private getMode(): Mode {
		return this.options.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
	}

	private getProviderId(mode: Mode): string | undefined {
		const config = this.options.stateManager.getApiConfiguration()
		const provider = mode === "plan" ? config.planModeApiProvider : config.actModeApiProvider
		return provider ? toLegacyApiProvider(provider) : undefined
	}

	isEnabledForMode(mode: Mode = this.getMode()): boolean {
		const key = mode === "plan" ? "planModeAutoModelRouting" : "actModeAutoModelRouting"
		return this.options.stateManager.getGlobalSettingsKey(key) === true
	}

	/** Mode + provider when Auto is on for the current mode AND the provider supports it. */
	isActive(): { mode: Mode; providerId: string } | undefined {
		const mode = this.getMode()
		if (!this.isEnabledForMode(mode)) {
			return undefined
		}
		const providerId = this.getProviderId(mode)
		return providerId && isAutoRoutingSupported(providerId) ? { mode, providerId } : undefined
	}

	/**
	 * Route the next turn and apply the model to the session when it changed.
	 * Never throws: a routing failure must not block the user's message.
	 */
	async beforeSend(
		sdkHost: SdkSessionHost,
		sessionId: string,
		prompt: string,
		/** Identity of the live session object; rebuilds reuse the id but not the object. */
		session?: object,
	): Promise<RoutingDecision | undefined> {
		try {
			const active = this.isActive()
			if (!active) {
				this.applied.delete(sessionId)
				return undefined
			}
			const decision = this.router.routeTurn({
				taskId: sessionId,
				providerId: active.providerId,
				mode: active.mode,
				prompt,
			})
			if (!decision) {
				return undefined
			}
			// A rebuilt session (mode switch, provider restart, resume) starts on the
			// saved fallback model, so re-apply even when the tier is unchanged.
			const sessionKey = session ?? sdkHost
			const rebuilt = this.appliedBySession.get(sessionKey) !== decision.model.modelId
			if (decision.changed || rebuilt) {
				await this.apply(sdkHost, sessionId, decision, !decision.changed)
				this.appliedBySession.set(sessionKey, decision.model.modelId)
			}
			return decision
		} catch (error) {
			Logger.warn("[AutoRouting] beforeSend failed; keeping current model:", error)
			return undefined
		}
	}

	/** Escalate after a mistake limit. Returns the decision when the caller should re-send a continuation. */
	async onMistakeLimit(
		sdkHost: SdkSessionHost | undefined,
		sessionId: string | undefined,
		reason: string,
		session?: object,
	): Promise<RoutingDecision | undefined> {
		try {
			const active = this.isActive()
			if (!active || !sdkHost || !sessionId) {
				return undefined
			}
			const decision = this.router.escalate({ taskId: sessionId, providerId: active.providerId, reason })
			if (!decision) {
				return undefined
			}
			await this.apply(sdkHost, sessionId, decision)
			if (session) {
				this.appliedBySession.set(session, decision.model.modelId)
			}
			return decision
		} catch (error) {
			Logger.warn("[AutoRouting] escalation failed:", error)
			return undefined
		}
	}

	getRoutedModel(sessionId: string | undefined): AutoRoutedModelView | undefined {
		return sessionId && this.isActive() ? this.applied.get(sessionId) : undefined
	}

	resetSession(sessionId?: string): void {
		this.router.reset(sessionId)
		if (sessionId === undefined) {
			this.applied.clear()
		} else {
			this.applied.delete(sessionId)
		}
	}

	private async apply(sdkHost: SdkSessionHost, sessionId: string, decision: RoutingDecision, silent = false): Promise<void> {
		if (sdkHost.updateSessionConnection) {
			await sdkHost.updateSessionConnection(sessionId, buildRoutingConnectionUpdate(decision.model))
		} else if (sdkHost.updateSessionModel) {
			await sdkHost.updateSessionModel(sessionId, decision.model.modelId)
		} else {
			Logger.warn("[AutoRouting] session host cannot switch models; routing skipped")
			return
		}
		this.applied.set(sessionId, {
			modelId: decision.model.modelId,
			label: decision.model.label,
			tier: ROUTING_TIER_LABELS[decision.tier],
		})
		Logger.log(
			`[AutoRouting] session=${sessionId} tier=${decision.tier} model=${decision.model.modelId} (${decision.reason})`,
		)
		if (!silent) {
			this.options.emitNotice(formatRoutingNotice(decision))
		}
	}
}
