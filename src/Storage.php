<?php
declare(strict_types=1);

namespace App;

/** Content-addressed file store: identical uploads are stored once. */
final class Storage
{
    private static function root(): string
    {
        return rtrim((string)Config::get('storage_path'), '/') . '/blobs';
    }

    public static function pathFor(string $sha): string
    {
        return self::root() . '/' . substr($sha, 0, 2) . '/' . substr($sha, 2, 2) . '/' . $sha;
    }

    /** Stores an uploaded file and returns the blob id. */
    public static function storeUpload(array $file, bool $mustBePdf = false): int
    {
        $max = (int)Config::get('max_upload_mb', 64) * 1024 * 1024;
        if ($file['size'] > $max) throw new HttpError(413, "File '{$file['name']}' is too large.");
        if (!is_uploaded_file($file['tmp']) && !Config::isDev()) throw new HttpError(400, 'Invalid upload.');
        return self::storeFile($file['tmp'], $mustBePdf, $file['name']);
    }

    public static function storeFile(string $tmp, bool $mustBePdf = false, string $name = 'file'): int
    {
        if ($mustBePdf) {
            $fh = fopen($tmp, 'rb');
            $head = fread($fh, 1024);
            fclose($fh);
            if (!str_contains((string)$head, '%PDF-')) throw new HttpError(422, "'$name' is not a PDF file.");
        }
        $sha = hash_file('sha256', $tmp);
        $existing = Db::value('SELECT id FROM blobs WHERE sha256 = ?', [$sha]);
        if ($existing) return (int)$existing;

        $dest = self::pathFor($sha);
        if (!is_dir(dirname($dest))) mkdir(dirname($dest), 0750, true);
        if (!@move_uploaded_file($tmp, $dest) && !copy($tmp, $dest)) {
            throw new HttpError(500, 'Could not store the file.');
        }
        $mime = $mustBePdf ? 'application/pdf' : ((new \finfo(FILEINFO_MIME_TYPE))->file($dest) ?: 'application/octet-stream');
        return Db::insert('blobs', [
            'sha256' => $sha, 'size' => filesize($dest), 'mime' => $mime, 'created_at' => Db::now(),
        ]);
    }

    public static function blob(int $id): array
    {
        $b = Db::one('SELECT * FROM blobs WHERE id = ?', [$id]);
        if (!$b) throw new HttpError(404, 'File not found');
        $b['path'] = self::pathFor($b['sha256']);
        return $b;
    }

    /** Streams a blob. PDFs are shown inline, everything else is a download. */
    public static function serve(int $blobId, string $filename, bool $inline = false): never
    {
        $b = self::blob($blobId);
        if (!is_file($b['path'])) throw new HttpError(404, 'File missing on disk');
        $etag = '"' . $b['sha256'] . '"';
        header('ETag: ' . $etag);
        header('Cache-Control: private, max-age=3600');
        header('X-Content-Type-Options: nosniff');
        if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
        $isPdf = $b['mime'] === 'application/pdf';
        header('Content-Type: ' . ($isPdf ? 'application/pdf' : 'application/octet-stream'));
        header('Content-Length: ' . $b['size']);
        $safe = preg_replace('/[^\w.\- ]+/u', '_', $filename) ?: 'file';
        $disp = ($inline && $isPdf) ? 'inline' : 'attachment';
        header("Content-Disposition: $disp; filename=\"$safe\"; filename*=UTF-8''" . rawurlencode($filename));
        readfile($b['path']);
        exit;
    }
}
