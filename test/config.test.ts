import { describe, expect, it } from "vitest";
import { loadTenantsConfig } from "../src/config/tenants.js";

describe("config/tenants.yaml", () => {
  it("loads and validates the shipped config", async () => {
    const tenants = await loadTenantsConfig();
    expect(tenants.length).toBeGreaterThanOrEqual(2);
    for (const t of tenants) {
      expect(Object.keys(t.sources).length).toBeGreaterThan(0);
    }
  });
});
