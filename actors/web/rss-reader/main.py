"""
An Actor in Python.

The whole contract is stdin and stdout: read a JSON input object from stdin,
print one JSON object per line to stdout. There is no SDK and nothing to
install — the server never needs to know this is Python.

    {"type": "item", "data": {...}}   a result row
    {"type": "log",  "message": "…"}  a log line
"""
import json
import os
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from datetime import timezone

NAMESPACES = {"atom": "http://www.w3.org/2005/Atom"}
TIMEOUT_SECS = 20


def ssl_context():
    """
    A verifying TLS context, whatever this machine happens to provide.

    A stock macOS python3 has no CA bundle configured and fails every HTTPS
    request with CERTIFICATE_VERIFY_FAILED. The fix is to point at a real
    bundle -- never to disable verification, which would turn a broken feed
    reader into a silent security hole.
    """
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass

    context = ssl.create_default_context()
    if context.cert_store_stats().get("x509_ca", 0) > 0:
        return context

    for bundle in ("/etc/ssl/cert.pem", "/usr/local/etc/openssl/cert.pem"):
        if os.path.exists(bundle):
            return ssl.create_default_context(cafile=bundle)

    raise RuntimeError(
        "no CA bundle found. Install certifi (pip install certifi), or on macOS "
        "run the 'Install Certificates.command' shipped with your Python."
    )


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(message):
    emit({"type": "log", "message": message})


def item(data):
    emit({"type": "item", "data": data})


def text_of(node, *paths):
    """First non-empty value among several possible tag names."""
    for path in paths:
        found = node.find(path, NAMESPACES)
        if found is not None:
            if found.text and found.text.strip():
                return found.text.strip()
            # Atom links carry their target in an attribute, not as text.
            href = found.get("href")
            if href:
                return href.strip()
    return None


def to_iso(raw):
    """Feeds mix RFC 822 (RSS) and ISO 8601 (Atom); normalise both."""
    if not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError):
        return raw.strip()


def read_feed(url, limit):
    request = urllib.request.Request(url, headers={"User-Agent": "openactors/0.1 (+rss-reader)"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECS, context=SSL_CONTEXT) as response:
        body = response.read()

    root = ET.fromstring(body)
    # RSS nests entries under channel/item; Atom puts them at the top level.
    entries = root.findall(".//item") or root.findall("atom:entry", NAMESPACES)

    count = 0
    for entry in entries[:limit]:
        item(
            {
                "feedUrl": url,
                "title": text_of(entry, "title", "atom:title"),
                "link": text_of(entry, "link", "atom:link"),
                "publishedAt": to_iso(text_of(entry, "pubDate", "atom:published", "atom:updated")),
                "summary": (text_of(entry, "description", "atom:summary", "atom:content") or "")[:1000] or None,
            }
        )
        count += 1
    return count


SSL_CONTEXT = None


def main():
    global SSL_CONTEXT
    SSL_CONTEXT = ssl_context()

    raw = sys.stdin.read()
    config = json.loads(raw) if raw.strip() else {}

    urls = config.get("feedUrls") or []
    limit = int(config.get("maxPerFeed", 20))

    if not urls:
        log("feedUrls is required")
        sys.exit(1)

    total = 0
    for url in urls:
        try:
            found = read_feed(url, limit)
            total += found
            log(f"{url} - {found} entry(s)")
        except Exception as error:
            # One unreachable or malformed feed must not lose the others.
            log(f"FAILED {url}: {type(error).__name__}: {error}")

    log(f"finished: {total} entry(s) from {len(urls)} feed(s)")


if __name__ == "__main__":
    main()
