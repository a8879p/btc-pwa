"""
Недельный прогноз BTC/ETH: вероятности лонг/флэт/шорт + риск-вероятности под вашу стратегию.

Выдаёт в процентах:
  1) P(шорт) / P(флэт) / P(лонг) через 7 дней (порог = THETA_K * недельная волатильность)
  2) P(просадка лонга): цена за неделю хоть раз опустится на LONG_DD% ниже входа
  3) P(стоп шорта): цена за неделю хоть раз вырастет на SHORT_STOP% выше входа

Запуск:  pip install -r requirements.txt
         python btc_weekly_model.py                       (BTC, только отчёт в консоль)
         python btc_weekly_model.py ETH/USDT              (ETH)
         python btc_weekly_model.py BTC/USDT ETH/USDT --out ../web/data   (+ JSON для PWA)
         python btc_weekly_model.py --demo --out ../web/data              (синтетика, без сети)

Что пишется в --out:
  index.json                    список инструментов
  <BTC-USDT>/forecast.json      прогноз на сегодня + метрики + калибровка
  <BTC-USDT>/history.json       каждый прогноз и, когда пройдёт неделя, что случилось на самом деле

Признаки ликвидаций Coinglass: положите CSV (колонка date + любые числовые колонки)
и укажите путь в LIQ_CSV (переменная окружения или константа ниже). Они подмешаются
к признакам автоматически.
Примеры колонок: liq_above_pct (доля кластеров ликвидаций выше цены),
dist_cluster_up, dist_cluster_down (расстояние до ближайшего крупного кластера, %).
"""
import argparse
import json
import os
import sys
import time
import zlib
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import lightgbm as lgb

H = 7                 # горизонт, дней
THETA_K = 0.5         # порог флэта = THETA_K * недельная сигма
LONG_DD = 0.15        # просадка для лонга, при которой "плохо" (подставьте расстояние до ликвидации)
SHORT_STOP = 0.10     # ваш стоп для шорта
LIQ_CSV = os.environ.get("LIQ_CSV")   # например "coinglass_liq.csv"
START = "2019-10-01"
MIN_TRAIN = 730       # дней до первого прогноза
STEP = 28             # переобучение раз в 4 недели

SEED_DAYS = 90        # сколько дней бэктеста подложить в историю при первом запуске
RECENT = 365          # окно для метрик "последние 12 месяцев"
STALE_DAYS = 3        # последняя закрытая свеча старше этого - данные считаем протухшими

# Источники свечей по порядку. С серверов в США Binance и Bybit часто отвечают 451/403 -
# тогда сработает Bitstamp (спот BTC/USD). Какой источник использован, пишется в forecast.json.
SOURCES = [("binanceusdm", "{b}/USDT"), ("bybit", "{b}/USDT"), ("bitstamp", "{b}/USD")]


# ---------- данные ----------
def _retry(fn, tries=3):
    import ccxt
    for k in range(tries):
        try:
            return fn()
        except ccxt.NetworkError:
            if k == tries - 1:
                raise
            time.sleep(2 * (k + 1))


def _fetch_all(ex, sym):
    since = ex.parse8601(START + "T00:00:00Z")
    now_ms = int(time.time() * 1000)
    rows, last = [], None
    while True:
        batch = _retry(lambda: ex.fetch_ohlcv(sym, "1d", since=since, limit=1000))
        if not batch or batch[-1][0] == last:
            break
        rows += batch
        last = batch[-1][0]
        since = last + 86_400_000
        if since > now_ms or len(batch) < 2:
            break
    return rows


def _to_frame(rows):
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df.index = pd.to_datetime(df.pop("ts"), unit="ms").dt.normalize()
    return df[~df.index.duplicated()].sort_index().astype(float)


def _today_utc():
    return pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()


