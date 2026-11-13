// The RabbitMQ plumbing is copied into three processes (no shared package between the monolith and the
// services). Every process asserts the same topology on connect, so a change made to only one copy
// breaks the others with PRECONDITION_FAILED. This keeps the copies identical apart from the line that
// imports each process's own config.
import "../test-helpers/boot.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const MONOLITH = "lib/amqp/connection.js";
const COPIES = ["services/payments/src/amqp.js", "services/notifications/src/amqp.js"];

// Normalise line endings and the one line that is allowed to differ.
const normalised = (rel) =>
  readFileSync(root + rel, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/^import \{ config \} from "[^"]+";$/m, 'import { config } from "<config>";');

// The Docker test image is built without services/ (see .dockerignore), so skip there.
const servicesPresent = COPIES.every((rel) => existsSync(root + rel));

test("the three RabbitMQ plumbing copies are identical", { skip: !servicesPresent && "services/ not in this checkout" }, () => {
  const expected = normalised(MONOLITH);
  for (const rel of COPIES) {
    assert.equal(normalised(rel), expected, `${rel} has drifted from ${MONOLITH}; change all three copies together`);
  }
});
