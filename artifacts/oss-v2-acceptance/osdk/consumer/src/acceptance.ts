import {
  OsdkV2Client,
  OsdkV2Error,
  type LoadObjectSetResponse,
} from "@tellus/telluslive";

const token = process.env.TELLUS_ACCEPTANCE_TOKEN;
const scenarioRid = process.env.TELLUS_SCENARIO_RID;
const transactionId = process.env.TELLUS_TRANSACTION_ID;
if (!token || !scenarioRid || !transactionId) {
  throw new Error("acceptance context is incomplete");
}
const acceptedScenarioRid: string = scenarioRid;
const acceptedTransactionId: string = transactionId;

const headers = { authorization: `Bearer ${token}` };
const nodeA = new OsdkV2Client({
  baseUrl: "http://127.0.0.1:3300/api",
  headers,
});
const nodeB = new OsdkV2Client({
  baseUrl: "http://127.0.0.1:3301/api",
  headers,
});
const base = OsdkV2Client.base("Employee");
const checks: Record<string, unknown> = {};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function pageAcrossNodes(snapshot: boolean): Promise<string[]> {
  const first = await nodeA.loadObjects({
    objectSet: base,
    select: ["employeeId", "name"],
    pageSize: 2,
    snapshot,
  });
  assert(first.nextPageToken, "first page did not return a token");
  const second = await nodeB.loadObjects({
    objectSet: base,
    select: ["employeeId", "name"],
    pageSize: 2,
    pageToken: first.nextPageToken,
    snapshot,
  });
  return [...first.data, ...second.data].map(StringKey);
}

function StringKey(value: Record<string, unknown>): string {
  return String(value.__primaryKey);
}

function waitForFrame(
  predicate: (frame: Record<string, unknown>) => boolean,
  subscribe: (
    onFrame: (frame: Record<string, unknown>) => void,
  ) => { close: () => void },
): Promise<{
  frame: Record<string, unknown>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("subscription frame timeout")),
      15_000,
    );
    const connection = subscribe((frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      resolve({ frame, close: connection.close });
    });
  });
}

