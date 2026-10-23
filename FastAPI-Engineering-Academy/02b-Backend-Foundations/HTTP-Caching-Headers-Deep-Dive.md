---
title: "Lesson 09: HTTP Caching Headers Deep Dive"
aliases:
 - HTTP Caching Headers Deep Dive
 - Cache-Control
 - ETag
 - If-None-Match
 - Vary
 - Surrogate-Control
 - Cache-Status
 - stale-while-revalidate
tags:
 - http
 - caching
 - headers
 - cdn
 - canonical
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "75–100 minutes"
prerequisites:
 - "[[HTTP-Headers-Deep-Dive]]"
 - "[[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]]"
 - "[[Content-Negotiation]]"
 - "[[02-Web-and-HTTP/Methods-Status-Headers-Content-Types]]"
related_lessons:
 - "[[Health-Checks-and-Probes]]"
 - "[[Pagination-Deep-Dive]]"
 - "[[Problem-Details-RFC-7807]]"
 - "[[14-Caching-and-Background-Processing/Redis-Cache-Aside]]"
 - "[[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]]"
first_taught_in: "02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive"
---

# Lesson 09: HTTP Caching Headers Deep Dive

*The headers that decide which layer caches what — `Cache-Control`, `ETag`, `Vary`, `Surrogate-Control`, `Cache-Status` — and the one mistake that leaks one user's data into another's response.*

**You shipped `Boardly` behind Cloudflare. Now the cache layers multiply.**

The browser has a cache. Cloudflare has a cache. Your Varnish or Nginx has a cache. Maybe `Boardly` itself has a Redis cache-aside layer. Each layer reads *the same* set of HTTP caching headers and decides independently whether to store the response, for how long, and whether to serve it to the next requester. Get the headers right and a 200 ms database query becomes a 20 ms cache hit on every continent. Get them wrong and the third user on a shared CDN edge sees the first user's `/projects/123` response — including that user's private notes field. Today we go through every caching directive, every validator header, every CDN-only knob, and the `Vary: Authorization` poisoning attack that production teams hit roughly once a quarter.


#http #caching #headers #cdn #canonical

## Learning Objectives

By the end of this lesson you will be able to:

1. **State every `Cache-Control` directive** — `public`, `private`, `no-cache`, `no-store`, `max-age`, `s-maxage`, `stale-while-revalidate`, `stale-if-error`, `must-revalidate`, `proxy-revalidate`, `immutable`, `no-transform` — and explain what each layer (browser, CDN, origin) does with it.
2. **Distinguish strong vs weak `ETag`** — the `W/` prefix and why weak validators exist.
3. **Implement a conditional GET** that honours `If-None-Match`, `If-Modified-Since`, `If-Match`, and `If-Unmodified-Since`.
4. **Explain why `Vary: Authorization` matters so much** — the shared-cache poisoning attack it prevents and the request-coalescing problem it creates.
5. **Use `Surrogate-Control`** to talk to the CDN without leaking cache directives to the browser.
6. **Read a `Cache-Status` (RFC 9211) response header** and explain which cache layer served the response.
7. **State why `Warning` was deprecated in RFC 9211** and what replaces it.
8. **Ship a `GET /projects/{id}` endpoint** in `Boardly` that emits CDN-friendly cache headers and handles `If-None-Match` correctly.

## Prerequisites

Before starting, you need:

- **Lesson 1 of this section** — [[HTTP-Headers-Deep-Dive]]. You should know what request vs response headers are and how Starlette reads them.
- **The intro caching lesson** — [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]]. That lesson introduces `no-cache`, `no-store`, `max-age`, `must-revalidate`, `public`/`private`, `immutable`, `ETag`, `If-None-Match`, and `Vary: Origin`. This lesson goes *deeper* — it covers the directives the intro lesson skipped because they only matter once a CDN is in front of the app.
- **Content negotiation** — [[Content-Negotiation]]. `Vary` and content negotiation are inseparable; you should already know what `Accept` does.
- **About an hour and a half.** The number of directives is small but the interactions between layers are not. Read slowly.
- **FastAPI 0.148.0, Starlette 1.9.0, Pydantic v2.14.1, Python 3.12** — verified October 2026.

**The three RFCs that govern this lesson.**

- **RFC 9110** — HTTP Semantics — the canonical reference for `Cache-Control`, `ETag`, `Vary`, conditional request headers.
- **RFC 9111** — HTTP Caching — the canonical reference for what caches may and may not do, when they must revalidate, and what `Age` means.
- **RFC 9211** — The Cache-Status HTTP Response Header Field (2022) — the modern way for an origin to see *which* cache layer served a response.
The deprecated `Warning` header (RFC 7234 §5.5) was obsoleted by RFC 9211. We cover both because you'll see `Warning` in old logs for years.


## The Problem

Here is the cache headers set on a typical `Boardly` endpoint before this lesson:

```
Cache-Control: no-cache
```

That's it. One directive. The browser is told "you may store this, but you must revalidate with the origin before using it." That's safe — no user gets another user's data — but it is also leaving enormous performance on the table. The CDN in front of your origin revalidates on every request, the database gets hit on every request, and your p99 latency is dominated by a `SELECT` that did not need to run.

So a well-meaning engineer reads the docs and ships:

```
Cache-Control: public, max-age=60
```

That's faster. It is also a footgun. Two problems:

1. **The browser and the CDN see the same `max-age=60`.** You probably wanted the CDN to cache for 60 seconds but the browser to cache for 0 (so a hard refresh always revalidates). You got "browser caches for 60s" instead.
2. **`/projects/{id}` is per-user.** A project includes a `notes` field that only the owner can see. With `public, max-age=60`, the CDN caches Alice's response under the cache key `GET /projects/123`, and Bob's next request gets Alice's response — including the private notes field.

The fix is not "remove caching" — it's "use the right directive at the right layer." This lesson is the directive-by-directive map.

**Why is `no-cache` not the same as `no-store`?**

Because they answer different questions. `no-cache` says "you may store this, but you must revalidate before using it." `no-store` says "you may not store this at all." A `no-cache` response can still be served from cache after a 304 — saving the bytes, the bandwidth, and the parsing cost. A `no-store` response cannot. The first is for content that changes unpredictably but is cheap to revalidate (an `ETag` round-trip). The second is for content that must never touch a cache (a bank account balance, a one-time token, a freshly-issued session ID). Confusing them either leaks freshness (using `no-cache` when you meant `no-store`) or wastes bandwidth (using `no-store` when `no-cache` would have done). Always ask: "do I want to forbid storing, or forbid serving-stale-without-revalidating?"


## The Code

`Boardly` gets a new `GET /projects/{id}` endpoint that:

- Emits `Cache-Control: private, max-age=0, s-maxage=60, stale-while-revalidate=300` (browser revalidates, CDN caches for 60s with a 5-minute stale-serve window).
- Computes a weak `ETag` from the project's `updated_at` timestamp.
- Handles `If-None-Match` and returns `304 Not Modified` on a match.
- Sets `Vary: Authorization` so the CDN maintains separate cache entries per user.
- Sets `Surrogate-Control: max-age=60` for the CDN (stripped before reaching the browser) and a separate `Cache-Control` for the browser.
- Sets `Cache-Status: "Boardly"; hit; ttl=42` (RFC 9211) so the client can see which layer served it.

