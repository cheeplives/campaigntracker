<?php
// Config for the browser tests only (tests/playwright.config.js points
// CHRONICLE_CONFIG here). Database settings come from the environment so the
// same file works locally and in CI.
return [
  'db' => [
    'host'     => getenv('DB_HOST') ?: '127.0.0.1',
    'port'     => (int) (getenv('DB_PORT') ?: 3306),
    'name'     => getenv('DB_NAME') ?: 'chronicle_test',
    'user'     => getenv('DB_USER') ?: 'root',
    'password' => getenv('DB_PASSWORD') ?: '',
    'charset'  => 'utf8mb4',
  ],
  'base_url' => 'http://127.0.0.1:' . (getenv('PORT') ?: '8755'),
  // Fake client ids, so the sign-in screen shows both buttons. No test follows them.
  'oauth' => [
    'google' => ['client_id' => 'test-google', 'client_secret' => 'x'],
    'github' => ['client_id' => 'test-github', 'client_secret' => 'x'],
  ],
  'admin_identities' => ['gm@example.test'],
  'approval_webhook_url' => '',
  'session' => ['name' => 'chronicle_sid', 'cookie_secure' => false, 'save_path' => sys_get_temp_dir()],
  'rate_limit_enabled' => true,
  'allow_install' => false,
  // Turns on tests/support/login.php. Never set this in a real config.
  'test_login' => true,
];
