"""
app.py — Flask REST API for the Financial Crime Investigation system.

Endpoints
---------
GET /accounts          → all accounts with risk scores + reasons
GET /transactions      → all raw transactions
GET /accounts/<id>     → one account: risk score, reasons, related transactions

Design notes
------------
- data.json + risk scores are computed ONCE at startup (startup_data dict).
  Every request reads from this in-memory cache — no disk I/O per request.
- CORS is open so the React frontend on any port can connect without proxy config.
- All error responses are JSON, never HTML, so the frontend can always parse them.
"""

import json
import sys
from flask import Flask, jsonify, abort
from flask_cors import CORS

from fraud_detection import compute_risk_scores

app = Flask(__name__)
CORS(app)  # allow all origins — tighten to origins=["http://localhost:5173"] for prod

# ── Startup: load data + run detection once ────────────────────────────────────

def _load():
    """
    Load data.json and run the full detection pipeline.
    Returns a dict with everything pre-indexed for O(1) lookups at request time.
    """
    try:
        with open("data.json") as f:
            raw = json.load(f)
    except FileNotFoundError:
        print("ERROR: data.json not found — make sure it's in the same directory as app.py")
        sys.exit(1)

    accounts_raw: list[dict] = raw["accounts"]
    transactions: list[dict] = raw["transactions"]

    # Run fraud detection — this is the expensive step (IsolationForest + graph)
    print(f"Running detection on {len(accounts_raw)} accounts and {len(transactions)} transactions…")
    scored: list[dict] = compute_risk_scores(accounts_raw, transactions)
    print(f"Detection complete. Top risk score: {max(a['risk_score'] for a in scored):.1f}")

    # Index for fast lookups
    accounts_by_id: dict[str, dict] = {a["id"]: a for a in scored}

    # Pre-group transactions by account (sender + receiver)
    txns_by_account: dict[str, list[dict]] = {a["id"]: [] for a in scored}
    for t in transactions:
        if t["from"] in txns_by_account:
            txns_by_account[t["from"]].append(t)
        if t["to"] in txns_by_account:
            txns_by_account[t["to"]].append(t)

    return {
        "accounts": scored,                 # full list, sorted by risk desc
        "accounts_by_id": accounts_by_id,
        "transactions": transactions,
        "txns_by_account": txns_by_account,
    }


# Module-level cache — populated once when the process starts
DATA = _load()


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/accounts")
def get_accounts():
    """
    Returns all accounts sorted by risk_score descending.

    Response shape:
    [
      { "id": "...", "name": "...", "risk_score": 0-100, "reasons": ["..."] },
      ...
    ]
    """
    sorted_accounts = sorted(DATA["accounts"], key=lambda a: a["risk_score"], reverse=True)
    return jsonify(sorted_accounts)


@app.get("/transactions")
def get_transactions():
    """
    Returns all transactions sorted by timestamp descending (most recent first).

    Response shape:
    [
      { "id": "...", "from": "acc_x", "to": "acc_y", "amount": 4500, "timestamp": "..." },
      ...
    ]
    """
    sorted_txns = sorted(DATA["transactions"], key=lambda t: t["timestamp"], reverse=True)
    return jsonify(sorted_txns)


@app.get("/accounts/<account_id>")
def get_account(account_id: str):
    """
    Returns one account with its risk score, reasons, and full transaction history.

    Response shape:
    {
      "id": "...",
      "name": "...",
      "risk_score": 0-100,
      "reasons": ["..."],
      "transactions": [
        { "id": "...", "from": "...", "to": "...", "amount": ..., "timestamp": "..." },
        ...
      ]
    }

    404 if account_id doesn't exist.
    """
    account = DATA["accounts_by_id"].get(account_id)
    if account is None:
        abort(404, description=f"Account '{account_id}' not found.")

    related_txns = sorted(
        DATA["txns_by_account"].get(account_id, []),
        key=lambda t: t["timestamp"],
        reverse=True,
    )

    return jsonify({**account, "transactions": related_txns})


# ── Error handlers (always JSON, never Flask's default HTML) ──────────────────

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "not_found", "message": str(e.description)}), 404


@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({"error": "method_not_allowed", "message": str(e.description)}), 405


@app.errorhandler(500)
def internal_error(e):
    return jsonify({"error": "internal_server_error", "message": str(e.description)}), 500


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(port=5000, debug=True)
