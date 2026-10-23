---
title: Async and Concurrency: Interview Questions
aliases:
 - Async Interview Questions
 - Concurrency Questions
 - asyncio Questions
tags:
 - interview
 - async
 - concurrency
 - asyncio
course_level: intermediate
difficulty: advanced
estimated_time: "3–4 hours for a full rehearsal"
status: complete
prerequisites:
 - "[[10-Async-Python/Event-Loop-and-Coroutines]]"
 - "[[10-Async-Python/asyncio-Primitives]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
related_lessons:
 - "[[10-Async-Python/Event-Loop-and-Coroutines]]"
 - "[[10-Async-Python/asyncio-Primitives]]"
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
---

# Async and Concurrency: Interview Questions

*A question bank on Python async, the event loop, `asyncio` primitives, the GIL, `TaskGroup` (PEP 654), and async DB drivers. Use [[Glossary]] vocabulary — event loop, coroutine, blocking I/O.*

**How to use this file**

Async is the topic where "I have used it" and "I understand it" diverge the most sharply. Almost everyone has written `async def`. Very few can explain what the event loop actually does at the OS level. Practice the model answers with code in front of you — type the examples, run them, watch the timings. The interview will ask follow-ups like "and what changes in 3.13+?" — know.


#interview #async #concurrency #asyncio

---

## Q1: What is the event loop? What does it actually do?

### What a strong answer demonstrates

You understand the event loop is a scheduler for coroutines and I/O callbacks, that it runs one task at a time but multiplexes I/O via the OS (epoll/kqueue/IOCP), and that it is *not* parallelism. You can describe the loop's iteration in concrete steps.

### Model answer

The event loop is a single-threaded scheduler. It maintains a queue of ready coroutines and a set of I/O watchers (selectors). On each iteration it:

1. Polls the OS for I/O readiness — `epoll` on Linux, `kqueue` on macOS/BSD, `IOCP` on Windows — with a timeout.
2. Runs the callbacks for any I/O that became ready.
3. Runs ready coroutines from the queue until the queue is empty or a checkpoint.
4. Repeats.

The key insight: the loop runs **one coroutine at a time**. Concurrency is achieved by coroutines *yielding control* at `await` points — typically at I/O. While one coroutine awaits a DB response, the loop runs another. This is **cooperative** concurrency: a coroutine that does not yield (blocking CPU work, or blocking I/O via a sync call) blocks every other coroutine.

The loop is *not* parallelism: only one thread is running Python code at a time. CPU-bound work saturates the loop. For CPU-bound work, use `run_in_executor` (a threadpool, useful for I/O-bound sync code) or multiple processes (the only true parallelism under the GIL).

**Why "single-threaded" matters**

Because the loop is single-threaded, anything that blocks the loop blocks every other coroutine. This is the root cause of "FastAPI is slow under load despite being async" — a single sync DB call in a single `async def` handler can stall every other request. See Q4.


**Interviewer's follow-up: "Where does the OS come in?"**

The OS selector (`epoll`/`kqueue`/`IOCP`) is what makes async I/O efficient. The loop tells the OS "wake me when this socket is readable"; the OS does; the loop runs the callback. The OS does the multiplexing at kernel level; Python just dispatches.


**Production reality: detecting a blocked loop**

Set `asyncio.get_event_loop().slow_callback_duration = 0.1` in staging and watch the `asyncio` logger for `Executing <Handle ...> took 125.3 ms` lines — every hit over 100 ms is a coroutine that did not yield. In production, where you cannot enable `asyncio.debug=True` (it is too slow for hot paths), attach `py-spy dump --pid <uvicorn-worker-pid>` to a worker whose P99 just spiked — the dump shows the exact `recv`/`send`/`read` syscall the loop is stuck in. Pair this with OpenTelemetry span gaps: a span that should be 1 ms but shows 100 ms has the loop-blocking gap inside it. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]] and [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]].


### Practical example

```python
import asyncio, time

async def slow():
 await asyncio.sleep(1) # yields to the loop
 return 42

async def main():
 # 3 sleeps run concurrently because each yields at await
 results = await asyncio.gather(slow(), slow(), slow())
 print(results) # ~1 second, not 3

asyncio.run(main())
```

### Common weak answers

- "It's a thread pool." — it is not. The loop is single-threaded by default.
- "It runs everything in parallel." — it does not. Concurrency, not parallelism.
- "It's a Python feature." — it's an OS feature exposed by Python via selectors.

### Follow-up questions

- What is a coroutine? (The return value of calling an `async def` function; it does not run until awaited or scheduled.)
- What is `asyncio.Future`? (A low-level awaitable; the loop completes it from a callback.)
- What is `asyncio.Task`? (A scheduled coroutine; wraps it in a `Future`.)

Canonical: [[10-Async-Python/Event-Loop-and-Coroutines]].

---

## Q2: `asyncio.run` – what does it do, and why does it raise if called from a running loop?

### What a strong answer demonstrates

You know `asyncio.run(coro)` creates a new event loop, runs the coroutine to completion, then closes the loop. You know it forbids nesting — calling it from inside a running loop raises `RuntimeError: asyncio.run() cannot be called from a running event loop` — because loops are not re-entrant.

### Model answer

`asyncio.run(coro)` is the high-level entry point for running async code from sync code. It:

1. Creates a new event loop.
2. Sets it as the running loop for the current thread.
3. Runs `coro` to completion.
4. Cancels any pending tasks.
5. Shuts down async generators.
6. Closes the loop.

The "cannot be called from a running event loop" error fires when you call `asyncio.run` *inside* an already-running loop — typically inside a Jupyter notebook (which runs on a loop), inside an `async def` function, or inside a callback. The reason is that the loop is not re-entrant: you can't have two loops running in the same thread simultaneously, and the existing loop is already running.

**Fixes:**

- Inside an `async def`, just `await coro` directly. You're already in a loop; you don't need `asyncio.run`.
- From a sync callback inside an async worker, use `asyncio.run_coroutine_threadsafe(coro, loop)` — schedules the coroutine on the existing loop from a different thread.
- For Jupyter, use `await coro` directly in a cell (Jupyter's top-level await works because it runs in a loop).

**Danger — Don't use `nest_asyncio` in production**

`nest_asyncio` patches asyncio to allow nested loops. It's a band-aid for Jupyter use. In production, it masks architecture problems (you're calling sync code that should be async, or async code that should be sync). Fix the architecture.


**Interviewer's follow-up: "If I'm in a sync function called from async, can I just `asyncio.run(coro)` to call my async helper?"**

No — `asyncio.run` raises `RuntimeError: asyncio.run() cannot be called from a running event loop` because the sync function is running inside the async event loop's thread, and the loop is already running. The fix is `asyncio.run_coroutine_threadsafe(coro, loop).result()` — `loop` is the running loop captured before the sync function was entered (e.g., `loop = asyncio.get_running_loop()` in the async caller, passed in). This schedules `coro` on the existing loop from a different thread and blocks the sync function until the result is ready. The pattern is the bridge between sync code that must call async code (legacy libraries, sync callbacks) and the async app. Avoid it where possible — if you can rewrite the sync function as async, do that instead.


**Warning — When this breaks: abrupt task cancellation on shutdown**

`asyncio.run` cancels every pending task before closing the loop — if your `lifespan` shutdown handler created background tasks via `asyncio.create_task` outside the lifespan's `async with` scope, those tasks are cancelled abruptly mid-flight. The symptom in logs is `Task was destroyed but it is pending!` warnings on shutdown, and worse, a transaction that was half-committed. Verify your shutdown path leaves no orphans: `assert not asyncio.all_tasks()` inside a pytest that exercises the lifespan teardown. The diagnosis command mid-incident is `py-spy dump --pid <pid>` on a worker stuck in `asyncio.run`'s shutdown wait — the stack shows `_GatheringFuture` or `_run_once` looping on pending-task cancellation. See [[03-FastAPI-Core/Application-and-Lifespan]].


