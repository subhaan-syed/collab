"""
Application settings loaded from environment variables.
In development, values are read from a .env file at the project root.
In Docker, they are supplied via docker-compose environment: keys.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # PostgreSQL (asyncpg DSN)
    database_url: str = "postgresql://collab:collab@localhost:5432/collab"

    # MongoDB (Motor)
    mongodb_url: str = "mongodb://localhost:27017"
    mongodb_db_name: str = "collab"

    # CORS — comma-separated list of allowed origins
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
