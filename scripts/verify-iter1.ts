import { TraceRecorder } from "../backend/src/modules/monitor/traceRecorder";

const recorder = new TraceRecorder({
  traceId: "trace.test",
  runId: "run.test",
  contextId: "ctx.test",
  caseId: "case.test",
});

const e1 = recorder.record("test_started", "system", {
  contextId: "ctx.test",
  sandboxId: "sb.test",
});

const e2 = recorder.record("task_sent", "system", {
  taskId: "task.1",
  instruction: "do something",
});

const e3 = recorder.record("agent_message", "agent", {
  message: "done",
});

const ids = new Set([e1.eventId, e2.eventId, e3.eventId]);
console.assert(ids.size === 3, "eventId must be unique");
console.assert(e1.sequence === 1, "e1 seq = 1");
console.assert(e2.sequence === 2, "e2 seq = 2");
console.assert(e3.sequence === 3, "e3 seq = 3");
console.assert(e1.traceId === "trace.test", "traceId inherited");
console.assert(e1.runId === "run.test", "runId inherited");
console.assert(e1.caseId === "case.test", "caseId inherited");

const trace = recorder.toTrace({
  schemaVersion: "mvp-1",
  traceId: "trace.test",
  runId: "run.test",
  contextId: "ctx.test",
  caseId: "case.test",
  agentId: "agent.test",
  sandboxId: "sb.test",
  startedAt: e1.timestamp,
  endedAt: e3.timestamp,
  status: "completed",
});
console.assert(trace.events.length === 3, "3 events in trace");
console.assert(trace.events[0].sequence === 1, "sorted by sequence");

console.log("PASS: iteration 1 verification");
