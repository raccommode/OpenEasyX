"""Exercise the real Chromium/CDP favorites helper against a local account fixture."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


HELPER = os.environ.get("EASYX_BROWSER_FETCH_SCRIPT", str(Path(__file__).with_name("easyx-browser-fetch.py")))


class FavoritesBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.TemporaryDirectory(prefix="easyx-browser-account-test-")
        cls.cookies = str(Path(cls.root.name) / "cookies.txt")
        Path(cls.cookies).write_text("# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\tsessionId\tfixture-session\n")
        cls.mode = "modern"
        cls.requests = []

        class AccountPage(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                path = urlparse(self.path)
                cls.requests.append(path.path)
                if path.path == "/room":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.end_headers()
                    self.wfile.write(b'<!doctype html><script>fetch("/stream.m3u8")</script>')
                    return
                if path.path == "/favorites":
                    state = '<script>window.__PRELOADED_STATE__={userSession:{currentUser:{id:77}}}</script>' if cls.mode == "legacy" else ""
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.end_headers()
                    self.wfile.write(("<!doctype html><html><body>Favorites" + state + "</body></html>").encode())
                    return
                if "sessionId=fixture-session" not in self.headers.get("Cookie", ""):
                    self.send_response(401)
                    self.end_headers()
                    return
                if path.path.endswith("initial-dynamic"):
                    payload = {"initialDynamic": {"user": None if cls.mode == "expired" else {"id": 77, "username": "viewer"}}}
                elif path.path == "/api/front/users/77/favorites":
                    payload = {"modelIds": [] if cls.mode == "empty" else list(range(1, 202)) if cls.mode == "large" else [11, 12]}
                elif path.path == "/api/front/models/list":
                    ids = parse_qs(path.query)["modelIds"][0].split(",")
                    payload = {"error": "blocked"} if cls.mode == "malformed" else {"models": [{"id": int(value), "username": "Creator" + value, "status": "offline"} for value in ids]}
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), AccountPage)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.root.cleanup()

    def read(self, mode):
        type(self).mode = mode
        type(self).requests = []
        return subprocess.run([sys.executable, HELPER, "--stripchat-favorites", self.cookies],
                              env={**os.environ, "EASYX_STRIPCHAT_FAVORITES_URL": f"http://127.0.0.1:{self.server.server_port}/favorites"},
                              capture_output=True, text=True, timeout=30, check=False)

    def test_capture_media_with_an_unwritable_home(self):
        base = f"http://127.0.0.1:{self.server.server_port}"
        result = subprocess.run([sys.executable, HELPER, "--capture-media", base + "/room"],
                                env={**os.environ, "HOME": "/root"}, capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["url"], base + "/stream.m3u8")

    def test_modern_account_uses_imported_cookies_and_dynamic_identity(self):
        result = self.read("modern")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertTrue(data["loggedIn"])
        self.assertEqual(data["userId"], 77)
        self.assertEqual(data["modelIds"], [11, 12])
        self.assertEqual(len(data["models"]), 2)
        self.assertIn("/api/front/v3/config/initial-dynamic", self.requests)

    def test_legacy_page_state(self):
        result = self.read("legacy")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["userId"], 77)

    def test_authenticated_empty_list(self):
        result = self.read("empty")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["models"], [])

    def test_expired_account_is_not_an_empty_favorites_list(self):
        result = self.read("expired")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not signed in", result.stderr)

    def test_malformed_model_details_fail_without_clearing_favorites(self):
        result = self.read("malformed")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("model details", result.stderr)

    def test_every_batch_of_a_large_favorite_list_is_imported(self):
        result = self.read("large")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(len(data["models"]), 201)
        self.assertEqual(self.requests.count("/api/front/models/list"), 3)


if __name__ == "__main__":
    unittest.main()