def _closed_only(df):
    """Дневная свеча за сегодня ещё не закрыта - в обучение и в прогноз она не годится."""
    df = df[df.index < _today_utc()]
    age = (_today_utc() - df.index[-1]).days
    if age > STALE_DAYS:
        raise RuntimeError(f"последняя закрытая свеча {df.index[-1].date()} ({age} дн. назад) - биржа отдаёт устаревшие данные")
    return df


def load_data(symbol, source=None):
    import ccxt
    base = symbol.split("/")[0]
    errors = []
    for ex_id, tpl in SOURCES:
        if source and ex_id != source:
            continue
        try:
            ex = getattr(ccxt, ex_id)({"enableRateLimit": True})
            df = _to_frame(_fetch_all(ex, tpl.format(b=base)))
            if len(df) < MIN_TRAIN + 200:
                raise RuntimeError(f"слишком мало свечей: {len(df)}")
            return _closed_only(df), ex_id
        except Exception as e:  # noqa: BLE001 - любая ошибка биржи = пробуем следующую
            errors.append(f"{ex_id}: {type(e).__name__}: {str(e)[:140]}")
    raise RuntimeError("Свечи не загрузились ни с одной биржи:\n  " + "\n  ".join(errors))


def demo_data(symbol, n=2500):
    """Синтетика для проверки пайплайна без сети: случайное блуждание с кластерами волатильности."""
    rng = np.random.default_rng(zlib.crc32(symbol.encode()))
    lv = np.zeros(n)
    for t in range(1, n):
        lv[t] = 0.97 * lv[t - 1] + 0.18 * rng.standard_normal()
    sig = 0.022 * np.exp(lv)
    z = rng.standard_t(5, n) / np.sqrt(5 / 3)
    close = (8000 if symbol.startswith("BTC") else 180) * np.exp(np.cumsum(0.0005 + sig * z))
    opn = np.r_[close[0], close[:-1]]
    high = np.maximum(opn, close) * (1 + np.abs(rng.standard_normal(n)) * sig * 0.5)
    low = np.minimum(opn, close) * (1 - np.abs(rng.standard_normal(n)) * sig * 0.5)
    vol = 1e4 * np.exp(0.6 * lv + 0.3 * rng.standard_normal(n))
    idx = pd.date_range(end=_today_utc() - pd.Timedelta(days=1), periods=n, freq="D")
    return pd.DataFrame({"open": opn, "high": high, "low": low, "close": close, "volume": vol}, index=idx)


# ---------- признаки ----------
def rsi(c, n):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn)


def stoch(df, n, k, d):
    ll, hh = df["low"].rolling(n).min(), df["high"].rolling(n).max()
    K = (100 * (df["close"] - ll) / (hh - ll)).rolling(k).mean()
    return K, K.rolling(d).mean()


def make_features(df):
    c = df["close"]
    r = np.log(c).diff()
    X = pd.DataFrame(index=df.index)
    # дневной масштаб
    X["rsi14"] = rsi(c, 14)
    X["stK14"], X["stD14"] = stoch(df, 14, 3, 3)
    # недельный масштаб (окна x7 на дневных данных, без заглядывания вперёд)
    X["rsi_w"] = rsi(c, 14 * 7)
    X["stK_w"], X["stD_w"] = stoch(df, 14 * 7, 7, 7)
    X["stK_cross"] = X["stK14"] - X["stD14"]
    X["stK_w_cross"] = X["stK_w"] - X["stD_w"]
    for n in (1, 3, 7, 14, 30, 90):
        X[f"ret{n}"] = c.pct_change(n)
    X["vol7"] = r.rolling(7).std()
    X["vol30"] = r.rolling(30).std()
    X["vol_ratio"] = X["vol7"] / X["vol30"]
    for n in (20, 50, 200):
        X[f"dist_ma{n}"] = c / c.rolling(n).mean() - 1
    X["dist_high90"] = c / df["high"].rolling(90).max() - 1
    X["dist_low90"] = c / df["low"].rolling(90).min() - 1
    X["vol_chg"] = df["volume"].rolling(7).mean() / df["volume"].rolling(60).mean() - 1
    X["dow"] = df.index.dayofweek
    if LIQ_CSV:
        liq = pd.read_csv(LIQ_CSV, parse_dates=["date"]).set_index("date")
        X = X.join(liq, how="left").ffill()
    return X


