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
  'uploads' => ['path' => sys_get_temp_dir() . '/chronicle-test-uploads', 'max_mb' => 2, 'campaign_mb' => 6, 'user_mb' => 10],
  // Find Image asks tests/support/image-stub.php instead of Openverse, the museums and DeviantArt.
  'image_search' => [
    'stub' => __DIR__ . '/image-stub.php',
    'contact' => 'tests@example.test',
    'deviantart' => ['client_id' => 'stub', 'client_secret' => 'stub'],
    'smithsonian' => ['api_key' => 'stub'],
  ],
  // Fan wikis ask tests/support/fanwiki-stub.php instead of Wookieepedia, Memory Alpha and Greyhawk Online.
  'fan_wikis' => ['enabled' => true, 'open_only' => false, 'stub' => __DIR__ . '/fanwiki-stub.php'],
  'rate_limit_enabled' => true,
  'allow_install' => false,
  // Turns on tests/support/login.php. Never set this in a real config.
  'test_login' => true,
];
