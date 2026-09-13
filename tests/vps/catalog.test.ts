import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OS, DEFAULT_REGIONS, DEFAULT_SIZES } from "../../src/vps/catalog.js";
import { vpsPlanPrice } from "../../src/vps/service.js";

test("VPS catalog defaults contain the requested regions, sizes, and installer OS choices", () => {
  assert.deepEqual(DEFAULT_REGIONS.map(item => item[0]), ["nyc1", "nyc2", "nyc3", "ams3", "sfo2", "sfo3", "sgp1", "lon1", "fra1", "tor1", "blr1", "syd1", "atl1", "ric1", "mkc1", "mem1"]);
  assert.deepEqual(DEFAULT_SIZES.map(item => item[1]), ["s-1vcpu-512mb-10gb", "s-1vcpu-1gb", "s-1vcpu-2gb", "s-2vcpu-2gb", "s-2vcpu-4gb", "s-4vcpu-8gb", "s-8vcpu-16gb"]);
  assert.deepEqual(DEFAULT_OS.filter(item => item[3] === "windows").map(item => item[0]), ["windows2016", "windows2019", "windows2022"]);
});

test("region-specific VPS price overrides legacy OS price and falls back for old plans", () => {
  const plan = { osPrices: [{ os: "windows2022", label: "Windows", price: 100_000 }], priceMatrix: [{ region: "sgp1", os: "windows2022", price: 125_000 }] };
  assert.equal(vpsPlanPrice(plan, "sgp1", "windows2022"), 125_000);
  assert.equal(vpsPlanPrice(plan, "fra1", "windows2022"), 100_000);
});
