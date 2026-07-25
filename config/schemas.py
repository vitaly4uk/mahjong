"""Pydantic/ninja request/response schemas for `config/api.py`."""
from ninja import Schema


class BackgroundResponse(Schema):
    url: str | None
    photographer: str | None = None
    photographer_url: str | None = None


class VersionResponse(Schema):
    version: str