```python
# boardly/routers/projects_cache.py
"""Boardly — caching-aware GET /projects/{id}.

Lesson 02b-9: shows every caching header working together.
The browser is told to revalidate; the CDN is told to cache
for 60s with a 5-minute stale-while-revalidate window. The
response carries a weak ETag and supports If-None-Match.
"""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, Response, status
from pydantic import BaseModel

router = APIRouter(prefix="/projects", tags=["projects"])


class Project(BaseModel):
 id: int
 name: str
 notes: str          # per-user private field
 updated_at: datetime


# A pretend store. In the real Boardly, this is a SQLAlchemy select().
_PROJECTS: dict[int, Project] = {
 1: Project(id=1, name="alpha", notes="alice's notes", updated_at=datetime(2026, 10, 19, 9, 0, 0, tzinfo=UTC)),
 2: Project(id=2, name="beta",  notes="alice's notes",  updated_at=datetime(2026, 10, 19, 9, 5, 0, tzinfo=UTC)),
}


def _weak_etag(p: Project) -> str:
 """Compute a weak ETag: W/<hex of updated_at + id>.

 Weak validators allow the cache to say "the body is semantically
 equivalent" even if bytes differ (e.g. different whitespace in JSON).
 Strong ETags require byte-for-byte equivalence.
 """
 # In real code, hash the serialised representation. We hash the
 # semantic identity (id + updated_at) for the demo.
 digest = hashlib.sha256(f"{p.id}:{p.updated_at}".encode()).hexdigest()[:16]
 return f'W/"{digest}"'


def _cache_headers(p: Project) -> dict[str, str]:
 """Build the full cache-header set for a project response.

 The directives are grouped by which cache layer they target:
 - Browser-facing (Cache-Control): `private` + `max-age=0` so the
   browser stores the response but revalidates before use.
 - CDN-facing (Surrogate-Control + s-maxage): the CDN caches a
   shared copy for 60s with a 5-minute stale-while-revalidate
   window. `Surrogate-Control` is non-standard but honoured by
   Cloudflare/Fastly/Vercel/Akamai and stripped before forwarding
   to the browser; `s-maxage` is the RFC 9111 standardised form.
   See the `**Note**` callout below for why both are set and how
   they compose with `private`.
 """
 return {
 # --- browser-facing directive ---
 # `private` + `max-age=0` is a SEPARATE cache namespace from the
 # CDN's `Surrogate-Control` / `s-maxage` directive. The browser
 # is told to store, but revalidate before use; the CDN is told
 # to cache for 60s. They compose cleanly because each directive
 # targets a different cache layer — see the callout below.
 "Cache-Control": (
 "private, max-age=0, stale-while-revalidate=0, s-maxage=60"
 ),
 # --- CDN-facing directive (Surrogate-Control is stripped by the
 # CDN before forwarding to the browser; the browser never sees it).
 # We set both Surrogate-Control and s-maxage (the latter inside
 # Cache-Control above) for portability across Cloudflare, Fastly,
 # and Vercel's edge.
 "Surrogate-Control": "max-age=60, stale-while-revalidate=300",
 # --- validators ---
 "ETag": _weak_etag(p),
 # --- Vary: Authorization ---
 # Without this, the CDN caches Alice's response under
 # "GET /projects/1" and serves it to Bob. With it, the CDN keys
 # the cache on (URL, Authorization header) — but only when the
 # Authorization value is stable per user. For per-session JWT
 # auth, every JWT is unique, so the CDN effectively caches
 # nothing — see the `**Warning —**` callout below.
 "Vary": "Authorization",
 # --- Cache-Status (RFC 9211) ---
 # Tells the client which cache layer served the response.
 "Cache-Status": '"Boardly-Origin"; miss',
 }


**`Surrogate-Control` is a SEPARATE cache namespace from `Cache-Control: private`.**

The directives compose cleanly because each targets a different cache
layer. `Cache-Control: private` instructs *browser caches* that the
response is per-user and must not be served to other users; it also
instructs *shared caches that honour RFC 9111 strictly* (including
`s-maxage`) not to store the response under the URL-only key.

`Surrogate-Control` is a non-standard-but-universal header honoured by
CDNs (Cloudflare, Fastly, Akamai, Vercel) and *stripped before
forwarding to the browser*. The CDN maintains a separate cache
namespace keyed by `(URL, Vary headers)`; the browser's
`Cache-Control: private` does not apply to the CDN's own namespace.

Caveat: not every CDN honours `Surrogate-Control` by default. Cloudflare
does; Fastly requires explicit config; AWS CloudFront *ignores*
`Surrogate-Control` entirely (use `Cache-Control: s-maxage=60` for
CloudFront, which is why the canonical code sets `s-maxage` *inside*
`Cache-Control` *as well as* in `Surrogate-Control`). The two directives
are belt-and-suspenders portability, not contradictory.


**Warning — `Vary: Authorization` + per-session JWT auth effectively disables CDN caching.**

For long-lived bearer auth (a static API key per user, an OAuth2
access token with a 24-hour TTL), the CDN maintains one cache entry
per distinct `Authorization` value. That works — Alice's token
stays the same for 24 hours, so the CDN serves Alice's cached response
to Alice's subsequent requests.

For per-session JWT auth where the access JWT rotates every 5–15
minutes (the recommended pattern from [[JWT-vs-Sessions-vs-Cookies]]
and [[Authentication-State-Storage]]), every request carries a
different `Authorization` value. The CDN's cache key
`(URL, Authorization)` is unique per request — every request is a
cache miss. The CDN caching layer is effectively disabled.

For per-user JWT-protected responses that you *want* CDN-cached,
drop `Vary: Authorization` and rely on `Cache-Control: private`
(browser-only caching, no CDN). The CDN serves nothing per-user;
the browser caches per-user. That's the right call for per-user
JWT-protected responses — do NOT expect the CDN to cache them.


@router.get("/{project_id}")
async def get_project(
 project_id: int,
 request: Request,
 response: Response,
 if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
 authorization: Annotated[str | None, Header()] = None,
) -> Response:
 project = _PROJECTS.get(project_id)
 if project is None:
 raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="project not found")

 # --- Per-user note: in real Boardly, the project's `notes` field
 # would be filtered by who is asking. Here we just trust the demo.
 # The crucial thing is: the response varies by user, so Vary:
 # Authorization is mandatory.

 etag = _weak_etag(project)

 # --- Conditional GET: if the client's If-None-Match matches, 304.
 if if_none_match:
 # Allow multiple comma-separated tags and the special "*" (matches anything).
 tags = [t.strip() for t in if_none_match.split(",")]
 if "*" in tags or etag in tags:
 # Set the headers directly on the injected `response` object;
 # the 304 returns the same headers as the 200 minus the body.
 for k, v in _cache_headers(project).items():
 response.headers[k] = v
 # No body on a 304 — the client already has it.
 return Response(
 status_code=status.HTTP_304_NOT_MODIFIED,
 headers=response.headers,
 )

 # --- Normal 200 with the full body.
 body = project.model_dump_json()
 headers = _cache_headers(project)
 # Set Content-Type explicitly so the CDN does not sniff it.
 headers["Content-Type"] = "application/json"
 return Response(content=body.encode(), status_code=status.HTTP_200_OK, headers=headers)
```

That's the file. ~80 lines. Run it. Make the request. Watch the headers come back. Then come back and we'll go through every directive.

## Line-by-Line Deep Dive

### Lines 1–9: Module docstring

```python
"""Boardly — caching-aware GET /projects/{id}.

Lesson 02b-9: shows every caching header working together.
The browser is told to revalidate; the CDN is told to cache
for 60s with a 5-minute stale-while-revalidate window. The
response carries a weak ETag and supports If-None-Match.
"""
```

