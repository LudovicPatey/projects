<?php
declare(strict_types=1);

spl_autoload_register(function (string $class): void {
    if (str_starts_with($class, 'App\\')) {
        $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, 4)) . '.php';
        if (is_file($file)) require $file;
    }
});
require __DIR__ . '/Http.php'; // HttpError, Request, Response

$configFile = __DIR__ . '/../config/config.php';
if (!is_file($configFile)) {
    http_response_code(500);
    exit('Missing config/config.php — copy config/config.example.php and fill it in.');
}
App\Config::load(require $configFile);

date_default_timezone_set('UTC');
error_reporting(E_ALL);
ini_set('display_errors', App\Config::isDev() ? '1' : '0');