# ---------- метки ----------
def realized(df):
    """Что реально произошло за H дней после каждой даты (NaN в последние H дней)."""
    c, lo, hi = df["close"], df["low"], df["high"]
    sigma_w = np.log(c).diff().rolling(30).std() * np.sqrt(H)
    # экстремумы за дни t+1..t+H
    fmin = lo[::-1].rolling(H).min()[::-1].shift(-1)
    fmax = hi[::-1].rolling(H).max()[::-1].shift(-1)
    return pd.DataFrame({"ret": c.shift(-H) / c - 1, "theta": THETA_K * sigma_w,
                         "min": fmin / c - 1, "max": fmax / c - 1})


def make_labels(df):
    R = realized(df)
    y3 = pd.Series(1, index=df.index)           # 0=шорт, 1=флэт, 2=лонг
    y3[R["ret"] > R["theta"]] = 2
    y3[R["ret"] < -R["theta"]] = 0
    y_dd = (R["min"] < -LONG_DD).astype(int)
    y_stop = (R["max"] > SHORT_STOP).astype(int)
    valid = R.notna().all(axis=1)
    return y3, y_dd, y_stop, valid


# ---------- модель ----------
PARAMS = dict(n_estimators=250, learning_rate=0.03, num_leaves=8, min_child_samples=50,
              subsample=0.8, subsample_freq=1, colsample_bytree=0.7,
              reg_lambda=5.0, verbose=-1)


def fit_predict(Xtr, ytr, Xte, n_classes):
    """Возвращает (n_test, n_classes) вероятностей; при нехватке классов - частоты."""
    prior = np.bincount(ytr, minlength=n_classes) / len(ytr)
    if (prior > 0).sum() < 2:
        return np.tile(prior, (len(Xte), 1)), prior
    obj = dict(objective="multiclass", num_class=n_classes) if n_classes > 2 else dict(objective="binary")
    m = lgb.LGBMClassifier(**obj, **PARAMS).fit(Xtr, ytr)
    p = m.predict_proba(Xte)
    full = np.zeros((len(Xte), n_classes))
    full[:, m.classes_] = p
    return full, prior


def walk_forward(X, y, n_classes):
    idx = np.arange(len(X))
    P = np.full((len(X), n_classes), np.nan)
    B = np.full((len(X), n_classes), np.nan)
    for i in range(MIN_TRAIN, len(X), STEP):
        tr = idx[: i - H]                      # purge: метки соседних дней перекрываются на H дней
        te = idx[i: i + STEP]
        if len(te) == 0:
            break
        p, prior = fit_predict(X.iloc[tr], y.iloc[tr].values, X.iloc[te], n_classes)
        P[te], B[te] = p, prior
    ok = ~np.isnan(P[:, 0])
    return P[ok], B[ok], y.values[ok], X.index[ok]


# ---------- метрики ----------
def logloss(y, P):
    y = np.asarray(y, dtype=int)
    return float(-np.mean(np.log(np.clip(np.asarray(P)[np.arange(len(y)), y], 1e-15, 1))))


def brier(y, p):
    return float(np.mean((np.asarray(p, dtype=float) - np.asarray(y, dtype=float)) ** 2))


def calib_table(p, y, bins=(0, .1, .2, .3, .4, .5, .6, .7, .8, 1.01)):
    cut = pd.cut(p, bins, right=False)
    t = pd.DataFrame({"pred": p, "real": y, "bin": cut}).groupby("bin", observed=True).agg(
        n=("real", "size"), pred=("pred", "mean"), real=("real", "mean"))
    return t[t.n >= 20].round(3)