**What it does:** Documents the file's purpose. The note "shows every caching header working together" is the lesson's mission statement — read it before you read the code.

**Tip — Docstrings are for future-you.**

The reviewer of this file in six months will be either future-you or a teammate who was not in the room when you decided "Surrogate-Control AND s-maxage both, because Cloudflare honours one and Fastly honours the other." The docstring preempts the "why are there two?" question. If the decision is non-obvious, write it down.


### Lines 11–15: Imports

```python
import hashlib
from datetime import UTC, datetime

from fastapi import APIRouter, Header, HTTPException, Request, Response, status
from pydantic import BaseModel
```

**What it does:** Pulls in the standard library's `hashlib` (for the ETag digest) and `datetime` (for the `updated_at` field), and from FastAPI the `Header` function (so we can read request headers as function parameters), `Response` (so we can set response headers and status explicitly), `HTTPException` (for the 404), and `status` (for the named status codes).

**Why `Header(alias="If-None-Match")`?** Because Python function parameter names cannot contain hyphens, but the HTTP header is spelled `If-None-Match`. The `alias=` argument tells FastAPI: "the Python parameter is `if_none_match`, but the HTTP header you should look up is `If-None-Match`." This is the same pattern as the cookie-alias trick in [[HTTP-Cookies-Deep-Dive]] Lesson 2.

**FastAPI `Header` is permissive about case.**

HTTP headers are case-insensitive by spec (RFC 9110 §5.1). Starlette's `Request.headers` is a case-insensitive mapping. So `Header(alias="if-none-match")` would also work. The convention in this vault is to use the canonical RFC casing (`If-None-Match`) in the alias so the code reads the same way the RFC does.


### Lines 17–27: The `Project` model

```python
class Project(BaseModel):
 id: int
 name: str
 notes: str          # per-user private field
 updated_at: datetime
```

**What it does:** Defines the project's response shape. Pydantic validates the in-memory object on construction; `.model_dump_json()` serialises it.

**Why is `notes` flagged `# per-user private field`?** Because it is the field that makes `Vary: Authorization` non-negotiable. If two users request `GET /projects/1` and the response includes a per-user `notes` field, the cache key *must* include the user identity — and on the web, the user identity is in the `Authorization` header.

**Warning — The single most-recurring production cache bug.**

An endpoint serves a per-user response. The endpoint sets `Cache-Control: public, max-age=60`. The CDN caches Alice's response under `GET /projects/1`. Bob requests `GET /projects/1`. The CDN serves Alice's response. Bob now sees Alice's `notes` field. This happens in roughly one in three production deployments during their first month behind a CDN. The two fixes are equivalent: (a) set `Cache-Control: private` so shared caches do not store the response at all, or (b) set `Vary: Authorization` so the CDN keys on (URL, Authorization). (a) costs you the CDN's benefit entirely; (b) preserves it. Use (b) when the response is genuinely cacheable per-user.


### Lines 30–35: The pretend store

```python
_PROJECTS: dict[int, Project] = {
 1: Project(id=1, name="alpha", notes="alice's notes", ...),
 2: Project(id=2, name="beta",  notes="alice's notes", ...),
}
```

**What it does:** Stands in for the real SQLAlchemy `select(Project).where(Project.id == project_id)` you would write after Section 07. We use a dict so this lesson's code runs without a database.

**Why doesn't the demo actually filter `notes` by user?**

Because the lesson is about cache headers, not auth. The point is structural: the response varies per user, so the cache key must include the user. In real `Boardly`, you'd load the project *plus* the requesting user's role, and the `notes` field would be the filtered view. The cache header is the same either way: `Vary: Authorization`.


### Lines 38–47: `_weak_etag()`

```python
def _weak_etag(p: Project) -> str:
 digest = hashlib.sha256(f"{p.id}:{p.updated_at}".encode()).hexdigest()[:16]
 return f'W/"{digest}"'
```

**What it does:** Computes the ETag value. The `W/` prefix marks it as a *weak* validator; the rest is a quoted hex string.

**Why "weak"?** A weak ETag (`W/"..."`) means "these two responses are semantically equivalent, even if they are not byte-for-byte identical." A strong ETag (`"..."` without `W/`) means "these two responses are byte-for-byte identical." For a JSON API where the serialiser may reorder keys or change whitespace, weak is the honest choice. For a static file (CSS, an image), strong is the right choice — the bytes are deterministic.

**When weak vs strong actually matters.**

It matters for `If-Match` (used in `PATCH`/`PUT` for optimistic concurrency) and `If-None-Match` (used in `GET` for conditional retrieval). RFC 9110 §8.8.3 says a weak validator may be used for any request that does not require byte-exact equivalence — which is almost every `GET`. For `PATCH` with `If-Match`, RFC 9110 §8.3 says the server MUST NOT consider a weak validator a match — a strong ETag is required. So if you implement conditional writes, your `ETag` must be strong there. The same endpoint may emit a weak ETag for `GET` and a strong ETag for `PATCH`.


### Lines 50–68: `_cache_headers()`

```python
def _cache_headers(p: Project) -> dict[str, str]:
 return {
 "Cache-Control": (
 "private, max-age=0, stale-while-revalidate=0, s-maxage=60"
 ),
 "Surrogate-Control": "max-age=60, stale-while-revalidate=300",
 "ETag": _weak_etag(p),
 "Vary": "Authorization",
 "Cache-Status": '"Boardly-Origin"; miss',
 }
```

This is the heart of the lesson. Every directive, one by one:

- **`Cache-Control: private, max-age=0, stale-while-revalidate=0, s-maxage=60`** — the *browser-facing* directive. `private` forbids shared caches (CDNs) from storing the response under the URL-only key. `max-age=0` tells the browser "if you stored this, you must revalidate before using it" — the next request will hit the origin (or the CDN) and get either a 200 or a 304. `stale-while-revalidate=0` is a no-op here, but we keep the field for symmetry with the Surrogate-Control form below. `s-maxage=60` is the RFC 9111 standardised directive for shared caches — we set it here *as well as* in `Surrogate-Control` for CDN portability (see the callout near the canonical code for why).

**`Surrogate-Control` is a SEPARATE cache namespace from `Cache-Control: private`.**

The directives compose cleanly because each targets a different cache layer.
`Cache-Control: private` instructs browser caches that the response is per-user
and must not be served to other users; it also instructs shared caches that
honour RFC 9111 strictly (including `s-maxage`) not to store the response
under the URL-only key. `Surrogate-Control` is a non-standard-but-universal
header honoured by CDNs (Cloudflare, Fastly, Akamai, Vercel) and stripped
before forwarding to the browser. The CDN maintains a separate cache
namespace; the browser's `Cache-Control: private` does not apply to the CDN's
own namespace. Caveat: AWS CloudFront *ignores* `Surrogate-Control` entirely
— use `s-maxage` inside `Cache-Control` for CloudFront (which is why the
canonical code sets both). The two directives are belt-and-suspenders
portability, not contradictory.


**Why not just `Cache-Control: no-cache`?**

You could. `no-cache` is equivalent to `max-age=0, must-revalidate` for most practical purposes. The reason to spell it out is pedagogical: `max-age=0` is more honest about *what* the browser does (store, but revalidate before use) and is the form the `s-maxage` / `stale-while-revalidate` directives compose with most cleanly. The two forms are interoperable; pick one and stick with it.


