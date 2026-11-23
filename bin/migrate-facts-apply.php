<?php
// For an OVH scheduled task: makes a verified backup, then applies the fact migration. Running it again changes nothing.
if (isset($_SERVER['REQUEST_METHOD'])) { http_response_code(404); exit; }
$_SERVER['argv'] = [__FILE__, '--apply'];
require __DIR__ . '/migrate-facts.php';
