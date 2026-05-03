"""FastAPI dependency functions."""

from typing import Annotated

import aiosqlite
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import auth
import database

_bearer = HTTPBearer(auto_error=False)


async def get_db() -> aiosqlite.Connection:
    return database.get()


async def get_current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> dict:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing token")

    payload = auth.decode_app_token(creds.credentials)
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")

    return payload


async def require_admin(
    user: Annotated[dict, Depends(get_current_user)],
) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    return user


# Convenience type aliases for route signatures
DB      = Annotated[aiosqlite.Connection, Depends(get_db)]
User    = Annotated[dict, Depends(get_current_user)]
Admin   = Annotated[dict, Depends(require_admin)]
