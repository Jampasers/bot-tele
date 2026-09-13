import assert from "node:assert/strict";
import test from "node:test";
import { SmsConfig } from "../models/SmsConfig.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import {
  buildCatalogKeyboard,
  buildCatalogText,
  buildMainMenuReplyKeyboard,
} from "./panel/index.js";

function rendered(value: unknown): string {
  return JSON.stringify(value);
}

test("rental entry is exposed once in the enabled platform catalog and hidden elsewhere", async t => {
  const previousRentalEnabled = process.env["RENTAL_ENABLED"];
  t.after(() => {
    if (previousRentalEnabled === undefined) delete process.env["RENTAL_ENABLED"];
    else process.env["RENTAL_ENABLED"] = previousRentalEnabled;
  });
  t.mock.method(SmsConfig, "getOrCreate", async () => ({ enabled: true }) as never);

  process.env["RENTAL_ENABLED"] = "true";
  await runWithTenant(platformContext(), async () => {
    const catalogKeyboard = rendered(await buildCatalogKeyboard());
    const catalogText = await buildCatalogText();
    const mainKeyboard = rendered(buildMainMenuReplyKeyboard());

    assert.equal((catalogKeyboard.match(/"callback_data":"rs_home"/g) ?? []).length, 1);
    assert.match(catalogText, /<b>Sewa Bot<\/b>/i);
    assert.doesNotMatch(mainKeyboard, /Sewa Bot/i);
  });

  process.env["RENTAL_ENABLED"] = "false";
  await runWithTenant(platformContext(), async () => {
    assert.doesNotMatch(rendered(await buildCatalogKeyboard()), /"callback_data":"rs_home"/);
    assert.doesNotMatch(await buildCatalogText(), /<b>Sewa Bot<\/b>/i);
    assert.doesNotMatch(rendered(buildMainMenuReplyKeyboard()), /Sewa Bot/i);
  });

  process.env["RENTAL_ENABLED"] = "true";
  await runWithTenant({
    tenantId: "tenant_catalog_test",
    rentalId: "rental_catalog_test",
    ownerTelegramId: "42",
    enabledFeatures: ["digital", "affiliate"],
  }, async () => {
    assert.doesNotMatch(rendered(await buildCatalogKeyboard()), /"callback_data":"rs_home"/);
    assert.doesNotMatch(await buildCatalogText(), /<b>Sewa Bot<\/b>/i);
    assert.doesNotMatch(rendered(buildMainMenuReplyKeyboard()), /Sewa Bot/i);
  });
});