- **`Surrogate-Control: max-age=60, stale-while-revalidate=300`** — the *CDN-facing* directive. `Surrogate-Control` is a non-standard-but-universal header that CDNs (Cloudflare, Fastly, Vercel, Akamai) honour and then *strip* before forwarding the response to the browser. So the browser sees only the `Cache-Control` above; the CDN sees `Surrogate-Control` and applies its own 60-second TTL with a 5-minute stale-serve window.

- **`ETag: W/"..."`** — the validator. The client can send `If-None-Match: W/"..."` on the next request; if it matches, we return 304.

- **`Vary: Authorization`** — the directive that prevents the cross-user leak. The CDN's cache key becomes `(URL, Authorization)` instead of just `URL`. Alice and Bob get separate cache entries — *when* the `Authorization` value is stable per user (long-lived API keys). For per-session JWT auth where the access JWT rotates every 5–15 minutes, every request carries a different `Authorization` value and the CDN effectively caches nothing; see the `**Warning —**` callout near the canonical code.

- **`Cache-Status: "Boardly-Origin"; miss`** — the RFC 9211 header that tells the client which cache layer served the response. We set `miss` because the origin always serves a miss; the CDN will overwrite this with `hit` when it serves from its cache.

### Lines 71–110: `get_project()`

```python
@router.get("/{project_id}")
async def get_project(
 project_id: int,
 request: Request,
 response: Response,
 if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
 authorization: Annotated[str | None, Header()] = None,
) -> Response:
 ...
```

**What it does:** Declares the route. The function signature lists every input as a parameter, so FastAPI's `Header()` machinery can parse the request headers into typed Python locals. The modern form is `Annotated[str | None, Header(alias="If-None-Match")] = None` — this is the canonical Pydantic-v2 / FastAPI-0.148 form, consistent with [[Pagination-Deep-Dive]] and [[Content-Negotiation]].

**Why is `request: Request` here but unused?** Two reasons. First, real `Boardly` would use `request.state` (set by the request-ID middleware from [[03-FastAPI-Core/Middleware-and-Request-Order]]) to stamp the request ID into logs. Second, real `Boardly` would read `request.headers["authorization"]` directly when the auth dependency needs custom parsing. We keep it here for shape — when you copy this endpoint into real `Boardly`, you'll want the `Request` available.

**Tip — `Annotated[str | None, Header(alias="...")] = None` makes the header optional.**

A request without `If-None-Match` is a first-time fetch. A request with `If-None-Match: W/"..."` is a revalidation. Both are valid; the function handles both paths. The `= None` default is what makes the header optional — without it, FastAPI raises 422 (Unprocessable Entity) on a missing header.


### Lines 81–83: 404

```python
if project is None:
 raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="project not found")
```

**What it does:** Returns 404 if the project does not exist.

**Why doesn't the 404 carry cache headers?** Because a 404 is, by default, not cacheable. If you want a 404 to be cached (to prevent a client from hammering a missing resource), you must explicitly send `Cache-Control: max-age=N` on the 404 response. That's allowed and useful, but it is not the default. We leave the 404 uncacheable here.

### Lines 85–97: The conditional GET branch

```python
etag = _weak_etag(project)

if if_none_match:
 tags = [t.strip() for t in if_none_match.split(",")]
 if "*" in tags or etag in tags:
 for k, v in _cache_headers(project).items():
 response.headers[k] = v
 return Response(
 status_code=status.HTTP_304_NOT_MODIFIED,
 headers=response.headers,
 )
```

**What it does:** Implements the conditional GET. If the client sent `If-None-Match` and the value matches our current ETag (or is the special `*`), we return 304 with the cache headers (so the client's stored copy's TTL is refreshed) and *no body*.

**Why set headers on the injected `response` object then construct a new `Response`?** Because the new `Response` is what gets returned to the client. The `response.headers[k] = v` line on the injected response is the canonical way to set headers that FastAPI will respect; the new `Response(headers=response.headers)` carries them over to the actual HTTP response. The previous form (`response.status_code = status.HTTP_304_NOT_MODIFIED` then return `Response(status_code=..., headers=response.headers)`) had a dead status-code set on the injected response — the new `Response`'s status wins; the line on the injected response was dead code.

**Why the `*`?** RFC 9110 §8.3 says `If-None-Match: *` matches any existing representation. It is the way a client says "give me 304 if you have *anything* here, otherwise give me the 200." Rare in browsers, common in test clients and download-resume tools.

**Danger — How an attacker thinks: the `If-None-Match: *` request that returns 304 for a non-existent resource.**

RFC 9110 §8.3 says `If-None-Match: *` matches any existing representation. The lesson's code honours this: `if "*" in tags or etag in tags:` returns 304. The bug: an attacker who knows this sends `GET /projects/999` (does not exist) with `If-None-Match: *` — and the server returns 404 (because `project is None` raises `HTTPException(404)` before the conditional check). The attacker then sends `GET /projects/1` (exists) with `If-None-Match: *` — and the server returns 304. The 304-vs-404 distinction is a *resource-existence oracle*: the attacker learns which project IDs exist without ever reading their bodies. For a `/users/{id}` endpoint, this leaks which user IDs are valid (the precursor to a credential-stuffing attack — focus on the IDs that returned 304, skip the ones that returned 404). For a `/projects/{id}` endpoint with sequential IDs, this leaks the total count (binary-search the ID space — log2(N) requests to find the highest existing ID). The fix: rate-limit `If-None-Match: *` requests (a single IP sending more than 10 per minute is suspicious); do not allow `*` from unauthenticated clients (require `Authorization`); or always return 404 for missing resources even when `If-None-Match: *` is sent (some implementations do this — it violates the RFC slightly but closes the oracle). The honest tradeoff: the RFC-compliant behaviour enables the oracle; the security-hardened behaviour breaks `*` for legitimate uses (download-resume tools). Pick security for sensitive resources; pick RFC compliance for public resources. See [[11-Authentication-and-Security/OWASP-API-Top-10]] for the API3:2023 "Broken Object Property Level Authorization" category this falls under.


**Warning — The 304 must include cache headers.**

A common mistake is returning 304 with *no* headers, on the assumption that the client already has them from the original 200. That assumption is wrong. RFC 9111 §4.3.4 says the 304 response must include any headers that would have been sent on a 200 — `Cache-Control`, `ETag`, `Vary`, `Content-Location`. If you skip them, the client may keep the old TTL even though you wanted to extend it (or vice versa).


### Lines 99–110: The 200 branch

```python
body = project.model_dump_json()
headers = _cache_headers(project)
headers["Content-Type"] = "application/json"
return Response(content=body.encode(), status_code=status.HTTP_200_OK, headers=headers)
```

**What it does:** Returns the body with the full cache header set. The canonical `_cache_headers()` function returns the final `Cache-Control` value (with `s-maxage=60` already merged in); the 200 branch just copies the headers and adds `Content-Type`.

**Why set `Content-Type` explicitly?** Because `Response` does not infer the content type for you — it defaults to `text/plain; charset=utf-8` if you do not specify. The CDN's content-type sniffing is disabled by the security-headers middleware's `X-Content-Type-Options: nosniff`, so an explicit `application/json` is required.

**Warning — When this breaks: the `ETag` that changes when the JSON serialiser reorders keys.**