### Practical example

```python
# Top-level sync code — use asyncio.run:
def main():
 result = asyncio.run(async_function())
 print(result)

# Inside async code — just await:
async def parent():
 result = await async_function()

# Sync callback in async worker — use run_coroutine_threadsafe:
def sync_callback(loop):
 future = asyncio.run_coroutine_threadsafe(async_function(), loop)
 return future.result() # blocks until done
```

### Common weak answers

- "It runs a coroutine." — true but useless; the interviewer wants the loop lifecycle.
- "It's the same as `loop.run_until_complete`." — close, but `asyncio.run` also creates and closes the loop and cancels pending tasks. `run_until_complete` doesn't.
- "You can nest it." — you can't, that's the point of the error.

### Follow-up questions

- What is `asyncio.Runner` (Python 3.12+)? (A context manager that runs multiple coroutines with shared loop, signal handling, and exception grouping — useful for benchmarks and test runners.)
- How do you stop a running task? (`task.cancel()` — see Q8.)
- What happens to pending tasks when `asyncio.run` ends? (It cancels them and waits for them to finish cancelling.)

Canonical: [[10-Async-Python/Event-Loop-and-Coroutines]], [[20-Exercises-and-Labs/Troubleshooting-Index]] (entry 4).

---

## Q3: `asyncio.gather` vs `asyncio.create_task` – when each? What happens if one of the gathered tasks raises?

### What a strong answer demonstrates

You know `gather` runs coroutines concurrently and returns a list of results in order. You know `create_task` schedules a single coroutine as a `Task` (so it runs in the background). You know the failure mode: by default, `gather` raises on the first exception and the other tasks continue running in the background; `gather(..., return_exceptions=True)` returns exceptions in the list instead.

### Model answer

Two different primitives:

- `asyncio.create_task(coro)` — schedules a coroutine on the loop, returns a `Task` object immediately. The coroutine runs in the background; you `await task` later to get its result. Useful when you want to start a long-running task and do other work, then await it.
- `asyncio.gather(*coros)` — schedules all the coroutines concurrently and returns a single awaitable that resolves to a list of results. Results are in the same order as the input coroutines.

The exception behavior is the tricky part:

- By default, `gather` raises the first exception any of its coroutines raises. The other coroutines keep running in the background — they aren't cancelled. This is a leak.
- With `gather(..., return_exceptions=True)`, exceptions are returned in the result list at their position, not raised. You iterate and check `isinstance(r, Exception)`.

**Warning — The "first exception" gotcha**

If you `await asyncio.gather(a, b, c)` and `b` raises, the gather raises `b`'s exception, but `a` and `c` keep running in the background. Their results are lost. If they hold resources (DB connections, file handles), they leak. The fix: wrap the `gather` in a `try/finally` and explicitly cancel the others, or use `asyncio.TaskGroup` (Python 3.11+) which handles this correctly — see Q9.


**Interviewer's follow-up: "If I `await asyncio.gather(...)` and the parent task is cancelled, what happens to the gathered children?"**

The cancellation propagates. When the parent task is cancelled, the `gather` awaitable is cancelled, and cancellation is propagated to all the child tasks (each child receives a `CancelledError` at its next `await`). This is the correct behaviour — `gather` does not leave orphans on parent cancellation. The bug-prone case is *individual* child failure: if `b` raises but the parent isn't cancelled, `a` and `c` keep running (the leak described in the warning above). The fix is `TaskGroup` (Python 3.11+), which cancels the siblings on any child failure and is the recommended pattern for new code. For pre-3.11 code, wrap the `gather` in `try/finally` and cancel the others manually.


**Danger — How an attacker thinks: gather without per-task timeouts is a DoS vector**

A `gather(fetch_a(), fetch_b(), fetch_c())` where one URL is attacker-controlled can stall the whole request — the attacker's server accepts the socket then never responds, the `httpx.AsyncClient.get()` waits on its default timeout (which may be infinite if unset on the client), and the gather's wall time = max child time = unbounded. One attacker request holds a Uvicorn worker for minutes. The fix is structural: every child of a `gather` must have its own `asyncio.timeout()` (or `httpx.Timeout(timeout=5.0)` on the client), and the gather's wall time is the max of those bounded timeouts. A `gather` with no per-task timeout is a latent DoS; lint for `asyncio.gather(` without a surrounding `asyncio.timeout`. See [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]] and [[11-Authentication-and-Security/OWASP-API-Top-10]].


### Practical example

```python
import asyncio

async def slow(n):
 await asyncio.sleep(n)
 return n * 2

# create_task — start, do other work, await:
async def with_create_task():
 task = asyncio.create_task(slow(1))
 print("doing other work")
 await asyncio.sleep(0.5)
 result = await task
 print(result) # 2

# gather — run concurrently:
async def with_gather():
 results = await asyncio.gather(slow(1), slow(2), slow(3))
 print(results) # [2, 4, 6] after 3 seconds (max)

# gather with return_exceptions:
async def with_gather_exceptions():
 async def boom():
 raise ValueError("x")
 results = await asyncio.gather(slow(1), boom(), slow(2), return_exceptions=True)
 print(results) # [2, ValueError("x"), 4]
```

### Common weak answers

- "`gather` is the same as `create_task`." — it isn't. `gather` runs N concurrently and returns a single awaitable; `create_task` schedules one in the background.
- "`gather` cancels the others on exception." — it doesn't, by default.
- "You can't catch exceptions from `gather`." — you can, with `return_exceptions=True`.

### Follow-up questions

