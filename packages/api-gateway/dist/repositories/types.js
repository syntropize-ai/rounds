// Gateway-level repository interfaces for dependency injection.
//
// All methods return `MaybeAsync<T>` so that:
// - Existing sync in-memory stores satisfy the interface with zero changes.
// - Future async repository implementations (Postgres, Redis, ...) also satisfy
//   the interface by returning Promises.
//
// Route handlers await every store call - `await syncValue` resolves
// immediately, so there is no performance cost for the inMemory path.
export {};
//# sourceMappingURL=types.js.map