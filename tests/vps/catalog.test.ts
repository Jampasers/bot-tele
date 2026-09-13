import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OS, DEFAULT_REGIONS, DEFAULT_SIZES, defaultVpsCatalog } from "../../src/vps/catalog.js";
import { vpsPlanPrice } from "../../src/vps/service.js";
import { catalogPlans, mergeCatalogPrices, planPrice } from "../../src/vps/catalogPlans.js";

test("VPS catalog defaults contain the requested regions, sizes, and installer OS choices", () => {
  assert.deepEqual(DEFAULT_REGIONS.map(item => item[0]), ["nyc1", "nyc2", "nyc3", "ams3", "sfo2", "sfo3", "sgp1", "lon1", "fra1", "tor1", "blr1", "syd1", "atl1", "ric1", "mkc1", "mem1"]);
  assert.deepEqual(DEFAULT_SIZES.map(item => item[1]), ["s-1vcpu-512mb-10gb", "s-1vcpu-1gb", "s-1vcpu-2gb", "s-2vcpu-2gb", "s-2vcpu-4gb", "s-4vcpu-8gb", "s-8vcpu-16gb"]);
  assert.deepEqual(DEFAULT_OS.filter(item => item[3] === "windows").map(item => item[0]), ["windows2012r2", "windows2016", "windows2019", "windows2022"]);
});

test("catalog replacement exposes seven specs per service with all regions and OS before prices exist", () => {
  const plans = catalogPlans(defaultVpsCatalog());
  assert.equal(plans.length, 14);
  assert.equal(new Set(plans.map(plan => plan.id)).size, 14);
  for (const service of ["purchase", "install"] as const) {
    assert.deepEqual(plans.filter(plan => plan.serviceType === service).map(plan => plan.sizeSlug), DEFAULT_SIZES.map(size => size[1]));
  }
  for (const plan of plans) {
    assert.equal(plan.regions.length, 16);
    assert.equal(plan.osPrices.length, 18);
    assert.ok(plan.osPrices.every(os => os.price === null));
    assert.equal(planPrice(plan, "sgp1", "windows2022"), undefined);
  }
  assert.deepEqual(catalogPlans(defaultVpsCatalog()), plans, "repeat loading keeps the same identities");
});

test("catalog pricing never borrows another region or old OS price; additions appear without a named package", () => {
  const catalog = defaultVpsCatalog();
  const base = catalogPlans(catalog)[0]!;
  const priced = mergeCatalogPrices(base, { enabled: true, priceMatrix: [{ region: "sgp1", os: "windows2022", price: 25000 }] });
  assert.equal(planPrice(priced, "sgp1", "windows2022"), 25000);
  assert.equal(planPrice(priced, "fra1", "windows2022"), undefined);
  assert.equal(planPrice(priced, "sgp1", "ubuntu24"), undefined);
  assert.equal(priced.osPrices.length, 18);
  assert.equal(priced.regions.length, 16);
  const custom = { ...catalog, sizes: [...catalog.sizes, { slug: "s-custom", cpu: 12, ram: "24 GB", disk: "500 GB", transfer: "8 TB", price: "$120/month" }] };
  assert.equal(catalogPlans(custom, "install").length, 8);
});

test("region-specific VPS price overrides legacy OS price and falls back for old plans", () => {
  const plan = { osPrices: [{ os: "windows2022", label: "Windows", price: 100_000 }], priceMatrix: [{ region: "sgp1", os: "windows2022", price: 125_000 }] };
  assert.equal(vpsPlanPrice(plan, "sgp1", "windows2022"), 125_000);
  assert.equal(vpsPlanPrice(plan, "fra1", "windows2022"), 100_000);
});
