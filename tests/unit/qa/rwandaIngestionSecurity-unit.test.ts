import { describe, expect, it } from "vitest";
import { quarantineDirtyCsv, sanitizeIso8583Csv } from "../../../src/qa/rwanda/ingestionSecurity";

describe("Rwanda ingestion security boundary", () => {
  it("replaces a raw ISO-8583 PAN with token and first-six/last-four mask", () => {
    const output = sanitizeIso8583Csv("transactionId,field2Pan,mti\nTX-1,4111111111111111,0200\n");
    expect(output).toContain("panToken,maskedPan");
    expect(output).toContain("tok_");
    expect(output).toContain("411111******1111");
    expect(output).not.toContain("4111111111111111");
  });

  it("quarantines each dirty row with a safe, row-level reason", () => {
    const records = quarantineDirtyCsv("dirty_payment_transactions.csv", "transactionId,amount,currency,createdAt\n,10,RWF,2026-08-10T08:00:00Z\nTX-2,-1,RWF,nope\n");
    expect(records).toEqual([
      expect.objectContaining({ rowNumber: 2, reasonCode: "MISSING_PRIMARY_KEY" }),
      expect.objectContaining({ rowNumber: 3, reasonCode: "INVALID_AMOUNT" }),
    ]);
    expect(JSON.stringify(records)).not.toContain("nope");
  });
});
