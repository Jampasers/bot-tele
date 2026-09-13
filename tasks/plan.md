# Implementation Plan: Dynamic VPS/Install Catalog

## Overview

Make VPS purchase and Windows install offerings data-driven. Regions, sizes, and operating systems come from a MongoDB catalog managed by admins; each plan prices the selected region/size/OS combination while existing plans remain readable through a compatibility fallback.

## Architecture Decisions

- Keep `VpsPlan` as the sellable offering and add an optional region/OS price matrix, so existing orders and plans remain compatible.
- Add one platform-scoped `VpsCatalog` singleton for regions, sizes, and OS definitions. Seed it lazily from the requested defaults.
- Keep buyer tokens/passwords memory-only or encrypted as they are today; catalog changes must not weaken payment, worker, or recovery guards.
- Snapshot the selected labels and provider image data on checkout so later catalog edits do not mutate an order.

## Task List

1. Add catalog model, requested defaults, and service contracts.
2. Resolve catalog entries and region/OS-specific pricing during checkout.
3. Update buyer VPS/install menus to display only valid priced combinations.
4. Add admin catalog management and per-combination price editing.
5. Add regression tests for catalog defaults, pricing matrix, and legacy-plan fallback.
6. Run focused tests, build, and review the final diff.

## Risks and Open Verification

- DigitalOcean availability is still checked live before create; catalog presence does not prove provider availability.
- Windows installer support remains limited to OS definitions with installer metadata; live Windows readiness is not proven by unit tests.
- Existing dirty files are preserved and must not be included in unrelated changes.
