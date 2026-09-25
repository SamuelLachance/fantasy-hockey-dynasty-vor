#!/usr/bin/env python3
"""Build site/data.json: Fantrax points projections for every NHL player.

Pipeline
1. Base projections (GP, G, A, SOG, HIT, BLK; goalie W, SV, SV%, SO) come from
   the stacked-ensemble model of samuellachance/fantasy-hockey-vor (its
   committed players.json). A local copy in data/ is the fallback.
2. The categories that model does not project (primary vs secondary assists,
   takeaways, OT points, hat tricks, skater shutouts, goalie GA / OTW / OTL /
   assists) are derived from each player's last two NHL seasons, shrunk toward
   the position average, plus league-wide rates.
3. In season, season-to-date and last-14-days stats are pulled from the NHL
   stats API and blended with the projection for a rest-of-season rate.
4. Future seasons (dynasty) scale the per-game rate by an age curve.

VOR itself is computed in the browser so the number of teams can change.
Standard library only; every network step degrades to the fallback data.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "site", "data.json")
BASE_URL = (
    "https://raw.githubusercontent.com/samuellachance/fantasy-hockey-vor/"
    "master/src/data/players.json"
)
STATS = "https://api.nhle.com/stats/rest/en"
WEB = "https://api-web.nhle.com/v1"
SEASON_ID = 20262027
SEASON_START = dt.date(2026, 10, 1)
HIST_SEASONS = [20242025, 20252026]
YEARS = 6  # dynasty horizon (this season + 5)
TODAY = dt.datetime.now(dt.timezone(dt.timedelta(hours=-5))).date()

# Fantrax scoring (league image). D-only: blocks, takeaways, skater shutouts.
SK = {"g": 3, "ht": 2, "a1": 2.4, "a2": 1.6, "otp": 0.5, "sog": 0.4,
      "hit": 0.30, "blk": 0.30, "tk": 0.35, "sho": 2}
GO = {"w": 3, "otw": 2, "otl": 1, "ga": -1.5, "sv": 0.27, "so": 3,
      "g": 3, "a": 2}
D_ONLY = {"blk", "tk", "sho"}

# Relative production by age (1.0 = peak). Forwards peak ~26-27,
# defensemen ~27-28, goalies ~29-30. Interpolated between integer ages.
CURVES = {
    "F": {18: .76, 19: .80, 20: .85, 21: .89, 22: .93, 23: .96, 24: .98,
          25: .995, 26: 1, 27: 1, 28: .99, 29: .97, 30: .94, 31: .91,
          32: .87, 33: .83, 34: .78, 35: .73, 36: .68, 37: .62, 38: .56,
          39: .50, 40: .44, 41: .30, 42: 0},
    "D": {18: .68, 19: .72, 20: .77, 21: .82, 22: .87, 23: .91, 24: .94,
          25: .97, 26: .99, 27: 1, 28: 1, 29: .99, 30: .97, 31: .94,
          32: .91, 33: .87, 34: .83, 35: .78, 36: .73, 37: .68, 38: .62,
          39: .56, 40: .50, 41: .35, 42: 0},
    "G": {18: .62, 20: .70, 21: .74, 22: .78, 23: .82, 24: .86, 25: .90,
          26: .93, 27: .96, 28: .98, 29: 1, 30: 1, 31: .99, 32: .97,
          33: .94, 34: .90, 35: .85, 36: .79, 37: .72, 38: .65, 39: .58,
          40: .50, 41: .35, 42: 0},
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get_json(url: str, tries: int = 3):
    if os.environ.get("OFFLINE"):
        return None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fh-dynasty-vor"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                log("  fetch failed:", url[:140], e)
                return None
            time.sleep(2 * (i + 1))


def stats_report(kind: str, report: str, cayenne: str, aggregate: bool = False):
    """Every row of an NHL stats REST report, paginated."""
    rows, start = [], 0
    while True:
        q = {"limit": 100, "start": start, "cayenneExp": cayenne,
             "sort": '[{"property":"playerId","direction":"ASC"}]'}
        if aggregate:
            q.update({"isAggregate": "true", "isGame": "true"})
        data = get_json(f"{STATS}/{kind}/{report}?" + urllib.parse.urlencode(q))
        if not data or "data" not in data:
            return rows if rows else None
        rows.extend(data["data"])
        start += 100
        if start >= data.get("total", 0) or not data["data"]:
            return rows


def by_player(rows):
    out = {}
    for r in rows or []:
        acc = out.setdefault(r["playerId"], {})
        for k, v in r.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool) and k not in ("playerId", "seasonId"):
                acc[k] = acc.get(k, 0) + v
            elif k not in acc:
                acc[k] = v
    return out


def season_cay(season: int) -> str:
    return f"seasonId={season} and gameTypeId=2"


def range_cay(start: dt.date, end: dt.date) -> str:
    return f'gameDate<="{end.isoformat()}" and gameDate>="{start.isoformat()}" and gameTypeId=2'


def skater_block(cay: str, aggregate: bool):
    summ = stats_report("skater", "summary", cay, aggregate)
    if summ is None:
        return None
    spg = stats_report("skater", "scoringpergame", cay, aggregate) or []
    rt = stats_report("skater", "realtime", cay, aggregate) or []
    merged = by_player(summ)
    for src in (by_player(spg), by_player(rt)):
        for pid, d in src.items():
            if pid in merged:
                for k in ("totalPrimaryAssists", "totalSecondaryAssists",
                          "takeaways", "hits", "blockedShots"):
                    if k in d:
                        merged[pid][k] = d[k]
    return merged


def goalie_block(cay: str, aggregate: bool):
    return by_player(stats_report("goalie", "summary", cay, aggregate))


# ---------------------------------------------------------------- helpers

def curve(group: str, age: float) -> float:
    c = CURVES[group]
    ks = sorted(c)
    if age <= ks[0]:
        return c[ks[0]]
    if age >= ks[-1]:
        return c[ks[-1]]
    for lo, hi in zip(ks, ks[1:]):
        if lo <= age <= hi:
            f = (age - lo) / (hi - lo)
            return c[lo] + f * (c[hi] - c[lo])
    return 1.0


def age_on(birth: str | None, when: dt.date) -> float | None:
    if not birth:
        return None
    try:
        b = dt.date.fromisoformat(birth[:10])
    except ValueError:
        return None
    return round((when - b).days / 365.25, 2)


def shrink(num: float, den: float, prior: float, weight: float) -> float:
    return (num + prior * weight) / (den + weight) if den + weight > 0 else prior


def p_hat_trick(lam: float) -> float:
    if lam <= 0:
        return 0.0
    return max(0.0, 1 - math.exp(-lam) * (1 + lam + lam * lam / 2))


def pedigree_growth(pick) -> float:
    if not pick:
        return 1.0
    if pick <= 5:
        return 1.03
    if pick <= 15:
        return 1.02
    if pick <= 32:
        return 1.01
    return 1.0


def skater_points(s: dict, is_d: bool) -> float:
    return sum(SK[k] * v for k, v in s.items() if k in SK and (is_d or k not in D_ONLY))


def goalie_points(s: dict) -> float:
    return sum(GO[k] * v for k, v in s.items() if k in GO)


# ------------------------------------------------------------------- main

def main():
    log("base projections…")
    base = get_json(BASE_URL)
    if not base or "players" not in base:
        log("  using local copy")
        base = json.load(open(os.path.join(ROOT, "data", "base-projections.json")))
    bios = json.load(open(os.path.join(ROOT, "data", "bios-fallback.json")))

    log("history…")
    hist_sk, hist_go, bio_rows = {}, {}, {}
    for s in HIST_SEASONS:
        blk = skater_block(season_cay(s), False) or {}
        for pid, d in blk.items():
            acc = hist_sk.setdefault(pid, {})
            for k, v in d.items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    acc[k] = acc.get(k, 0) + v
                elif isinstance(v, str):
                    acc[k] = v  # keep positionCode etc.
        for pid, d in (goalie_block(season_cay(s), False) or {}).items():
            acc = hist_go.setdefault(pid, {})
            for k, v in d.items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    acc[k] = acc.get(k, 0) + v
                elif isinstance(v, str):
                    acc[k] = v  # keep positionCode etc.
        for kind in ("skater", "goalie"):
            for r in stats_report(kind, "bios", season_cay(s)) or []:
                bio_rows[r["playerId"]] = r

    # League-wide rates (fallbacks are typical NHL values)
    def tot(d, k):
        return sum(v.get(k, 0) for v in d.values())

    n_ast = tot(hist_sk, "assists")
    a1_f = a1_d = 0.55
    if n_ast > 1000:
        fa = [v for v in hist_sk.values() if v.get("positionCode") != "D"]
        da = [v for v in hist_sk.values() if v.get("positionCode") == "D"]
        a1_f = sum(v.get("totalPrimaryAssists", 0) for v in fa) / max(1, sum(v.get("assists", 0) for v in fa))
        a1_d = sum(v.get("totalPrimaryAssists", 0) for v in da) / max(1, sum(v.get("assists", 0) for v in da))
    if not 0.35 < a1_f < 0.75:
        a1_f = 0.55
    if not 0.30 < a1_d < 0.70:
        a1_d = 0.47
    d_rows = [v for v in hist_sk.values() if v.get("positionCode") == "D"]
    tk_d = (sum(v.get("takeaways", 0) for v in d_rows) / max(1, sum(v.get("gamesPlayed", 0) for v in d_rows))) if d_rows else 0.28
    ot_share = (tot(hist_sk, "otGoals") / tot(hist_sk, "goals")) if tot(hist_sk, "goals") > 1000 else 0.022
    g_ast = (tot(hist_go, "assists") / max(1, tot(hist_go, "gamesPlayed"))) if hist_go else 0.03

    log("standings / team shutouts…")
    standings = (get_json(f"{WEB}/standings/{min(TODAY, dt.date(2026, 4, 16)).isoformat()}") or {}).get("standings", [])
    games = sum(t.get("gamesPlayed", 0) for t in standings)
    ot_games = sum(t.get("wins", 0) - t.get("regulationWins", 0) for t in standings)
    ot_game_share = (ot_games / (games / 2)) if games > 500 else 0.23
    team_so_rate = {}
    last = goalie_block(season_cay(HIST_SEASONS[-1]), False) or {}
    for g in last.values():
        t = str(g.get("teamAbbrevs", "")).split(",")[-1]
        team_so_rate[t] = team_so_rate.get(t, 0) + g.get("shutouts", 0)
    league_so = (sum(team_so_rate.values()) / (82 * max(1, len(team_so_rate)))) if team_so_rate else 0.075
    team_so_rate = {t: (v / 82 + league_so) / 2 for t, v in team_so_rate.items()}

    log("season to date / last 14 days…")
    cur_sk = cur_go = l14_sk = l14_go = {}
    team_gp = {}
    if TODAY >= dt.date(2026, 10, 7):
        cur_sk = skater_block(season_cay(SEASON_ID), False) or {}
        cur_go = goalie_block(season_cay(SEASON_ID), False) or {}
        rng = range_cay(TODAY - dt.timedelta(days=14), TODAY)
        l14_sk = skater_block(rng, True) or {}
        l14_go = goalie_block(rng, True) or {}
        now = (get_json(f"{WEB}/standings/now") or {}).get("standings", [])
        team_gp = {t["teamAbbrev"]["default"]: t.get("gamesPlayed", 0) for t in now}
        cur_team_so = {}
        for g in cur_go.values():
            t = str(g.get("teamAbbrevs", "")).split(",")[-1]
            cur_team_so[t] = cur_team_so.get(t, 0) + g.get("shutouts", 0)
    else:
        cur_team_so = {}

    log("schedule…")
    sched = {}
    d = TODAY
    for _ in range(3):
        wk = get_json(f"{WEB}/schedule/{d.isoformat()}")
        if not wk:
            break
        for day in wk.get("gameWeek", []):
            for gm in day.get("games", []):
                if gm.get("gameType") != 2:
                    continue
                a, h = gm["awayTeam"]["abbrev"], gm["homeTeam"]["abbrev"]
                sched.setdefault(day["date"], []).append([a, h])
        nxt = wk.get("nextStartDate")
        if not nxt:
            break
        d = dt.date.fromisoformat(nxt)

    # ------------------------------------------------------------ players
    players = []
    for p in base["players"]:
        pid = p["id"]
        br = bio_rows.get(pid, {})
        fb = bios.get(str(pid), {})
        birth = br.get("birthDate") or fb.get("b")
        pick = br.get("draftOverall") or fb.get("d")
        age = age_on(birth, SEASON_START)
        now_age = age_on(birth, TODAY)
        pos = sorted({"W" if x in ("LW", "RW") else x for x in (p.get("positions") or [p["position"]])},
                     key="CWDG".index)
        prim = p.get("primaryPosition") or p["position"]
        is_g = p["isGoalie"]
        is_d = prim == "D" or pos == ["D"]
        group = "G" if is_g else ("D" if is_d else "F")
        gp = p.get("gamesPlayed") or 0
        pr = p["projection"]
        team = p.get("team", "")

        if is_g:
            w = pr.get("wins", 0)
            sv = pr.get("saves", 0)
            svp = pr.get("savePct", 0.9) or 0.9
            h = hist_go.get(pid, {})
            proj = {
                "w": w, "otw": w * ot_game_share,
                "otl": max(0.0, gp - w) * ot_game_share,
                "ga": sv * (1 - svp) / svp, "sv": sv, "so": pr.get("shutouts", 0),
                "g": 0.0,
                "a": gp * shrink(h.get("assists", 0), h.get("gamesPlayed", 0), g_ast, 60),
            }
            fp = goalie_points(proj)
        else:
            h = hist_sk.get(pid, {})
            g_, a = pr.get("goals", 0), pr.get("assists", 0)
            a1s = shrink(h.get("totalPrimaryAssists", 0), h.get("assists", 0), a1_d if is_d else a1_f, 30)
            tk = shrink(h.get("takeaways", 0), h.get("gamesPlayed", 0), tk_d, 60) if is_d else 0
            lam = g_ / gp if gp else 0
            proj = {
                "g": g_, "ht": gp * p_hat_trick(lam), "a1": a * a1s, "a2": a * (1 - a1s),
                "otp": (g_ + a) * ot_share,  # league share of scoring that happens in OT
                "sog": pr.get("shots", 0), "hit": pr.get("hits", 0),
                "blk": pr.get("blocks", 0) if is_d else 0,
                "tk": gp * tk,
                "sho": gp * team_so_rate.get(team, league_so) if is_d else 0,
            }
            fp = skater_points(proj, is_d)

        # ------------------------------ in-season: actuals and blended rate
        def actual(src, key_team=True):
            s = src.get(pid)
            if not s:
                return None
            n = s.get("gamesPlayed", 0)
            if is_g:
                st = {"w": s.get("wins", 0), "otw": s.get("wins", 0) * ot_game_share,
                      "otl": s.get("otLosses", 0), "ga": s.get("goalsAgainst", 0),
                      "sv": s.get("saves", 0), "so": s.get("shutouts", 0),
                      "g": s.get("goals", 0), "a": s.get("assists", 0)}
                return n, goalie_points(st)
            a1 = s.get("totalPrimaryAssists")
            a_ = s.get("assists", 0)
            if a1 is None:
                a1 = a_ * (a1_d if is_d else a1_f)
            st = {"g": s.get("goals", 0), "a1": a1, "a2": a_ - a1,
                  "otp": (s.get("goals", 0) + a_) * ot_share, "sog": s.get("shots", 0),
                  "hit": s.get("hits", 0), "blk": s.get("blockedShots", 0),
                  "tk": s.get("takeaways", 0),
                  "ht": n * p_hat_trick(s.get("goals", 0) / n) if n else 0}
            if is_d and key_team and team_gp.get(team):
                st["sho"] = cur_team_so.get(team, 0) * min(1, n / team_gp[team])
            return n, skater_points(st, is_d)

        cur = actual(cur_sk if not is_g else cur_go)
        l14 = actual(l14_sk if not is_g else l14_go, key_team=False)
        rate_proj = fp / gp if gp else 0
        tgp = team_gp.get(team, 0)
        if cur and cur[0]:
            k = 25  # prior games for the projection
            rate = (rate_proj * k + cur[1]) / (k + cur[0])
            ros_gp = gp * max(0, 82 - tgp) / 82
            season_fp = cur[1] + rate * ros_gp
        else:
            rate = rate_proj
            ros_gp = gp * max(0, 82 - tgp) / 82
            season_fp = fp

        rec = {
            "id": pid, "n": p["name"], "t": team, "p": pos, "grp": group,
            "age": now_age, "a0": age, "b": birth, "dp": pick,
            "gp": gp, "fp": round(fp, 1), "fpg": round(rate_proj, 3),
            "rate": round(rate, 3), "rosgp": round(ros_gp, 1),
            "fpy": [round(season_fp, 1)], "m": p.get("projectionMethod", ""),
            "s": {k: round(v, 1) for k, v in proj.items()},
        }
        if cur:
            rec["cur"] = [cur[0], round(cur[1], 1)]
        if l14:
            rec["l14"] = [l14[0], round(l14[1], 1)]
        players.append(rec)

    # ------------------------------------------------------ dynasty years
    # Future per-game rate = current blended rate x age-curve ratio, with a
    # small draft-pedigree boost until 23, capped at the best current rate
    # in the group (+5%) so a young star isn't projected past any real one.
    cap_rate = {}
    for r in players:
        if r["gp"] >= (45 if r["grp"] == "G" else 60):
            cap_rate[r["grp"]] = max(cap_rate.get(r["grp"], 0), r["rate"] * 1.05)
    for r in players:
        group, age, gp, rate = r["grp"], r["a0"], r["gp"], r["rate"]
        c0 = curve(group, age) if age else 1
        growth = pedigree_growth(r["dp"])
        full_gp = 52 if group == "G" else 76
        for t in range(1, YEARS):
            if age is None:
                ratio = 1.0
            else:
                ratio = curve(group, age + t) / c0 if c0 else 0
                ratio *= growth ** max(0, min(t, 23 - age))
            # Young players on a partial workload grow into a full one;
            # established part-timers (backup goalies, depth) keep theirs.
            young = age is not None and age <= (26 if group == "G" else 23)
            if young and gp < full_gp:
                ramp = 3 if group == "G" else 2
                gp_t = min(full_gp, gp + (full_gp - gp) * min(1, t / ramp))
            else:
                gp_t = gp
            r["fpy"].append(round(min(rate * ratio, cap_rate.get(group, 99)) * gp_t, 1))

    out = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "today": TODAY.isoformat(),
        "season": "2026-27",
        "baseGeneratedAt": base.get("generatedAt"),
        "scoring": {"skater": SK, "goalie": GO},
        "rates": {"a1F": round(a1_f, 3), "a1D": round(a1_d, 3), "tkD": round(tk_d, 3),
                  "otShare": round(ot_share, 4), "otGameShare": round(ot_game_share, 3),
                  "leagueSO": round(league_so, 3)},
        "schedule": sched,
        "players": players,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    log(f"wrote {len(players)} players, {len(sched)} schedule days")


if __name__ == "__main__":
    main()
