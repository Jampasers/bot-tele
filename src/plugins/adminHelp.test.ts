import assert from "node:assert/strict";
import test from "node:test";
import adminPlugin from "./admin/index.js";
import digiAdminPlugin from "./digiadmin/index.js";
import rentalAdminPlugin from "./rentaladmin/index.js";
import {
  ADMIN_HELP_SECTION_IDS,
  buildAdminHelpText,
  buildRentalAdminHelpText,
} from "./adminHelp.js";

test("panduan admin utama mencantumkan seluruh command admin dan produk digital", () => {
  const helpText = ADMIN_HELP_SECTION_IDS.map(buildAdminHelpText).join("\n");
  const commands = [
    ...(adminPlugin.commands ?? []),
    ...(digiAdminPlugin.commands ?? []),
  ];

  for (const { command } of commands) {
    assert.match(helpText, new RegExp(`/${command}(?![a-z0-9_])`), `/${command} belum tercantum`);
  }
});

test("setiap halaman panduan admin aman untuk batas pesan Telegram", () => {
  for (const sectionId of ADMIN_HELP_SECTION_IDS) {
    const text = buildAdminHelpText(sectionId);
    assert.ok(text.length > 0);
    assert.ok(text.length <= 4_096, `${sectionId} melebihi batas Telegram`);
  }
});

test("panduan admin rental mencantumkan seluruh command rental", () => {
  const helpText = buildRentalAdminHelpText();

  for (const { command } of rentalAdminPlugin.commands ?? []) {
    assert.match(helpText, new RegExp(`/${command}(?![a-z0-9_])`), `/${command} belum tercantum`);
  }
  assert.ok(helpText.length <= 4_096);
});
