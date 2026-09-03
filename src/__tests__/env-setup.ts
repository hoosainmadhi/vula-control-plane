// Runs before every test file: deterministic env for an in-memory registry.
process.env.NODE_ENV = 'test';
process.env.CP_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.OFFICE_ADMIN_EMAIL = 'office@test.local';
process.env.OFFICE_ADMIN_PASSWORD = 'office-pass-123';
process.env.STORE_REQUEST_TIMEOUT_MS = '100';
process.env.LOG_LEVEL = 'error';
