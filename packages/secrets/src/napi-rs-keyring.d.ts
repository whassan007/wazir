// @napi-rs/keyring is an optionalDependency (native addon, no prebuilt binary
// guaranteed on every platform/CI target). This ambient declaration lets the
// dynamic `import('@napi-rs/keyring')` in keyringBackend.ts type-check without
// requiring the package to actually be installed — createSecretBroker() falls
// back to the encrypted-file backend at runtime if the real import fails.
declare module '@napi-rs/keyring';
