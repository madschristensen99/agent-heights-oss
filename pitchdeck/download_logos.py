#!/usr/bin/env python3
"""Download brand logos for the Agent Heights pitch deck."""

import os
import urllib.request

LOGOS = {
    # Direct URLs — these work with a simple GET
    "solana.svg": "https://cryptach.org/crypto-logo/solanaLogoMark.svg",
    "solana.png": "https://cryptach.org/crypto-logo/solana-sol-logo.png",
    "jupiter.svg": "https://cryptologo.org/icon/jupiter/jupiter.svg",
    "jupiter.png": "https://cryptologo.org/icon/jupiter/jupiter-512.png",
    "raydium.svg": "https://cryptologo.org/icon/raydium/raydium.svg",
    "raydium.png": "https://cryptologo.org/icon/raydium/raydium-512.png",
    "okx.svg": "https://commons.wikimedia.org/wiki/Special:FilePath/OKX_Logo.svg",
    "polymarket-blue.png": "https://polymarket.com/images/brand/logo-blue.png",
    "polymarket-icon-blue.png": "https://polymarket.com/images/brand/icon-blue.png",
    "polymarket-icon-black.png": "https://polymarket.com/images/brand/icon-black.png",
    "clawpump.png": "https://clawpumpsol.com/assets/clawlogo-CvZzu5Oo.png",
    "crossmint.png": "https://www.crossmint.com/assets/crossmint/logo.png",
    "coinbase.svg": "https://commons.wikimedia.org/wiki/Special:FilePath/Coinbase.svg",
}

# These require manual download (zip files, gitbook redirects, etc.)
MANUAL = {
    "Drift + Zeta": "https://docs.zeta.markets/build-with-zeta/brand-assets/logo-and-visual-guidelines",
    "Phantom": "https://docs.phantom.com/resources/assets",
    "Coinbase CDP": "https://github.com/cdp-organization/brand-kit",
    "PulseMCP": "https://www.pulsemcp.com (right-click logo on site)",
    "pump.fun": "https://brandlogos.net/pump-fun-113166.html",
}

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logos")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    success = []
    failed = []

    for filename, url in LOGOS.items():
        path = os.path.join(OUT_DIR, filename)
        try:
            print(f"  Downloading {filename}...")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                if len(data) < 100:
                    raise ValueError(f"Response too small ({len(data)} bytes), probably an error page")
                with open(path, "wb") as f:
                    f.write(data)
                print(f"    OK — {len(data)} bytes -> {path}")
                success.append(filename)
        except Exception as e:
            print(f"    FAILED — {e}")
            failed.append((filename, str(e)))

    print(f"\n=== Results ===")
    print(f"Downloaded: {len(success)}")
    for s in success:
        print(f"  - logos/{s}")

    if failed:
        print(f"\nFailed: {len(failed)}")
        for name, err in failed:
            print(f"  - {name}: {err}")

    print(f"\n=== Manual downloads needed ===")
    for name, url in MANUAL.items():
        print(f"  {name}: {url}")
    print(f"\nPut manually downloaded files in: {OUT_DIR}/")


if __name__ == "__main__":
    main()
