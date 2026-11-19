import { createFileRoute } from '@tanstack/react-router';
import { Layer, Map as MapView, Marker, Popup, Source, type MapRef } from '@vis.gl/react-maplibre';
import { Children, useCallback, useEffect, useMemo, useState } from 'react';

import 'maplibre-gl/dist/maplibre-gl.css';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

const TUBE_LINES = [
    { id: 'district', name: 'District', color: '#007D32' },
    { id: 'circle', name: 'Circle', color: '#FFD300' },
    { id: 'central', name: 'Central', color: '#DC241F' },
    { id: 'bakerloo', name: 'Bakerloo', color: '#894E24' },
    { id: 'northern', name: 'Northern', color: '#111111' },
    { id: 'metropolitan', name: 'Metropolitan', color: '#751056' },
    { id: 'jubilee', name: 'Jubilee', color: '#646B73' },
    { id: 'victoria', name: 'Victoria', color: '#009FE0' },
    { id: 'piccadilly', name: 'Piccadilly', color: '#0019A8' },
    { id: 'hammersmith-city', name: 'Hammersmith & City', color: '#F4A9BE' },
    { id: 'waterloo-city', name: 'Waterloo & City', color: '#76D0BD' }
];

type PointFeature = {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
};

type LineFeature = {
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    properties: Record<string, unknown>;
};

type FeatureCollection<TFeature> = {
    type: 'FeatureCollection';
    features: TFeature[];
    capturedAt?: string;
};

type Arrival = {
    stationId: string;
    stationName: string;
    lineId: string;
    lineName: string;
    destination: string;
    seconds: number;
    expectedArrival: string;
};

type TflJourneyLeg = {
    duration: number;
    distance?: number;
    instruction?: { summary?: string; detailed?: string };
    departurePoint?: { commonName?: string; lat?: number; lon?: number };
    arrivalPoint?: { commonName?: string; lat?: number; lon?: number };
    mode?: { id?: string; name?: string };
    routeOptions?: { lineIdentifier?: { id?: string; name?: string }; name?: string }[];
    path?: { lineString?: string | [number, number][] };
};

type TflJourney = {
    duration: number;
    startDateTime?: string;
    arrivalDateTime?: string;
    legs: TflJourneyLeg[];
    fare?: { totalCost?: number };
};

type TflJourneyResponse = {
    journeys?: TflJourney[];
};

type PlannedTrip = {
    journey: TflJourney | null;
    error: string | null;
};
type TripPlans = { tube: PlannedTrip; cycle: PlannedTrip; walking: PlannedTrip };

type TripPoint = { latitude: number; longitude: number; label: string };
type TripPoints = { from: TripPoint | null; to: TripPoint | null };
type PickTarget = keyof TripPoints;

type MapData = {
    bikes: FeatureCollection<PointFeature>;
    tubeRoutes: FeatureCollection<LineFeature>;
    tubeStations: FeatureCollection<PointFeature>;
    tubeArrivals: { arrivals: Arrival[]; count: number; capturedAt: string };
};

type RandomJourneyPair = {
    from: { name: string; latitude: number; longitude: number };
    to: { name: string; latitude: number; longitude: number };
    tube: PlannedTrip;
    cycle: PlannedTrip;
};

type HomepageLiveMetrics = {
    arrivals: number[] | null;
    disruptedLines: number | null;
    lockedBikePoints: number | null;
};

type MapInstance = ReturnType<MapRef['getMap']>;

function MapsRoutePage() {
    return null;
}

export const Route = createFileRoute('/maps')({ component: MapsRoutePage });

export function LondonMapsPage({
    showHomepageComparison = false
}: {
    showHomepageComparison?: boolean;
}) {
    const [data, setData] = useState<MapData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tripPoints, setTripPoints] = useState<TripPoints>({ from: null, to: null });
    const [pickTarget, setPickTarget] = useState<PickTarget | null>(null);
    const [plannedTrips, setPlannedTrips] = useState<TripPlans | null>(null);
    const [tubeMap, setTubeMap] = useState<MapInstance | null>(null);
    const [bikeMap, setBikeMap] = useState<MapInstance | null>(null);

    useEffect(() => {
        if (!tubeMap || !bikeMap) return;
        const syncCamera = (source: MapInstance, target: MapInstance) => {
            const center = source.getCenter();
            const targetCenter = target.getCenter();
            const sameCamera =
                Math.abs(center.lng - targetCenter.lng) < 1e-6 &&
                Math.abs(center.lat - targetCenter.lat) < 1e-6 &&
                Math.abs(source.getZoom() - target.getZoom()) < 1e-4 &&
                Math.abs(source.getBearing() - target.getBearing()) < 1e-3 &&
                Math.abs(source.getPitch() - target.getPitch()) < 1e-3;
            if (!sameCamera) {
                target.jumpTo({
                    center: [center.lng, center.lat],
                    zoom: source.getZoom(),
                    bearing: source.getBearing(),
                    pitch: source.getPitch()
                });
            }
        };
        const syncTubeToBike = () => syncCamera(tubeMap, bikeMap);
        const syncBikeToTube = () => syncCamera(bikeMap, tubeMap);
        syncTubeToBike();
        tubeMap.on('move', syncTubeToBike);
        bikeMap.on('move', syncBikeToTube);
        return () => {
            tubeMap.off('move', syncTubeToBike);
            bikeMap.off('move', syncBikeToTube);
        };
    }, [tubeMap, bikeMap]);

    useEffect(() => {
        if (!plannedTrips || !tubeMap || !bikeMap) return;
        const coordinates = [
            ...journeyRouteGeoJSON(plannedTrips.tube.journey, 'tube').features,
            ...journeyRouteGeoJSON(plannedTrips.cycle.journey, 'cycle').features,
            ...journeyRouteGeoJSON(plannedTrips.walking.journey, 'walking').features
        ].flatMap((feature) => feature.geometry.coordinates);
        if (coordinates.length < 2) return;
        const bounds = coordinates.reduce(
            (current, coordinate) => ({
                west: Math.min(current.west, coordinate[0]),
                south: Math.min(current.south, coordinate[1]),
                east: Math.max(current.east, coordinate[0]),
                north: Math.max(current.north, coordinate[1])
            }),
            {
                west: coordinates[0][0],
                south: coordinates[0][1],
                east: coordinates[0][0],
                north: coordinates[0][1]
            }
        );
        tubeMap.fitBounds(
            [
                [bounds.west, bounds.south],
                [bounds.east, bounds.north]
            ],
            { padding: 55, maxZoom: 14, duration: 700 }
        );
    }, [plannedTrips, tubeMap, bikeMap]);

    const pickMapPoint = (latitude: number, longitude: number, label = 'Map point') => {
        if (!pickTarget) return;
        setTripPoints((current) => ({
            ...current,
            [pickTarget]: { latitude, longitude, label }
        }));
        setPlannedTrips(null);
        setPickTarget(null);
    };

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const paths = [
                    '/data/bikepoints.geojson',
                    '/data/tube-routes.geojson',
                    '/data/tube-stations.geojson',
                    '/data/tube-arrivals.json'
                ];
                const responses = await Promise.all(paths.map((path) => fetch(path)));
                const failed = responses.find((response) => !response.ok);
                if (failed) throw new Error(`Could not load map data (${failed.status}).`);
                const [bikes, tubeRoutes, tubeStations, tubeArrivals] = await Promise.all(
                    responses.map((response) => response.json())
                );
                if (!cancelled) {
                    setData({ bikes, tubeRoutes, tubeStations, tubeArrivals });
                }
            } catch (cause) {
                if (!cancelled) {
                    setError(cause instanceof Error ? cause.message : 'Could not load map data.');
                }
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, []);

    const lastUpdated = useMemo(() => {
        const value = data?.tubeArrivals.capturedAt || data?.bikes.capturedAt;
        if (!value) return 'Local TfL snapshot';
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? 'Local TfL snapshot'
            : `Snapshot · ${date.toLocaleString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit'
              })}`;
    }, [data]);

    return (
        <main className="flex min-h-screen flex-col gap-3 bg-violet-50/70 p-3 text-slate-900 md:gap-4 md:p-5">
            <header className="grid shrink-0 grid-cols-1 items-center gap-2 md:grid-cols-[1fr_auto_1fr]">
                <div aria-hidden="true" className="hidden md:block" />
                <div className="text-center">
                    <p className="text-[10px] font-semibold tracking-[0.28em] text-violet-700 uppercase">
                        London · urban mobility
                    </p>
                    <h1 className="mt-1 text-3xl font-bold tracking-tight text-violet-950 md:text-4xl">
                        Bike vs Tube
                    </h1>
                    <p className="mt-1 text-sm font-medium text-slate-600 md:text-base">
                        Which is better for getting around London?
                    </p>
                </div>
                <span className="text-center text-[10px] text-slate-500 md:justify-self-end md:text-right md:text-xs">
                    {lastUpdated}
                </span>
            </header>

            {showHomepageComparison && (
                <section className="rounded-xl border border-violet-200 bg-white px-5 py-6 text-center shadow-md shadow-violet-950/5 md:px-10 md:py-8">
                    <p className="text-[10px] font-semibold tracking-[0.25em] text-violet-700 uppercase md:text-xs">
                        The question
                    </p>
                    <h2 className="mx-auto mt-2 max-w-4xl text-xl leading-snug font-semibold text-violet-950 md:text-3xl">
                        For international students new to London, which one should you choose?
                    </h2>
                    <p className="mx-auto mt-3 max-w-3xl text-sm leading-relaxed text-slate-600 md:text-base">
                        The Tube and hire bikes are two obvious ways to get around, but comparing
                        price, time, availability and potential issues can be complicated. When
                        living costs are high and study/work balance is difficult, students cannot
                        afford to waste time or money.
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {['Price', 'Time', 'Availability', 'Potential issues'].map((item) => (
                            <span
                                key={item}
                                className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-900"
                            >
                                {item}
                            </span>
                        ))}
                    </div>
                </section>
            )}

            {error ? (
                <div className="rounded-lg border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200">
                    {error}
                </div>
            ) : !data ? (
                <div className="grid min-h-0 flex-1 place-items-center rounded-xl border border-slate-200 bg-white text-sm text-slate-500">
                    Loading London transport data…
                </div>
            ) : (
                <div className="grid h-[78vh] min-h-[680px] shrink-0 grid-cols-1 grid-rows-2 gap-3 md:h-[68vh] md:min-h-[520px] md:grid-cols-2 md:grid-rows-1">
                    <TubePanel
                        data={data}
                        onMapReady={setTubeMap}
                        plannedTrips={plannedTrips}
                        tripPoints={tripPoints}
                        pickTarget={pickTarget}
                        onPickPoint={pickMapPoint}
                    />
                    <BikePanel
                        data={data}
                        onMapReady={setBikeMap}
                        plannedTrips={plannedTrips}
                        tripPoints={tripPoints}
                        pickTarget={pickTarget}
                        onPickPoint={pickMapPoint}
                    />
                </div>
            )}

            {data && (
                <>
                    <TripPlanner
                        points={tripPoints}
                        pickTarget={pickTarget}
                        onSelectTarget={(target) => {
                            setPlannedTrips(null);
                            setPickTarget(target);
                        }}
                        onPlansCalculated={setPlannedTrips}
                    />
                    {plannedTrips && (
                        <SelectedJourneyComparison
                            data={data}
                            points={tripPoints}
                            plans={plannedTrips}
                        />
                    )}
                    {showHomepageComparison && <HomepageAnalysis data={data} />}
                    {showHomepageComparison && <HomepageComments />}
                </>
            )}

            <footer className="flex shrink-0 items-center justify-between text-[10px] text-slate-500">
                <span>Transport for London data · Map tiles by CARTO</span>
                {data && (
                    <span>
                        {data.bikes.features.length} bike points · {data.tubeArrivals.count} Tube
                        predictions
                    </span>
                )}
            </footer>
        </main>
    );
}

