<?php
declare(strict_types=1);

namespace App;

/**
 * The contract between the platform and the AI clients (client/oq.py).
 * A client older than MIN_VERSION no longer speaks this protocol: it is refused with 426 and told to update.
 * Change MIN_VERSION only through `npm run protocol -- --breaking "reason"`, which records the decision in protocol/client-protocol.json.
 */
final class ClientProtocol
{
    public const MIN_VERSION = '1.0.0';

    /** The release of the official client making this request, from its User-Agent. Null for any other program. */
    public static function clientVersion(): ?string
    {
        return preg_match('#^open-questions-client/(\d+\.\d+\.\d+)\b#', (string)($_SERVER['HTTP_USER_AGENT'] ?? ''), $m) ? $m[1] : null;
    }

    /** Stops an official client that is too old for this platform, before it can do anything. */
    public static function check(): void
    {
        if (!Auth::isClient()) return;
        $version = self::clientVersion();
        if ($version === null || version_compare($version, self::MIN_VERSION, '>=')) return;
        Response::json(['error' => 'This AI client (version ' . $version . ') is too old for this platform. Update it to version ' . self::MIN_VERSION . ' or later.',
            'update_required' => true, 'min_version' => self::MIN_VERSION, 'current_version' => $version], 426);
    }
}