def calib_records(p, y):
    t = calib_table(p, y)
    return [{"lo": round(float(i.left), 2), "hi": round(min(float(i.right), 1.0), 2), "n": int(r.n),
             "pred": float(r.pred), "real": float(r.real)} for i, r in t.iterrows()]


def r4(x):
    x = float(x)
    return round(x, 4) if np.isfinite(x) else None


def metric_pair(kind, y, P, B, last=None):
    """kind: 'dir' (log loss, 3 класса) или 'bin' (Brier, P = вероятность события)."""
    if last:
        y, P, B = y[-last:], P[-last:], B[-last:]
    if len(y) == 0:
        return None
    if kind == "dir":
        return {"n": int(len(y)), "model": r4(logloss(y, P)), "base": r4(logloss(y, B))}
    return {"n": int(len(y)), "model": r4(brier(y, P)), "base": r4(brier(y, B))}


# ---------- история ----------
def _entry_out(d, R, y3, y_dd, y_stop):
    return {"ret": r4(R["ret"][d]), "cls": int(y3[d]), "min": r4(R["min"][d]), "max": r4(R["max"][d]),
            "dd_hit": int(y_dd[d]), "stop_hit": int(y_stop[d])}


def load_history(path, demo):
    try:
        with open(path, encoding="utf-8") as f:
            h = json.load(f)
        if h.get("demo") == demo:
            return {e["asof"]: e for e in h["entries"]}
    except (OSError, ValueError, KeyError):
        pass
    return {}   # нет файла или он от демо/боевого режима другого типа - начинаем с нуля


def save_json(path, obj, one_per_line=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if one_per_line:   # history: одна запись на строку, чтобы diff в git был читаемым
            head = {k: v for k, v in obj.items() if k != one_per_line}
            f.write(json.dumps(head, ensure_ascii=False, separators=(",", ":"))[:-1] + f',"{one_per_line}":[\n')
            f.write(",\n".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in obj[one_per_line]))
            f.write("\n]}\n")
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
            f.write("\n")
    os.replace(tmp, path)


def live_metrics(entries):
    """Метрики только по живым прогнозам, итог которых уже известен."""
    done = [e for e in entries if e["src"] == "live" and e.get("out")]
    if not done:
        return {"direction": None, "long_drawdown": None, "short_stop": None}
    y = np.array([e["out"]["cls"] for e in done])
    P = np.array([e["p"] for e in done])
    B = np.array([e["base"]["dir"] for e in done])
    out = {"direction": metric_pair("dir", y, P, B)}
    for key, pk, bk, hk in (("long_drawdown", "dd", "dd", "dd_hit"), ("short_stop", "stop", "stop", "stop_hit")):
        out[key] = metric_pair("bin", np.array([e["out"][hk] for e in done]),
                               np.array([e[pk] for e in done]), np.array([e["base"][bk] for e in done]))
    return out