async function run(): Promise<void> {
  const runId = Date.now().toString(36);
  const loaded = await nodeA.loadObjects({
    objectSet: base,
    select: ["employeeId", "name", "department"],
    pageSize: 10,
  });
  assert(loaded.data.length >= 3, "base load count mismatch");
  assert(
    ["E-001", "E-002", "E-003"].every((key) =>
      loaded.data.some((row) => row.__primaryKey === key),
    ),
    "baseline objects missing",
  );
  assert(loaded.data.every((row) => row.__rid && row.__apiName === "Employee"), "system properties missing");
  checks.authenticatedLoad = loaded.data.map(StringKey);

  checks.signedPagination = await pageAcrossNodes(false);
  checks.snapshotAcrossNodes = await pageAcrossNodes(true);

  const filtered = await nodeA.loadObjects({
    objectSet: {
      type: "filter",
      objectSet: base,
      where: { type: "eq", field: "department", value: "Engineering" },
    },
    select: ["employeeId", "department"],
  });
  assert(filtered.data.length === 2, "filter mismatch");
  checks.filter = filtered.data.map(StringKey);

  const aggregate = await nodeA.aggregate({
    objectSet: OsdkV2Client.base("BigGroup"),
    aggregation: [
      { type: "count" },
      { type: "sum", field: "metric_value" },
      { type: "avg", field: "metric_value" },
      { type: "min", field: "metric_value" },
      { type: "max", field: "metric_value" },
    ],
    groupBy: [
      { type: "exact", field: "group_value", includeNullValues: true },
    ],
    accuracy: "REQUIRE_ACCURATE",
  });
  assert(aggregate.accuracy === "ACCURATE", "large aggregation not exact");
  assert(aggregate.data.length === 100_001, "large aggregation group count mismatch");
  checks.exactCompositeAggregation = {
    groups: aggregate.data.length,
    accuracy: aggregate.accuracy,
  };

  const temporary = await nodeA.createTemporaryObjectSet({
    type: "filter",
    objectSet: base,
    where: { type: "eq", field: "department", value: "Engineering" },
  });
  const referenced = await nodeA.loadObjects({
    objectSet: { type: "reference", reference: temporary.objectSetRid },
    select: ["employeeId"],
  });
  assert(referenced.data.length === 2, "temporary reference mismatch");
  checks.temporaryAndReference = {
    ridPrefix: temporary.objectSetRid.split(".").slice(0, 4).join("."),
    count: referenced.data.length,
  };

  const interfaces = await nodeA.loadObjectsOrInterfaces({
    objectSet: { type: "interfaceBase", interfaceType: "Named" },
    selectV2: [{ type: "property", apiName: "displayName" }],
  });
  assert(interfaces.data.length >= 5, "interface fan-out mismatch");
  checks.interfaces = interfaces.data.map((row) => `${row.__apiName}:${row.displayName}`);

  const transaction = await nodeA.loadObjects(
    { objectSet: base, select: ["employeeId", "name", "department"] },
    { transactionId: acceptedTransactionId },
  );
  assert(
    transaction.data.some((row) => row.__primaryKey === "E-004"),
    "transaction create not visible",
  );
  assert(
    transaction.data.some((row) => row.department === "Transaction Engineering"),
    "transaction modification not visible",
  );
  checks.transaction = transaction.data.map(StringKey);

  const scenario = await nodeA.loadObjects(
    { objectSet: base, select: ["employeeId", "name", "department"] },
    { scenarioRid: acceptedScenarioRid },
  );
  assert(
    scenario.data.some((row) => row.name === "Scenario Alice"),
    "scenario modification not visible",
  );
  checks.scenario = scenario.data.find((row) => row.__primaryKey === "E-001");

  const combined = await nodeB.loadObjects(
    { objectSet: base, select: ["employeeId", "name", "department"] },
    {
      scenarioRid: acceptedScenarioRid,
      transactionId: acceptedTransactionId,
    },
  );
  const combinedE1 = combined.data.find((row) => row.__primaryKey === "E-001");
  assert(combinedE1?.name === "Scenario Alice", "scenario portion missing");
  assert(combinedE1.department === "Transaction Engineering", "transaction precedence missing");
  checks.combinedContexts = combinedE1;

  const validation = await nodeA.applyAction(
    "createEmployee",
    { employeeId: "E-VALIDATION", name: "Validation Only", department: "QA" },
    { mode: "VALIDATE_ONLY", returnEdits: "ALL" },
  );
  checks.validationOnly = validation;

  const apply = await nodeA.applyAction(
    "createEmployee",
    {
      employeeId: `E-ACTION-${runId}`,
      name: "Action Created",
      department: "QA",
    },
    { mode: "VALIDATE_AND_EXECUTE", returnEdits: "ALL" },
  );
  checks.action = apply;

  const batch = await nodeA.applyActionBatch(
    "createEmployee",
    [
      {
        parameters: {
          employeeId: `E-BATCH-1-${runId}`,
          name: "Batch One",
          department: "QA",
        },
      },
      {
        parameters: {
          employeeId: `E-BATCH-2-${runId}`,
          name: "Batch Two",
          department: "QA",
        },
      },
    ],
    { returnEdits: "ALL" },
  );
  checks.batchAction = batch;

  let subscriptionId = "";
  let subscriptionCursor = "";
  const frames: Record<string, unknown>[] = [];
  const firstConnection = nodeA.subscribeObjectSets(
    {
      id: `acceptance-${runId}`,
      requests: [
        {
          objectSet: base,
          propertySet: ["employeeId", "name"],
          referenceSet: [],
        },
      ],
    },
    {
      onMessage: (frame) => {
        frames.push(frame);
        if (frame.type === "subscribeResponses") {
          const responses = frame.responses as Array<Record<string, unknown>>;
          const response = responses[0];
          if (response?.type === "success") {
            subscriptionId = String(response.id);
            subscriptionCursor = String(response.cursor);
          }
        }
        if (frame.type === "objectSetChanged") {
          subscriptionCursor = String(frame.cursor);
        }
      },
      onError: (error) => {
        throw error;
      },
    },
  );
  for (let attempt = 0; attempt < 50 && !subscriptionId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(subscriptionId && subscriptionCursor, "subscription acknowledgment missing");
  await nodeB.applyAction(
    "createEmployee",
    {
      employeeId: `E-SUBSCRIBE-${runId}`,
      name: "Subscription Event",
      department: "Streaming",
    },
    { mode: "VALIDATE_AND_EXECUTE", returnEdits: "ALL" },
  );
  for (
    let attempt = 0;
    attempt < 100 &&
    !frames.some((frame) => frame.type === "objectSetChanged");
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(
    frames.some((frame) => frame.type === "objectSetChanged"),
    "subscription update missing",
  );
  firstConnection.close();

  await nodeB.applyAction(
    "createEmployee",
    {
      employeeId: `E-REPLAY-${runId}`,
      name: "Replay Event",
      department: "Streaming",
    },
    { mode: "VALIDATE_AND_EXECUTE", returnEdits: "ALL" },
  );
  const resumed = await waitForFrame(
    (frame) => frame.type === "objectSetChanged",
    (onFrame) =>
      nodeB.subscribeObjectSets(
        {
          id: `resume-${runId}`,
          requests: [
            {
              objectSet: base,
              propertySet: ["employeeId", "name"],
              referenceSet: [],
            },
          ],
        },
        {
          onMessage: onFrame,
          resume: { subscriptionId, cursor: subscriptionCursor },
        },
      ),
  );
  resumed.close();
  checks.subscription = {
    acknowledged: true,
    updateReceived: true,
    resumeReplayReceived: true,
    replayFrameType: resumed.frame.type,
  };

  try {
    await nodeA.loadObjects({
      objectSet: OsdkV2Client.base("DoesNotExist"),
      select: [],
    });
    throw new Error("typed error was not thrown");
  } catch (error) {
    assert(error instanceof OsdkV2Error, "error was not OsdkV2Error");
    assert(Boolean(error.errorName), "typed error name missing");
    checks.typedError = {
      status: error.status,
      errorCode: error.errorCode,
      errorName: error.errorName,
      retryable: error.retryable,
    };
  }

  console.log(JSON.stringify({ result: "PASS", checks }, null, 2));
}

await run();