- What is `asyncio.wait(coros)`? (Lower-level — returns `(done, pending)` sets; doesn't gather results; you handle each.)
- What is the order of results from `gather`? (Same order as input — not completion order.)
- How do you cancel a `gather`? (Cancel the awaitable returned by gather — `gather_obj.cancel()` — which cancels all child tasks.)

Canonical: [[10-Async-Python/asyncio-Primitives]].

---

## Q4: What counts as "blocking inside async"? What is the cost?

### What a strong answer demonstrates

You can name the categories: blocking I/O (sync `requests`, sync DB drivers), CPU-bound work (pandas, big loops), and `time.sleep`. You know the cost: every other coroutine stalls for the duration. You can articulate the detection mechanism (a 10ms request that becomes a 1000ms request under concurrency).

### Model answer

"Blocking inside async" is any operation that holds the event loop without yielding. Three categories:

1. **Blocking I/O.** Sync HTTP client (`requests.get(...)`), sync DB driver (`psycopg2` cursor, legacy `Session.query`), file `open()` + `read()` without `aiofiles`, `time.sleep(n)` instead of `await asyncio.sleep(n)`. These block the calling thread until the OS returns; the loop can't run other coroutines.
2. **CPU-bound work.** `pandas` operations, big `for` loops, JSON parsing of huge payloads, image processing. These hold the GIL and the loop.
3. **Subprocess sync calls.** `subprocess.run(...)` blocks; use `asyncio.create_subprocess_exec(...)` instead.

The cost: every other coroutine stalls for the duration. A 10ms sync DB call in one handler means every other request waits 10ms longer. Under concurrency (100 concurrent requests), the 10ms calls compound; you see 1000ms+ latencies on requests that "should" be fast.

**Detection:**

- **Latency under load.** A single request is fast; under load, it's slow. That's the signature.
- **OpenTelemetry spans.** A span that should be 1ms shows 100ms; the gap is the loop blocking.
- **`asyncio.get_event_loop().slow_callback_duration = 0.1`** — set this in dev; the loop logs any callback that takes >100ms. Catches blocking.
- **`asyncio.debug = True`** — enables slow-callback logging.

**Interviewer's follow-up: "What if my library has only a sync API?"**

Use `anyio.to_thread.run_sync(sync_func, *args)` (or `asyncio.to_thread(sync_func, *args)` in Python 3.9+). The call runs in the loop's threadpool; the loop is free. The threadpool default is 40 threads; tune with `anyio.to_thread.current_default_thread_limiter()`.


**Production reality: the lint rule and the log search**

The cheapest defense against `time.sleep` in an `async def` handler is a `ruff` custom rule that fails CI on any `time.sleep` call inside an `async def` — the rule is one AST check, ~20 lines, and catches the cheapest DoS in the book. For blocking calls you cannot lint (sync `requests`, sync `psycopg2`), the production signal is the `asyncio` logger's `took X ms` line — search your log aggregator for `took` and inspect the X > 100 hits — plus `py-spy top --pid <pid>` showing the worker stuck in `_PyEval_EvalFrameDefault` with a sync call frame on top. The diagnosis command that confirms a sync call is the blocker (not a slow coroutine): `py-spy dump --pid <pid> | grep -E 'requests|psycopg2|time.sleep'` returns the offending library's frame. See [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] and [[03-FastAPI-Core/Sync-vs-Async-Path-Operations]].


### Practical example

```python
# WRONG — blocking I/O:
async def fetch(url):
 return requests.get(url).json() # blocks the loop

# RIGHT — async I/O:
async def fetch(url):
 async with httpx.AsyncClient() as client:
 resp = await client.get(url)
 return resp.json()

# CPU-bound work — offload to thread:
async def process(data):
 return await asyncio.to_thread(cpu_intensive_pandas_op, data)
```

### Common weak answers

- "Only I/O counts as blocking." — CPU-bound work also blocks the loop.
- "Async makes everything faster." — async makes I/O-bound concurrent work faster; CPU-bound work is unchanged or worse.
- "I have multiple workers, so it's fine." — workers help, but each worker has the same problem; you've just moved it.

### Follow-up questions

- How do you tune the threadpool? (`anyio.to_thread.current_default_thread_limiter().total_tokens = N`.)
- What is `asyncio.set_event_loop_policy`? (Allows overriding the loop implementation — e.g., `uvloop` for performance. See [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]].)
- What is `uvloop`? (A C-based event loop implementation, ~2-4x faster than the stdlib loop. Production-grade; used by Uvicorn via `--loop uvloop`.)

Canonical: [[10-Async-Python/Event-Loop-and-Coroutines]], [[03-FastAPI-Core/Dependency-Injection]].

---

## Q5: `run_in_executor` and `anyio.to_thread.run_sync` – when and how?

### What a strong answer demonstrates

You know both APIs run a sync function in a threadpool and return an awaitable. You know `run_in_executor` is the lower-level `asyncio` API; `anyio.to_thread.run_sync` is the Starlette/FastAPI-preferred abstraction that handles cancellation correctly.

### Model answer

Both APIs run a sync callable in a threadpool, returning an awaitable that resolves to the result.

