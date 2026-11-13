// RabbitMQ plumbing under failure (lib/amqp/connection.js + the relay): closed channels, missing
// confirms, a broker that cancels the consumer, and a handler whose dependency is briefly down.
// Uses in-process fake connections/channels — no broker, no sockets.
import { freshBoot, getDb, fakeBroker } from "../test-helpers/boot.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  handleDelivery, publish, getPublisher, dropPublisher, startConsumer,
} from "../lib/amqp/connection.js";
import { runRelayOnce } from "../lib/outbox/relay.js";
import { insertEvent } from "../lib/db/events.js";

freshBoot();

const msgOf = (body) => ({ content: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });
const envelope = { source: "test", id: 1, type: "booking.completed", payload: {} };
const noWait = async () => {};
const until = async (cond, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

function recordingLog() {
  const lines = [];
  const add = (level) => (obj, msg) => lines.push({ level, msg, ...obj });
  return { lines, warn: add("warn"), error: add("error"), info: add("info") };
}

// ack/nack record the call, or throw like amqplib does once the channel is closed.
function fakeAckChannel({ closed = false } = {}) {
  const calls = [];
  const settle = (name) => (_msg, _allUpTo, requeue) => {
    if (closed) throw new Error("Channel closed");
    calls.push(name === "nack" ? ["nack", requeue] : ["ack"]);
  };
  return { calls, ack: settle("ack"), nack: settle("nack") };
}

// A fake amqplib connection whose channels are EventEmitters with async topology methods.
class FakeChannel extends EventEmitter {
  constructor({ failSetup = false } = {}) {
    super();
    this.failSetup = failSetup;
    this.acks = [];
  }
  async assertExchange() { if (this.failSetup) throw new Error("PRECONDITION_FAILED"); }
  async assertQueue() {}
  async bindQueue() {}
  async prefetch() {}
  async consume(_queue, onMessage) { this.onMessage = onMessage; }
  ack(msg) { if (this.closed) throw new Error("Channel closed"); this.acks.push(["ack", msg]); }
  nack(msg, _all, requeue) { if (this.closed) throw new Error("Channel closed"); this.acks.push(["nack", requeue]); }
}
class FakeConnection extends EventEmitter {
  constructor(opts) {
    super();
    this.channel = new FakeChannel(opts);
    this.closed = false;
  }
  async createChannel() { return this.channel; }
  async createConfirmChannel() { return this.channel; }
  async close() {
    if (this.closed) throw new Error("Connection closed");
    this.closed = true;
    this.channel.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
}
// connect() that hands out the given connections in order (then fresh healthy ones).
function connector(...planned) {
  const made = [];
  const connect = async () => {
    const c = planned.shift() ?? new FakeConnection();
    made.push(c);
    return c;
  };
  return { connect, made };
}

// ------------------------------------------------------------------ handleDelivery (G1, G5)

test("handleDelivery: a successful handler is acked once", async () => {
  const ch = fakeAckChannel();
  let calls = 0;
  await handleDelivery(ch, msgOf(envelope), async () => { calls += 1; }, recordingLog(), { retries: 3, wait: noWait });
  assert.equal(calls, 1);
  assert.deepEqual(ch.calls, [["ack"]]);
});

test("handleDelivery: a briefly failing handler is retried in-process with backoff, then acked", async () => {
  const ch = fakeAckChannel();
  const waits = [];
  let calls = 0;
  const handler = async () => { calls += 1; if (calls < 3) throw new Error("db down"); };
  await handleDelivery(ch, msgOf(envelope), handler, recordingLog(), {
    retries: 5, baseMs: 100, wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200], "exponential backoff between attempts");
  assert.deepEqual(ch.calls, [["ack"]], "acked, never nacked: the broker's delivery limit is not spent");
});

test("handleDelivery: after every retry fails the message is nacked back to the broker (requeue)", async () => {
  const ch = fakeAckChannel();
  let calls = 0;
  await handleDelivery(ch, msgOf(envelope), async () => { calls += 1; throw new Error("still down"); },
    recordingLog(), { retries: 2, wait: noWait });
  assert.equal(calls, 3, "1 attempt + 2 retries");
  assert.deepEqual(ch.calls, [["nack", true]]);
});

test("handleDelivery: once the channel is gone, retries stop and nothing is acked or nacked", async () => {
  const ch = fakeAckChannel();
  let calls = 0;
  let open = true;
  await handleDelivery(ch, msgOf(envelope), async () => { calls += 1; open = false; throw new Error("db down"); },
    recordingLog(), { retries: 5, wait: noWait, isOpen: () => open });
  assert.equal(calls, 1, "no further attempts: the broker is redelivering this message to the new consumer");
  assert.deepEqual(ch.calls, []);
});

test("handleDelivery: unparseable JSON is dead-lettered at once, the handler never runs", async () => {
  const ch = fakeAckChannel();
  let calls = 0;
  await handleDelivery(ch, msgOf("{not json"), async () => { calls += 1; }, recordingLog(), { retries: 5, wait: noWait });
  assert.equal(calls, 0);
  assert.deepEqual(ch.calls, [["nack", false]]);
});

test("handleDelivery: ack/nack on a closed channel do not throw (G1 crash)", async () => {
  const log = recordingLog();
  await handleDelivery(fakeAckChannel({ closed: true }), msgOf(envelope), async () => {}, log, { retries: 0, wait: noWait });
  await handleDelivery(fakeAckChannel({ closed: true }), msgOf(envelope), async () => { throw new Error("x"); },
    log, { retries: 0, wait: noWait });
  const closed = log.lines.filter((l) => /channel closed before (ack|nack)/.test(l.msg));
  assert.equal(closed.length, 2, "both are logged instead of thrown");
});

// ------------------------------------------------------------------ publish + relay (G4)

test("publish: rejects when the broker never confirms", async () => {
  const silent = { publish() { return true; } };             // never calls the confirm callback
  await assert.rejects(publish(silent, envelope, { timeoutMs: 20 }), /timed out after 20 ms/);
});

test("publish: a broker nack rejects with the broker's error", async () => {
  const nacking = { publish(_e, _k, _c, _o, cb) { cb(new Error("nacked")); return true; } };
  await assert.rejects(publish(nacking, envelope, { timeoutMs: 1000 }), /nacked/);
});

test("relay: a publish that never confirms does not wedge the relay", async () => {
  getDb().transaction(() => insertEvent("review.created", "review", 1, { review_id: 1 }))();
  const silent = { publish() { return true; } };
  assert.equal(await runRelayOnce({ publisher: silent, publishTimeoutMs: 20 }), 0, "nothing marked processed");
  const delivered = await runRelayOnce({ publisher: fakeBroker.channel });
  assert.ok(delivered >= 1, "the next tick runs (BUSY was released) and delivers the waiting event");
});

// ------------------------------------------------------------------ getPublisher (G2)

test("getPublisher: a failed setup closes the connection it opened", async () => {
  const bad = new FakeConnection({ failSetup: true });
  const { connect } = connector(bad);
  await assert.rejects(getPublisher({ connect }), /PRECONDITION_FAILED/);
  assert.equal(bad.closed, true, "no leaked connection per failed attempt");
});

test("getPublisher: a closed channel is forgotten, so the next call reconnects", async () => {
  const { connect, made } = connector();
  const ch = await getPublisher({ connect });
  assert.equal(await getPublisher({ connect }), ch, "cached while healthy");
  ch.emit("close");
  assert.equal(made[0].closed, true, "its connection is closed too");
  const fresh = await getPublisher({ connect });
  assert.notEqual(fresh, ch);
  assert.equal(made.length, 2);
  dropPublisher();
});

test("getPublisher: while the broker blocks the connection, a failed publish does not drop it", async () => {
  const { connect, made } = connector();
  const ch = await getPublisher({ connect });
  made[0].emit("blocked", "memory alarm");
  dropPublisher();                                           // what the relay does after a publish timeout
  assert.equal(made[0].closed, false, "no close() on a blocked connection (it would never complete)");
  assert.equal(await getPublisher({ connect }), ch, "the same channel is reused; no new connection per tick");
  made[0].emit("unblocked");
  dropPublisher();
  assert.equal(made[0].closed, true, "once unblocked, a failed publish drops it as usual");
});

// ------------------------------------------------------------------ startConsumer (G1, G3)

test("startConsumer: a cancelled consumer (msg === null) reconnects", async () => {
  const { connect, made } = connector();
  await startConsumer("payments.events", async () => {}, recordingLog(), { connect, retryDelayMs: 5 });
  made[0].channel.onMessage(null);
  await until(() => made.length === 2 && made[1].channel.onMessage);
  assert.equal(made[0].closed, true);
});

test("startConsumer: a channel-only close reconnects", async () => {
  const { connect, made } = connector();
  await startConsumer("payments.events", async () => {}, recordingLog(), { connect, retryDelayMs: 5 });
  made[0].channel.emit("close");
  await until(() => made.length === 2 && made[1].channel.onMessage);
});

test("startConsumer: a failed setup closes that connection and schedules exactly one retry", async () => {
  const { connect, made } = connector(new FakeConnection({ failSetup: true }));
  await startConsumer("payments.events", async () => {}, recordingLog(), { connect, retryDelayMs: 5 });
  await until(() => made.length === 2 && made[1].channel.onMessage);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(made[0].closed, true, "the failed connection is not leaked");
  assert.equal(made.length, 2, "its close event did not start a second consumer loop");
});

test("startConsumer: with the configured defaults, a briefly failing handler is retried and acked", async () => {
  // No `delivery` override: retries and backoff come from config (CONSUMER_RETRIES / _BASE_MS).
  const { connect, made } = connector();
  let calls = 0;
  await startConsumer("payments.events", async () => { calls += 1; if (calls === 1) throw new Error("db blip"); },
    recordingLog(), { connect, retryDelayMs: 5 });
  made[0].channel.onMessage(msgOf(envelope));
  await until(() => made[0].channel.acks.length === 1, 3000);
  assert.equal(calls, 2);
  assert.equal(made[0].channel.acks[0][0], "ack");
});

test("startConsumer: the channel closing while a handler runs causes no unhandled rejection (G1)", async () => {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);
  try {
    const { connect, made } = connector();
    let release;
    const handlerDone = new Promise((r) => { release = r; });
    const log = recordingLog();
    await startConsumer("payments.events", () => handlerDone, log,
      { connect, retryDelayMs: 5, delivery: { retries: 0, wait: noWait } });
    made[0].channel.onMessage(msgOf(envelope));             // the handler is now waiting on "the DB"
    await made[0].close();                                   // RabbitMQ restarts meanwhile
    release();                                               // the DB answers; ack now hits a closed channel
    await until(() => log.lines.some((l) => /channel closed before ack/.test(l.msg)));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(rejections, []);
    await until(() => made.length === 2, 1000);              // and the consumer came back
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
