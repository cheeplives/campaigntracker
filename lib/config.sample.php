<?php
// Copy this file to lib/config.php and fill in your DreamHost MySQL details.
// (DreamHost panel → Websites → MySQL Databases shows the hostname, e.g. mysql.yourdomain.com)
return [
    'db_host' => 'mysql.example.com',
    'db_name' => 'rpg_tracker',
    'db_user' => 'rpg_user',
    'db_pass' => 'change-me',

    // Set to false after running install.php once.
    'allow_install' => true,
];