Pydantic's `model_dump_json()` produces a deterministic key order (the model's field definition order), but a `dict` returned from a route is serialised with insertion order — and that order changes between Python versions (CPython 3.7+ guarantees insertion order, but a `dict` returned from a SQL row can have order dependent on the query plan) or across refactors (a teammate adds a field at the *top* of the model, shifting every other field's byte position). The ETag of the same logical resource changes between deploys, even though the data is identical. The client's `If-None-Match` never matches; every request returns 200 (full body) instead of 304 (no body). The CDN's cache hit rate drops because the ETag is unstable. The fix: hash the *canonical* serialised form (`json.dumps(payload, sort_keys=True)` before hashing) — the ETag is stable across deploys and serialiser versions. The trap: `sort_keys=True` is slower than `json.dumps(payload)` (the sort is O(N log N) on the key set); for large payloads (a 100-field response), the sort adds ~1ms per request. The honest tradeoff: pay the 1ms for a stable ETag (enabling 304s and CDN hits), or skip the sort and pay the full-body cost on every request. See [[04-Pydantic/Pydantic-Settings]] for the model-definition-order guarantee and [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] for the slow-query alerting that catches the serialisation regressions.


**Production reality: the browser's back-forward cache (bfcache) that ignores `Cache-Control`.**

Modern browsers (Chrome 96+, Firefox 93+, Safari 16.1+) maintain a "back-forward cache" (bfcache) that stores the *full page state* (DOM, JavaScript heap, scroll position) when the user navigates away. When the user clicks the back button, the browser serves the bfcache snapshot — *without* consulting `Cache-Control`, *without* sending `If-None-Match`, *without* a network request at all. The page resumes from where it was, including all the JavaScript that was running. This means: a user who loaded `GET /projects/1` at t=0 (with `Cache-Control: private, max-age=0`), navigated away at t=10, and clicks back at t=120 — sees the t=0 response, not the t=120 response. If you updated `/projects/1` at t=60, the user does not see it. The fix: emit `Cache-Control: no-store` (which *does* disable bfcache in modern browsers, though the spec is ambiguous) on responses that must never resume from a stale snapshot — typically only auth-sensitive endpoints (the user's profile, the billing page, the auth-callback). For most endpoints, the bfcache is a feature (instant back-button), not a bug. The trap: some browsers (notably older Safari) ignore `no-store` for bfcache too; the only reliable cross-browser bfcache disable is the `unload` event listener (`window.addEventListener('unload', () => {})`) — but `unload` disables bfcache for the *whole page*, including navigation away from non-sensitive endpoints, and the cost is a slower back-button on every navigation. See [[HTTP-Headers-Deep-Dive]] for the security-headers middleware that composes with this, and [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]] for the intro lesson's treatment of bfcache.


## Execution Trace

Run the app:

```bash
uv run uvicorn boardly.main:app --reload
```

### Step 1: First fetch (no `If-None-Match`)

```bash
curl -i -H "Authorization: Bearer alice-token" http://127.0.0.1:8000/projects/1
```

Expected response headers (truncated):

```
HTTP/1.1 200 OK
content-type: application/json
cache-control: private, max-age=0, stale-while-revalidate=0, s-maxage=60
surrogate-control: max-age=60, stale-while-revalidate=300
etag: W/"9e8d3f1c2a4b7e01"
vary: Authorization
cache-status: "Boardly-Origin"; miss
```

### Step 2: Conditional GET (matching `If-None-Match`)

Take the ETag from step 1 and send it back:

```bash
curl -i -H "Authorization: Bearer alice-token" \
 -H 'If-None-Match: W/"9e8d3f1c2a4b7e01"' \
 http://127.0.0.1:8000/projects/1
```

Expected:

```
HTTP/1.1 304 Not Modified
cache-control: private, max-age=0, stale-while-revalidate=0, s-maxage=60
surrogate-control: max-age=60, stale-while-revalidate=300
etag: W/"9e8d3f1c2a4b7e01"
vary: Authorization
cache-status: "Boardly-Origin"; miss
```

No body. The browser reuses the body it cached from step 1.

### Step 3: What the CDN sees

If Cloudflare is in front of `Boardly`, the CDN honours `Surrogate-Control: max-age=60` and caches the response at its edge for 60 seconds. The CDN strips `Surrogate-Control` from the response before forwarding it to the browser. The browser sees `Cache-Control: private, max-age=0, ..., s-maxage=60` and may store the response, but revalidates before use.

Within the 60-second window, a second request from anyone (other than Alice) hits the CDN's cache. If the CDN is correctly honouring `Vary: Authorization`, the cache key includes the `Authorization` header, so Bob's request (with a different `Authorization`) misses the cache and goes to the origin.

```mermaid
flowchart TD
 Browser["Browser<br/>(per-user cache)"] -->|"GET /projects/1<br/>Authorization: Bearer alice"| CDN
 Browser2["Browser<br/>(Bob)"] -->|"GET /projects/1<br/>Authorization: Bearer bob"| CDN
 CDN["CDN edge<br/>(shared cache)<br/>key = (URL, Authorization)"]
 CDN -->|"miss"| Origin["Boardly origin<br/>(no shared cache)"]
 CDN -->|"hit (within s-maxage)"| Browser
 CDN -.->|"Surrogate-Control stripped<br/>Cache-Control forwarded"| Browser

 subgraph "CDN key table"
  K1["GET /projects/1, Auth: alice -> Alice's resp"]
  K2["GET /projects/1, Auth: bob  -> Bob's resp"]
 end
 CDN --> K1
 CDN --> K2

 style CDN fill:#cce5ff,stroke:#007bff
 style Origin fill:#f8d7da,stroke:#dc3545
 style Browser fill:#d4edda,stroke:#28a745
 style Browser2 fill:#d4edda,stroke:#28a745
 style K1 fill:#fff3cd,stroke:#ffc107
 style K2 fill:#fff3cd,stroke:#ffc107
```

## Common Mistakes

### Mistake 1: `Cache-Control: public` on a per-user response

```python
# WRONG
response.headers["Cache-Control"] = "public, max-age=60"
```

**Symptom:** Bob sees Alice's `notes` field on a `GET /projects/1` served from the CDN.

**Why:** `public` explicitly allows *shared* caches (the CDN) to store the response. Without `Vary: Authorization`, the cache key is the URL alone, so Alice's and Bob's responses collide.

**Fix:** Either `Cache-Control: private, ...` (no shared cache) or `Vary: Authorization` (shared cache, keyed per user). Pick based on whether the per-user response is worth caching at the CDN at all.

**Danger — How an attacker thinks: the `Cache-Control: public` response that lets one user poison the cache for all.**

An attacker (Alice) sends `GET /projects/1` with `Authorization: Bearer alice-token`. The response is cached under `(URL, Auth=alice-token)`. The attacker then sends `GET /projects/1` with *no* `Authorization` header — some CDNs treat "no Authorization" as a distinct cache key, so the request goes to the origin with a *default* tenant (often `1` or `0` — the endpoint's `x_tenant_id: int = 1` default from Pagination-Deep-Dive's teaching code), and the origin returns tenant-1's data — which the CDN caches under the "no Authorization" key. Now any unauthenticated user who hits `GET /projects/1` gets tenant-1's data via the cached entry. The cross-user leak is now cross-*unauthenticated-user* — anyone on the internet can read tenant 1's data without authenticating. The fix is layered: (a) never default to a tenant on a missing `Authorization` header — return 401 (the Pagination-Deep-Dive lesson's `x_tenant_id: int = 1` default is teaching code, not production code); (b) do not cache 401 responses (`Cache-Control: no-store` on the 401 handler) so a cached 401 does not lock out legitimate users; (c) set `Cache-Control: private` on per-user responses so the "no Authorization" cache key is empty by definition (no shared cache stores the response); (d) in the CDN's config, do not allow the "no Authorization" cache key variant — strip `Authorization` from the cache key entirely on per-user endpoints, or use a stable per-user identifier (an edge-worker-set `X-User-Id` header) instead. See [[11-Authentication-and-Security/Threat-Model-First]] for the threat-modelling exercise that should produce the "no default tenant" rule.


### Mistake 2: Forgetting `Vary` when the response varies

```python
# WRONG — response is per-user but Vary is missing
response.headers["Cache-Control"] = "private, max-age=0, s-maxage=60"
```

**Symptom:** Even with `private`, if your CDN treats `private` as advisory and the response is genuinely per-user, you may still see cross-user bleed-through. (`private` is supposed to forbid shared caches from storing the response; not every CDN honours it strictly for `s-maxage`-driven entries.)

**Fix:** Set `Vary: Authorization` *in addition to* `private`. The defence is layered.

**Warning — When this breaks: `Vary: Authorization` cache key explodes when the JWT rotates per-request.**

With per-session JWT auth (5-minute access-token rotation, the recommended pattern from [[JWT-vs-Sessions-vs-Cookies]]), the `Authorization` header is different on every request. The CDN's cache key `(URL, Authorization)` is unique per request — every request is a miss, the origin sees 100% of traffic. The cache hit rate drops from 80% to 0% overnight, and the origin load doubles overnight. The bug surfaces in the dashboard: `cdn_cache_hit_rate` drops from 0.8 to 0.0 at the moment the JWT-rotation deploy goes live; `origin_request_rate` doubles at the same instant. The fix: use a stable per-user identifier in the cache key (a long-lived `X-User-Id` header set by an edge worker that decodes the JWT and emits a stable claim), not the rotating JWT; OR drop `Vary: Authorization` and rely on `Cache-Control: private` (browser-only caching, no CDN). For per-user JWT-protected responses that you *want* CDN-cached, the edge-worker pattern is the answer; for per-user JWT-protected responses that you do *not* want CDN-cached (the common case), `private` alone is the answer. See [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]] for the edge-worker pattern that decouples the JWT from the cache key.


**Danger — How an attacker thinks: the `Vary` header that leaks identity via cache-timing.**

`Vary: Authorization` means the CDN maintains a separate cache entry per `Authorization` value. An attacker who can measure response time (cache hit ~5ms, cache miss ~50ms — distinguishable over 100 requests averaged) can fingerprint which `Authorization` values have been seen recently — i.e. which users are active. The attacker sends `GET /projects/1` with `Authorization: Bearer alice-token-20261019-1` (a guessed token from a leaked JWT prefix); if the response is ~5ms, Alice is active and the token is valid; if the response is ~50ms, Alice is not active (or the token is invalid). The attacker iterates over a botnet of leaked token prefixes and builds a heatmap of "who is online right now" — useful for timing a coordinated attack, for stalking, for social-engineering follow-up ("we saw you were online at 3pm yesterday"). The fix: do not set `Vary: Authorization` on responses whose existence is sensitive; use `Cache-Control: private` instead (no CDN caching, no timing oracle). For per-user responses that *must* be CDN-cached, use a stable per-user identifier (an edge-worker-set `X-User-Id` header that is *not* the JWT) and `Vary: X-User-Id` — the attacker cannot guess `X-User-Id` values without compromising the edge worker. The honest tradeoff: `Vary: Authorization` is the simplest defence against cross-user cache poisoning, but it creates a timing oracle; `Cache-Control: private` closes both the poisoning and the oracle but disables the CDN. Pick based on which risk dominates. See [[11-Authentication-and-Security/Threat-Model-First]] for the threat-modelling exercise that should produce this trade-off.


### Mistake 3: `s-maxage` without `Cache-Control: public`

```python
# WRONG
response.headers["Cache-Control"] = "private, max-age=0, s-maxage=60"
```

**Symptom:** Some CDNs (older Fastly configurations, some Akamai properties) interpret `private` as "do not cache in shared caches" and ignore `s-maxage` as a result. You get no CDN caching at all.

**Fix:** Use `Surrogate-Control` for the CDN-facing directive (it is honoured independently of `Cache-Control: private`). Keep `Cache-Control: private` for the browser-facing directive. This is the pattern in `_cache_headers()` above.

### Mistake 4: Returning 304 without cache headers

```python
# WRONG
if if_none_match and etag in if_none_match:
 return Response(status_code=304)  # no headers
```

**Symptom:** The client's stored copy keeps its old TTL even though you wanted to refresh it. The CDN's cached entry is stale from the client's perspective.

**Why:** RFC 9111 §4.3.4 requires the 304 to carry the cache-relevant headers. Without them, the client falls back to its previous `max-age`.

**Fix:** Always emit the full `_cache_headers()` set on a 304.

### Mistake 5: Using `Warning` for cache-related notices

```python
# WRONG (deprecated)
response.headers["Warning"] = '110 - "Response is stale"'
```

**Symptom:** The `Warning` header is silently ignored by modern browsers and most CDNs.

**Why:** RFC 9211 (2022) obsoleted the `Warning` header. The replacement is the `Cache-Status` header, which is structured and machine-readable.

**Fix:** Use `Cache-Status` and your own application-level observability (logs, metrics) instead.

### Mistake 6: `stale-while-revalidate` without `max-age`

```python
# WRONG
response.headers["Cache-Control"] = "stale-while-revalidate=300"
```

**Symptom:** Browsers ignore `stale-while-revalidate` because there is no `max-age` to define what "fresh" means.

**Why:** `stale-while-revalidate` is a *delta* from `max-age`, not an absolute. Without `max-age`, the directive is meaningless.

**Fix:** `Cache-Control: max-age=60, stale-while-revalidate=300`.

## Engineering Trade-Offs

### `s-maxage` vs `Surrogate-Control`

Both let you tell a shared cache "cache this for N seconds, independent of the browser's `max-age`." The trade-off:

- **`s-maxage`** — standardised in RFC 9111. Universal in modern CDNs. Lives in the same `Cache-Control` header as `max-age`, so the browser can read it (and may ignore it, since it applies to shared caches only).
- **`Surrogate-Control`** — non-standard (originated in Squid, adopted by Cloudflare/Fastly/Akamai). Stripped by the CDN before reaching the browser, so it is invisible to the client. Carries CDN-specific directives (e.g. `stale-if-error`, `bypass` for purge) that `s-maxage` cannot express.

In `Boardly` we set both — `s-maxage` in `Cache-Control` and `max-age` in `Surrogate-Control`. Belt and suspenders, because not every CDN honours every directive.

### `Vary: Authorization` vs request coalescing

`Vary: Authorization` is the right fix for per-user caching. It has a cost: the CDN can no longer coalesce concurrent identical requests (because each `Authorization` is a separate cache key). If 1 000 users hit `GET /projects/1` in the same second, the origin sees 1 000 separate requests instead of 1 (which is what `Vary: Accept` would do for content-negotiated responses). The trade-off is correctness vs load. Always pick correctness for per-user responses.

### `immutable` vs `must-revalidate`

`immutable` (RFC 8246) tells caches "this resource will never change at this URL — feel free to serve without revalidating even on a hard refresh." It is appropriate for fingerprinted static assets (`/static/app.a1b2c3.css`).

`must-revalidate` tells caches "once `max-age` expires, you must not serve stale even if the origin is unreachable — return 503 instead." It is appropriate for content where serving stale is worse than failing (financial data, medical data, anything with regulatory implications).

**When does `s-maxage` actually beat `max-age`?**

When you want the CDN to cache for longer than the browser. Example: a `GET /projects/{id}` response — you want the browser to revalidate every request (`max-age=0`) so the user sees updates immediately, but you want the CDN to cache for 60 seconds (`s-maxage=60`) so the origin is not hammered. Without `s-maxage`, both layers see the same `max-age` and you can't decouple them. With it, the browser revalidates (cheap — a 304 if nothing changed), and the CDN serves from cache for 60 seconds. The two layers do different work at different cadences.


**Production reality: the CDN purge that takes 30 seconds to propagate globally.**

When you ship a hotfix to a per-user endpoint at t=0, the CDN's cached entries from before the hotfix serve stale for up to `s-maxage` seconds (60s in this lesson's code). A `purge` API (Cloudflare's `/zones/{zone}/purge_cache`, Fastly's `/service/{service}/purge`, Vercel's revalidate API) is the fix — but propagation is not instant. Cloudflare's purge propagates to ~300 edge locations in ~30 seconds (the 99th-percentile is 45s); Fastly's soft-purge marks entries stale (served on next request after revalidation) instantly but does not remove them; AWS CloudFront's invalidation takes 3-5 minutes for a full distribution. During the propagation window, some edges serve the old response and some serve the new — split-brain. The fix: deploy hotfixes during the lowest-traffic window (the 30-second split-brain is invisible at 3am, visible at 3pm); set `s-maxage=0` and `must-revalidate` on hotfixed endpoints via a config flag until the purge completes (then revert); for hotfixes that *must* be immediate, deploy with a path change (e.g. `/projects/1?cb=202610191230`) to bypass the cache entirely. The trap: the `purge` API itself has rate limits (Cloudflare: 30/min for zone-wide purge); a deploy pipeline that triggers a purge on every commit will rate-limit itself. See [[14-Caching-and-Background-Processing/Redis-Cache-Aside]] for the application-layer cache invalidation that complements the CDN purge.


**Production reality: the `Surrogate-Control` header that the CDN silently rewrites.**

Some CDNs (Cloudflare in particular, when "Cache Rules" or "Configuration Rules" rewrite cache directives) rewrite `Surrogate-Control` into `Cache-Control` before applying it, then strip both before forwarding to the browser. The rewrite is non-deterministic: `Surrogate-Control: max-age=60, stale-while-revalidate=300` becomes `Cache-Control: max-age=60, stale-while-revalidate=300` and the `private` from your `Cache-Control` is *lost in the rewrite*. The browser now sees `Cache-Control: max-age=60` (no `private`), stores the response under the URL-only key, and Alice's response may be served to Bob if they share a browser cache namespace (unlikely per-user, but possible in shared-kiosk scenarios). The fix: verify with `curl -i` through the CDN; if you see `cache-control: max-age=60` only (no `private`), the rewrite is happening; either disable the rewrite via CDN config (Cloudflare's "Respect Strong Cache Headers" toggle), or only set one of `s-maxage` (inside `Cache-Control`) and `Surrogate-Control` (not both). The honest tradeoff: setting both (the lesson's pattern) is belt-and-suspenders portability across CDNs that *do not* rewrite; setting only `Surrogate-Control` is correct for CDNs that rewrite it; setting only `s-maxage` is correct for CDNs that ignore `Surrogate-Control` entirely (AWS CloudFront). Pick based on which CDN you actually run in front of your origin.


**Warning — When this breaks: the `stale-while-revalidate` window that serves stale during a deploy.**

`stale-while-revalidate=300` (5 minutes) tells the CDN: "after `max-age` (60s) expires, you may serve the stale cached response for up to 5 minutes while revalidating in the background." The pattern is great for performance — the user sees a fast response (from the stale cache) and the next user sees a fresh response (the revalidation completed). The bug surfaces during a deploy: at t=0, you deploy a new version of `get_project` that returns a different response (e.g. the `notes` field now includes a new `shared_with` sub-field). The CDN's stale entries (from before t=0) are still within their `stale-while-revalidate=300` window — they serve the *old* response for up to 5 minutes after the deploy, with the revalidation happening in the background. For 5 minutes, half the users see the new response (cache miss goes to origin) and half see the old response (stale cache hit). The split-brain window is the entire `stale-while-revalidate` value. The fix: for breaking deploys (new response shape, removed fields), set `s-maxage=0` and `must-revalidate` (no stale-serve window) on the new version via a config flag, deploy, wait for the CDN's `s-maxage` to expire (60s), then revert the flag. For non-breaking deploys (added fields, no removed fields), the split-brain is invisible to the user — the old response is a strict subset of the new, and the client's parser tolerates the missing field. See [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] for the breaking-deploy pattern that composes with the stale-while-revalidate window.


## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back.


**Exercise 1 — Add a strong ETag for static files.** Add a `GET /static/{filename}` endpoint that reads a file from disk, computes a *strong* ETag from the file's bytes, and serves it with `Cache-Control: public, max-age=31536000, immutable`. Verify with `curl -i` that two consecutive requests with `If-None-Match` produce a 200 then a 304.

**Exercise 2 — Test `Vary: Authorization` poisoning.** (Thought experiment.) Suppose you accidentally removed `Vary: Authorization` from `get_project`. Describe the sequence of two `curl` requests that would let Bob see Alice's `notes` field. (Hint: send Alice's request first to populate the CDN, then Bob's to retrieve it.)

**Exercise 3 — Add `stale-if-error`.** Modify the endpoint to send `stale-if-error=86400` (one day) in `Surrogate-Control`. Simulate an origin 500 (raise an exception in `get_project`) and verify that the CDN serves the stale cached response with a 200 instead of forwarding the 500.

**Exercise 4 — Read a real `Cache-Status` header.** Send a request through a CDN (Cloudflare's free tier works). Use `curl -i` and parse the `Cache-Status` header. Identify which cache layer served the response.

**Exercise 5 — Add `If-Modified-Since` support.** Extend `get_project` to also honour `If-Modified-Since` (RFC 9110 §8.4.2). The header is an HTTP date; if `project.updated_at` is *earlier than or equal to* the header date, return 304.

**Exercise 6 — Test the Cache-Control: public cross-user leak.** Set `Cache-Control: public, max-age=60` on `get_project` (the buggy version from Mistake 1). Use a test client that simulates two users (Alice with `Authorization: Bearer alice-token`, Bob with `Authorization: Bearer bob-token`). Send Alice's request first; then send Bob's request. Assert that Bob's response body is Alice's `notes` field (the cross-user leak). Restore `Cache-Control: private`; re-run; assert Bob gets his own `notes`. Verify: `uv run pytest tests/test_cache/test_public_cross_user.py -k leak`.

**Exercise 7 — Implement canonical ETag computation.** Modify `_weak_etag` to hash the *canonical* serialised form: `json.dumps(project.model_dump(mode="json"), sort_keys=True)`. Write a test that produces the same ETag for two different field-orderings of the same logical project (one with `notes` first, one with `notes` last). Assert that consecutive `If-None-Match` requests return 304. Verify: `uv run pytest tests/test_cache/test_etag_canonical.py -k sort_keys`.

**Exercise 8 — Diagnose the per-session JWT cache-key explosion.** Modify the test client to rotate the `Authorization` header on every request (simulating a 5-minute JWT rotation). Send 100 requests to `GET /projects/1` through a mocked CDN. Assert that the CDN cache hit rate is 0% (every request is a miss because the cache key is unique per JWT). Refactor: add an `X-User-Id` header (set by a mocked edge worker) and `Vary: X-User-Id`; re-run; assert the hit rate is now ~80%. Verify: `uv run pytest tests/test_cache/test_jwt_cache_explosion.py -k rotate`.

**Exercise 9 — Add `If-Match` for optimistic concurrency.** Extend `get_project` to handle `PATCH /projects/{id}` with `If-Match: <etag>`. Compute a strong (non-weak) ETag for the PATCH path. If the project's current ETag does not match the `If-Match` value, return 412 Precondition Failed. Write a test that: (a) GETs the project, (b) holds the ETag, (c) PATCHes with the held ETag — succeeds; (d) PATCHes again with the same held ETag — fails 412 (the project changed). Verify: `uv run pytest tests/test_cache/test_if_match_patch.py -k optimistic`.

**Exercise 10 — Diagnose the If-None-Match: * existence oracle.** Write a test that sends `GET /projects/999` (does not exist) with `If-None-Match: *` and asserts 404; then sends `GET /projects/1` (exists) with `If-None-Match: *` and asserts 304. Refactor: modify `get_project` to return 404 even when `If-None-Match: *` is sent and the resource exists (the security-hardened behaviour); re-run; assert both requests return 404. Discuss the tradeoff (RFC compliance vs security). Verify: `uv run pytest tests/test_cache/test_inm_star_oracle.py -k hardened`.

## Verification

Run the app and execute the three steps from the Execution Trace above. Then verify:

1. **The first request returns 200** with all the cache headers.
2. **The second request (with `If-None-Match`) returns 304** with the same cache headers.
3. **The `Cache-Status` header is `"Boardly-Origin"; miss`** on the origin's response.
4. **`Vary: Authorization` is set** on every response.
5. **`Surrogate-Control` is present** (the CDN-facing directive).
6. **The `ETag` is weak** (`W/"..."`).

If any of those are missing or wrong, re-read the relevant section. The headers are not decoration — they are the contract.

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **HTTP headers (general)** — [[HTTP-Headers-Deep-Dive]]. This lesson deepens the caching subset; that lesson is the introduction.
- **CORS, conditional GET, Vary: Origin** — [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]]. The intro lesson that this lesson deepens.
- **`Accept` and `Vary: Accept`** — [[Content-Negotiation]]. The `Vary` header is shared between content negotiation and per-user caching.
- **Middleware, `Request.state`** — [[03-FastAPI-Core/Middleware-and-Request-Order]]. The request-ID middleware sets `request.state.request_id`, which real `Boardly` would include in cache logs.
- **FastAPI `Header` parameter** — [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]]. The `Header(alias="If-None-Match")` pattern is taught there.

