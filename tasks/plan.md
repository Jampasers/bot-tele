# Implementation Plan: Dynamic VPS/Install Catalog

## Overview

Replace the old named VPS/install packages with the user's full catalog: seven Basic sizes, sixteen regions, fourteen Linux OS entries, and the four Windows versions already supported by the installer. Show every catalog choice before any price is configured. Prices remain unset until an admin sets a service/size/region/OS price.

## Architecture Decisions

- Remove old VpsPlan records after saving a recoverable snapshot; replace them with one catalog-managed plan per service and size (14 total). Existing VpsOrder snapshots are untouched.
- Derive menu choices from the catalog, including additions made by admins. Stop creating arbitrary named packages. Catalog prices are exact combinations with no fallback to a different region or old package.
- Add one platform-scoped `VpsCatalog` singleton for regions, sizes, and OS definitions. Seed it lazily from the requested defaults.
- Keep buyer tokens/passwords memory-only or encrypted as they are today; catalog changes must not weaken payment, worker, or recovery guards.
- Snapshot the selected labels and provider image data on checkout so later catalog edits do not mutate an order.

## Task List

1. Add catalog model, requested defaults, and service contracts.
2. Resolve catalog entries and region/OS-specific pricing during checkout.
3. Display all catalog specs/regions/OS; refuse checkout for combinations whose price has not been set. The USD labels are reference provider charges, not sale/install prices.
4. Add admin catalog management and per-combination price editing.
5. Test catalog replacement, unset pricing, direct installer OS selection, and admin combination pricing.
6. Run focused tests, build, and review the final diff.

## Risks and Open Verification

- DigitalOcean availability is still checked live before create; catalog presence does not prove provider availability.
- Windows installer support remains limited to OS definitions with installer metadata; live Windows readiness is not proven by unit tests.
- Existing dirty files are preserved and must not be included in unrelated changes.