function TubePanel({
    data,
    onMapReady,
    plannedTrips,
    tripPoints,
    pickTarget,
    onPickPoint
}: {
    data: MapData;
    onMapReady: (map: MapInstance | null) => void;
    plannedTrips: TripPlans | null;
    tripPoints: TripPoints;
    pickTarget: PickTarget | null;
    onPickPoint: (latitude: number, longitude: number, label?: string) => void;
}) {
    const [map, setMap] = useState<MapInstance | null>(null);
    const mapRef = useCallback(
        (instance: MapRef | null) => {
            const current = instance?.getMap() ?? null;
            setMap(current);
            onMapReady(current);
        },
        [onMapReady]
    );
    const [selected, setSelected] = useState<{
        latitude: number;
        longitude: number;
        properties: Record<string, unknown>;
    } | null>(null);

    const arrivalsByStation = useMemo(() => {
        const grouped = new Map<string, Arrival[]>();
        for (const arrival of data.tubeArrivals.arrivals) {
            const stationArrivals = grouped.get(arrival.stationId) ?? [];
            stationArrivals.push(arrival);
            grouped.set(arrival.stationId, stationArrivals);
        }
        return grouped;
    }, [data.tubeArrivals.arrivals]);
    const routeGeoJSON = useMemo(
        () => ({
            type: 'FeatureCollection' as const,
            features: [
                ...journeyRouteGeoJSON(plannedTrips?.tube.journey ?? null, 'tube').features,
                ...journeyRouteGeoJSON(plannedTrips?.walking.journey ?? null, 'walking').features
            ]
        }),
        [plannedTrips]
    );
    useRouteOverlay(map, 'tube-planned-route-source', 'tube-planned-route-line', routeGeoJSON);

    return (
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="shrink-0 border-b border-slate-200 px-3 py-3 md:px-4">
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <p className="text-[10px] font-medium tracking-[0.2em] text-slate-500 uppercase">
                            Network · 01
                        </p>
                        <h2 className="text-base font-semibold md:text-lg">London Underground</h2>
                    </div>
                    <div className="text-right">
                        <p className="text-lg font-semibold tabular-nums">
                            {data.tubeStations.features.length}
                        </p>
                        <p className="text-[10px] text-slate-500">stations</p>
                    </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5">
                    {TUBE_LINES.map((line) => (
                        <span
                            key={line.id}
                            className="inline-flex items-center gap-1.5 text-[10px] text-slate-700"
                        >
                            <i
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: line.color }}
                            />
                            {line.name}
                        </span>
                    ))}
                </div>
            </div>
            <div className="relative min-h-0 flex-1">
                <MapView
                    ref={mapRef}
                    style={{ width: '100%', height: '100%' }}
                    initialViewState={{ longitude: -0.12, latitude: 51.52, zoom: 9.8 }}
                    mapStyle={MAP_STYLE}
                    onClick={(event) => {
                        if (pickTarget) {
                            onPickPoint(event.lngLat.lat, event.lngLat.lng);
                            setSelected(null);
                            return;
                        }
                        setSelected(null);
                    }}
                    reuseMaps
                >
                    <Source id="tube-routes-source" type="geojson" data={data.tubeRoutes as never}>
                        <Layer
                            id="tube-route-lines"
                            type="line"
                            paint={{
                                'line-color': ['get', 'color'],
                                'line-width': 3,
                                'line-opacity': 0.9
                            }}
                        />
                    </Source>
                    {data.tubeStations.features.map((station) => {
                        const [longitude, latitude] = station.geometry.coordinates;
                        const properties = station.properties;
                        const colors = Array.isArray(properties.colors)
                            ? properties.colors.map(String)
                            : [String(properties.color ?? '#334155')];
                        const segmentSize = 100 / Math.max(colors.length, 1);
                        const markerFill =
                            colors.length > 1
                                ? `conic-gradient(${colors.map((color, index) => `${color} ${index * segmentSize}% ${(index + 1) * segmentSize}%`).join(', ')})`
                                : colors[0];
                        const stationName = String(properties.name ?? 'Tube station');
                        return (
                            <Marker
                                key={String(properties.id)}
                                longitude={longitude}
                                latitude={latitude}
                                anchor="center"
                            >
                                <button
                                    type="button"
                                    aria-label={stationName}
                                    title={stationName}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        if (pickTarget) {
                                            onPickPoint(latitude, longitude, stationName);
                                            setSelected(null);
                                            return;
                                        }
                                        setSelected({ longitude, latitude, properties });
                                    }}
                                    className={`rounded-full border-2 border-white shadow-[0_1px_4px_rgba(0,0,0,0.65)] ${properties.interchange ? 'h-4 w-4' : 'h-3 w-3'}`}
                                    style={{ background: markerFill }}
                                />
                            </Marker>
                        );
                    })}
                    <TripPointMarker point={tripPoints.from} label="A" color="#2563eb" />
                    <TripPointMarker point={tripPoints.to} label="B" color="#ea580c" />
                    {selected && (
                        <Popup
                            longitude={selected.longitude}
                            latitude={selected.latitude}
                            closeButton
                            closeOnClick={false}
                            onClose={() => setSelected(null)}
                        >
                            <StationPopup
                                properties={selected.properties}
                                arrivals={
                                    arrivalsByStation.get(String(selected.properties.id)) ?? []
                                }
                            />
                        </Popup>
                    )}
                </MapView>
                <div className="pointer-events-none absolute right-3 bottom-3 rounded-md border border-slate-200 bg-white/95 px-2 py-1 text-[10px] text-slate-700 shadow backdrop-blur">
                    Click a station for arrivals
                </div>
                {routeGeoJSON.features.length > 0 && (
                    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-slate-200 bg-white/95 px-2 py-1 text-[10px] text-slate-700 shadow">
                        Tube route · purple is walking
                    </div>
                )}
                {pickTarget && <PickMapHint target={pickTarget} />}
            </div>
        </section>
    );
}

