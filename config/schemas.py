"""Pydantic/ninja-схеми запитів і відповідей для `config/api.py`."""
from ninja import Schema


class BackgroundResponse(Schema):
    url: str | None
    photographer: str | None = None
    photographer_url: str | None = None


class VersionResponse(Schema):
    version: str
