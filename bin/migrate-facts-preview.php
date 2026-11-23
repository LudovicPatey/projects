<?php
// For an OVH scheduled task, which runs a file without options: previews the fact migration.
if (isset($_SERVER['REQUEST_METHOD'])) { http_response_code(404); exit; }
$_SERVER['argv'] = [__FILE__];
require __DIR__ . '/migrate-facts.php';
