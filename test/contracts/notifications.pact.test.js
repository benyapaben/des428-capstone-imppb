// Pact consumer contract edemand -> notifications (Step 6 / E7). Runs the monolith's real client code
// (lib/clients/notifications.js, used by the /notifications page) against a Pact mock server and writes
// pacts/edemand-notifications.json, which Notifications verifies against its real app
// (services/notifications/test/contracts/verify.pact.test.js).
import { NOTIFICATIONS_MOCK_PORT, PACT_DIR, freshPactFile, placeholderToken, BEARER, ISO_TIME, JSON_TYPE } from "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";

const { integer, string, regex, eachLike } = MatchersV3;
const { listNotifications } = await import("../../lib/clients/notifications.js");

freshPactFile("edemand", "notifications");
const pact = new PactV3({
  consumer: "edemand",
  provider: "notifications",
  dir: PACT_DIR,
  port: NOTIFICATIONS_MOCK_PORT,
  logLevel: "warn",
});

const inboxRequest = {
  method: "GET",
  path: "/api/notifications",
  headers: { authorization: regex(BEARER, "Bearer customer-1"), accept: "application/json" },
};
const json = { "content-type": regex(JSON_TYPE, "application/json; charset=utf-8") };

test("GET /api/notifications returns the user's notifications", async () => {
  pact
    .given("customer 1 has an unread notification")
    .uponReceiving("a request for customer 1's notifications")
    .withRequest(inboxRequest)
    .willRespondWith({
      status: 200,
      headers: json,
      // The fields the page renders; read_at null = unread (shows the "Mark read" button).
      body: eachLike({
        id: integer(1),
        type: string("booking_status"),
        title: string("Booking confirmed"),
        body: string("Booking #8001 is now confirmed."),
        read_at: null,
        created_at: regex(ISO_TIME, "2026-11-15T10:00:00.000Z"),
      }),
    });

  await pact.executeTest(async () => {
    const res = await listNotifications({ token: placeholderToken("customer", 1) });
    assert.equal(res.ok, true);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].read_at, null);
    assert.equal(typeof res.data[0].title, "string");
  });
});

test("GET /api/notifications with an empty inbox returns []", async () => {
  pact
    .given("customer 1 has no notifications")
    .uponReceiving("a request for customer 1's notifications when there are none")
    .withRequest(inboxRequest)
    .willRespondWith({ status: 200, headers: json, body: [] });

  await pact.executeTest(async () => {
    const res = await listNotifications({ token: placeholderToken("customer", 1) });
    assert.deepEqual(res, { ok: true, status: 200, data: [] });
  });
});