function StationPopup({
    properties,
    arrivals
}: {
    properties: Record<string, unknown>;
    arrivals: Arrival[];
}) {
    const lineNames = Array.isArray(properties.lineNames) ? properties.lineNames.join(' · ') : '';
    const nextArrivals = arrivals
        .slice()
        .sort((a, b) => a.seconds - b.seconds)
        .slice(0, 5);

    return (
        <div className="min-w-48 text-zinc-900">
            <h3 className="font-semibold">{String(properties.name ?? 'Tube station')}</h3>
            {lineNames && <p className="mt-0.5 text-xs text-zinc-600">{lineNames}</p>}
            {properties.zone != null && properties.zone !== '' && (
                <p className="mt-0.5 text-xs text-zinc-600">Fare zone {String(properties.zone)}</p>
            )}
            <div className="mt-2 border-t border-zinc-200 pt-2">
                <p className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
                    Next trains
                </p>
                {nextArrivals.length ? (
                    nextArrivals.map((arrival, index) => (
                        <p
                            key={`${arrival.lineId}-${arrival.expectedArrival}-${index}`}
                            className="text-xs"
                        >
                            {arrival.lineName} · {arrival.destination} ·{' '}
                            {formatArrival(arrival.seconds)}
                        </p>
                    ))
                ) : (
                    <p className="text-xs text-zinc-500">No arrivals in this snapshot.</p>
                )}
            </div>
        </div>
    );
}

function BikePanel({
    data,
    onMapReady,
    plannedTrips,
    tripPoints,
    pickTarget,
    onPickPoint
}: {
    data: MapData;
    onMapReady: (map: MapInstance | null) => void;
    plannedTrips: TripPlans | null;
    tripPoints: TripPoints;
    pickTarget: PickTarget | null;
    onPickPoint: (latitude: number, longitude: number, label?: string) => void;
}) {
    const [map, setMap] = useState<MapInstance | null>(null);
    const mapRef = useCallback(
        (instance: MapRef | null) => {
            const current = instance?.getMap() ?? null;
            setMap(current);
            onMapReady(current);
        },
        [onMapReady]
    );
    const [selected, setSelected] = useState<{
        latitude: number;
        longitude: number;
        properties: Record<string, unknown>;
    } | null>(null);
    const totals = useMemo(
        () =>
            data.bikes.features.reduce(
                (sum, feature) => ({
                    bikes: sum.bikes + numberValue(feature.properties.bikes),
                    docks: sum.docks + numberValue(feature.properties.emptyDocks)
                }),
                { bikes: 0, docks: 0 }
            ),
        [data.bikes.features]
    );
    const routeGeoJSON = useMemo(
        () => ({
            type: 'FeatureCollection' as const,
            features: [
                ...journeyRouteGeoJSON(plannedTrips?.cycle.journey ?? null, 'cycle').features,
                ...journeyRouteGeoJSON(plannedTrips?.walking.journey ?? null, 'walking').features
            ]
        }),
        [plannedTrips]
    );
    useRouteOverlay(map, 'bike-planned-route-source', 'bike-planned-route-line', routeGeoJSON);

    return (
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-3 md:px-4">
                <div>
                    <p className="text-[10px] font-medium tracking-[0.2em] text-slate-500 uppercase">
                        Network · 02
                    </p>
                    <h2 className="text-base font-semibold md:text-lg">Santander Cycles</h2>
                </div>
                <div className="flex gap-4 text-right">
                    <div>
                        <p className="text-lg font-semibold tabular-nums">
                            {data.bikes.features.length}
                        </p>
                        <p className="text-[10px] text-slate-500">BikePoints</p>
                    </div>
                    <div>
                        <p className="text-lg font-semibold tabular-nums">
                            {totals.bikes.toLocaleString('en-GB')}
                        </p>
                        <p className="text-[10px] text-slate-500">bikes available</p>
                    </div>
                    <div className="hidden sm:block">
                        <p className="text-lg font-semibold tabular-nums">
                            {totals.docks.toLocaleString('en-GB')}
                        </p>
                        <p className="text-[10px] text-slate-500">empty docks</p>
                    </div>
                </div>
            </div>
            <div className="relative min-h-0 flex-1">
                <MapView
                    ref={mapRef}
                    style={{ width: '100%', height: '100%' }}
                    initialViewState={{ longitude: -0.12, latitude: 51.52, zoom: 9.8 }}
                    mapStyle={MAP_STYLE}
                    onClick={(event) => {
                        if (pickTarget) {
                            onPickPoint(event.lngLat.lat, event.lngLat.lng);
                            setSelected(null);
                            return;
                        }
                        setSelected(null);
                    }}
                    reuseMaps
                >
                    {data.bikes.features.map((bike) => {
                        const [longitude, latitude] = bike.geometry.coordinates;
                        const properties = bike.properties;
                        const name = String(properties.name ?? 'BikePoint');
                        const hasBikes = numberValue(properties.bikes) > 0;
                        return (
                            <Marker
                                key={String(properties.id)}
                                longitude={longitude}
                                latitude={latitude}
                                anchor="center"
                            >
                                <button
                                    type="button"
                                    aria-label={name}
                                    title={`${name} · ${numberValue(properties.bikes)} bikes`}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        if (pickTarget) {
                                            onPickPoint(latitude, longitude, name);
                                            setSelected(null);
                                            return;
                                        }
                                        setSelected({ longitude, latitude, properties });
                                    }}
                                    className="h-2.5 w-2.5 rounded-full border border-white shadow-[0_1px_4px_rgba(0,0,0,0.55)]"
                                    style={{ backgroundColor: hasBikes ? '#059669' : '#94a3b8' }}
                                />
                            </Marker>
                        );
                    })}
                    <TripPointMarker point={tripPoints.from} label="A" color="#2563eb" />
                    <TripPointMarker point={tripPoints.to} label="B" color="#ea580c" />
                    {selected && (
                        <Popup
                            longitude={selected.longitude}
                            latitude={selected.latitude}
                            closeButton
                            closeOnClick={false}
                            onClose={() => setSelected(null)}
                        >
                            <BikePopup properties={selected.properties} />
                        </Popup>
                    )}
                </MapView>
                <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-2 rounded-md border border-slate-200 bg-white/95 px-2 py-1 text-[10px] text-slate-700 shadow backdrop-blur">
                    <i className="h-2 w-2 rounded-full bg-emerald-400" /> Bikes available
                    <i className="ml-2 h-2 w-2 rounded-full bg-zinc-500" /> Empty station
                </div>
                {routeGeoJSON.features.length > 0 && (
                    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-slate-200 bg-white/95 px-2 py-1 text-[10px] text-slate-700 shadow">
                        Green = cycling · orange = station access · purple = walking route
                    </div>
                )}
                {pickTarget && <PickMapHint target={pickTarget} />}
            </div>
        </section>
    );
}

function BikePopup({ properties }: { properties: Record<string, unknown> }) {
    return (
        <div className="min-w-40 text-zinc-900">
            <h3 className="font-semibold">{String(properties.name ?? 'BikePoint')}</h3>
            <p className="mt-1 text-xs">{numberValue(properties.bikes)} bikes available</p>
            <p className="text-xs">{numberValue(properties.ebikes)} electric bikes</p>
            <p className="text-xs">
                {numberValue(properties.emptyDocks)} empty docks · {numberValue(properties.docks)}{' '}
                total docks
            </p>
        </div>
    );
}