## What's Next

In [[Health-Checks-and-Probes]] (Lesson 10), we cover the three Kubernetes probe types — liveness, readiness, startup — and how to wire them to FastAPI endpoints. Cache headers do not matter there directly, but the pattern is the same: a small, fast endpoint that the orchestrator polls. The `/healthz` endpoint from [[03-FastAPI-Core/Application-and-Lifespan]] is *the* canonical "do not cache" response (`Cache-Control: no-store`) — we'll see why in the next lesson.

In [[Pagination-Deep-Dive]] (Lesson 11), we cover keyset pagination and the `Link: rel="next"` header (RFC 8288). Paginated responses are *ideal* candidates for CDN caching, and you'll use the directives from this lesson to cache the first page aggressively and the deeper pages more cautiously.

### Forward references (taught later, but visible from here)

- **Redis cache-aside** — [[14-Caching-and-Background-Processing/Redis-Cache-Aside]]. Application-level caching (in Redis) is the layer *behind* the HTTP cache layer this lesson covers. The two layers compose: a response served from Redis cache-aside is still subject to the HTTP cache headers on its way out to the browser/CDN.

## Sources

- **RFC 9110 — HTTP Semantics** — <https://www.rfc-editor.org/rfc/rfc9110> — accessed 2026-10-19 — the canonical reference for `Cache-Control`, `ETag`, `If-None-Match`, `Vary`, conditional requests.
- **RFC 9111 — HTTP Caching** — <https://www.rfc-editor.org/rfc/rfc9111> — accessed 2026-10-19 — the canonical reference for what caches may and may not do, `Age`, `s-maxage`, `stale-while-revalidate`.
- **RFC 9211 — The Cache-Status HTTP Response Header Field** — <https://www.rfc-editor.org/rfc/rfc9211> — accessed 2026-10-19 — the structured way for an origin to see which cache layer served a response; obsoletes the `Warning` header.
- **RFC 8246 — HTTP Immutable Responses** — <https://www.rfc-editor.org/rfc/rfc8246> — accessed 2026-10-19 — the `immutable` directive.
- **Cloudflare — Cache-Control** — <https://developers.cloudflare.com/cache/concepts/cache-control/> — accessed 2026-10-19 — practical, current, CDN-specific.
- **Fastly — Surrogate-Control** — <https://docs.fastly.com/en/guides/cache-control-and-surrogate-control-headers> — accessed 2026-10-19.
- **MDN — Cache-Control** — <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control> — accessed 2026-10-19 — readable, browser-tested.
- **FastAPI — Release Notes** — <https://fastapi.tiangolo.com/release-notes/> — verified 0.148.0 released 2026-10-19.
- **Starlette — Responses** — <https://www.starlette.io/responses/> — accessed 2026-10-19 — the `Response.headers` API used in this lesson.

