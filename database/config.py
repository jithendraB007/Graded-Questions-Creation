import os
from psycopg2 import pool
from pgvector.psycopg2 import register_vector

DB_CONFIG = {
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     int(os.getenv("DB_PORT", "5432")),
    "dbname":   os.getenv("DB_NAME", "questions_db"),
    "user":     os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", ""),
}

# Render hosted PostgreSQL requires SSL — local Docker does not
if os.getenv("DB_HOST", "localhost") not in ("localhost", "127.0.0.1"):
    DB_CONFIG["sslmode"] = "require"

# Connection pool — reuse connections instead of opening new ones
connection_pool = pool.SimpleConnectionPool(
    minconn=1,
    maxconn=10,
    **DB_CONFIG
)

def get_connection():
    conn = connection_pool.getconn()
    register_vector(conn)
    return conn

def release_connection(conn):
    connection_pool.putconn(conn)
