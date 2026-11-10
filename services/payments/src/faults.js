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
