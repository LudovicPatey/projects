<?php
// Creates the database tables. Usage: php bin/install.php
require __DIR__ . '/../src/bootstrap.php';
App\Db::install();
echo "Database schema installed.\n";
