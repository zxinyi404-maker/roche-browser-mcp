import base64
import os
from typing import Dict
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse


HOP_BY_HOP_HEADERS = {
    "accept-encoding",
    "connection",
    "content-encoding",
    "content-length",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
}

def split_list(value: str):
    return [item.strip() for item in str(value or "").replace("\n", ",").split(",") if item.strip()]


def allowed_origins():
    configured = split_list(os.getenv("ALLOWED_PROXY_ORIGINS", "*"))
    return configured or ["*"]


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)


def error_response(status: int, message: str):
    return JSONResponse(
        {"error": message},
        status_code=status,
        headers={"x-ai-proxy-error": "true"},
    )


def host_allowed(parsed) -> bool:
    allowed = split_list(os.getenv("ALLOWED_LLM_HOSTS", ""))
    if not allowed:
        return True
    return any(parsed.hostname == host or parsed.hostname.endswith(f".{host}") for host in allowed)


def path_allowed(parsed) -> bool:
    allowed = split_list(os.getenv("ALLOWED_LLM_PATHS", ""))
    if not allowed:
        return True
    return any(parsed.path.endswith(path) for path in allowed)


def sanitize_headers(headers: Dict[str, str]) -> Dict[str, str]:
    return {
        str(key): str(value)
        for key, value in (headers or {}).items()
        if str(key).lower() not in HOP_BY_HOP_HEADERS
    }


def sanitize_response_headers(headers) -> Dict[str, str]:
    return {
        str(key): str(value)
        for key, value in headers.items()
        if str(key).lower() not in HOP_BY_HOP_HEADERS
        and not str(key).lower().startswith("access-control-")
        and str(key).lower() != "vary"
    }


def decode_body(payload) -> bytes | str | None:
    body = payload.get("body")
    if body is None:
        return None
    if payload.get("bodyEncoding") == "base64":
        return base64.b64decode(str(body))
    return str(body)


@app.get("/")
async def health():
    return PlainTextResponse("AI CORS proxy is running.")


async def forward_upstream(method: str, target_url: str, headers: Dict[str, str], body=None):
    parsed = urlparse(target_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return error_response(400, "Invalid target URL")

    if not host_allowed(parsed):
        return error_response(403, "Target host is not allowed")

    if not path_allowed(parsed):
        return error_response(403, "Target path is not allowed")

    client = httpx.AsyncClient(timeout=None, follow_redirects=True)
    try:
        upstream_request = client.build_request(method, target_url, headers=headers, content=body)
        upstream = await client.send(upstream_request, stream=True)
    except Exception as exc:
        await client.aclose()
        return error_response(502, str(exc))

    async def stream_body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        stream_body(),
        status_code=upstream.status_code,
        headers=sanitize_response_headers(upstream.headers),
        media_type=upstream.headers.get("content-type"),
    )


@app.post("/proxy")
async def proxy(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return error_response(400, "Invalid JSON payload")

    target_url = str(payload.get("url") or "")
    method = str(payload.get("method") or "GET").upper()
    body = None if method in {"GET", "HEAD"} else decode_body(payload)
    headers = sanitize_headers(payload.get("headers") or {})

    return await forward_upstream(method, target_url, headers, body)


async def novelai_mirror(request: Request, upstream_host: str, upstream_path: str):
    target_url = f"https://{upstream_host}/{upstream_path}"
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    method = request.method.upper()
    body = None if method in {"GET", "HEAD"} else await request.body()
    headers = sanitize_headers(dict(request.headers))

    return await forward_upstream(method, target_url, headers, body)


@app.api_route("/user/{upstream_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
async def novelai_user(request: Request, upstream_path: str):
    return await novelai_mirror(request, "api.novelai.net", f"user/{upstream_path}")


@app.api_route("/ai/{upstream_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
async def novelai_ai(request: Request, upstream_path: str):
    return await novelai_mirror(request, "image.novelai.net", f"ai/{upstream_path}")


@app.api_route("/proxy/user/{upstream_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
async def proxied_novelai_user(request: Request, upstream_path: str):
    return await novelai_mirror(request, "api.novelai.net", f"user/{upstream_path}")


@app.api_route("/proxy/ai/{upstream_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
async def proxied_novelai_ai(request: Request, upstream_path: str):
    return await novelai_mirror(request, "image.novelai.net", f"ai/{upstream_path}")
