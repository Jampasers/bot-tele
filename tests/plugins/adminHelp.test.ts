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
import { formatAdminValue, formatSecretStatus, isPrivateAdminChat } from "./adminDisplay.js";

test("data operasional admin ditampilkan utuh tanpa masking", () => {
  assert.equal(formatAdminValue("customer.full@example.com"), "customer.full@example.com");
  assert.equal(formatAdminValue("023e105f4ecef8ad9ca31a8372d0c353"), "023e105f4ecef8ad9ca31a8372d0c353");
});

test("secret hanya menampilkan status dan tidak mengulang nilainya ke Telegram", () => {
  const secret = "secret-value-that-must-not-leak";
  const status = formatSecretStatus(secret);
  assert.equal(status, "✅ Tersimpan");
  assert.doesNotMatch(status, new RegExp(secret));
  assert.equal(formatSecretStatus(""), "⚪ Belum diatur");
});

test("data admin utuh hanya boleh dirender di chat pribadi", () => {
  assert.equal(isPrivateAdminChat("private"), true);
  assert.equal(isPrivateAdminChat("group"), false);
  assert.equal(isPrivateAdminChat("supergroup"), false);
  assert.equal(isPrivateAdminChat("channel"), false);
});

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
