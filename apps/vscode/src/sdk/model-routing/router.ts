/**
 * Per-task state machine for "Auto" model routing.
 *
 * Pure logic (no I/O) so it is fully unit-testable; SdkController wires it to
 * the live session. Design rules, in priority order:
 *
 * 1. Sticky: a model switch invalidates the provider prompt cache, so the tier
 *    only changes on a real signal, never per message.
 * 2. Escalate on failure (mistake limit / turn error): +1 tier immediately, and
 *    never route below that floor again for the rest of the task.
 * 3. A follow-up that classifies *higher* raises the tier at once.
 * 4. A follow-up that classifies *lower* only lowers the tier after
 *    DOWNSHIFT_AFTER_TURNS consecutive cheaper classifications, and never
 *    below the escalation floor.
 * 5. Entering plan mode never starts below t2 (planning quality compounds).
 */

import { classifyTask } from "./classifier"
import {
	getTierTable,
	maxTier,
	ROUTING_TIER_LABELS,
	type RoutingTier,
	type RoutingTierModel,
	shiftTier,
	tierIndex,
} from "./tiers"

export const DOWNSHIFT_AFTER_TURNS = 3
export const PLAN_MODE_MIN_TIER: RoutingTier = "t2"

export type RoutingMode = "plan" | "act"

export interface RoutingDecision {
	tier: RoutingTier
	model: RoutingTierModel
	/** True when this decision changes the model the session is running. */
	changed: boolean
	/** Human-readable reason for the decision. */
	reason: string
}

interface TaskRoutingState {
	tier: RoutingTier
	/** Lowest tier allowed after escalations. */
	floor: RoutingTier
	/** Consecutive follow-ups that classified below the current tier. */
	lowerStreak: number
	mode: RoutingMode
}

export class AutoModelRouter {
	private readonly tasks = new Map<string, TaskRoutingState>()

	/** Route the next user turn of `taskId`. Returns undefined when the provider has no tier table. */
	routeTurn(input: { taskId: string; providerId: string; mode: RoutingMode; prompt: string }): RoutingDecision | undefined {
		const table = getTierTable(input.providerId)
		if (!table) {
			return undefined
		}
		const classified = classifyTask(input.prompt)
		const modeFloor: RoutingTier = input.mode === "plan" ? PLAN_MODE_MIN_TIER : "t0"
		const existing = this.tasks.get(input.taskId)

		if (!existing) {
			const tier = maxTier(classified.tier, modeFloor)
			const reason =
				tier === classified.tier ? classified.reasons.join("; ") : `${classified.reasons.join("; ")}; plan mode minimum`
			this.tasks.set(input.taskId, { tier, floor: "t0", lowerStreak: 0, mode: input.mode })
			return { tier, model: table.tiers[tier], changed: true, reason }
		}

		const previousTier = existing.tier
		const floor = maxTier(existing.floor, modeFloor)
		let nextTier = maxTier(previousTier, floor)
		let reason = `kept ${ROUTING_TIER_LABELS[previousTier]} tier`

		if (tierIndex(classified.tier) > tierIndex(nextTier)) {
			nextTier = classified.tier
			existing.lowerStreak = 0
			reason = `raised: ${classified.reasons.join("; ")}`
		} else if (tierIndex(classified.tier) < tierIndex(nextTier)) {
			existing.lowerStreak += 1
			if (existing.lowerStreak >= DOWNSHIFT_AFTER_TURNS) {
				const candidate = maxTier(shiftTier(nextTier, -1), floor)
				if (candidate !== nextTier) {
					nextTier = candidate
					reason = `lowered after ${existing.lowerStreak} simpler follow-ups`
				}
				existing.lowerStreak = 0
			}
		} else {
			existing.lowerStreak = 0
		}

		if (nextTier !== previousTier && reason.startsWith("kept")) {
			reason = input.mode === "plan" ? "plan mode minimum" : reason
		}
		existing.tier = nextTier
		existing.mode = input.mode
		return { tier: nextTier, model: table.tiers[nextTier], changed: nextTier !== previousTier, reason }
	}

	/**
	 * Escalate after a failure. Returns the new decision, or undefined when the
	 * task is unknown, the provider is unsupported, or already at the top tier.
	 */
	escalate(input: { taskId: string; providerId: string; reason: string }): RoutingDecision | undefined {
		const table = getTierTable(input.providerId)
		const state = this.tasks.get(input.taskId)
		if (!table || !state || state.tier === "t3") {
			return undefined
		}
		const tier = shiftTier(state.tier, 1)
		state.tier = tier
		state.floor = maxTier(state.floor, tier)
		state.lowerStreak = 0
		return { tier, model: table.tiers[tier], changed: true, reason: `escalated: ${input.reason}` }
	}

	getCurrent(taskId: string, providerId: string): { tier: RoutingTier; model: RoutingTierModel } | undefined {
		const table = getTierTable(providerId)
		const state = this.tasks.get(taskId)
		return table && state ? { tier: state.tier, model: table.tiers[state.tier] } : undefined
	}

	/** Forget routing state (task closed / Auto turned off). */
	reset(taskId?: string): void {
		if (taskId === undefined) {
			this.tasks.clear()
		} else {
			this.tasks.delete(taskId)
		}
	}
}

export function formatRoutingNotice(decision: RoutingDecision): string {
	return `Auto routing → **${decision.model.label}** (${ROUTING_TIER_LABELS[decision.tier]} tier) — ${decision.reason}`
}