# ---------- один инструмент ----------
def run_symbol(symbol, out_dir=None, demo=False, force=False, source=None):
    df, src = (demo_data(symbol), "demo") if demo else load_data(symbol, source)
    X = make_features(df)
    y3, y_dd, y_stop, valid = make_labels(df)
    R = realized(df)
    last_x = X.iloc[[-1]]
    Xv = X[valid].dropna()
    y3, y_dd, y_stop = y3.loc[Xv.index], y_dd.loc[Xv.index], y_stop.loc[Xv.index]
    print(f"{symbol}: {len(Xv)} размеченных дней, признаков: {Xv.shape[1]}, источник: {src}\n")

    # --- 3 класса ---
    P, B, yt, dates = walk_forward(Xv, y3, 3)
    m_dir = {"all": metric_pair("dir", yt, P, B), "recent": metric_pair("dir", yt, P, B, RECENT)}
    print("== Направление (шорт/флэт/лонг), walk-forward ==")
    print(f"log loss модели : {m_dir['all']['model']:.4f}")
    print(f"log loss базы   : {m_dir['all']['base']:.4f}   (база = частоты классов в обучении)")
    print("Калибровка P(лонг):\n", calib_table(P[:, 2], (yt == 2).astype(int)), "\n")
    cal = {"long": calib_records(P[:, 2], (yt == 2).astype(int)),
           "short": calib_records(P[:, 0], (yt == 0).astype(int))}

    # --- риски ---
    risk = {}
    for key, name, y in (("long_drawdown", "просадка лонга", y_dd), ("short_stop", "стоп шорта", y_stop)):
        Pb, Bb, ytb, d_b = walk_forward(Xv, y, 2)
        assert (d_b == dates).all()
        risk[key] = (Pb[:, 1], Bb[:, 1], ytb)
        print(f"== P({name}) ==")
        print(f"Brier модели: {brier(ytb, Pb[:, 1]):.4f} | базы: {brier(ytb, Bb[:, 1]):.4f}")
        print("Калибровка:\n", calib_table(Pb[:, 1], ytb), "\n")
        cal[key] = calib_records(Pb[:, 1], ytb)
    metrics = {"direction": m_dir}
    for key, (p1, b1, yb) in risk.items():
        metrics[key] = {"all": metric_pair("bin", yb, p1, b1), "recent": metric_pair("bin", yb, p1, b1, RECENT)}

    # --- финальный прогноз на сегодня (обучение на всех размеченных данных) ---
    cut = len(Xv) - H
    p3, prior3 = fit_predict(Xv.iloc[:cut], y3.values[:cut], last_x[Xv.columns], 3)
    pd_, prior_dd = fit_predict(Xv.iloc[:cut], y_dd.values[:cut], last_x[Xv.columns], 2)
    ps_, prior_st = fit_predict(Xv.iloc[:cut], y_stop.values[:cut], last_x[Xv.columns], 2)
    asof = df.index[-1]
    price = float(df["close"].iloc[-1])
    print("=" * 50)
    print(f"Прогноз на {H} дней от {asof.date()}  (цена {price:.0f})")
    print(f"  Шорт : {p3[0, 0] * 100:5.1f}%")
    print(f"  Флэт : {p3[0, 1] * 100:5.1f}%")
    print(f"  Лонг : {p3[0, 2] * 100:5.1f}%")
    print(f"  Касание -{LONG_DD * 100:.0f}% от входа за неделю (риск лонга): {pd_[0, 1] * 100:5.1f}%")
    print(f"  Касание +{SHORT_STOP * 100:.0f}% от входа за неделю (стоп шорта): {ps_[0, 1] * 100:5.1f}%")

    if not out_dir:
        return None

    slug = symbol.replace("/", "-")
    today = {"asof": str(asof.date()), "price": round(price, 2), "src": "live",
             "p": [r4(v) for v in p3[0]], "dd": r4(pd_[0, 1]), "stop": r4(ps_[0, 1]),
             "theta": r4(R["theta"].iloc[-1]),
             "base": {"dir": [r4(v) for v in prior3], "dd": r4(prior_dd[1]), "stop": r4(prior_st[1])},
             "out": None}

    # --- история: бэктест-затравка при первом запуске, сегодняшний прогноз, итоги прошедших ---
    hist_path = os.path.join(out_dir, slug, "history.json")
    hist = load_history(hist_path, demo)
    if not hist:
        pdd, bdd, _ = risk["long_drawdown"]
        pst, bst, _ = risk["short_stop"]
        for k in range(max(0, len(dates) - SEED_DAYS), len(dates)):
            d = dates[k]
            hist[str(d.date())] = {
                "asof": str(d.date()), "price": round(float(df["close"][d]), 2), "src": "backtest",
                "p": [r4(v) for v in P[k]], "dd": r4(pdd[k]), "stop": r4(pst[k]), "theta": r4(R["theta"][d]),
                "base": {"dir": [r4(v) for v in B[k]], "dd": r4(bdd[k]), "stop": r4(bst[k])}, "out": None}
    if today["asof"] not in hist or force:     # прогноз дня фиксируется при первом запуске и не переписывается
        hist[today["asof"]] = today
    return _finish(symbol, slug, out_dir, demo, src, df, hist, hist_path, today, metrics, cal,
                   prior3, prior_dd, prior_st, R, valid)