- `loop.run_in_executor(executor, func, *args)` — the stdlib API. `executor=None` uses the default `ThreadPoolExecutor`. Returns a `Future` you can `await`. Cancellation: cancelling the future does NOT cancel the underlying thread (it can't — Python threads are not cancellable). The thread keeps running; the future just resolves to `CancelledError`.
- `anyio.to_thread.run_sync(func, *args, abandon_on_cancel=False)` — the anyio abstraction. Used by Starlette under the hood for `def` path operations. `abandon_on_cancel=True` (default in newer versions) attempts to abandon the thread on cancellation — Python cannot kill a thread, but anyio marks it as abandoned and the result is discarded.

The rule:

- **In FastAPI code**, prefer `anyio.to_thread.run_sync`. It's what Starlette uses; it handles cancellation consistently with the rest of the framework.
- **In stdlib code or scripts**, `loop.run_in_executor(None, func, *args)` is fine.
- **In test code**, `asyncio.to_thread(func, *args)` (Python 3.9+; the stdlib version of anyio's API) is the simplest.

The threadpool default is 40 threads (anyio) or `min(32, os.cpu_count() + 4)` (stdlib `ThreadPoolExecutor`). Tune with `anyio.to_thread.current_default_thread_limiter().total_tokens = N`.

**Tip — When to actually use it**

Only when you cannot switch to an async library. The canonical cases: legacy sync DB drivers, sync file I/O on Windows (where `aiofiles` falls back to threads anyway), CPU-bound work in an async app. If an async alternative exists (`httpx` for HTTP, `asyncpg` for Postgres, `aiofiles` for files), use it instead.


**Interviewer's follow-up: "Why does anyio default to a threadpool, not a process pool, given the GIL?"**

Because the threadpool is for *I/O-bound* sync calls (where the GIL is released during the I/O syscall — `recv`, `send`, file reads), not for CPU-bound sync calls. A thread doing `psycopg2`'s `cursor.execute(...)` releases the GIL while waiting on the socket, so other threads (and the event loop) can run. The threadpool default of 40 threads is sized for "many concurrent I/O calls," not "few CPU-heavy calls." For CPU-bound work — pandas, big numerical loops — the threadpool is wrong; you'd want a `ProcessPoolExecutor` (one process per core, each with its own GIL). The pattern: `await loop.run_in_executor(ProcessPoolExecutor(), cpu_func, *args)` for CPU-bound; `await anyio.to_thread.run_sync(io_func, *args)` for I/O-bound sync. The threadpool is the right default because most sync libraries are I/O-bound (DB drivers, HTTP clients, file I/O), not CPU-bound.


**Warning — When this breaks: threadpool starvation and abandoned-thread FD leak**

`asyncio.to_thread` shares the anyio threadpool (default 40 threads) with `def` path operations — a handler doing 40 concurrent `to_thread` offloads starves every sync `def` handler on the same worker. The symptom is sync handlers' P99 spiking when an async handler is doing many `to_thread` calls; monitor with `anyio.to_thread.current_default_thread_limiter().statistics()` and alert when `borrowed == total_tokens`. Worse: `abandon_on_cancel=True` cannot kill a thread — a thread running `requests.post(...)` to a slow upstream holds its socket and TLS context for the full client timeout even after the request is cancelled. In a load spike, abandoned threads accumulate file descriptors; monitor `ls /proc/<pid>/fd | wc -l` and alert at > 500. See [[03-FastAPI-Core/Sync-vs-Async-Path-Operations]] and [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]].


### Practical example

```python
import anyio.to_thread
import asyncio

async def handler():
 # Async-preferred:
 result = await async_db_call()

 # Sync-only library — offload to thread:
 result = await anyio.to_thread.run_sync(sync_db_call, arg1, arg2)

 # Stdlib alternative:
 result = await asyncio.get_event_loop().run_in_executor(None, sync_db_call, arg1, arg2)

 # Python 3.9+ stdlib:
 result = await asyncio.to_thread(sync_db_call, arg1, arg2)
```

### Common weak answers

- "`run_in_executor` makes the call async." — it doesn't; it runs sync code in a thread. The call is still sync; you just don't block the loop.
- "It's the same as `gather`." — `gather` runs multiple coroutines; `run_in_executor` runs one sync function.
- "It can be cancelled." — the future can be cancelled, but the thread cannot. The thread keeps running.

### Follow-up questions

- What is `ProcessPoolExecutor`? (A pool of processes; the only true parallelism under the GIL. Use for CPU-bound work.)
- How does `abandon_on_cancel` work? (It cannot kill the thread; it marks it as abandoned so the result is discarded. The thread may still hold resources.)
- How does Starlette use `anyio.to_thread`? (For `def` path operations — the handler runs in the threadpool, freeing the loop.)

Canonical: [[10-Async-Python/asyncio-Primitives]], [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]].

---

## Q6: What is the GIL? How does it interact with async? What changes in 3.13+ (no-GIL experiments)?

### What a strong answer demonstrates

You know the GIL is the Global Interpreter Lock, a mutex that serializes Python bytecode execution within a process. You know async doesn't help CPU-bound work because the GIL still applies — the event loop is single-threaded. You know Python 3.13 introduced an experimental no-GIL build (PEP 703), but that it's not the default and has trade-offs (single-threaded perf regression).

### Model answer

The GIL (Global Interpreter Lock) is a per-interpreter mutex in CPython. It ensures that only one OS thread executes Python bytecode in a given interpreter at a time. The practical effect: multi-threaded Python code does not achieve parallelism for CPU-bound work — the threads take turns.

How it interacts with async:

- **Async I/O is unaffected.** Async uses a single thread; the GIL is held by that thread. I/O multiplexing at the OS level (`epoll`/`kqueue`) doesn't need the GIL — the loop releases the GIL while waiting in the selector.
- **CPU-bound work in async is affected.** A long CPU loop in an `async def` holds the GIL for its duration; every other coroutine (and every other thread) stalls.
- **`run_in_executor` with threads is affected.** A threadpool running CPU-bound Python code is serialized by the GIL — no parallelism. (For I/O-bound sync code, threads work because the GIL is released during I/O.)
- **`ProcessPoolExecutor` is not affected.** Each process has its own GIL.

**Python 3.13+ (PEP 703):**

- An experimental free-threaded build is available (the `--disable-gil` build, or install the `python3.13t` package). It removes the GIL.
- It's not the default; the regular build still has the GIL.
- Trade-off: single-threaded performance regresses slightly (5-10%) because of the loss of GIL-based optimizations (e.g., reference counting now needs atomic operations).
- For multi-threaded CPU-bound Python, free-threaded builds can deliver real parallelism — but the ecosystem (NumPy, etc.) needs to be rebuilt with free-threaded support.

**Warning — Async and the GIL — the practical upshot**

If your workload is I/O-bound: async + asyncio is the right tool. The GIL doesn't matter.
If your workload is CPU-bound: async is the wrong tool. Use multiprocessing, or a free-threaded build (3.13+).
If your workload is mixed: async for the I/O parts, `run_in_executor` with a `ProcessPoolExecutor` for the CPU parts.


**Interviewer's follow-up: "Does my async app benefit from a multi-core machine, or is one core enough?"**

For pure I/O-bound async — one core is enough. The event loop is single-threaded; extra cores don't help because the loop only runs on one. The win from a multi-core machine in async-land comes from running *multiple Uvicorn worker processes* — each worker is its own Python process with its own GIL and its own event loop, and the OS schedules one worker per core. So a 4-core machine running `uvicorn --workers 4` is the canonical scaling pattern for I/O-bound async — four processes, four loops, four cores busy. For CPU-bound async work, the cores help only if you explicitly offload to a `ProcessPoolExecutor` — the loop's single thread is still GIL-bound for in-process Python work. The default Uvicorn guidance is `workers = (2 × CPU cores) + 1` for I/O-bound async, matching the standard sync-server tuning.


**Danger — How an attacker thinks: the free-threaded build as DoS-resilience**

Under the GIL build (the default), a busy-loop DoS (`while True: pass` or `sum(i for i in range(10**10))`) in one handler serializes the entire worker's CPU — every other request on that worker stalls for the busy-loop's duration, and one attacker request takes down a Uvicorn worker for as long as it runs. Under the free-threaded build (PEP 703, `python3.13t`), the same busy-loop only stalls its own thread; the loop's other threads keep serving requests. For a public API with any CPU-bound endpoint, the free-threaded build is a DoS-resilience upgrade, not just a performance one — but the ecosystem (NumPy 2.x, pandas 3.x, Cython 3.x free-threaded wheels) still lags as of Oct 2026, so benchmark before adopting. The diagnosis command that confirms a busy-loop DoS is in flight: `py-spy top --pid <pid>` showing 100% CPU on one thread with `_PyEval_EvalFrameDefault` as the top frame. See [[10-Async-Python/Concurrency-vs-Parallelism]] and [[11-Authentication-and-Security/Threat-Model-First]].


### Practical example

```python
# CPU-bound in async — GIL-bound, no parallelism:
async def cpu_loop():
 # This holds the GIL the entire time; the loop is blocked.
 s = sum(i * i for i in range(10**7))
 return s

# CPU-bound offloaded to a process:
from concurrent.futures import ProcessPoolExecutor
async def cpu_parallel():
 loop = asyncio.get_event_loop()
 return await loop.run_in_executor(ProcessPoolExecutor(), cpu_sync_work, arg)
```

### Common weak answers

- "The GIL prevents async." — it doesn't; async uses one thread and the GIL is held by that thread.
- "Async is parallel." — it's concurrent, not parallel.
- "3.13 removed the GIL." — 3.13 has an experimental no-GIL build; the default still has the GIL.

### Follow-up questions

- What is `multiprocessing`? (Stdlib module for spawning Python processes — each with its own GIL. The right tool for CPU-bound parallelism.)
- What is `asyncio`'s relationship to threads? (Asyncio uses one thread by default. `run_in_executor` adds threads. The loop does not use threads for its own scheduling.)
- When is the free-threaded build production-ready? (PEP 703 targeted full support in 3.14+; check CPython's release notes. As of Oct 2026, it's experimental.)

Canonical: [[10-Async-Python/Event-Loop-and-Coroutines]].

---

## Q7: `asyncio.Lock` vs `threading.Lock` – which when?

### What a strong answer demonstrates

You know `asyncio.Lock` is for serializing coroutines within a single event loop — it cooperates with `await` and doesn't block the loop. You know `threading.Lock` is for serializing OS threads — it blocks the calling thread until acquired. Using a `threading.Lock` inside an `async def` blocks the loop; using `asyncio.Lock` outside a loop raises.

### Model answer

Two different locks for two different concurrency models:

- `asyncio.Lock` — an async primitive. `async with lock:` cooperates with the event loop; while a coroutine waits for the lock, the loop runs other coroutines. Use when you need to serialize access to a resource shared across coroutines in the same loop.
- `threading.Lock` — a sync primitive. `with lock:` blocks the calling thread until acquired. If used inside an `async def`, it blocks the event loop for the duration of the wait.

**When to use which:**

- **Same loop, shared resource across coroutines** → `asyncio.Lock`. Example: a per-app rate-limiter or a shared in-memory cache.
- **Across threads** → `threading.Lock`. Example: protecting a global from multiple worker threads (e.g., a threadpool job writing to a shared log).
- **Across processes** → `multiprocessing.Lock` or a Redis lock (distributed).

**Danger — The classic bug: `threading.Lock` in async**

```python
lock = threading.Lock()
async def handler():
with lock: # blocks the entire event loop while waiting
...
```
If another coroutine holds the lock, every other coroutine stalls. The fix: `asyncio.Lock` and `async with lock:`.


**Interviewer's follow-up: "What if I need a distributed lock across processes — does asyncio have a primitive for that?"**

No — `asyncio.Lock` is strictly per-process (per-event-loop, in fact). For cross-process or cross-machine locking, you need an external primitive, typically a Redis lock (`SET key value NX PX 30000` with a token + Lua compare-and-delete for safe release) or a Postgres advisory lock (`pg_advisory_lock(key)`). The async wrapper for the Redis lock is `redis.lock(name, timeout=30, blocking=True, blocking_timeout=10)` — `async with` releases it. The choice between Redis and Postgres advisory locks: Redis is faster (sub-millisecond acquire) but the lock is lost if Redis restarts; Postgres advisory locks are tied to the DB connection and survive Redis restarts but require a DB round-trip. For a multi-process FastAPI app, the canonical pattern is Redis for short-lived locks (rate-limit per user, prevent duplicate submission) and Postgres advisory locks for transaction-scoped locks (prevent two workers processing the same job).


**Warning — Production reality: the two distributed-lock failure modes**

A Redis distributed lock acquired without a per-acquire token is a silent split-brain waiting to happen — if the holder pauses (a 200 ms GC pause, a slow `await`), the lock's TTL expires, another worker acquires it, and now two workers hold "the lock" simultaneously. The token (a UUID per acquire) plus a Lua compare-and-delete on release (`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`) prevents the second worker from deleting a lock it does not own. Separately, a per-user `asyncio.Lock` dict keyed by `user_id` without an LRU eviction is both a memory leak and a DoS vector — an attacker who creates 1 M sessions fills the dict; bound it with `cachetools.LRUCache(maxsize=10000)` and reject lock creation for users not in the cache. See [[14-Caching-and-Background-Processing/Redis-Cache-Aside]] and [[11-Authentication-and-Security/Threat-Model-First]].


### Practical example

```python
import asyncio

# Async lock — serializes coroutines:
lock = asyncio.Lock()

async def limited_concurrent():
 async with lock: # other coroutines can run while this one waits
 await do_work()

# Threading lock — serializes threads:
import threading
tlock = threading.Lock()

def thread_work():
 with tlock: # blocks this thread
 do_sync_work()
```

### Common weak answers

- "`threading.Lock` works in async code." — it does, but it blocks the loop. Wrong tool.
- "`asyncio.Lock` works across processes." — it doesn't; it's per-loop.
- "You don't need locks in async because it's single-threaded." — true for *atomic* operations, but a multi-step operation (read-modify-write) can be interleaved at `await` points; you still need a lock.

### Follow-up questions

- What is `asyncio.Semaphore`? (Allows N concurrent holders, not just 1. Use for rate-limiting concurrency to N.)
- What is a Redis lock? (`SET key value NX PX 30000` — distributed across processes/machines. Use for cross-process serialization.)
- What is `tenacity.AsyncRetrying`? (An async retry library; useful for retrying flaky operations with backoff.)

Canonical: [[10-Async-Python/asyncio-Primitives]].

---

## Q8: How does cancellation work in asyncio? What is `CancelledError` and what should you do in `finally`?

### What a strong answer demonstrates

You know cancellation is cooperative — `task.cancel()` schedules a `CancelledError` to be raised at the next `await` in the task. You know the task's `finally` block runs. You know the rule: if you catch `CancelledError`, you must re-raise it (or the cancellation is suppressed).

### Model answer

Cancellation in asyncio is cooperative. `task.cancel()` does not kill the task — it schedules a `CancelledError` to be raised at the next `await` point in the coroutine. The coroutine's `try/except/finally` blocks run normally.

The rule:

- The coroutine receives `CancelledError` at its next `await`.
- The coroutine's `finally` block runs — that's where you clean up (close files, release locks, rollback sessions).
- If the coroutine catches `CancelledError` and does not re-raise it, the cancellation is suppressed. The task continues. This is almost always a bug — you've overridden the caller's intent.

**Warning — Don't swallow `CancelledError`**

```python
try:
await work()
except CancelledError:
pass # WRONG — task continues; caller's cancel is lost
```
Always re-raise: `except CancelledError: cleanup(); raise`. The exception is `BaseException` in Python 3.8+, so a broad `except Exception:` won't catch it — but `except BaseException:` will.


**Interviewer's follow-up: "What if my `finally` block itself raises — does the cancellation still propagate?"**

It depends on what the `finally` raises. If the `finally` block raises a *different* exception (not `CancelledError`), the original `CancelledError` is replaced by the new exception — the caller sees the `finally`'s error, not the cancellation. This is usually a bug because the caller asked for cancellation and instead gets an unrelated error. If the `finally` block raises `CancelledError` (e.g., via `await` on a cancelled task), the cancellation propagates normally. The rule: keep `finally` blocks defensive — wrap any cleanup that can fail in `try/except` and log, so the original exception (cancellation or otherwise) is preserved. The pattern: `finally: try: await cleanup() except Exception: log.exception("cleanup failed")`.


**Danger — How an attacker thinks: swallowing cancellation as a cheap DoS**

A long-running handler with a broad `except BaseException: pass` (or `except: pass`) swallows `CancelledError` — the request runs to completion even after the client disconnects. The attacker pattern is trivial: open 1000 sockets, send a request on each, disconnect immediately, repeat — the server keeps doing 1000 expensive queries per wave for clients that are long gone, and the workers' CPU saturates on phantom work. The fix is structural: every `except` that catches `CancelledError` (or `BaseException`) must `raise` it; lint for `except BaseException` and `except:` with a custom `ruff` rule and fail CI on any hit. Pair the lint with `asyncio.timeout()` on the inner work so the handler respects cancellation even when the caller does not disconnect. See [[11-Authentication-and-Security/OWASP-API-Top-10]] and [[03-FastAPI-Core/Middleware-and-Request-Order]].


### Practical example

```python
import asyncio

async def work_with_cleanup():
 try:
 await asyncio.sleep(60)
 except asyncio.CancelledError:
 print("cancelled — cleaning up")
 await cleanup() # async cleanup is OK in finally
 raise # CRITICAL: re-raise
 finally:
 # finally runs whether the body raised or cancelled
 await release_resources()

async def main():
 task = asyncio.create_task(work_with_cleanup())
 await asyncio.sleep(1)
 task.cancel() # schedules CancelledError at the next await in work
 try:
 await task
 except asyncio.CancelledError:
 print("task was cancelled")
```

### Common weak answers

- "Cancel kills the task." — it doesn't; it schedules an exception.
- "`finally` doesn't run on cancel." — it does.
- "You can catch it with `except Exception`." — `CancelledError` is `BaseException` since 3.8; `except Exception` doesn't catch it.

### Follow-up questions

- What is `task.uncancel()`? (3.11+ — undoes a `cancel()` call; the task continues. Niche; used in complex frameworks.)
- What happens if a task is cancelled while in `run_in_executor`? (The thread keeps running; the future resolves to `CancelledError`. Cannot kill a thread.)
- How does Starlette handle cancellation on client disconnect? (It cancels the handler's task; the handler's `finally` runs. Use this for cleanup. See [[03-FastAPI-Core/Middleware-and-Request-Order]].)

Canonical: [[10-Async-Python/asyncio-Primitives]].

---

## Q9: What is `TaskGroup` (PEP 654)? How does it differ from `gather`?

### What a strong answer demonstrates

You know `async with asyncio.TaskGroup()` (Python 3.11+, PEP 654) is the modern structured-concurrency primitive. It schedules tasks inside the context manager; on exit, awaits all of them. If one raises, the others are cancelled automatically, and the group raises an `ExceptionGroup` (PEP 654) containing all the exceptions.

### Model answer

`TaskGroup` is Python's structured-concurrency primitive (3.11+; PEP 654):

```python
async with asyncio.TaskGroup() as tg:
 tg.create_task(coro1())
 tg.create_task(coro2())
# On exit: all tasks awaited. If any raised, others are cancelled; an ExceptionGroup is raised.
```

Differences from `gather`:

- **Structured.** `TaskGroup` is a scope — tasks are started inside the `async with` block and are guaranteed done by the time the block exits. `gather` is a function call returning an awaitable; tasks are not "scoped."
- **Cancellation.** If one task in a `TaskGroup` raises, the others are automatically cancelled. With `gather`, the others keep running (a leak) unless you handle it explicitly.
- **Exception grouping.** `TaskGroup` raises `ExceptionGroup` (PEP 654) containing all the exceptions. `gather` raises the first one and discards the rest.
- **No return value.** `TaskGroup` doesn't return results — you collect them via shared state (each task writes to a list, a dict, etc.). `gather` returns a list of results in order.

**Tip — When to use TaskGroup vs gather**

Use `TaskGroup` for any new code where you want structured concurrency and proper cancellation. Use `gather` when you specifically want results as a list and don't care about per-task cancellation (rare).

In a FastAPI handler, `TaskGroup` is the right primitive — if any sub-task fails, you want the others cancelled and the request to fail cleanly.


**Interviewer's follow-up: "What's the difference between `async with TaskGroup()` and `async with` on a single awaitable — are they equivalent for one task?"**

No. `async with TaskGroup() as tg: tg.create_task(coro)` is structured concurrency — the task is scheduled *inside* the context manager, and the manager waits for all tasks to complete before exiting. Even for one task, the `TaskGroup` adds: cancellation propagation (if the body raises, the task is cancelled), `ExceptionGroup` wrapping (the task's exception is wrapped, not raised directly), and structured scope (the task is guaranteed done before the `async with` block exits). `await coro` directly is simpler — no `TaskGroup` overhead, no `ExceptionGroup` wrapping — and is the right choice when you have one coroutine and want its result. Use `TaskGroup` when you have *multiple* concurrent tasks that should fail together; use plain `await` when you have one task. For two tasks that should fail together, `TaskGroup` is the right primitive even though it's more verbose than `gather`.


**Warning — When this breaks: ExceptionGroup does not unwrap automatically**

`asyncio.TaskGroup` raises an `ExceptionGroup` (PEP 654) wrapping every child exception — a handler with `except SomeError:` does not catch a `SomeError` nested inside an `ExceptionGroup`, so the handler never fires and the request 500s with an uncaught `ExceptionGroup`. The fix is the `except*` syntax (PEP 654, Python 3.11+): `except* SomeError as eg:` filters across the group, splitting the `ExceptionGroup` into matched and unmatched halves. Forgetting this is the #1 bug in new `TaskGroup` code — the unit test that asserts `SomeError` is raised passes (because the group contains it) but the production handler never fires. Verify with `uv run python -c "import sys; print(sys.version_info >= (3, 11))"` in CI — if the matrix does not include 3.11+, the `TaskGroup` code path is untested on the supported runtimes. See [[03-FastAPI-Core/Exception-Handlers]] and [[12-Testing-and-Quality/Async-Testing]].


### Practical example

```python
import asyncio

async def fetch_user(id):
 ...

async def fetch_orders(id):
 ...

async def handler(user_id):
 results = {}
 async with asyncio.TaskGroup() as tg:
 tg.create_task(_fetch(fetch_user, user_id, results, "user"))
 tg.create_task(_fetch(fetch_orders, user_id, results, "orders"))
 return results

async def _fetch(coro, id, results, key):
 results[key] = await coro(id)
```

### Common weak answers

- "It's the same as `gather`." — it isn't; it provides structured scope and automatic cancellation.
- "It doesn't raise on task failure." — it raises an `ExceptionGroup`.
- "It returns a list of results." — it doesn't; you collect via shared state.

### Follow-up questions

- What is `ExceptionGroup` (PEP 654)? (A new exception type that wraps multiple exceptions; `except*` syntax allows filtering by type.)
- Can a `TaskGroup` task spawn its own sub-`TaskGroup`? (Yes — nested groups have well-defined cancellation semantics.)
- What happens if the body of `async with TaskGroup()` raises (not a task)? (The group's tasks are cancelled, then the body's exception is raised in an `ExceptionGroup`.)

Canonical: [[10-Async-Python/asyncio-Primitives]].

---

## Q10: Async DB drivers – what are the choices for PostgreSQL, and what are the trade-offs?

### What a strong answer demonstrates

You know the main async Postgres drivers: `asyncpg` (the high-performance pure-async driver), `psycopg` (3.x, has an async mode via `psycopg.AsyncConnection`), and `aiopg` (older, wraps `psycopg2` in a threadpool — effectively sync). You know the trade-offs: `asyncpg` is fast but has its own parameter style; `psycopg` 3 is more standard and supports prepared statements; `aiopg` is legacy.

### Model answer

Three async-compatible Postgres drivers in 2026:

- **`asyncpg`** — a pure-async, from-scratch implementation. Fastest. Used by SQLAlchemy's `postgresql+asyncpg` dialect. Has its own parameter style (`$1`, `$2`, not `%s`); SQLAlchemy abstracts this. Supports prepared statements natively. Caveat: with PgBouncer in transaction mode, prepared statements don't work cleanly — set `statement_cache_size=0` on `asyncpg` (or use SQLAlchemy's `prepared_statement_cache_size`).
- **`psycopg` (3.x)** — the modern psycopg, with first-class async (`psycopg.AsyncConnection`). Used by `postgresql+psycopg` dialect (async via `+psycopg_async` in some configurations). Compatible with `psycopg2` semantics; supports prepared statements. Slower than `asyncpg` but more standard.
- **`aiopg`** — legacy; wraps `psycopg2` in a threadpool. Effectively sync under the hood. Avoid in new code; use `asyncpg` or `psycopg` 3.

Trade-offs:

| Driver | Speed | Stdlib-like | PgBouncer-friendly | Notes |
|---|---|---|---|---|
| `asyncpg` | Fastest | No (own API) | Needs `statement_cache_size=0` in txn mode | SQLAlchemy abstracts API |
| `psycopg` 3 | Slower | Yes | Yes | Better ecosystem compat |
| `aiopg` | Slowest | Yes | Yes | Legacy; avoid |

**Warning — PgBouncer + asyncpg prepared statements**

`asyncpg` caches prepared statements per connection. With PgBouncer in transaction mode, each "transaction" may run on a different server-side connection, so the prepared statement doesn't exist where you think it does. Symptom: `prepared statement "_stmt_1" does not exist`. Fix: `create_async_engine(url, connect_args={"statement_cache_size": 0})` or use PgBouncer 1.21+ with prepared-statement support.


**Interviewer's follow-up: "If I don't use PgBouncer, do I still need `statement_cache_size=0`?"**

No — without PgBouncer, your app holds one server-side connection per pool slot, and `asyncpg`'s prepared statement cache works correctly (the prepared statement exists on the connection that created it and stays there for the connection's lifetime). The `statement_cache_size=0` setting is only needed when the connection multiplexes across server-side connections (PgBouncer transaction mode, or a similar pooler like `pgcat`). The cost of `statement_cache_size=0` is one extra round-trip per query (the `PREPARE` step is replaced by inline parameter substitution), so setting it when you don't need to is a ~10% perf hit on hot paths. The diagnostic: if you see `prepared statement "_stmt_N" does not exist` errors, you need it; otherwise you don't. PgBouncer 1.21+ supports prepared statements in transaction mode via `max_prepared_statements`, so upgrading PgBouncer lets you keep the cache — that's the modern fix.


**Danger — How an attacker thinks: the pool-size as a cross-service boundary**

A connection pool configured with `pool_size=100` and `max_overflow=200` per worker, times 8 workers, is 2400 connections to Postgres. A single bad deploy (a `time.sleep` in a handler that holds a session, a leaked `AsyncSession` in a background task) pins all 2400 connections, Postgres refuses new ones with `FATAL: sorry, too many clients already`, and every other service sharing that Postgres instance goes down — the attacker is one buggy deploy away from a multi-service outage. Treat the pool size as a security boundary: `workers * (pool_size + max_overflow) <= 0.5 * Postgres max_connections`, where the 0.5 leaves headroom for other services, DBA sessions, and Alembic migrations. For shared Postgres instances, prefer `pool_size=8, max_overflow=4` per worker plus PgBouncer in transaction mode; the smaller per-worker pool forces backpressure instead of allowing connection sprawl. See [[07-SQLAlchemy/02-Engines-Connections-Pools]] and [[19-Interview-Preparation/Production-Incidents-Debugging]] (Incident 6).


### Practical example

```python
# asyncpg via SQLAlchemy:
from sqlalchemy.ext.asyncio import create_async_engine

engine = create_async_engine(
 "postgresql+asyncpg://user:pass@host/db",
 pool_size=10,
 pool_pre_ping=True,
 connect_args={"statement_cache_size": 0}, # for PgBouncer txn mode
)

# psycopg 3 async via SQLAlchemy:
engine = create_async_engine(
 "postgresql+psycopg_async://user:pass@host/db",
 pool_size=10,
)
```

### Common weak answers

- "`asyncpg` is always faster." — usually, but the difference matters only at high QPS. For most apps, `psycopg` 3 is fine.
- "Use `aiopg` — it's mature." — it's mature but legacy; it's a sync driver wrapped in threads.
- "PgBouncer doesn't work with async." — it does; you just need the right settings.

### Follow-up questions

- What is `statement_cache_size`? (asyncpg's client-side prepared statement cache; set to 0 for PgBouncer txn mode.)
- What is PgBouncer's "transaction mode"? (Multiplexes many app connections onto few server connections, switching per-transaction. The default for production pooling.)
- What is `pool_pre_ping`? (SQLAlchemy option to test the connection before use; catches dropped connections. Adds a `SELECT 1` per checkout. See [[07-SQLAlchemy/02-Engines-Connections-Pools]].)

Canonical: [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[07-SQLAlchemy/02-Engines-Connections-Pools]].

---

## Q11: Async vs sync SQLAlchemy – what are the real trade-offs?

### What a strong answer demonstrates

You can articulate the workload that benefits (I/O-bound concurrent), the workload that doesn't (CPU-bound, single-query-per-request), and the costs (async semantics, `MissingGreenlet`, driver caveats, learning curve).

### Model answer

The trade-offs:

**Async wins when:**

- The app is async end-to-end (FastAPI + async clients + async drivers). Sync SQLAlchemy in an otherwise-async app is the bottleneck — it blocks the loop.
- The workload is I/O-bound with many concurrent queries per request. A `gather(select1, select2, select3)` runs in ~max(time) instead of sum.
- The DB is remote (latency matters; async overlaps the round-trips).

**Sync wins when:**

- The workload is CPU-bound (data processing in Python). Async doesn't help CPU-bound; the GIL serializes.
- The app is small / a script. Async overhead isn't worth it.
- The team is unfamiliar with async. Async semantics (`MissingGreenlet`, `await` everywhere, event loop management) have a learning curve.
- Driver reliability matters more than peak throughput. `asyncpg` is mature but has caveats with PgBouncer; psycopg2 is rock-solid.

**Costs of async:**

- **`MissingGreenlet`.** See Q12 of [[SQLAlchemy-Sessions-Questions]] and Incident 3 of [[Production-Incidents-Debugging]]. The classic async-SQLAlchemy bug.
- **`await` everywhere.** Every `session.execute`, `session.scalar`, `session.commit` must be awaited. Easy to forget; the coro doesn't run.
- **Driver caveats.** See Q10 — PgBouncer + asyncpg prepared statements.
- **Test setup.** Tests need an async event loop; `pytest-asyncio` strict mode adds boilerplate.

**Tip — The honest recommendation for a FastAPI service**

If your app is FastAPI, use `AsyncSession`. The app is async; sync SQLAlchemy is the only blocking call in the loop. The cost of async semantics is paid once (a learning curve); the cost of sync-DB-in-async-app is paid forever (every request stalls the loop on every query).


**Interviewer's follow-up: "If I'm forced to use sync SQLAlchemy in an async app (legacy codebase), what's the right pattern?"**

Wrap every sync DB call in `await anyio.to_thread.run_sync(...)`. The handler stays `async def`; the sync `Session` operations (execute, commit, rollback) run in the threadpool. The pattern: `user = await anyio.to_thread.run_sync(session.scalar, select(User).where(User.id == 42))` for each sync call. The cost is one threadpool context switch per call (~1 ms), which over 1000 requests is 1 second of overhead — measurable but not catastrophic. The wrong pattern is to call the sync method directly inside `async def` — that blocks the loop (the Q12 of [[FastAPI-and-DI-Questions]] bug). The medium-term plan is to migrate to `AsyncSession` table by table, test by test, until the sync `Session` is gone — at which point the threadpool offload is unnecessary. The short-term reality is that the threadpool offload keeps the app working without the loop-blocking bug while you pay down the sync technical debt.


**Warning — When this breaks: mixed sync+async engines sharing one process**

A codebase that runs both a sync `Session` (for Alembic migrations and legacy scripts) and an `AsyncSession` (for the FastAPI app) inside the same Uvicorn worker shares the GIL between them — the sync `Session.commit()` holds the GIL during the commit syscall, and the async `await session.execute()` on the same worker blocks waiting for that GIL. The symptom is async endpoints stalling with P99 spikes during the nightly Alembic run, even though the async endpoints' queries are fast. The diagnosis command: `psql -c "SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC"` — set `application_name` via `connect_args={"server_settings": {"application_name": "app-async"}}` (async engine) and `"alembic"` (sync engine) so the split is visible in `pg_stat_activity`. The fix is two engines with separate `application_name` tags, and ideally two processes (one for the app, one for Alembic). See [[07-SQLAlchemy/07-Async-SQLAlchemy]] and [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]].


### Practical example

```python
# Async (recommended for FastAPI):
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

engine = create_async_engine("postgresql+asyncpg://...")
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)

async def get_session() -> AsyncSession:
 async with AsyncSessionLocal() as session:
 async with session.begin():
 yield session

# Sync (for Alembic, scripts, sync Flask apps):
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

engine = create_engine("postgresql+psycopg://...")
SyncSessionLocal = sessionmaker(engine)
```

### Common weak answers

- "Async is faster." — only for I/O-bound concurrent workloads.
- "Sync is simpler." — true, but in an async app, sync is the bottleneck.
- "You can mix sync and async SQLAlchemy in the same app." — you can (different engines), but it's confusing and error-prone.

### Follow-up questions

- What is `expire_on_commit=False` and why is it the async idiom? (After commit, attributes are expired; in async, the re-fetch needs an await that may be outside the session's context. Setting `False` keeps the in-memory state.)
- How does Alembic work with async? (Alembic runs sync internally; use a sync driver for migrations, async for the app.)
- How do you test async SQLAlchemy? (`pytest-asyncio` strict mode; `httpx.AsyncClient` with `ASGITransport`. See [[12-Testing-and-Quality/Async-Testing]].)

Canonical: [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[10-Async-Python/Event-Loop-and-Coroutines]].

---

## Q12: A leaked session causes `MissingGreenlet` in production. Walk me through your diagnosis.

### What a strong answer demonstrates

You have a methodical diagnosis framework. You read the traceback to find the sync attribute access; you trace the object's lifecycle backward to find where the session closed; you fix the architecture (return DTOs, not ORM objects).

### Model answer

The framework:

**Step 1: Read the traceback.** The error fires at the sync attribute access — `user.orders` somewhere in a serializer or route handler. The line that raises is not the bug; it's the symptom. The bug is upstream — where the object was loaded and the session was closed.

**Step 2: Trace the object backward.** Where was the object created? Walk back through the service. Look for `async with AsyncSession(...) as session:` blocks that exited before the object was returned. Look for `session.scalar(select(User).where(...))` followed by `return user` outside the `async with` block.

**Step 3: Confirm the hypothesis.** Add a print or log inside the `async with` block: `print(session.in_transaction() if hasattr(session, "in_transaction") else "sync")`. If the session is closed by the time the route accesses `user.orders`, the bug is confirmed.

**Step 4: Fix the architecture.**

1. **Eager-load** the unloaded attribute inside the session's await context: `select(User).options(selectinload(User.orders))`.
2. **Return DTOs.** Build the Pydantic model inside the session; return plain data.
3. **Set `expire_on_commit=False`** on the `AsyncSession` to prevent post-commit expiry.

**Step 5: Add a regression test.** Use `raiseload(User.orders)` (or per-relationship options) in the test session so any future lazy access in a serializer raises in tests, not in production.

**Interviewer's follow-up: "Why is this intermittent?"**

Because some users have no orders. For those, the lazy load is never triggered — the attribute access returns an empty collection without a DB round trip. For users with orders, the lazy load *would* require a query, which fails. The intermittency is a clue.


**Production reality: the intermittency is the diagnostic signal**

The `MissingGreenlet` error fires only when the lazy attribute is actually accessed and would require a DB round-trip — for users with no `orders`, the access returns the empty collection from the `__initialized` state without a query, so the error does not fire. The intermittency is the diagnostic clue: the failure rate correlates with the percentage of users who have non-empty `orders` collections. Chart the error rate against `users.has_orders` (a boolean column or a derived metric) and the correlation is the proof — if the error rate spikes exactly when the has-orders cohort hits the endpoint, the lazy-load bug is confirmed in 30 seconds, not the hour the wrong-pool-size hypothesis cost. Separately, the `MissingGreenlet` traceback includes the SQL that would have been run — for a `User.password_hash` lazy attribute, the traceback exposes the column name in production logs. Configure `structlog` to redact tracebacks matching `password|token|secret|key|hash` before they reach the log aggregator. See [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] and [[11-Authentication-and-Security/Password-Hashing]].


### Practical example

```python
# Buggy:
async def get_user(id: int) -> User:
 async with AsyncSession(engine) as session:
 return await session.scalar(select(User).where(User.id == id))
# Route: user = await service.get_user(42); return UserOut.model_validate(user)
# UserOut accesses user.orders → MissingGreenlet

# Fixed:
async def get_user_dto(id: int) -> UserOut:
 async with AsyncSession(engine, expire_on_commit=False) as session:
 stmt = select(User).options(selectinload(User.orders)).where(User.id == id)
 user = await session.scalar(stmt)
 return UserOut.model_validate(user) # built inside the session
```

### Common weak answers

- "Increase the pool size." — pool size is unrelated; the session is closed, not exhausted.
- "Add a sleep." — masks the symptom.
- "Use `nest_asyncio`." — band-aid; fix the architecture.

### Follow-up questions

- How do you test for this regression? (`raiseload` in the test session; assertion that no lazy access happens.)
- What is `AsyncAttrs`? (A 2.0+ mixin allowing `await obj.awaitable_attrs.orders` — but only if the session is still open.)
- Where else does this pattern hide? (Background tasks that take ORM objects out of the session; see [[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]] and Q11 of [[FastAPI-and-DI-Questions]].)

Canonical: [[Production-Incidents-Debugging]] (Incident 3), [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[SQLAlchemy-Sessions-Questions]] Q12.

---

## Cross-references

- [[00-Interview-MOC]] — study strategy and the four failure modes.
- [[FastAPI-and-DI-Questions]] — Q4 (yield cleanup runs in async too), Q8 (sync vs async path operations), Q12 (sync driver in async dependency).
- [[SQLAlchemy-Sessions-Questions]] — Q12 (`MissingGreenlet` deep dive), Q14 (async vs sync SQLAlchemy trade-offs).
- [[Production-Incidents-Debugging]] — Incident 3 (leaked session causing `MissingGreenlet`), Incident 6 (PgBouncer compatibility).
- [[20-Exercises-and-Labs/Troubleshooting-Index]] — entry 4 (asyncio.run nested), entry 5 (`MissingGreenlet`).
- [[22-Diagrams/Request-Lifecycle-Diagram]] — where the event loop fits in the request path.

## Verification

Each question's "Practical example" block is runnable as-is. To verify your model answer actually runs (and that you understand the timing claims), scaffold a minimal async project and exercise the patterns. The numbers are the signal — async correctness is verified by wall-clock timing, not by reading the code.

```bash
uv init async-lab
cd async-lab
uv add fastapi==0.148.0 'uvicorn[standard]' sqlalchemy==2.1.5 'asyncpg' pydantic==2.14.1 httpx
uv add --dev pytest pytest-asyncio
```

For Q1 (event loop), Q3 (`gather` vs `create_task`), run the Q1 practical example and time it:

```bash
uv run python -c "
import asyncio, time

async def slow():
    await asyncio.sleep(1)
    return 42

async def main():
    t0 = time.perf_counter()
    results = await asyncio.gather(slow(), slow(), slow())
    elapsed = time.perf_counter() - t0
    print(f'results={results}, elapsed={elapsed:.3f}s')
asyncio.run(main())
"
# Expected: results=[42, 42, 42], elapsed≈1.0s (not 3.0s).
# If elapsed ≈ 3.0s, your three coroutines ran serially — re-read Q3.
```

For Q4 (blocking inside async), measure the loop-latency cost:

```bash
uv run python -c "
import asyncio, time

async def blocking_call():
    time.sleep(1)  # blocks the loop — this is the bug

async def other():
    t0 = time.perf_counter()
    await asyncio.sleep(0.001)
    print(f'other coroutine waited {time.perf_counter()-t0:.3f}s')

async def main():
    asyncio.create_task(other())
    await blocking_call()
asyncio.run(main())
"
# Expected: 'other coroutine waited ~1.000s' (it should have been ~1 ms).
# This is the smoking gun for 'a single sync call in an async handler stalls every other coroutine'.
```

For Q9 (`TaskGroup`), trigger an exception inside a task and watch the `ExceptionGroup`:

```bash
uv run python -c "
import asyncio

async def boom():
    await asyncio.sleep(0.1)
    raise RuntimeError('child failed')

async def main():
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(boom())
            tg.create_task(asyncio.sleep(1))
    except BaseExceptionGroup as eg:
        print(f'caught: {eg.exceptions}')
asyncio.run(main())
"
# Expected: 'caught: (RuntimeError(\"child failed\"),)' and the second task is cancelled.
# If you see 'RuntimeError' alone (not inside a group), you are on Python < 3.11 — re-read Q9.
```

For Q12 (leaked session causing `MissingGreenlet`), use the same reproduction from Q12 of [[SQLAlchemy-Sessions-Questions]] — the two questions are the same failure mode from two angles (async mechanics vs SQLAlchemy session mechanics).

If the timings above match your prediction (and the exception-group shape matches what the model answer said), you have internalised the mechanism. If the timings are off by an order of magnitude, re-read the Q's model answer; the gap is in your mental model of what blocks the loop, not in your recall of the term "event loop."

## Sources

- Python `asyncio` documentation — https://docs.python.org/3/library/asyncio.html — 2026-10-15 — event loop, `gather`, `create_task`, `TaskGroup`, cancellation.
- PEP 654 — Exception Groups and TaskGroup — https://peps.python.org/pep-0654/ — 2026-10-15.
- PEP 703 — Free-threaded CPython — https://peps.python.org/pep-0703/ — 2026-10-15.
- Verified version: Python 3.12 — per [[21-Reference-Library/Source-Register]].
