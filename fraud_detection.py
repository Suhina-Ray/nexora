
"""
Fraud detection logic for the Financial Crime Investigation system.

Pure Python / networkx / sklearn — no Flask here on purpose. Person B should
be able to call compute_risk_scores(accounts, transactions) and get back a
list of accounts with risk_score and reasons, with zero web-framework code
mixed in.
"""

from collections import defaultdict
from datetime import datetime

import networkx as nx
from sklearn.ensemble import IsolationForest
import numpy as np


def _parse_ts(ts):
    return datetime.fromisoformat(ts)


def build_graph(transactions):
    """Builds a directed multigraph: nodes = accounts, edges = transactions."""
    g = nx.MultiDiGraph()
    for t in transactions:
        g.add_edge(t["from"], t["to"], amount=t["amount"], timestamp=t["timestamp"], id=t["id"])
    return g


def find_cycles(graph, max_length=6, max_span_hours=48, max_cycles_to_check=3000):
    """Finds cycles in the transaction graph where money flows back to its
    origin through a chain of accounts (layering).

    Structural cycles alone are noisy in any reasonably dense graph — random
    coincidental loops happen constantly. The thing that actually separates
    a real layering ring from a coincidence is TIME: real layering moves
    fast and in order. So a cycle only counts if its hops occur in roughly
    chronological order within a tight time window.
    """
    flagged = defaultdict(list)
    simple_graph = nx.DiGraph(graph)
    checked = 0

    for cycle in nx.simple_cycles(simple_graph, length_bound=max_length):
        if len(cycle) < 3:
            continue
        checked += 1
        if checked > max_cycles_to_check:
            break

        cycle_nodes = cycle + [cycle[0]]
        hop_times = []
        valid = True
        for i in range(len(cycle_nodes) - 1):
            u, v = cycle_nodes[i], cycle_nodes[i + 1]
            edge_data = graph.get_edge_data(u, v)
            if not edge_data:
                valid = False
                break
            timestamps = [_parse_ts(d["timestamp"]) for d in edge_data.values()]
            hop_times.append(min(timestamps))
        if not valid:
            continue

        is_sequential = all(hop_times[i] <= hop_times[i + 1] for i in range(len(hop_times) - 1))
        span_hours = (max(hop_times) - min(hop_times)).total_seconds() / 3600

        if is_sequential and span_hours <= max_span_hours:
            for acc in cycle:
                flagged[acc].append(
                    f"part of a {len(cycle)}-hop money cycle completed within {span_hours:.1f}h"
                )

    return flagged


def find_fan_patterns(transactions, in_threshold=10, out_threshold=10, window_hours=6):
    """Flags accounts with an abnormal concentration of distinct counterparties
    within a short rolling time window — fast fan-in (smurfing, many senders
    feeding one account) or fast fan-out (one account rapidly splitting funds
    across many recipients). Using a time window (not lifetime degree) is what
    separates a genuinely busy business account from a structuring pattern."""
    by_account_in = defaultdict(list)
    by_account_out = defaultdict(list)
    for t in transactions:
        ts = _parse_ts(t["timestamp"])
        by_account_in[t["to"]].append((ts, t["from"]))
        by_account_out[t["from"]].append((ts, t["to"]))

    flagged = defaultdict(list)
    window_seconds = window_hours * 3600

    def scan(by_account, threshold, label):
        for acc, events in by_account.items():
            events.sort(key=lambda e: e[0])
            left = 0
            for right in range(len(events)):
                while (events[right][0] - events[left][0]).total_seconds() > window_seconds:
                    left += 1
                distinct_cp = len({cp for _, cp in events[left:right + 1]})
                if distinct_cp >= threshold:
                    flagged[acc].append(f"{label} {distinct_cp} distinct accounts within {window_hours}h")
                    break  # one mention per account/direction is enough

    scan(by_account_in, in_threshold, "received transfers from")
    scan(by_account_out, out_threshold, "sent transfers to")
    return flagged


def find_velocity_spikes(transactions, window_hours=1, count_threshold=20):
    """Flags accounts that fire off an unusually large number of transactions
    within a short rolling time window."""
    by_account = defaultdict(list)
    for t in transactions:
        by_account[t["from"]].append(_parse_ts(t["timestamp"]))

    flagged = defaultdict(list)
    window = window_hours * 3600
    for acc, timestamps in by_account.items():
        timestamps.sort()
        left = 0
        for right in range(len(timestamps)):
            while (timestamps[right] - timestamps[left]).total_seconds() > window:
                left += 1
            count_in_window = right - left + 1
            if count_in_window >= count_threshold:
                flagged[acc].append(
                    f"{count_in_window} transactions within a {window_hours}-hour window"
                )
                break
    return flagged


def compute_ml_scores(accounts, transactions):
    """Trains an IsolationForest on per-account transaction features and
    returns a continuous anomaly score (0-100) per account. This is the
    genuine ML component — it catches accounts that look 'weird' even if
    they don't trip any single hand-written rule."""
    by_account_out = defaultdict(list)
    by_account_in = defaultdict(list)
    for t in transactions:
        by_account_out[t["from"]].append(t)
        by_account_in[t["to"]].append(t)

    account_ids = [a["id"] for a in accounts]
    features = []
    for acc_id in account_ids:
        out_txns = by_account_out[acc_id]
        in_txns = by_account_in[acc_id]
        all_txns = out_txns + in_txns
        total_amount = sum(t["amount"] for t in all_txns)
        avg_amount = total_amount / len(all_txns) if all_txns else 0
        txn_count = len(all_txns)
        unique_counterparties = len({t["to"] for t in out_txns} | {t["from"] for t in in_txns})
        in_out_ratio = (len(in_txns) + 1) / (len(out_txns) + 1)
        features.append([total_amount, avg_amount, txn_count, unique_counterparties, in_out_ratio])

    X = np.array(features)
    model = IsolationForest(contamination=0.1, random_state=42)
    model.fit(X)
    raw_scores = model.score_samples(X)  # higher = more normal

    min_s, max_s = raw_scores.min(), raw_scores.max()
    normalized = 100 * (max_s - raw_scores) / (max_s - min_s + 1e-9)

    return dict(zip(account_ids, normalized.tolist()))


def compute_risk_scores(accounts, transactions):
    """Combines rule-based flags and the ML anomaly score into one final
    risk_score (0-100) per account, with human-readable reasons attached.

    Returns: list of {id, name, risk_score, reasons} dicts, matching the
    schema agreed with Person B and Person C.
    """
    graph = build_graph(transactions)

    cycle_flags = find_cycles(graph)
    fan_flags = find_fan_patterns(transactions)
    velocity_flags = find_velocity_spikes(transactions)
    ml_scores = compute_ml_scores(accounts, transactions)

    results = []
    for acc in accounts:
        acc_id = acc["id"]
        reasons = []
        rule_score = 0

        if acc_id in cycle_flags:
            reasons += cycle_flags[acc_id][:1]
            rule_score += 45
        if acc_id in fan_flags:
            reasons += fan_flags[acc_id]
            rule_score += 25 * len(fan_flags[acc_id])
        if acc_id in velocity_flags:
            reasons += velocity_flags[acc_id]
            rule_score += 30

        ml_score = ml_scores.get(acc_id, 0)
        final_score = min(100, round(0.65 * min(rule_score, 100) + 0.35 * ml_score, 1))

        if not reasons and ml_score > 70:
            reasons.append("unusual transaction pattern flagged by anomaly model")

        results.append({
            "id": acc_id,
            "name": acc["name"],
            "risk_score": final_score,
            "reasons": reasons,
        })

    return results