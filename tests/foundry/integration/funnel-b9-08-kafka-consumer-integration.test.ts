import { describe, expect, it, vi } from "vitest";
import { B9KafkaConsumer } from "../../../src/services/funnel/b9KafkaConsumer";

const c = new B9KafkaConsumer();

describe("B9.08 — Kafka consumer for tellus.oms.object-type.updated", () => {
  it("dispatches on matching event", async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handled = await c.handleEvent({
      objectType: 'tellus.oms.object-type.updated',
      objectTypeRid: 'ri.ontology.main.object-type.x',
      ontologyRid: 'ri.ontology.main.ontology.default',
      branchRid: null,
      etag: 2,
    }, trigger);
    expect(handled).toBe(true);
    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledWith('ri.ontology.main.object-type.x', 'ri.ontology.main.ontology.default', null);
  });

  it("ignores unrelated objectType strings", async () => {
    const trigger = vi.fn();
    const handled = await c.handleEvent({ objectType: 'something.else', objectTypeRid: 'x', ontologyRid: 'y' }, trigger);
    expect(handled).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("ignores malformed events", async () => {
    const trigger = vi.fn();
    expect(await c.handleEvent(null, trigger)).toBe(false);
    expect(await c.handleEvent({ objectType: 'tellus.oms.object-type.updated' }, trigger)).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("forwards branchRid when present", async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    await c.handleEvent({
      objectType: 'tellus.oms.object-type.updated',
      objectTypeRid: 'ri.ontology.main.object-type.x',
      ontologyRid: 'ri.ontology.main.ontology.default',
      branchRid: 'ri.compass.main.branch.feature',
    }, trigger);
    expect(trigger).toHaveBeenCalledWith('ri.ontology.main.object-type.x', 'ri.ontology.main.ontology.default', 'ri.compass.main.branch.feature');
  });
});
