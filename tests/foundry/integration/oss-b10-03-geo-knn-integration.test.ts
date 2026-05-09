import { describe, expect, it } from "vitest";
import { compileFilter } from "../../../src/services/oss/irCompiler";

describe("B10.03 — geoDistance + knn", () => {
  it("geoDistance compiles to OS geo_distance", () => {
    const r = compileFilter({ kind: 'geoDistance', field: 'loc', lat: 37, lon: -122, distanceMeters: 5000 }) as any;
    expect(r.geo_distance.distance).toBe('5000m');
    expect(r.geo_distance.loc).toEqual({ lat: 37, lon: -122 });
  });

  it("knn compiles to OS knn vector with k", () => {
    const r = compileFilter({ kind: 'knn', field: 'embedding', vector: [0.1, 0.2, 0.3], k: 5 }) as any;
    expect(r.knn.embedding.k).toBe(5);
    expect(r.knn.embedding.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it("nested and(geoDistance, knn) is well-formed", () => {
    const r = compileFilter({ kind: 'and', filters: [
      { kind: 'geoDistance', field: 'loc', lat: 0, lon: 0, distanceMeters: 100 },
      { kind: 'knn', field: 'v', vector: [1], k: 3 },
    ]}) as any;
    expect(r.bool.must.length).toBe(2);
    expect(r.bool.must[0].geo_distance).toBeTruthy();
    expect(r.bool.must[1].knn).toBeTruthy();
  });
});
