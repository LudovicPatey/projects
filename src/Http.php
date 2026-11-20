<?php
declare(strict_types=1);

namespace App;

final class HttpError extends \RuntimeException
{
    public function __construct(public int $status, string $message)
    {
        parent::__construct($message);
    }
}

final class Request
{
    public string $method;
    public string $path;
    public array $query;
    public array $params = [];
    private ?array $json = null;

    public function __construct()
    {
        $this->method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        // Support installation in a sub-directory.
        $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
        if ($base && str_starts_with($uri, $base)) $uri = substr($uri, strlen($base)) ?: '/';
        $this->path = '/' . trim($uri, '/');
        $this->query = $_GET;
    }

    /** JSON body (or form fields for multipart requests). */
    public function input(?string $key = null, mixed $default = null): mixed
    {
        if ($this->json === null) {
            $ct = $_SERVER['CONTENT_TYPE'] ?? '';
            if (str_contains($ct, 'application/json')) {
                $this->json = json_decode(file_get_contents('php://input') ?: '[]', true) ?: [];
            } else {
                $this->json = $_POST;
            }
        }
        if ($key === null) return $this->json;
        return $this->json[$key] ?? $default;
    }

    public function str(string $key, string $default = ''): string
    {
        $v = $this->input($key, $default);
        return is_scalar($v) ? trim((string)$v) : $default;
    }

    public function int(string $key): int
    {
        return (int)($this->params[$key] ?? 0);
    }

    /** Normalised list of uploaded files for a field (supports name[]). */
    public function files(string $field): array
    {
        if (empty($_FILES[$field])) return [];
        $f = $_FILES[$field];
        if (!is_array($f['name'])) $f = array_map(fn($v) => [$v], $f);
        $out = [];
        foreach ($f['name'] as $i => $name) {
            if (($f['error'][$i] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) continue;
            if ($f['error'][$i] !== UPLOAD_ERR_OK) {
                throw new HttpError(400, "Upload of '$name' failed (error code {$f['error'][$i]}). The file may exceed the server limit.");
            }
            $out[] = ['name' => $name, 'tmp' => $f['tmp_name'][$i], 'size' => (int)$f['size'][$i]];
        }
        return $out;
    }
}

final class Response
{
    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function redirect(string $url): never
    {
        header('Location: ' . $url, true, 302);
        exit;
    }
}