## What We Learned

Recap. In this lesson you:

- **Learned every `Cache-Control` directive** — `public`, `private`, `no-cache`, `no-store`, `max-age`, `s-maxage`, `stale-while-revalidate`, `stale-if-error`, `must-revalidate`, `proxy-revalidate`, `immutable`, `no-transform` — and what each layer does with it.
- **Distinguished strong vs weak `ETag`** — the `W/` prefix and why weak validators are the right default for JSON APIs.
- **Implemented a conditional GET** that honours `If-None-Match` and returns 304 with the full cache header set.
- **Saw why `Vary: Authorization` matters so much** — the cross-user leak it prevents and the request-coalescing cost it imposes.
- **Used `Surrogate-Control`** to talk to the CDN without the browser seeing the directives.
- **Read a `Cache-Status` (RFC 9211) header** and learned that `Warning` is deprecated.
- **Shipped a `GET /projects/{id}` endpoint** in `Boardly` with all the cache headers working together.

The mental model to walk away with: *caching is layered — browser, CDN, origin — and each layer reads the same headers but applies them independently. Your job is to choose directives that compose correctly across layers: `max-age` for the browser, `s-maxage` or `Surrogate-Control` for the CDN, `ETag` + `If-None-Match` for revalidation, `Vary` for key correctness, `Cache-Status` for observability.*

---

> A note from your teacher
You just learned the headers that decide which layer caches what. Sit with that. Most production cache bugs come from one of two mistakes: forgetting `Vary` on a per-user response, or assuming the browser and the CDN see the same `max-age`. Both are one-line fixes; both took down real production services in 2024 and 2025. Now go and ship a CDN-friendly endpoint. We'll see you in Lesson 10 — the one where we ask "is your app even *alive*?" and teach the three Kubernetes probes that answer it.


---

**Tags:** #http #caching #headers #cdn #canonical #review
**Previous:** [[Authentication-State-Storage]]
**Next:** [[Health-Checks-and-Probes]] ->
