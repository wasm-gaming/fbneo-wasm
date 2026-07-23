#!/usr/bin/env python3
"""Static preview server with COOP/COEP headers for local WebAssembly testing."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class CoopCoepHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve static files with COOP/COEP headers for local preview."
    )
    parser.add_argument("--port", type=int, default=8080, help="Port to bind to (default: 8080)")
    parser.add_argument(
        "--directory",
        type=Path,
        default=Path("dist"),
        help="Directory to serve (default: dist)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    directory = args.directory.resolve()

    if not directory.is_dir():
        raise SystemExit(f"preview-server: directory does not exist: {directory}")

    handler = partial(CoopCoepHandler, directory=str(directory))
    server = ThreadingHTTPServer(("", args.port), handler)
    print(f"Serving {directory} at http://localhost:{args.port} (Ctrl+C to stop)")
    server.serve_forever()


if __name__ == "__main__":
    main()