def _finish(symbol, slug, out_dir, demo, src, df, hist, hist_path, today, metrics, cal,
            prior3, prior_dd, prior_st, R, valid):
    """Проставляет итоги прошедших прогнозов, пишет history.json и forecast.json."""
    y3, y_dd, y_stop, _ = make_labels(df)
    for e in hist.values():
        d = pd.Timestamp(e["asof"])
        if e.get("out") is None and d in valid.index and bool(valid[d]):
            e["out"] = _entry_out(d, R, y3, y_dd, y_stop)
    entries = sorted(hist.values(), key=lambda e: e["asof"])
    save_json(hist_path, {"symbol": symbol, "demo": demo, "horizon_days": H, "entries": entries},
              one_per_line="entries")

    live = live_metrics(entries)
    for k in ("direction", "long_drawdown", "short_stop"):
        metrics[k]["live"] = live[k]
    asof = pd.Timestamp(today["asof"])
    fc = {
        "schema": 1, "symbol": symbol, "demo": demo, "source": src,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "asof": today["asof"], "target_date": str((asof + pd.Timedelta(days=H)).date()),
        "horizon_days": H, "price": today["price"],
        "params": {"theta_k": THETA_K, "long_dd": LONG_DD, "short_stop": SHORT_STOP},
        "theta": today["theta"],
        "probs": {"short": today["p"][0], "flat": today["p"][1], "long": today["p"][2]},
        "risk": {"long_drawdown": today["dd"], "short_stop": today["stop"]},
        "base": {"short": r4(prior3[0]), "flat": r4(prior3[1]), "long": r4(prior3[2]),
                 "long_drawdown": r4(prior_dd[1]), "short_stop": r4(prior_st[1])},
        "metrics": metrics, "calibration": cal,
        "spark": [round(float(v), 2) for v in df["close"].tail(60)],
    }
    save_json(os.path.join(out_dir, slug, "forecast.json"), fc)
    return fc


def write_index(out_dir):
    syms = []
    for name in sorted(os.listdir(out_dir)):
        p = os.path.join(out_dir, name, "forecast.json")
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                fc = json.load(f)
            syms.append({"symbol": fc["symbol"], "slug": name, "asof": fc["asof"]})
    save_json(os.path.join(out_dir, "index.json"),
              {"symbols": syms, "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("symbols", nargs="*", default=["BTC/USDT"], help="например BTC/USDT ETH/USDT")
    ap.add_argument("--out", help="папка для JSON (для PWA); без неё - только отчёт в консоли")
    ap.add_argument("--demo", action="store_true", help="синтетические свечи вместо биржи (проверка без сети)")
    ap.add_argument("--force", action="store_true", help="перезаписать сегодняшний прогноз в истории")
    ap.add_argument("--source", help="использовать только эту биржу из ccxt (binanceusdm, bybit, bitstamp)")
    a = ap.parse_args()

    failed = []
    for s in a.symbols:
        try:
            run_symbol(s, a.out, a.demo, a.force, a.source)
        except Exception as e:  # noqa: BLE001 - один инструмент не должен ронять остальные
            failed.append(s)
            print(f"\n!!! {s}: {type(e).__name__}: {e}\n", file=sys.stderr)
    if a.out and os.path.isdir(a.out):
        write_index(a.out)
    if failed:
        sys.exit(f"Не удалось посчитать: {', '.join(failed)}")


if __name__ == "__main__":
    main()
