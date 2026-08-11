import { describe, expect, it } from "vitest";
import { omitUnauthorizedProperties } from "../../../src/services/security/propertyMarkingProjection";

describe("direct-object property marking projection", () => {
  it("keeps a property only when every required marking is granted", () => {
    const properties = {
      publicName: "Synthetic customer",
      nationalId: "9990000000000012",
      riskClass: "CANARY-CREDITRISK-000123",
    };

    const omitted = omitUnauthorizedProperties(
      properties,
      [
        { api_name: "nationalId", marking_required: ["PII_ID"] },
        { api_name: "riskClass", marking_required: ["CREDIT_RISK", "SUPERVISOR"] },
      ],
      new Set(["PII_ID", "CREDIT_RISK"]),
    );

    expect(properties).toEqual({
      publicName: "Synthetic customer",
      nationalId: "9990000000000012",
    });
    expect(omitted).toEqual(["riskClass"]);
  });

  it("does not remove marked properties for a marking-bypass service identity", () => {
    const properties = { balance: 100_000 };
    expect(
      omitUnauthorizedProperties(
        properties,
        [{ api_name: "balance", marking_required: ["FINANCIAL_DETAIL"] }],
        new Set(),
        true,
      ),
    ).toEqual([]);
    expect(properties.balance).toBe(100_000);
  });

  it("removes both API and datasource-column representations from flat object documents", () => {
    const properties = {
      riskClass: "CANARY-CREDITRISK-000123",
      risk_class: "CANARY-CREDITRISK-000123",
      model_risk_code: "CANARY-CREDITRISK-000123",
      __pk: "QA-RW-BK-C-0000001",
    };

    expect(
      omitUnauthorizedProperties(
        properties,
        [{
          api_name: "riskClass",
          column_name: "model_risk_code",
          marking_required: ["CREDIT_RISK"],
        }],
        new Set(),
      ),
    ).toEqual(["riskClass"]);
    expect(properties).toEqual({ __pk: "QA-RW-BK-C-0000001" });
  });
});
