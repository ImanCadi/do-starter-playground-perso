#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = PROJECT_ROOT.parent
OUTPUT_DIR = PROJECT_ROOT / "apps" / "website" / "public" / "data"


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as output:
        json.dump(value, output, separators=(",", ":"))


def additional_properties(place: dict[str, Any]) -> dict[str, str]:
    return {
        str(item.get("key", "")): str(item.get("value", ""))
        for item in place.get("additionalProperties", [])
    }


def bike_geojson(path: Path) -> dict[str, Any]:
    places = read_json(path)
    features = []
    for place in places:
        details = additional_properties(place)
        features.append(
            {
                "type": "Feature",
                "id": place.get("id"),
                "geometry": {
                    "type": "Point",
                    "coordinates": [place.get("lon"), place.get("lat")],
                },
                "properties": {
                    "id": place.get("id"),
                    "name": place.get("commonName", "BikePoint"),
                    "bikes": int(details.get("NbBikes", 0) or 0),
                    "ebikes": int(details.get("NbEBikes", 0) or 0),
                    "emptyDocks": int(details.get("NbEmptyDocks", 0) or 0),
                    "docks": int(details.get("NbDocks", 0) or 0),
                    "locked": details.get("Locked", "false").lower() == "true",
                    "terminalName": details.get("TerminalName", ""),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def tube_arrivals(path: Path) -> dict[str, Any]:
    predictions = read_json(path)
    arrivals = [
        {
            "stationId": item.get("naptanId", ""),
            "stationName": item.get("stationName", "").removesuffix(
                " Underground Station"
            ),
            "lineId": item.get("lineId", ""),
            "lineName": item.get("lineName", item.get("lineId", "")),
            "destination": item.get("destinationName", ""),
            "seconds": item.get("timeToStation", 0),
            "expectedArrival": item.get("timestamp", ""),
        }
        for item in predictions
    ]
    timestamps = [item["expectedArrival"] for item in arrivals if item["expectedArrival"]]
    return {
        "arrivals": arrivals,
        "count": len(arrivals),
        "capturedAt": max(timestamps) if timestamps else datetime.now().astimezone().isoformat(),
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    bikes = bike_geojson(WORKSPACE_ROOT / "data_bikes.json")
    arrivals = tube_arrivals(WORKSPACE_ROOT / "data_tubes.json")
    bikes["capturedAt"] = arrivals["capturedAt"]
    write_json(OUTPUT_DIR / "bikepoints.geojson", bikes)
    write_json(OUTPUT_DIR / "tube-arrivals.json", arrivals)
    for name in ("tube-routes.geojson", "tube-stations.geojson"):
        path = OUTPUT_DIR / name
        if not path.exists():
            raise FileNotFoundError(f"Missing network data: {path}")
        write_json(path, read_json(path))

    print(
        f"Wrote bikepoints.geojson, tube-arrivals.json, tube-routes.geojson, "
        f"and tube-stations.geojson to {OUTPUT_DIR}"
    )


if __name__ == "__main__":
    main()
