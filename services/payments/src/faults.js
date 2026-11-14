// Step 5 fault switches for POST /intents (used by app.js). Three faults, for resilience tests and
// evidence only — all off unless set via FAULT_* env at boot or the internal /internal/faults route:
//   drop   — write the intent, then cut the connection (the caller sees no reply)
//   delay  — write the intent, then answer delayMs late (slower than the caller's timeout)
//   down   — answer 503 without writing anything, for a window of time
import { config } from "./config.js";

const state = { dropReplies: 0, delayReplies: 0, delayMs: 0, downUntil: 0 };

export function reset() {
  state.dropReplies = config.faults.dropReplies;
  state.delayReplies = config.faults.delayReplies;
  state.delayMs = config.faults.delayMs;
  state.downUntil = config.faults.downMs > 0 ? Date.now() + config.faults.downMs : 0;
  return getFaults();
}
reset();

// DELETE /internal/faults means "all off"
export function clear() {
  Object.assign(state, { dropReplies: 0, delayReplies: 0, delayMs: 0, downUntil: 0 });
  return getFaults();
}

export function setFaults({ drop_replies, delay_replies, delay_ms, down_ms }) {
  if (drop_replies !== undefined) state.dropReplies = drop_replies;
  if (delay_replies !== undefined) state.delayReplies = delay_replies;
  if (delay_ms !== undefined) state.delayMs = delay_ms;
  if (down_ms !== undefined) state.downUntil = down_ms > 0 ? Date.now() + down_ms : 0;
  return getFaults();
}

export function getFaults() {
  const remaining = Math.max(0, state.downUntil - Date.now());
  return {
    drop_replies: state.dropReplies,
    delay_replies: state.delayReplies,
    delay_ms: state.delayMs,
    down: remaining > 0,
    down_remaining_ms: remaining,
  };
}

export const isDown = () => Date.now() < state.downUntil;

// Each take*() consumes one use, so a fault hits the first N requests and the retry succeeds.
export function takeDropReply() {
  if (state.dropReplies <= 0) return false;
  state.dropReplies--;
  return true;
}
export function takeDelay() {
  if (state.delayReplies <= 0) return 0;
  state.delayReplies--;
  return state.delayMs;
}
