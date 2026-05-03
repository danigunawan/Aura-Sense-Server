import asyncio
import logging
from functools import wraps
from typing import Tuple, Type

log = logging.getLogger(__name__)


def async_retry(
    max_attempts: int = 3,
    base_delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: Tuple[Type[Exception], ...] = (Exception,),
):
    """Exponential-backoff retry for async functions."""
    def decorator(fn):
        @wraps(fn)
        async def wrapper(*args, **kwargs):
            delay = base_delay
            last_exc: Exception | None = None

            for attempt in range(1, max_attempts + 1):
                try:
                    return await fn(*args, **kwargs)
                except exceptions as exc:
                    last_exc = exc
                    if attempt == max_attempts:
                        break
                    log.warning(
                        "%s attempt %d/%d failed: %s — retrying in %.1fs",
                        fn.__qualname__, attempt, max_attempts, exc, delay,
                    )
                    await asyncio.sleep(delay)
                    delay *= backoff

            log.error("%s failed after %d attempts: %s", fn.__qualname__, max_attempts, last_exc)
            raise last_exc  # type: ignore[misc]

        return wrapper
    return decorator


def sync_retry(
    max_attempts: int = 3,
    base_delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: Tuple[Type[Exception], ...] = (Exception,),
):
    """Exponential-backoff retry for blocking functions (used inside executor threads)."""
    import time

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            delay = base_delay
            last_exc: Exception | None = None

            for attempt in range(1, max_attempts + 1):
                try:
                    return fn(*args, **kwargs)
                except exceptions as exc:
                    last_exc = exc
                    if attempt == max_attempts:
                        break
                    log.warning(
                        "%s attempt %d/%d failed: %s — retrying in %.1fs",
                        fn.__qualname__, attempt, max_attempts, exc, delay,
                    )
                    time.sleep(delay)
                    delay *= backoff

            raise last_exc  # type: ignore[misc]

        return wrapper
    return decorator