function HomepageAnalysis({ data }: { data: MapData }) {
    const [samples, setSamples] = useState<RandomJourneyPair[]>([]);
    const [sampleProgress, setSampleProgress] = useState({ completed: 0, requested: 0 });
    const [live, setLive] = useState<HomepageLiveMetrics>({
        arrivals: null,
        disruptedLines: null,
        lockedBikePoints: null
    });

    useEffect(() => {
        let cancelled = false;
        const pairs = randomStationPairs(data.tubeStations.features, 50);
        setSamples([]);
        setSampleProgress({ completed: 0, requested: pairs.length });

        const runSample = async () => {
            for (const pair of pairs) {
                // Two TfL requests are made for each pair. Space pairs apart to
                // stay within TfL's anonymous API rate limit.
                await new Promise((resolve) => window.setTimeout(resolve, 2700));
                if (cancelled) return;
                const from = `${pair.from.latitude},${pair.from.longitude}`;
                const to = `${pair.to.latitude},${pair.to.longitude}`;
                const [tube, cycle] = await Promise.all([
                    findBestJourney(from, to, 'tube'),
                    findBestJourney(from, to, 'cycle')
                ]);
                if (cancelled) return;
                setSamples((current) => [...current, { ...pair, tube, cycle }]);
                setSampleProgress((current) => ({ ...current, completed: current.completed + 1 }));
            }
        };
        void runSample();
        return () => {
            cancelled = true;
        };
    }, [data.tubeStations.features]);

    useEffect(() => {
        let cancelled = false;
        const get = async (path: string) => {
            const response = await fetch(`https://api.tfl.gov.uk${path}`);
            if (!response.ok) throw new Error(`TfL request failed: ${response.status}`);
            return response.json() as Promise<unknown>;
        };
        void Promise.allSettled([
            get('/Mode/tube/Arrivals'),
            get('/Line/Mode/tube/Status'),
            get('/BikePoint')
        ]).then(([arrivalsResult, linesResult, bikesResult]) => {
            if (cancelled) return;
            const arrivals =
                arrivalsResult.status === 'fulfilled' && Array.isArray(arrivalsResult.value)
                    ? arrivalsResult.value.map((item) =>
                          numberValue((item as { timeToStation?: unknown }).timeToStation)
                      )
                    : null;
            const disruptedLines =
                linesResult.status === 'fulfilled' && Array.isArray(linesResult.value)
                    ? linesResult.value.filter((line) => {
                          const statuses =
                              (line as { lineStatuses?: { statusSeverity?: number }[] })
                                  .lineStatuses ?? [];
                          return statuses.some(
                              (status) =>
                                  typeof status.statusSeverity === 'number' &&
                                  status.statusSeverity < 10
                          );
                      }).length
                    : null;
            const lockedBikePoints =
                bikesResult.status === 'fulfilled' && Array.isArray(bikesResult.value)
                    ? bikesResult.value.filter((point) => {
                          const properties =
                              (
                                  point as {
                                      additionalProperties?: { key?: string; value?: string }[];
                                  }
                              ).additionalProperties ?? [];
                          return properties.some(
                              (property) =>
                                  property.key === 'Locked' &&
                                  String(property.value).toLowerCase() === 'true'
                          );
                      }).length
                    : null;
            setLive({ arrivals, disruptedLines, lockedBikePoints });
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const tubeDurations = samples.flatMap((sample) =>
        sample.tube.journey ? [sample.tube.journey.duration] : []
    );
    const bikeDurations = samples.flatMap((sample) =>
        sample.cycle.journey ? [sample.cycle.journey.duration] : []
    );
    const tubePrices = samples.flatMap((sample) => {
        const cost = sample.tube.journey?.fare?.totalCost;
        return typeof cost === 'number' ? [cost / 100] : [];
    });
    const bikePrices = samples.flatMap((sample) => {
        const minutes =
            sample.cycle.journey?.legs
                .filter((leg) => leg.mode?.id === 'cycle' || leg.mode?.id === 'cycling')
                .reduce((total, leg) => total + leg.duration, 0) ?? 0;
        return minutes > 0 ? [Math.ceil(minutes / 30) * 1.65] : [];
    });
    const averageWaitSeconds = live.arrivals?.length
        ? live.arrivals.reduce((total, seconds) => total + seconds, 0) / live.arrivals.length
        : data.tubeArrivals.arrivals.length
          ? data.tubeArrivals.arrivals.reduce((total, arrival) => total + arrival.seconds, 0) /
            data.tubeArrivals.arrivals.length
          : null;
    const bikeSampleOrigins = samples.filter((sample) => sample.cycle.journey != null);
    const sampledPickupStations = bikeSampleOrigins.flatMap((sample) => {
        const station = nearestFeature(data.bikes.features, sample.from);
        return station ? [station] : [];
    });
    const alternativeStationRate = sampledPickupStations.length
        ? (sampledPickupStations.filter(
              (station) =>
                  numberValue(station.properties.bikes) === 0 || station.properties.locked === true
          ).length /
              sampledPickupStations.length) *
          100
        : null;
    const walkToAvailableBikeSeconds = bikeSampleOrigins.flatMap((sample) => {
        const station = nearestAvailableBikeStation(data.bikes.features, sample.from);
        if (!station) return [];
        return [estimatedWalkingSeconds(sample.from, station)];
    });
    const sampledEmptyDocks = bikeSampleOrigins.flatMap((sample) => {
        const station = nearestFeature(data.bikes.features, sample.to);
        return station ? [numberValue(station.properties.emptyDocks)] : [];
    });
    const averageSampleEmptyDocks = mean(sampledEmptyDocks);
    const averageWalkToAvailableBikeSeconds = mean(walkToAvailableBikeSeconds);

    return (
        <section className="overflow-hidden rounded-xl border border-violet-200 bg-white shadow-md shadow-violet-950/5">
            <div className="border-b border-violet-200 bg-gradient-to-r from-violet-100/80 to-white px-4 py-5 md:px-6">
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase">
                            Independent journey comparison
                        </p>
                        <h2 className="mt-1 text-xl font-semibold tracking-tight">
                            Tube vs Santander Cycles · 50 random route pairs
                        </h2>
                        <p className="mt-1 max-w-3xl text-sm text-slate-600">
                            This city-wide comparison is independent of the route selected above.
                            Both modes use the same randomly sampled start and destination pairs.
                        </p>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        {sampleProgress.completed}/{sampleProgress.requested} route pairs compared
                    </span>
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] border-collapse text-left text-sm">
                    <thead>
                        <tr className="border-b border-slate-200">
                            <th className="w-1/4 px-4 py-3 text-xs font-semibold tracking-wide text-slate-500 uppercase md:px-6">
                                Criteria
                            </th>
                            <th className="w-[37.5%] px-4 py-3 font-semibold text-violet-900 md:px-6">
                                London Underground
                            </th>
                            <th className="w-[37.5%] px-4 py-3 font-semibold text-emerald-900 md:px-6">
                                Santander Cycles
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        <ComparisonRow label="Average journey time">
                            <ComparisonValue
                                value={
                                    mean(tubeDurations) == null
                                        ? 'Calculating route sample…'
                                        : `${formatJourneyDuration(mean(tubeDurations)!)} average`
                                }
                                detail={`${tubeDurations.length} successful door-to-door routes, including walking and transfers in TfL estimates.`}
                            />
                            <ComparisonValue
                                value={
                                    mean(bikeDurations) == null
                                        ? 'Calculating route sample…'
                                        : `${formatJourneyDuration(mean(bikeDurations)!)} average`
                                }
                                detail={`${bikeDurations.length} successful routes; TfL cycling journeys include walking to and from hire points.`}
                            />
                        </ComparisonRow>
                        <ComparisonRow label="Average price">
                            <ComparisonValue
                                value={
                                    mean(tubePrices) == null
                                        ? 'Fare sample unavailable'
                                        : `£${mean(tubePrices)!.toFixed(2)} per journey`
                                }
                                detail={`${tubePrices.length} fares returned by TfL for the random route sample.`}
                            />
                            <ComparisonValue
                                value={
                                    mean(bikePrices) == null
                                        ? 'Calculating estimate…'
                                        : `£${mean(bikePrices)!.toFixed(2)} per journey`
                                }
                                detail={`Estimated at £1.65 per started 30-minute cycling block; ${bikePrices.length} route estimates.`}
                            />
                        </ComparisonRow>
                        <ComparisonRow label="Availability">
                            <ComparisonValue
                                value={
                                    averageWaitSeconds == null
                                        ? 'Arrival data unavailable'
                                        : `${formatDurationSeconds(averageWaitSeconds)} average predicted wait`
                                }
                                detail="Mean time to the next predicted train across available London arrival predictions."
                            />
                            <ComparisonValue
                                value={
                                    alternativeStationRate == null
                                        ? 'Calculating availability…'
                                        : `${alternativeStationRate.toFixed(0)}% estimated chance of needing another station`
                                }
                                detail={`Nearest-point check across ${sampledPickupStations.length} successful sampled bike-route starts: empty or locked in this share of the snapshot. Average walk to a station showing bikes: ${averageWalkToAvailableBikeSeconds == null ? '—' : formatDurationSeconds(averageWalkToAvailableBikeSeconds)}. Average free docks at destinations: ${averageSampleEmptyDocks == null ? '—' : averageSampleEmptyDocks.toFixed(1)}. This is not a historical probability.`}
                            />
                        </ComparisonRow>
                        <ComparisonRow label="Potential issues">
                            <ComparisonValue
                                value={
                                    live.disruptedLines == null
                                        ? 'Live status unavailable'
                                        : `${live.disruptedLines} Tube lines with disruption`
                                }
                                detail="Disruptions can affect routes; trains can also be very crowded at peak times."
                            />
                            <ComparisonValue
                                value={
                                    live.lockedBikePoints == null
                                        ? 'Live station status unavailable'
                                        : `${live.lockedBikePoints} locked BikePoints`
                                }
                                detail="BikePoint availability can change; cycling is also exposed to rain, wind and other weather. TfL does not publish a live count of broken bikes or docks."
                            />
                        </ComparisonRow>
                        <ComparisonRow label="Comfort & experience">
                            <ComparisonValue
                                value="Potential time to study or rest"
                                detail="You may be able to sit, read or work while travelling; crowding and seating vary."
                            />
                            <ComparisonValue
                                value="Fresh air and movement"
                                detail="Cycling gets you outdoors, though weather, traffic and confidence on London roads matter."
                            />
                        </ComparisonRow>
                    </tbody>
                </table>
            </div>
            <div className="border-t border-slate-200 px-4 py-4 md:px-6">
                {samples.length > 0 && (
                    <details className="mt-3 text-xs text-slate-600">
                        <summary className="w-fit cursor-pointer font-medium text-violet-800">
                            Show sampled routes
                        </summary>
                        <ol className="mt-2 grid gap-1 sm:grid-cols-2">
                            {samples.map((sample, index) => (
                                <li
                                    key={`${sample.from.name}-${sample.to.name}-${index}`}
                                    className="rounded bg-violet-50 px-2 py-1.5"
                                >
                                    {sample.from.name} → {sample.to.name}
                                    <span className="text-slate-500">
                                        {' '}
                                        · Tube{' '}
                                        {sample.tube.journey
                                            ? formatJourneyDuration(sample.tube.journey.duration)
                                            : '—'}{' '}
                                        · Bike{' '}
                                        {sample.cycle.journey
                                            ? formatJourneyDuration(sample.cycle.journey.duration)
                                            : '—'}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </details>
                )}
                <div className="mt-4 grid gap-4 rounded-lg border border-violet-200 bg-violet-50 p-4 md:grid-cols-2 md:p-5">
                    <div>
                        <p className="text-[10px] font-semibold tracking-[0.2em] text-violet-800 uppercase">
                            Why this matters
                        </p>
                        <h3 className="mt-1 text-base font-semibold">
                            Students cannot afford to lose time or money
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-slate-700">
                            With London’s high cost of living and the pressure of balancing study
                            and work, waits, missed connections and unavailable bikes have a real
                            cost. A useful choice should also account for access walking time, time
                            of day, reliability, safety, weather and crowding.
                        </p>
                    </div>
                    <div>
                        <p className="text-[10px] font-semibold tracking-[0.2em] text-violet-800 uppercase">
                            What could improve the comparison?
                        </p>
                        <h3 className="mt-1 text-base font-semibold">Other modes</h3>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700">
                            <li>Add buses as another common, affordable option.</li>
                            <li>
                                Include dockless bikes such as Lime and Forest with live prices and
                                availability.
                            </li>
                            <li>
                                Record wait times and bike/dock faults repeatedly to measure real
                                search times and interruption rates.
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </section>
    );
}

function HomepageComments() {
    return (
        <section className="rounded-xl border border-violet-200 bg-violet-950 p-4 text-violet-50 shadow-md md:p-5">
            <p className="text-[10px] font-semibold tracking-[0.2em] text-violet-300 uppercase">
                Final notes
            </p>
            <h2 className="mt-1 text-lg font-semibold">Comments</h2>
            <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-violet-100 md:grid-cols-2 xl:grid-cols-4">
                <li className="rounded-lg border border-violet-700 bg-violet-900/60 p-3">
                    We use 50 random start and destination pairs as a compromise between a useful
                    statistical sample and API load. Each pair is routed by Tube and bike, one pair
                    at a time with a 2.7-second pause between pairs, spreading up to 100 TfL
                    requests over time.
                </li>
                <li className="rounded-lg border border-violet-700 bg-violet-900/60 p-3">
                    Tube prices do not account for possible travelcards, student discounts or other
                    subscriptions, which could lower the actual cost.
                </li>
                <li className="rounded-lg border border-violet-700 bg-violet-900/60 p-3">
                    Santander Cycles estimates use £1.65 for each started 30-minute cycling block.
                    Walking time to a bike is estimated from straight-line distance, adjusted for
                    streets, at 5 km/h; availability is a snapshot, not a historical probability.
                </li>
                <li className="rounded-lg border border-violet-700 bg-violet-900/60 p-3">
                    <strong className="font-semibold text-white">Data sources.</strong> Journey
                    routes, train arrivals and Tube status are requested live from TfL; the
                    BikePoint live request is used for locked-station counts. Map geometry, bike
                    stock and fallback arrivals are stored snapshots in{' '}
                    <code className="text-violet-200">public/data</code>; the deleted downloaded
                    tables and notebook are not needed to run the site. This keeps the map quick to
                    load while live requests provide changing journey and service information.
                </li>
            </ul>
        </section>
    );
}

function ComparisonRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <tr>
            <th
                scope="row"
                className="px-4 py-4 align-top text-xs font-semibold text-slate-700 md:px-6"
            >
                {label}
            </th>
            {Children.toArray(children).map((child, index) => (
                <td key={index} className="px-4 py-4 align-top md:px-6">
                    {child}
                </td>
            ))}
        </tr>
    );
}

function ComparisonValue({ value, detail }: { value: string; detail: string }) {
    return (
        <>
            <p className="font-semibold text-slate-900">{value}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{detail}</p>
        </>
    );
}

function randomStationPairs(
    stations: PointFeature[],
    count: number
): Omit<RandomJourneyPair, 'tube' | 'cycle'>[] {
    const pairs: Omit<RandomJourneyPair, 'tube' | 'cycle'>[] = [];
    const used = new Set<string>();
    let attempts = 0;
    while (pairs.length < count && attempts < count * 100) {
        attempts += 1;
        const a = stations[Math.floor(Math.random() * stations.length)];
        const b = stations[Math.floor(Math.random() * stations.length)];
        if (!a || !b || a === b) continue;
        const pairId = [String(a.properties.id), String(b.properties.id)].sort().join(':');
        const distance = distanceKm(a.geometry.coordinates, b.geometry.coordinates);
        if (used.has(pairId) || distance < 1.5 || distance > 20) continue;
        used.add(pairId);
        pairs.push({
            from: {
                name: String(a.properties.name ?? 'Tube station'),
                longitude: a.geometry.coordinates[0],
                latitude: a.geometry.coordinates[1]
            },
            to: {
                name: String(b.properties.name ?? 'Tube station'),
                longitude: b.geometry.coordinates[0],
                latitude: b.geometry.coordinates[1]
            }
        });
    }
    return pairs;
}

function distanceKm(from: [number, number], to: [number, number]) {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = radians(to[1] - from[1]);
    const dLon = radians(to[0] - from[0]);
    const value =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(radians(from[1])) * Math.cos(radians(to[1])) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function mean(values: number[]) {
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function formatJourneyDuration(minutes: number) {
    return formatDurationSeconds(minutes * 60);
}

function formatDurationSeconds(seconds: number) {
    const roundedSeconds = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(roundedSeconds / 60);
    const remainingSeconds = roundedSeconds % 60;
    if (!minutes) return `${remainingSeconds} sec`;
    return remainingSeconds ? `${minutes} min ${remainingSeconds} sec` : `${minutes} min`;
}

function nearestAvailableBikeStation(
    features: PointFeature[],
    point: TripPoint | { latitude: number; longitude: number } | null | undefined
) {
    return nearestFeature(
        features.filter(
            (feature) =>
                numberValue(feature.properties.bikes) > 0 && feature.properties.locked !== true
        ),
        point
    );
}

function estimatedWalkingSeconds(
    point: { latitude: number; longitude: number },
    station: PointFeature
) {
    const [longitude, latitude] = station.geometry.coordinates;
    const straightLineKm = distanceKm([point.longitude, point.latitude], [longitude, latitude]);
    // Approximate street distance as 1.25x straight-line distance at 5 km/h.
    return ((straightLineKm * 1.25) / 5) * 60 * 60;
}

function TripPlanner({
    points,
    pickTarget,
    onSelectTarget,
    onPlansCalculated
}: {
    points: TripPoints;
    pickTarget: PickTarget | null;
    onSelectTarget: (target: PickTarget) => void;
    onPlansCalculated: (plans: TripPlans) => void;
}) {
    const [loading, setLoading] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);

    useEffect(() => {
        setFormError(null);
    }, [pickTarget, points.from, points.to]);

    const calculate = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!points.from || !points.to) {
            setFormError('Choose a start and destination by clicking on either map.');
            return;
        }
        setLoading(true);
        setFormError(null);
        const from = `${points.from.latitude},${points.from.longitude}`;
        const to = `${points.to.latitude},${points.to.longitude}`;
        const [tube, cycle, walking] = await Promise.all([
            findBestJourney(from, to, 'tube'),
            findBestJourney(from, to, 'cycle'),
            findBestJourney(from, to, 'walking')
        ]);
        const calculatedPlans = { tube, cycle, walking };
        onPlansCalculated(calculatedPlans);
        setLoading(false);
    };

    return (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="mb-4">
                <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase">
                    Journey planner · 03
                </p>
                <h2 className="text-lg font-semibold">Find the best route</h2>
                <p className="mt-1 text-sm text-slate-600">
                    Choose two points on either map to compare Tube and Santander Cycles, with
                    walking when TfL can plan it.
                </p>
            </div>

            <form
                onSubmit={calculate}
                className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
            >
                <PointPickerButton
                    label="A · Start"
                    point={points.from}
                    active={pickTarget === 'from'}
                    onClick={() => onSelectTarget('from')}
                />
                <PointPickerButton
                    label="B · Destination"
                    point={points.to}
                    active={pickTarget === 'to'}
                    onClick={() => onSelectTarget('to')}
                />
                <button
                    type="submit"
                    disabled={loading}
                    className="h-10 rounded-md bg-violet-800 px-5 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-60"
                >
                    {loading ? 'Calculating…' : 'Compare routes'}
                </button>
            </form>

            <p className="mt-2 text-xs text-slate-500">
                Choose a point, then click anywhere on either map. You can click a Tube station or
                BikePoint directly.
            </p>
            {formError && (
                <p role="alert" className="mt-3 text-sm text-red-700">
                    {formError}
                </p>
            )}

            <p className="mt-4 text-[10px] text-slate-400">
                Powered by the Transport for London Journey Planner API.
            </p>
        </section>
    );
}

async function findBestJourney(
    from: string,
    to: string,
    mode: 'tube' | 'cycle' | 'walking'
): Promise<PlannedTrip> {
    try {
        const modePreference =
            mode === 'cycle'
                ? '&cyclePreference=cycleHire'
                : mode === 'walking'
                  ? '&maxWalkingMinutes=120&walkingSpeed=average'
                  : '';
        const url = `https://api.tfl.gov.uk/Journey/JourneyResults/${encodeURIComponent(from)}/to/${encodeURIComponent(to)}?mode=${mode}${modePreference}`;
        const response = await fetch(url);
        const result = (await response.json()) as TflJourneyResponse;
        const journeys = result.journeys ?? [];
        if (!journeys.length) {
            return {
                journey: null,
                error: response.ok
                    ? 'No route found. Try a station, full address, postcode, or coordinates.'
                    : `TfL could not plan this journey (HTTP ${response.status}). Check the place names and try again.`
            };
        }
        journeys.sort((a, b) => a.duration - b.duration);
        return { journey: journeys[0], error: null };
    } catch {
        return {
            journey: null,
            error: 'Could not reach TfL. Check the internet connection and try again.'
        };
    }
}

function explainJourneyError(
    plan: PlannedTrip,
    mode: 'tube' | 'cycle' | 'walking',
    distanceKmValue: number | null
) {
    if (!plan.error) return null;
    if (plan.error.startsWith('Could not reach TfL')) return plan.error;
    if (distanceKmValue == null) return plan.error;

    const distance = distanceKmValue.toFixed(1);
    const modeName =
        mode === 'tube' ? 'the Tube' : mode === 'cycle' ? 'Santander Cycles' : 'walking';
    const tooShort = mode === 'tube' ? 0.5 : mode === 'cycle' ? 0.4 : 0.03;
    const tooLong = mode === 'tube' ? 55 : mode === 'cycle' ? 30 : 8;

    if (distanceKmValue < tooShort) {
        return `This trip is only ${distance} km apart, so it is probably too short to plan by ${modeName}. Choose points farther apart.`;
    }
    if (distanceKmValue > tooLong) {
        const limitNote =
            mode === 'walking' ? ' TfL walking requests are limited to 120 minutes.' : '';
        return `This trip is about ${distance} km, which is too long to plan by ${modeName}.${limitNote} Choose closer points.`;
    }
    return `TfL did not return a route by ${modeName} for points ${distance} km apart. They may be outside this mode’s service coverage or planning limits.`;
}

function SelectedJourneyComparison({
    data,
    points,
    plans
}: {
    data: MapData;
    points: TripPoints;
    plans: TripPlans;
}) {
    const [tubeProblems, setTubeProblems] = useState<string[] | null>(null);
    const tubeJourney = plans.tube.journey;
    const bikeJourney = plans.cycle.journey;
    const walkingJourney = plans.walking.journey;
    const selectedDistanceKm =
        points.from && points.to
            ? distanceKm(
                  [points.from.longitude, points.from.latitude],
                  [points.to.longitude, points.to.latitude]
              )
            : null;
    const tubeError = explainJourneyError(plans.tube, 'tube', selectedDistanceKm);
    const bikeError = explainJourneyError(plans.cycle, 'cycle', selectedDistanceKm);
    const walkingError = explainJourneyError(plans.walking, 'walking', selectedDistanceKm);
    const tubeTime = tubeJourney?.duration ?? null;
    const bikeTime = bikeJourney?.duration ?? null;
    const walkingTime = walkingJourney?.duration ?? null;
    const optionTimes = [
        ['Tube', tubeTime],
        ['Bike', bikeTime],
        ['Walking', walkingTime]
    ] as const;
    const fastestTime = optionTimes.reduce<number | null>(
        (shortest, [, duration]) =>
            duration != null && (shortest == null || duration < shortest) ? duration : shortest,
        null
    );
    const fastestModes =
        fastestTime == null
            ? []
            : optionTimes.filter(([, duration]) => duration === fastestTime).map(([mode]) => mode);
    const tubeFastest = tubeTime != null && tubeTime === fastestTime;
    const bikeFastest = bikeTime != null && bikeTime === fastestTime;
    const walkingFastest = walkingTime != null && walkingTime === fastestTime;

    const tubeRideLegs = tubeJourney?.legs.filter((leg) => leg.mode?.id === 'tube') ?? [];
    const usedTubeLines = [
        ...new Set(tubeRideLegs.flatMap((leg) => leg.routeOptions?.[0]?.lineIdentifier?.id ?? []))
    ];
    const cycleLegs =
        bikeJourney?.legs.filter((leg) => leg.mode?.id === 'cycle' || leg.mode?.id === 'cycling') ??
        [];
    const cycleMinutes = cycleLegs.reduce((total, leg) => total + leg.duration, 0);
    const bikeHireCost = cycleMinutes > 0 ? Math.ceil(cycleMinutes / 30) * 1.65 : null;

    const tubeOrigin = nearestFeature(data.tubeStations.features, points.from);
    const tubeArrivals = tubeOrigin
        ? data.tubeArrivals.arrivals.filter(
              (arrival) => arrival.stationId === String(tubeOrigin.properties.id)
          )
        : [];
    const nextTubeSeconds = tubeArrivals.length
        ? Math.min(...tubeArrivals.map((arrival) => arrival.seconds))
        : null;
    const pickupPoint = cycleLegs[0]?.departurePoint;
    const returnPoint = cycleLegs.at(-1)?.arrivalPoint;
    const pickupFallback =
        pickupPoint?.lat != null && pickupPoint.lon != null
            ? { latitude: pickupPoint.lat, longitude: pickupPoint.lon }
            : points.from;
    const returnFallback =
        returnPoint?.lat != null && returnPoint.lon != null
            ? { latitude: returnPoint.lat, longitude: returnPoint.lon }
            : points.to;
    const pickupStation = nearestFeature(data.bikes.features, pickupFallback);
    const returnStation = nearestFeature(data.bikes.features, returnFallback);
    const nearestAvailablePickup = nearestAvailableBikeStation(data.bikes.features, points.from);
    const cyclingStartIndex =
        bikeJourney?.legs.findIndex(
            (leg) => leg.mode?.id === 'cycle' || leg.mode?.id === 'cycling'
        ) ?? -1;
    const walkToPickupMinutes =
        cyclingStartIndex > 0
            ? (bikeJourney?.legs
                  .slice(0, cyclingStartIndex)
                  .filter((leg) => leg.mode?.id === 'walking')
                  .reduce((total, leg) => total + leg.duration, 0) ?? null)
            : null;
    const estimatedWalkToAvailablePickup =
        points.from && nearestAvailablePickup
            ? estimatedWalkingSeconds(points.from, nearestAvailablePickup)
            : null;
    const pickupBikeCount = pickupStation ? numberValue(pickupStation.properties.bikes) : null;
    const pickupAvailability = pickupStation
        ? `${String(pickupStation.properties.name ?? 'Planned pickup')}: ${pickupBikeCount} ${pickupBikeCount === 1 ? 'bike' : 'bikes'}${pickupStation.properties.locked === true ? ' · station locked' : ''}`
        : 'Pickup station availability is not in the saved snapshot';
    const walkToBikeText =
        walkToPickupMinutes != null
            ? `${formatJourneyDuration(walkToPickupMinutes)} planned walk to hire station`
            : estimatedWalkToAvailablePickup != null
              ? `about ${formatDurationSeconds(estimatedWalkToAvailablePickup)} walk to nearest station showing bikes`
              : 'walk time unavailable';
    const returnDockText = returnStation
        ? `${numberValue(returnStation.properties.emptyDocks)} free docks at ${String(returnStation.properties.name ?? 'return point')}`
        : 'return dock availability unavailable';

    useEffect(() => {
        let cancelled = false;
        void fetch('https://api.tfl.gov.uk/Line/Mode/tube/Status')
            .then((response) =>
                response.ok ? response.json() : Promise.reject(new Error('TfL status unavailable'))
            )
            .then(
                (
                    lines: {
                        id?: string;
                        name?: string;
                        lineStatuses?: {
                            statusSeverity?: number;
                            statusSeverityDescription?: string;
                            reason?: string;
                        }[];
                    }[]
                ) => {
                    if (cancelled) return;
                    const issues = lines
                        .filter((line) => usedTubeLines.includes(String(line.id)))
                        .flatMap((line) =>
                            (line.lineStatuses ?? [])
                                .filter(
                                    (status) =>
                                        typeof status.statusSeverity === 'number' &&
                                        status.statusSeverity < 10
                                )
                                .map(
                                    (status) =>
                                        `${line.name ?? line.id}: ${status.statusSeverityDescription ?? status.reason ?? 'Disruption reported'}`
                                )
                        );
                    setTubeProblems(issues);
                }
            )
            .catch(() => {
                if (!cancelled) setTubeProblems(null);
            });
        return () => {
            cancelled = true;
        };
    }, [usedTubeLines.join(',')]);

    return (
        <section className="overflow-hidden rounded-xl border border-violet-300 bg-white shadow-md shadow-violet-950/5">
            <div className="border-b border-violet-200 bg-gradient-to-r from-violet-100 to-indigo-50 px-4 py-4 md:px-5">
                <p className="text-[10px] font-semibold tracking-[0.2em] text-violet-900 uppercase">
                    Your selected journey
                </p>
                <h2 className="mt-1 text-lg font-semibold text-slate-900">
                    Tube, bike or walking: compare the whole trip
                </h2>
                {fastestTime != null ? (
                    <p className="mt-2 inline-flex rounded-full bg-violet-200 px-3 py-1 text-sm font-semibold text-violet-950">
                        Fastest: {fastestModes.join(' & ')} · {formatJourneyDuration(fastestTime)}
                    </p>
                ) : (
                    <p className="mt-2 text-sm text-slate-600">
                        TfL could not find a route for these points.
                    </p>
                )}
            </div>
            <div className="grid gap-3 p-3 md:grid-cols-2 md:p-4 xl:grid-cols-3">
                <SelectedModeCard
                    title="London Underground"
                    fastest={tubeFastest}
                    duration={tubeTime}
                    error={tubeError}
                    accent="border-violet-200"
                    price={
                        typeof tubeJourney?.fare?.totalCost === 'number'
                            ? `£${(tubeJourney.fare.totalCost / 100).toFixed(2)}`
                            : 'Fare not returned by TfL'
                    }
                    availability={
                        nextTubeSeconds == null
                            ? 'No arrival prediction for the nearest departure station'
                            : `Next predicted train in ${formatWait(nextTubeSeconds)} at ${String(tubeOrigin?.properties.name ?? 'nearest Tube station')}`
                    }
                    issues={
                        tubeProblems == null
                            ? 'Live line status unavailable'
                            : tubeProblems.length
                              ? tubeProblems.join(' · ')
                              : 'No live disruption reported on this route'
                    }
                    steps={
                        tubeJourney?.legs.map(
                            (leg) =>
                                `${leg.instruction?.summary ?? leg.mode?.name ?? 'Travel'}${leg.duration ? ` · ${formatJourneyDuration(leg.duration)}` : ''}`
                        ) ?? []
                    }
                />
                <SelectedModeCard
                    title="Santander Cycles"
                    fastest={bikeFastest}
                    duration={bikeTime}
                    error={bikeError}
                    accent="border-emerald-200"
                    price={
                        bikeHireCost == null
                            ? 'Hire estimate unavailable'
                            : `£${bikeHireCost.toFixed(2)} hire estimate`
                    }
                    availability={`${pickupAvailability} · ${walkToBikeText} · ${returnDockText}`}
                    issues={`${pickupStation?.properties.locked === true ? 'Pickup station is locked' : pickupBikeCount === 0 ? 'Planned pickup is empty; another station is needed' : pickupBikeCount == null ? 'Pickup stock is unknown' : 'Bike available at planned pickup'} · ${returnStation?.properties.locked ? 'Return station is locked' : returnStation && numberValue(returnStation.properties.emptyDocks) === 0 ? 'No free return dock' : returnStation ? 'Return dock available' : 'Return point is unknown'}`}
                    steps={
                        bikeJourney?.legs.map(
                            (leg) =>
                                `${leg.instruction?.summary ?? leg.mode?.name ?? 'Travel'}${leg.duration ? ` · ${formatJourneyDuration(leg.duration)}` : ''}`
                        ) ?? []
                    }
                />
                <SelectedModeCard
                    title="Walking"
                    fastest={walkingFastest}
                    duration={walkingTime}
                    error={walkingError}
                    accent="border-slate-300"
                    price="£0"
                    availability="No vehicle or station wait; walk straight from start to destination."
                    issues="Longer distances, weather, crossings and step-free access can affect this option."
                    steps={
                        walkingJourney?.legs.map(
                            (leg) =>
                                `${leg.instruction?.summary ?? 'Walk'}${leg.duration ? ` · ${formatJourneyDuration(leg.duration)}` : ''}`
                        ) ?? []
                    }
                />
            </div>
            <p className="px-4 pb-4 text-[11px] leading-relaxed text-slate-500 md:px-5">
                The cycling route includes walking to and from hire stations. Bike availability
                comes from the saved BikePoint snapshot. “Too short” and “too long” notes use
                approximate straight-line distance checks.
            </p>
        </section>
    );
}

function SelectedModeCard({
    title,
    fastest,
    duration,
    error,
    accent,
    price,
    availability,
    issues,
    steps
}: {
    title: string;
    fastest: boolean;
    duration: number | null;
    error: string | null;
    accent: string;
    price: string;
    availability: string;
    issues: string;
    steps: string[];
}) {
    return (
        <article
            className={`rounded-lg border p-4 ${fastest ? 'border-emerald-400 bg-emerald-50 ring-2 ring-emerald-600/15' : `${accent} bg-slate-50`}`}
        >
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
                        {error ? 'Route unavailable' : fastest ? 'Fastest option' : 'Alternative'}
                    </p>
                    <h3 className="mt-1 text-base font-semibold">{title}</h3>
                </div>
                <div className="text-right">
                    <p className="text-xl font-semibold tabular-nums">
                        {duration == null ? '—' : formatJourneyDuration(duration)}
                    </p>
                    <p className="text-[10px] text-slate-500">journey time</p>
                </div>
            </div>
            {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
            {steps.length > 0 && (
                <div className="mt-4 border-t border-violet-200 pt-3">
                    <h4 className="text-xs font-bold tracking-wide text-violet-900 uppercase">
                        Journey steps · {steps.length}
                    </h4>
                    <ol className="mt-2 space-y-2">
                        {steps.map((step, index) => (
                            <li
                                key={`${step}-${index}`}
                                className="flex items-start gap-3 rounded-lg border border-violet-100 bg-violet-50/80 p-3 text-sm leading-relaxed text-slate-800 shadow-sm"
                            >
                                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-violet-800 text-xs font-bold text-white">
                                    {index + 1}
                                </span>
                                <span className="pt-0.5">{step}</span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
            <dl className="mt-3 space-y-3 border-t border-slate-200 pt-3 text-sm">
                <SelectedDetail label="Price" value={price} />
                <SelectedDetail label="Expected wait / availability" value={availability} />
                <SelectedDetail label="Potential issues" value={issues} />
            </dl>
        </article>
    );
}

function SelectedDetail({ label, value }: { label: string; value: string }) {
    return (
        <div className="grid grid-cols-[7rem_1fr] gap-2">
            <dt className="text-xs font-medium text-slate-500">{label}</dt>
            <dd className="text-xs leading-relaxed font-medium text-slate-800">{value}</dd>
        </div>
    );
}

function nearestFeature<T extends PointFeature>(
    features: T[],
    point: TripPoint | { latitude: number; longitude: number } | null | undefined
) {
    if (!point || !features.length) return null;
    return (
        features.reduce(
            (nearest, feature) => {
                const [longitude, latitude] = feature.geometry.coordinates;
                const distance = Math.hypot(latitude - point.latitude, longitude - point.longitude);
                return !nearest || distance < nearest.distance ? { feature, distance } : nearest;
            },
            null as { feature: T; distance: number } | null
        )?.feature ?? null
    );
}

function formatWait(seconds: number) {
    return formatDurationSeconds(seconds);
}

function journeyRouteGeoJSON(
    journey: TflJourney | null,
    journeyMode: 'tube' | 'cycle' | 'walking'
): FeatureCollection<LineFeature> {
    const features: LineFeature[] = [];
    if (!journey) return { type: 'FeatureCollection', features };

    journey.legs.forEach((leg, index) => {
        const rawPath = leg.path?.lineString;
        if (!rawPath) return;

        let latLonPairs: unknown;
        try {
            latLonPairs = typeof rawPath === 'string' ? JSON.parse(rawPath) : rawPath;
        } catch {
            return;
        }
        if (!Array.isArray(latLonPairs)) return;

        const coordinates: [number, number][] = [];
        for (const pair of latLonPairs) {
            if (Array.isArray(pair) && pair.length >= 2) {
                const latitude = Number(pair[0]);
                const longitude = Number(pair[1]);
                if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
                    // TfL returns each point as [latitude, longitude]; GeoJSON expects [longitude, latitude].
                    coordinates.push([longitude, latitude]);
                }
            } else if (pair && typeof pair === 'object') {
                const point = pair as {
                    lat?: unknown;
                    lon?: unknown;
                    latitude?: unknown;
                    longitude?: unknown;
                };
                const latitude = Number(point.lat ?? point.latitude);
                const longitude = Number(point.lon ?? point.longitude);
                if (Number.isFinite(latitude) && Number.isFinite(longitude))
                    coordinates.push([longitude, latitude]);
            }
        }
        if (coordinates.length < 2) return;

        const modeId = leg.mode?.id ?? '';
        const lineId = leg.routeOptions?.[0]?.lineIdentifier?.id;
        const line = TUBE_LINES.find((candidate) => candidate.id === lineId);
        const color =
            journeyMode === 'walking'
                ? '#7c3aed'
                : modeId === 'walking'
                  ? journeyMode === 'cycle'
                      ? '#f97316'
                      : '#64748b'
                  : journeyMode === 'cycle'
                    ? '#059669'
                    : (line?.color ?? '#7c3aed');

        features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates },
            properties: {
                color,
                mode: modeId,
                lineName: line?.name ?? leg.routeOptions?.[0]?.name ?? '',
                instruction: leg.instruction?.summary ?? `Leg ${index + 1}`
            }
        });
    });

    return { type: 'FeatureCollection', features };
}

function useRouteOverlay(
    map: MapInstance | null,
    sourceId: string,
    layerId: string,
    route: FeatureCollection<LineFeature>
) {
    useEffect(() => {
        if (!map) return;
        const update = () => {
            if (!map.isStyleLoaded()) return;
            let source = map.getSource(sourceId) as
                | { setData?: (data: unknown) => void }
                | undefined;
            if (!source && route.features.length) {
                map.addSource(sourceId, { type: 'geojson', data: route as never });
                source = map.getSource(sourceId) as
                    | { setData?: (data: unknown) => void }
                    | undefined;
            } else if (source?.setData) {
                source.setData(route);
            }
            if (route.features.length && !map.getLayer(layerId)) {
                map.addLayer({
                    id: layerId,
                    type: 'line',
                    source: sourceId,
                    layout: { 'line-cap': 'round', 'line-join': 'round' },
                    paint: { 'line-color': ['get', 'color'], 'line-width': 7, 'line-opacity': 1 }
                });
            }
            if (map.getLayer(layerId)) map.moveLayer(layerId);
        };
        if (map.isStyleLoaded()) update();
        else map.once('load', update);
        return () => {
            map.off('load', update);
        };
    }, [map, route, sourceId, layerId]);
}

function PointPickerButton({
    label,
    point,
    active,
    onClick
}: {
    label: string;
    point: TripPoint | null;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`flex h-12 min-w-0 items-center gap-3 rounded-md border px-3 text-left transition ${active ? 'border-violet-700 bg-violet-50 ring-2 ring-violet-700/15' : 'border-slate-300 bg-white hover:border-slate-400'}`}
        >
            <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-white ${label.startsWith('A') ? 'bg-blue-600' : 'bg-orange-600'}`}
            >
                {label.charAt(0)}
            </span>
            <span className="min-w-0">
                <span className="block text-xs font-semibold text-slate-800">{label.slice(4)}</span>
                <span className="block truncate text-[11px] font-normal text-slate-500">
                    {point
                        ? `${point.label} · ${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`
                        : 'Click to choose on map'}
                </span>
            </span>
            <span className="ml-auto shrink-0 text-[10px] font-semibold text-violet-800">
                {active ? 'Selecting…' : point ? 'Change' : 'Choose'}
            </span>
        </button>
    );
}

function TripPointMarker({
    point,
    label,
    color
}: {
    point: TripPoint | null;
    label: string;
    color: string;
}) {
    if (!point) return null;
    return (
        <Marker longitude={point.longitude} latitude={point.latitude} anchor="center">
            <span
                aria-label={`${label}: ${point.label}`}
                title={`${label}: ${point.label}`}
                className="grid h-8 w-8 place-items-center rounded-full border-2 border-white text-xs font-bold text-white shadow-[0_2px_6px_rgba(0,0,0,0.45)]"
                style={{ backgroundColor: color }}
            >
                {label}
            </span>
        </Marker>
    );
}

function PickMapHint({ target }: { target: PickTarget }) {
    const pointName = target === 'from' ? 'start point A' : 'destination B';
    return (
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet-800 px-4 py-2 text-xs font-semibold text-white shadow-lg">
            Click the map to set {pointName}
        </div>
    );
}

function numberValue(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatArrival(seconds: number) {
    if (seconds <= 30) return 'due';
    return formatDurationSeconds(seconds);
}
