<?php
declare(strict_types=1);

namespace App;

/** ORCID OAuth 2.0 (/authenticate scope) + public API lookups. */
final class Orcid
{
    private static function base(): string
    {
        return Config::get('orcid.sandbox') ? 'https://sandbox.orcid.org' : 'https://orcid.org';
    }

    private static function pubApi(): string
    {
        return Config::get('orcid.sandbox') ? 'https://pub.sandbox.orcid.org/v3.0' : 'https://pub.orcid.org/v3.0';
    }

    public static function redirectUri(): string { return Config::appUrl() . '/auth/callback'; }

    public static function authorizeUrl(string $state): string
    {
        return self::base() . '/oauth/authorize?' . http_build_query([
            'client_id' => Config::get('orcid.client_id'),
            'response_type' => 'code',
            'scope' => '/authenticate',
            'redirect_uri' => self::redirectUri(),
            'state' => $state,
        ]);
    }

    /** @return array{orcid:string,name:string} */
    public static function exchangeCode(string $code): array
    {
        $res = self::http(self::base() . '/oauth/token', [
            'client_id' => Config::get('orcid.client_id'),
            'client_secret' => Config::get('orcid.client_secret'),
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => self::redirectUri(),
        ]);
        $data = json_decode($res, true);
        if (empty($data['orcid'])) throw new HttpError(502, 'ORCID authentication failed.');
        return ['orcid' => $data['orcid'], 'name' => trim((string)($data['name'] ?? ''))];
    }

    /** Public display name of an ORCID record (used when inviting someone who never logged in). */
    public static function publicName(string $orcid): ?string
    {
        try {
            $res = self::http(self::pubApi() . '/' . rawurlencode($orcid) . '/person');
        } catch (\Throwable) {
            return null;
        }
        $d = json_decode($res, true);
        if (!is_array($d) || empty($d['name'])) return null;
        $credit = $d['name']['credit-name']['value'] ?? null;
        if ($credit) return $credit;
        $n = trim(($d['name']['given-names']['value'] ?? '') . ' ' . ($d['name']['family-name']['value'] ?? ''));
        return $n ?: null;
    }

    public static function isValid(string $orcid): bool
    {
        if (!preg_match('/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/', $orcid)) return false;
        // ISO 7064 11,2 checksum
        $digits = str_replace('-', '', $orcid);
        $total = 0;
        for ($i = 0; $i < 15; $i++) $total = ($total + (int)$digits[$i]) * 2;
        $check = (12 - $total % 11) % 11;
        return $digits[15] === ($check === 10 ? 'X' : (string)$check);
    }

    public static function normalize(string $s): string
    {
        $s = strtoupper(trim($s));
        $s = preg_replace('#^HTTPS?://(SANDBOX\.)?ORCID\.ORG/#', '', $s);
        return $s;
    }

    public static function http(string $url, ?array $post = null, array $headers = ['Accept: application/json']): string
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_USERAGENT => 'CollaborativeResearchPlatform/1.0',
        ]);
        if ($post !== null) {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($post));
        }
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($body === false || $code >= 400) throw new \RuntimeException("HTTP $code from $url");
        return (string)$body;
    }
}
