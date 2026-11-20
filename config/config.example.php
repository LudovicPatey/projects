<?php
// Copy this file to config/config.php and fill in the values.
return [
    // Public URL of the platform, without trailing slash.
    'app_url' => 'https://research.example.org',

    // 'prod' on OVH. 'dev' enables the local "dev login" (no ORCID needed) — never use on a public server.
    'env' => 'prod',

    // OVH shared hosting: host looks like "xxxxx.mysql.db", database and user are given in the OVH console.
    'db' => [
        'dsn'      => 'mysql:host=xxxxx.mysql.db;dbname=xxxxx;charset=utf8mb4',
        'user'     => 'xxxxx',
        'password' => 'xxxxx',
    ],
    // For local development you can use SQLite instead:
    // 'db' => ['dsn' => 'sqlite:' . __DIR__ . '/../storage/dev.sqlite', 'user' => null, 'password' => null],

    // Register a public API client at https://orcid.org/developer-tools
    // Redirect URI to declare: {app_url}/auth/callback
    'orcid' => [
        'client_id'     => 'APP-XXXXXXXXXXXXXXXX',
        'client_secret' => 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        'sandbox'       => false, // true => uses sandbox.orcid.org
    ],

    // Where uploaded files are stored. Must NOT be inside the public web root.
    'storage_path' => __DIR__ . '/../storage',

    // Maximum size of a single uploaded file, in MB (also bounded by PHP's upload_max_filesize).
    'max_upload_mb' => 64,

    // Optional: restrict who may create new projects (list of ORCID iDs). Empty = any logged-in user.
    'project_creators' => [],
];
