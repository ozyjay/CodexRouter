import assert from "node:assert/strict";
import test from "node:test";
import { TurnStopController } from "../src/turnStop";

test("stop requests are sent once while awaiting turn completion", async () => {
  let requests = 0;
  const states: boolean[] = [];
  const stop = new TurnStopController(async () => { requests++; }, (state) => states.push(state));
  stop.request();
  stop.request();
  await Promise.resolve();
  stop.request();
  assert.equal(requests, 1);
  assert.deepEqual(states, [true]);
});

test("failed stop requests expose retry without ending the turn", async () => {
  let requests = 0;
  const states: boolean[] = [];
  const stop = new TurnStopController(async () => { if (++requests === 1) throw new Error("unavailable"); }, (state) => states.push(state));
  stop.request();
  await Promise.resolve();
  stop.request();
  await Promise.resolve();
  assert.equal(requests, 2);
  assert.deepEqual(states, [true, false, true]);
});

test("late stop failures cannot update a completed turn", async () => {
  let fail!: (error: Error) => void;
  const states: boolean[] = [];
  const stop = new TurnStopController(() => new Promise<void>((_resolve, reject) => { fail = reject; }), (state) => states.push(state));
  stop.request();
  stop.dispose();
  fail(new Error("late failure"));
  await Promise.resolve();
  stop.request();
  assert.deepEqual(states, [true]);
});
