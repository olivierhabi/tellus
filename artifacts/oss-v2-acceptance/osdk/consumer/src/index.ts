import {
  OsdkV2Client,
  OsdkV2Error,
  type ObjectSetDefinition,
  type LoadObjectSetRequest,
  type V2ReadContext,
} from "@tellus/telluslive";

const objectSet: ObjectSetDefinition = {
  type: "filter",
  objectSet: { type: "base", objectType: "RcObject" },
  where: { type: "eq", field: "name", value: "release-candidate" },
};
const request: LoadObjectSetRequest = {
  objectSet,
  selectV2: [{ type: "property", apiName: "name" }],
  snapshot: true,
  pageSize: 100,
};
const context: V2ReadContext = {
  transactionId: "example-transaction",
};
const client = new OsdkV2Client({
  baseUrl: "http://localhost:3000/api",
});

void client.loadObjects(request, context).catch((error: unknown) => {
  if (error instanceof OsdkV2Error) {
    console.log(error.errorName, error.retryable);
  }
});
