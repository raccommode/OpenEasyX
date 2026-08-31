#!/opt/easyx/bin/python
"""Fetch or render a public HTML page with the browser tooling bundled in EasyX."""

import os
import asyncio
import json
import re
import socket
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode
from curl_cffi import requests
from websockets.asyncio.client import connect


MEDIA_URL_RE = re.compile(
    r"https?://[^\s'\"<>\\]+?(?:\.m3u8|\.mpd)(?:\?[^\s'\"<>\\]*)?",
    re.IGNORECASE,
)


def rendered_html(url: str) -> str:
    executable = next(
        (value for value in (shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome")) if value),
        None,
    )
    if not executable:
        raise RuntimeError("Chromium is not installed")
    with tempfile.TemporaryDirectory(prefix="easyx-render-") as profile:
        result = subprocess.run(
            [
                executable,
                "--headless=new",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-background-networking",
                "--hide-scrollbars",
                "--window-size=1440,1200",
                "--virtual-time-budget=7000",
                f"--user-data-dir={profile}",
                "--dump-dom",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=75,
            env={**os.environ, "LANG": "en_US.UTF-8"},
            check=False,
        )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(result.stderr.strip()[-1000:] or f"Chromium exited with code {result.returncode}")
    return result.stdout


def myfreecams_models(page: int, search: str) -> str:
    """Load the public, online-only Model Explorer through its browser session."""
    session = requests.Session(impersonate="chrome")
    explorer_url = "https://www.myfreecams.com/php/model_explorer.php?explore_by=bio"
    landing = session.get(
        explorer_url,
        timeout=45,
        allow_redirects=True,
        headers={"Accept-Language": "en-US,en;q=0.8"},
    )
    if landing.status_code >= 400:
        raise RuntimeError(f"MyFreeCams Model Explorer returned HTTP {landing.status_code}")
    query = urlencode(
        {
            "get_contents": "1",
            "selected_field": "room_topic",
            "sort": "cam_score",
            "selection": "all",
            "search": search,
            "mode": "",
            "page": str(max(1, page)),
            "night_mode": "0",
        }
    )
    response = session.get(
        f"https://www.myfreecams.com/php/model_explorer.php?{query}",
        timeout=45,
        allow_redirects=True,
        headers={
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.8",
            "Referer": explorer_url,
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    if response.status_code >= 400:
        raise RuntimeError(f"MyFreeCams live models returned HTTP {response.status_code}")
    if not response.text.strip() or response.text.strip() == "0":
        raise RuntimeError("MyFreeCams returned an empty live model catalogue")
    return response.text


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _media_urls(value: str) -> list[str]:
    decoded = value.replace("\\/", "/").replace("\\u0026", "&")
    return [
        candidate for match in MEDIA_URL_RE.finditer(decoded)
        if "ping.m3u8" not in (candidate := match.group(0).rstrip(".,);]")).lower()
    ]


def _netscape_cookies(filename: str | None) -> list[dict[str, object]]:
    if not filename:
        return []
    cookies: list[dict[str, object]] = []
    with open(filename, encoding="utf-8") as source:
        for raw_line in source:
            line = raw_line.strip()
            if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
                continue
            values = line.split("\t")
            if len(values) < 7:
                continue
            domain, _include_subdomains, cookie_path, secure, expires, name, value = values[:7]
            domain = domain.removeprefix("#HttpOnly_")
            cookie: dict[str, object] = {
                "name": name, "value": value, "domain": domain,
                "path": cookie_path or "/", "secure": secure.upper() == "TRUE",
            }
            try:
                expiry = int(expires)
                if expiry > 0:
                    cookie["expires"] = expiry
            except ValueError:
                pass
            cookies.append(cookie)
    return cookies


async def _capture_media_cdp(websocket_url: str, url: str, timeout_seconds: int, saved_cookies: list[dict[str, object]]) -> dict[str, object]:
    found: list[str] = []
    final_url = url
    message_id = 0

    def remember(value: object) -> None:
        if not isinstance(value, str):
            return
        for candidate in _media_urls(value):
            if candidate not in found:
                found.append(candidate)

    async with connect(websocket_url, origin=None, max_size=16 * 1024 * 1024) as websocket:
        pending: dict[int, asyncio.Future] = {}

        def process_event(message: dict[str, object]) -> None:
            nonlocal final_url
            event = message.get("method")
            values = message.get("params") or {}
            if event == "Network.requestWillBeSent":
                remember((values.get("request") or {}).get("url"))
            elif event == "Network.responseReceived":
                remember((values.get("response") or {}).get("url"))
            elif event == "Network.webSocketFrameReceived":
                remember((values.get("response") or {}).get("payloadData"))
            elif event == "Page.frameNavigated":
                final_url = (values.get("frame") or {}).get("url") or final_url

        async def receive_messages() -> None:
            while True:
                message = json.loads(await websocket.recv())
                response_id = message.get("id")
                if isinstance(response_id, int) and response_id in pending:
                    future = pending.pop(response_id)
                    if not future.done():
                        future.set_result(message)
                else:
                    process_event(message)

        async def command(method: str, params: dict[str, object] | None = None) -> dict[str, object]:
            nonlocal message_id
            message_id += 1
            expected = message_id
            future = asyncio.get_running_loop().create_future()
            pending[expected] = future
            await websocket.send(json.dumps({"id": expected, "method": method, "params": params or {}}))
            try:
                return await asyncio.wait_for(future, timeout=15)
            finally:
                pending.pop(expected, None)

        receiver = asyncio.create_task(receive_messages())
        try:
            await command("Network.enable")
            if saved_cookies:
                await command("Network.setCookies", {"cookies": saved_cookies})
            await command("Page.enable")
            try:
                await command("Page.navigate", {"url": url})
            except asyncio.TimeoutError:
                pass
            started = time.monotonic()
            deadline = time.monotonic() + timeout_seconds
            next_interaction = time.monotonic() + 2
            while time.monotonic() < deadline and (not found or time.monotonic() - started < 6):
                if time.monotonic() >= next_interaction:
                    try:
                        await asyncio.wait_for(command(
                            "Runtime.evaluate",
                            {
                                "expression": """(() => {
                                  const labels = /accept|agree|allow|continue|enter|watch|play|i am over|18/i;
                                  for (const el of document.querySelectorAll('button,[role=button],a')) {
                                    if (labels.test((el.innerText || el.textContent || '').trim())) { try { el.click(); } catch {} }
                                  }
                                  for (const video of document.querySelectorAll('video')) { video.muted = true; video.play().catch(() => {}); }
                                  return location.href;
                                })()""",
                                "returnByValue": True,
                            },
                        ), timeout=3)
                    except asyncio.TimeoutError:
                        pass
                    next_interaction = time.monotonic() + 2
                await asyncio.sleep(0.25)
            try:
                cookies_response = await asyncio.wait_for(command("Network.getAllCookies"), timeout=3)
                cookies = ((cookies_response.get("result") or {}).get("cookies") or [])
            except asyncio.TimeoutError:
                cookies = []
            cookie_header = "; ".join(
                f"{cookie.get('name')}={cookie.get('value')}" for cookie in cookies
                if cookie.get("name") and cookie.get("value") is not None
            )
            preferred = next((item for item in found if ".m3u8" in item.lower()), found[0] if found else "")
            return {"url": preferred, "pageUrl": final_url if final_url != "about:blank" else url, "cookie": cookie_header}
        finally:
            receiver.cancel()
            try:
                await receiver
            except asyncio.CancelledError:
                pass


def captured_media(url: str, cookies_file: str | None = None) -> str:
    executable = next(
        (value for value in (shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome")) if value),
        None,
    )
    if not executable:
        raise RuntimeError("Chromium is not installed")
    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="easyx-capture-", ignore_cleanup_errors=True) as profile:
        process = subprocess.Popen(
            [
                executable,
                "--headless=new",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--autoplay-policy=no-user-gesture-required",
                "--remote-allow-origins=*",
                f"--remote-debugging-port={port}",
                f"--user-data-dir={profile}",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "LANG": "en_US.UTF-8"},
        )
        try:
            page = None
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    response = requests.get(f"http://127.0.0.1:{port}/json/list", timeout=1)
                    pages = response.json()
                    page = next((item for item in pages if item.get("type") == "page"), None)
                    if page:
                        break
                except Exception:
                    time.sleep(0.1)
            if not page or not page.get("webSocketDebuggerUrl"):
                raise RuntimeError("Chromium debugging page did not start")
            result = asyncio.run(_capture_media_cdp(page["webSocketDebuggerUrl"], url, 25, _netscape_cookies(cookies_file)))
            if not result.get("url"):
                raise RuntimeError("No public HLS or DASH stream was captured")
            return json.dumps(result, ensure_ascii=False)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


async def _stripchat_favorite_cdp(
    websocket_url: str,
    url: str,
    cookies: list[dict[str, object]],
    model_id: int,
    follow: bool,
) -> dict[str, object]:
    message_id = 0
    favorite_statuses: list[int] = []
    request_methods: dict[str, str] = {}
    async with connect(websocket_url, origin=None, max_size=16 * 1024 * 1024) as websocket:
        pending: dict[int, asyncio.Future] = {}

        async def receive_messages() -> None:
            while True:
                message = json.loads(await websocket.recv())
                response_id = message.get("id")
                if isinstance(response_id, int) and response_id in pending:
                    future = pending.pop(response_id)
                    if not future.done():
                        future.set_result(message)
                    continue
                if message.get("method") == "Network.requestWillBeSent":
                    params = message.get("params") or {}
                    request = params.get("request") or {}
                    request_methods[str(params.get("requestId") or "")] = str(request.get("method") or "").upper()
                elif message.get("method") == "Network.responseReceived":
                    params = message.get("params") or {}
                    response = params.get("response") or {}
                    response_url = str(response.get("url") or "")
                    request_method = request_methods.get(str(params.get("requestId") or ""), "")
                    if request_method in {"PUT", "DELETE"} and "/api/front/users/" in response_url and "/favorites" in response_url:
                        favorite_statuses.append(int(response.get("status") or 0))

        async def command(method: str, params: dict[str, object] | None = None) -> dict[str, object]:
            nonlocal message_id
            message_id += 1
            future = asyncio.get_running_loop().create_future()
            pending[message_id] = future
            await websocket.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
            try:
                return await asyncio.wait_for(future, timeout=15)
            finally:
                pending.pop(message_id, None)

        async def evaluate(expression: str) -> object:
            response = await command("Runtime.evaluate", {
                "expression": expression, "returnByValue": True, "awaitPromise": True,
            })
            result = ((response.get("result") or {}).get("result") or {})
            if result.get("subtype") == "error":
                raise RuntimeError(str(result.get("description") or "Stripchat browser action failed"))
            return result.get("value")

        receiver = asyncio.create_task(receive_messages())
        try:
            await command("Network.enable")
            await command("Network.setCookies", {"cookies": cookies})
            await command("Page.enable")
            await command("Page.navigate", {"url": url})
            inspect = f"""(() => {{
              const state = (() => {{ try {{ return window.getState && window.getState(); }} catch {{ return null; }} }})();
              const ids = state?.favorites?.favoriteIds;
              const pageModel = state?.viewCam?.model || state?.viewCam?.user || state?.viewCam?.item;
              const resolvedModelId = Number({model_id}) || Number(pageModel?.id || pageModel?.streamName || 0);
              const selectors = ['[data-testid*="favorite" i]','[data-test*="favorite" i]','[aria-label*="favorite" i]','[aria-label*="favourite" i]','[title*="favorite" i]','[title*="favourite" i]'];
              const elements = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
              const buttons = [...new Set(elements.map(element => element.closest('button,[role="button"],a') || element))];
              const descriptions = buttons.map(element => `${{element.getAttribute('aria-label') || ''}} ${{element.getAttribute('title') || ''}} ${{element.getAttribute('data-testid') || ''}} ${{element.innerText || element.textContent || ''}}`.toLowerCase());
              const uiCurrent = descriptions.some(label => /remove|delete|unfavorite|unfavourite/.test(label))
                ? true : descriptions.some(label => /add\\s+(?:to\\s+)?favou?rites?|favou?rite/.test(label)) ? false : null;
              return {{
                loggedIn: Boolean(state?.userSession?.currentUser?.id),
                modelId: resolvedModelId,
                current: Array.isArray(ids) && resolvedModelId ? ids.map(Number).includes(resolvedModelId) : uiCurrent,
                candidates: buttons.map((element, index) => ({{
                  index, aria: element.getAttribute('aria-label') || '', title: element.getAttribute('title') || '',
                  testid: element.getAttribute('data-testid') || element.getAttribute('data-test') || '',
                  text: (element.innerText || element.textContent || '').trim().replace(/\\s+/g,' ').slice(0,120),
                  pressed: element.getAttribute('aria-pressed'), disabled: Boolean(element.disabled)
                }}))
              }};
            }})()"""
            clicked = False
            last: dict[str, object] = {}
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                value = await evaluate(inspect)
                last = value if isinstance(value, dict) else {}
                if last.get("current") is follow:
                    return {"success": True, "favorite": follow, "modelId": last.get("modelId")}
                if not clicked and last.get("candidates"):
                    clicked = bool(await evaluate(f"""(() => {{
                      const desired = {str(follow).lower()};
                      const selectors = ['[data-testid*="favorite" i]','[data-test*="favorite" i]','[aria-label*="favorite" i]','[aria-label*="favourite" i]','[title*="favorite" i]','[title*="favourite" i]'];
                      const elements = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
                      const buttons = [...new Set(elements.map(element => element.closest('button,[role="button"],a') || element))];
                      const description = element => `${{element.getAttribute('aria-label') || ''}} ${{element.getAttribute('title') || ''}} ${{element.getAttribute('data-testid') || ''}} ${{element.innerText || element.textContent || ''}}`.toLowerCase();
                      const target = buttons.find(element => {{
                        const label = description(element);
                        const removes = /remove|delete|unfavorite|unfavourite/.test(label) || element.getAttribute('aria-pressed') === 'true';
                        return !element.disabled && /favou?rite/.test(label) && (desired ? !removes : removes);
                      }});
                      if (!target) return false;
                      target.click(); return true;
                    }})()"""))
                if clicked and favorite_statuses:
                    status = favorite_statuses[-1]
                    if status < 200 or status >= 300:
                        raise RuntimeError(f"Stripchat favorite request returned HTTP {status}")
                    return {"success": True, "favorite": follow, "modelId": last.get("modelId")}
                await asyncio.sleep(0.5)
            labels = [
                " | ".join(str(candidate.get(key) or "") for key in ("aria", "title", "testid", "text")).strip(" |")
                for candidate in (last.get("candidates") or [])[:6] if isinstance(candidate, dict)
            ]
            raise RuntimeError("Stripchat favorite control was not confirmed" + (f" ({'; '.join(labels)})" if labels else ""))
        finally:
            receiver.cancel()
            try:
                await receiver
            except asyncio.CancelledError:
                pass


def stripchat_favorite(url: str, cookies_file: str, model_id: int, follow: bool) -> str:
    executable = next((value for value in (shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome")) if value), None)
    if not executable:
        raise RuntimeError("Chromium is not installed")
    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="easyx-stripchat-favorite-", ignore_cleanup_errors=True) as profile:
        process = subprocess.Popen([
            executable, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
            "--remote-allow-origins=*", f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "LANG": "en_US.UTF-8"})
        try:
            page = None
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    pages = requests.get(f"http://127.0.0.1:{port}/json/list", timeout=1).json()
                    page = next((item for item in pages if item.get("type") == "page"), None)
                    if page:
                        break
                except Exception:
                    time.sleep(0.1)
            if not page or not page.get("webSocketDebuggerUrl"):
                raise RuntimeError("Chromium debugging page did not start")
            result = asyncio.run(_stripchat_favorite_cdp(page["webSocketDebuggerUrl"], url, _netscape_cookies(cookies_file), model_id, follow))
            return json.dumps(result, ensure_ascii=False)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def main() -> int:
    render = len(sys.argv) == 3 and sys.argv[1] == "--render"
    mfc_models = len(sys.argv) in (3, 4) and sys.argv[1] == "--mfc-models"
    capture_media = len(sys.argv) in (3, 4) and sys.argv[1] == "--capture-media"
    stripchat_favorite_action = len(sys.argv) == 6 and sys.argv[1] == "--stripchat-favorite"
    if not render and not mfc_models and not capture_media and not stripchat_favorite_action and len(sys.argv) != 2:
        print("usage: easyx-browser-fetch [--render|--capture-media] URL | --mfc-models PAGE [SEARCH] | --stripchat-favorite URL COOKIES MODEL_ID follow|unfollow", file=sys.stderr)
        return 2
    try:
        if stripchat_favorite_action:
            if sys.argv[5] not in {"follow", "unfollow"}:
                raise RuntimeError("Stripchat favorite action must be follow or unfollow")
            content = stripchat_favorite(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5] == "follow")
        elif mfc_models:
            content = myfreecams_models(int(sys.argv[2]), sys.argv[3] if len(sys.argv) == 4 else "")
        elif capture_media:
            content = captured_media(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
        elif render:
            content = rendered_html(sys.argv[2])
        else:
            response = requests.get(
                sys.argv[1],
                impersonate="chrome",
                timeout=45,
                allow_redirects=True,
                headers={"Accept-Language": "en-US,en;q=0.8"},
            )
            if response.status_code >= 400:
                print(f"Remote site returned HTTP {response.status_code}", file=sys.stderr)
                return 1
            content = response.text
    except Exception as error:
        print(f"Browser-compatible request failed: {error}", file=sys.stderr)
        return 1
    lowered = content[:12000].lower()
    if "cf-chl-" in lowered or "<title>just a moment" in lowered:
        print("Remote site presented a Cloudflare challenge", file=sys.stderr)
        return 1
    sys.stdout.write(content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
