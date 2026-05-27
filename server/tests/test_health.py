from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)


def test_healthz_returns_ok():
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_root_returns_service_info():
    r = client.get("/")
    assert r.status_code == 200
    assert r.json()["service"] == "budsai-prototype-server"
