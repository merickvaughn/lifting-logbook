// `server-only` throws on import anywhere outside a Server Component module —
// including Jest. Mapped here (see jest.config.js moduleNameMapper) so a
// server-side lib module such as lib/loadWorkoutPlan.ts can be unit-tested
// directly instead of only through a page test that mocks it away.
module.exports = {};
