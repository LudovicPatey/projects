<?php
// For an OVH scheduled task: undoes the latest fact migration. Running it again changes nothing.
if (isset($_SERVER['REQUEST_METHOD'])) { http_response_code(404); exit; }
$_SERVER['argv'] = [__FILE__, '--undo'];
require __DIR__ . '/migrate-facts.php';
