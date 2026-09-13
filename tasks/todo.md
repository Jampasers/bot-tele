# Dynamic VPS/Install Catalog

- [x] Add catalog model and defaults
- [x] Wire catalog-aware checkout and UI
- [x] Add admin catalog and price matrix controls
- [x] Add regression tests
- [x] Run build/tests and review diff

## Correction: replace the old packages

- [x] Replace named-package menu with full catalog choices
- [x] Set prices through service > size > region > OS
- [x] Back up and remove exactly the old VPS/install plan records; insert 14 catalog plans
- [x] Verify resulting database records and buyer/admin handlers

Verified on the configured database: 0 old packages, 14 catalog-managed plans, 16 regions, 14 Linux + 4 Windows choices. The buyer handler using real database reads rendered 7 sizes, 16 regions, and 18 OS choices with intercepted Telegram calls. No prices were invented. Backup configuration is in `vpscatalogresetbackups`; no order/wallet/provider resources were changed. Bot-process deployment/restart has not been performed.
