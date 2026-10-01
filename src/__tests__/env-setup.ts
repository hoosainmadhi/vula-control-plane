// Runs before every test file: deterministic env for an in-memory registry.
process.env.NODE_ENV = 'test';
process.env.CP_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.OFFICE_ADMIN_EMAIL = 'office@test.local';
process.env.OFFICE_ADMIN_PASSWORD = 'office-pass-123';
process.env.STORE_REQUEST_TIMEOUT_MS = '100';
process.env.LOG_LEVEL = 'error';
// config/env.ts loads the developer's local .env at import time — after this
// file runs — so on a machine with real COOLIFY_* keys every suite's
// provisioning paths flip from "Coolify not configured" to live calls against
// mocks that answer no uuid. dotenv never overrides an existing var, so the
// five are pinned to empty here (falsy to readCoolifyConfig); suites that
// test Coolify set their own values afterwards (configureCoolify).
process.env.COOLIFY_API_URL = '';
process.env.COOLIFY_API_TOKEN = '';
process.env.COOLIFY_PROJECT_UUID = '';
process.env.COOLIFY_SERVER_UUID = '';
process.env.COOLIFY_GITHUB_APP_UUID = '';
