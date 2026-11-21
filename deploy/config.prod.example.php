<?php
// Production configuration. Copy to cache/config.prod.php (git-ignored), fill in the values,
// then upload it once with: npm run deploy -- --config
return [
    'app_url' => 'https://projects.ludovicpatey.com',
    'env' => 'prod', // never 'dev' on the server: it enables a login without ORCID

    // OVH Control Panel: Web Cloud → Hosting → Databases.
    'db' => [
        'dsn'      => 'mysql:host=xxxxx.mysql.db;dbname=xxxxx;charset=utf8mb4',
        'user'     => 'xxxxx',
        'password' => 'xxxxx',
    ],

    // https://orcid.org/developer-tools
    // Redirect URI to declare: https://projects.ludovicpatey.com/auth/callback
    'orcid' => [
        'client_id'     => 'APP-XXXXXXXXXXXXXXXX',
        'client_secret' => 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        'sandbox'       => false,
    ],

    // Uploads and backups, next to the site's folder and outside the web root.
    'storage_path' => __DIR__ . '/../../projects-data',
    'backup' => ['path' => __DIR__ . '/../../projects-data/backups', 'keep' => 14],

    'max_upload_mb' => 64,

    // Optional: ORCID iDs allowed to create projects. Empty = anyone who signs in.
    'project_creators' => [],
];
