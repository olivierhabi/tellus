import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetMetricsForTesting,
  incCounter,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";

describe("funnel metrics label serialization", () => {
  beforeEach(() => {
    __resetMetricsForTesting();
  });

  it("serializes non-string labels without throwing", () => {
    expect(() =>
      incCounter("tellus_request_timeout_total", {
        method: "POST",
        route: ["/actions/:actionType/apply"],
        status: 504,
      }),
    ).not.toThrow();

    expect(renderPrometheus()).toContain(
      'tellus_request_timeout_total{method="POST",route="/actions/:actionType/apply",status="504"} 1',
    );
  });
});
