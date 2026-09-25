import assert from "node:assert/strict";
import test from "node:test";
import { SmsConfig } from "../../src/models/SmsConfig.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";
import {
  buildCatalogKeyboard,
  buildCatalogText,
  buildMainMenuReplyKeyboard,
} from "../../src/plugins/panel/index.js";

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

test("Email OTP is visible in Catalog only when globally enabled and allowed for the tenant", async t => {
  const previousEmailEnabled = process.env["EMAIL_RENTAL_ENABLED"];
  t.after(() => {
    if (previousEmailEnabled === undefined) delete process.env["EMAIL_RENTAL_ENABLED"];
    else process.env["EMAIL_RENTAL_ENABLED"] = previousEmailEnabled;
  });
  t.mock.method(SmsConfig, "getOrCreate", async () => ({ enabled: true }) as never);

  process.env["EMAIL_RENTAL_ENABLED"] = "true";
  await runWithTenant(platformContext(), async () => {
    assert.equal((rendered(await buildCatalogKeyboard()).match(/"callback_data":"email_otp"/g) ?? []).length, 1);
    assert.match(await buildCatalogText(), /<b>OTP Email<\/b>/i);
  });

  await runWithTenant({
    tenantId: "tenant_email_catalog",
    rentalId: "rental_email_catalog",
    ownerTelegramId: "42",
    enabledFeatures: ["digital", "email_otp"],
  }, async () => {
    assert.match(rendered(await buildCatalogKeyboard()), /"callback_data":"email_otp"/);
    assert.match(await buildCatalogText(), /<b>OTP Email<\/b>/i);
  });

  await runWithTenant({
    tenantId: "tenant_without_email",
    rentalId: "rental_without_email",
    ownerTelegramId: "43",
    enabledFeatures: ["digital"],
  }, async () => {
    assert.doesNotMatch(rendered(await buildCatalogKeyboard()), /"callback_data":"email_otp"/);
  });

  process.env["EMAIL_RENTAL_ENABLED"] = "false";
  await runWithTenant(platformContext(), async () => {
    assert.doesNotMatch(rendered(await buildCatalogKeyboard()), /"callback_data":"email_otp"/);
  });
});
